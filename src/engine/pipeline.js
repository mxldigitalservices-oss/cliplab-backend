import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { store } from '../storage/store.js';
import { descargarVideo } from './download.js';
import { transcribirAudio } from './transcribe.js';
import { escribirAss } from './subtitles.js';
import { renderizarClip } from './render.js';

function crearAvance(id) {
  let ultimoProgreso = 0;
  let ultimaEtapa = '';

  return (etapa, valor) => {
    const progreso = Math.max(ultimoProgreso, Math.min(99, Math.round(valor)));
    if (progreso === ultimoProgreso && etapa === ultimaEtapa) return;
    ultimoProgreso = progreso;
    ultimaEtapa = etapa;
    store.actualizar(id, { etapa, progreso });
  };
}

function registrarTiempo(id, etapa, inicioMs) {
  logger.info('Etapa completada', {
    id,
    etapa,
    segundos: Math.round((Date.now() - inicioMs) / 100) / 10,
  });
}

async function podarClips() {
  let archivos;
  try {
    archivos = await fs.readdir(config.clipsDir);
  } catch {
    return;
  }

  const videos = [];
  for (const nombre of archivos) {
    if (!nombre.endsWith('.mp4')) continue;
    try {
      const info = await fs.stat(path.join(config.clipsDir, nombre));
      videos.push({ nombre, modificado: info.mtimeMs });
    } catch {
      // El archivo desaparecio mientras se listaba: se ignora.
    }
  }

  videos.sort((a, b) => b.modificado - a.modificado);
  for (const viejo of videos.slice(config.maxClipsStored)) {
    await fs.rm(path.join(config.clipsDir, viejo.nombre), { force: true });
    store.retirarVideo('/clips/' + viejo.nombre);
  }
}

export async function procesarClip(trabajo, signal) {
  const id = trabajo.id;
  const dirTrabajo = path.join(config.tmpDir, 'jobs', id);
  const token = crypto.randomBytes(16).toString('hex');
  const salida = path.join(config.clipsDir, token + '.mp4');
  const avanzar = crearAvance(id);
  let exito = false;

  try {
    await fs.mkdir(config.clipsDir, { recursive: true });
    await fs.mkdir(dirTrabajo, { recursive: true });

    // 1. Descarga (0-30 %)
    let marca = Date.now();
    avanzar('Descargando video', 2);
    const video = await descargarVideo(trabajo.url, dirTrabajo, {
      signal,
      onProgreso: (fraccion) => avanzar('Descargando video', 2 + fraccion * 28),
    });
    store.actualizar(id, { titulo: video.titulo });
    registrarTiempo(id, 'descarga', marca);

    const inicio = trabajo.inicio;
    if (video.duracion && inicio >= video.duracion - 1) {
      throw new Error(
        'El inicio indicado (' + inicio + ' s) supera la duracion del video (' + Math.floor(video.duracion) + ' s)'
      );
    }
    const disponible = video.duracion ? video.duracion - inicio : trabajo.duracion;
    const duracion = Math.max(1, Math.min(trabajo.duracion, disponible, config.maxClipSeconds));

    // 2. Transcripcion (30-55 %)
    marca = Date.now();
    avanzar('Transcribiendo audio', 30);
    const palabras = await transcribirAudio(video.archivo, dirTrabajo, {
      inicio,
      duracion,
      signal,
      onProgreso: (fraccion) => avanzar('Transcribiendo audio', 30 + fraccion * 25),
    });
    registrarTiempo(id, 'transcripcion', marca);

    // 3. Subtitulos (55-60 %)
    avanzar('Generando subtitulos', 56);
    let subtitulos = null;
    if (palabras.length > 0) {
      subtitulos = await escribirAss(palabras, path.join(dirTrabajo, 'subtitulos.ass'));
    } else {
      store.registrarIncidencia(
        'warn',
        'No se detecto voz en "' + video.titulo + '"; el clip se genero sin subtitulos',
        'pipeline'
      );
    }

    // 4. Render 9:16 (60-98 %)
    marca = Date.now();
    avanzar('Renderizando 9:16', 60);
    const resultado = await renderizarClip({
      entrada: video.archivo,
      salida,
      inicio,
      duracion,
      subtitulos,
      modo: trabajo.modo,
      signal,
      onProgreso: (fraccion) => avanzar('Renderizando 9:16', 60 + fraccion * 38),
    });
    registrarTiempo(id, 'render', marca);

    store.completar(id, {
      url: '/clips/' + token + '.mp4',
      duracion: resultado.duracion,
      bytes: resultado.bytes,
      transcripcion: palabras.map((p) => p.texto).join(' '),
    });
    exito = true;

    await podarClips();
  } finally {
    if (!exito) {
      await fs.rm(salida, { force: true });
    }
    await fs.rm(dirTrabajo, { recursive: true, force: true });
  }
}
