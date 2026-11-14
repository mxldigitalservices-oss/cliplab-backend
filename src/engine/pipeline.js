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
import { planificarSegmentos, leerHistorial, registrarPasada } from './segmentos.js';
import { generarMarketing } from './marketing.js';
import { detalleDeError } from '../utils/run.js';

let avisoLogo = false;

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

/** Directorio de trabajo exclusivo del job: tmp/jobs/<id>. Nunca se comparte con otro trabajo. */
export function directorioDeTrabajo(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id))) {
    throw new Error('Identificador de trabajo invalido: ' + id);
  }
  const raiz = path.resolve(config.tmpDir, 'jobs');
  const dir = path.resolve(raiz, String(id));
  if (path.dirname(dir) !== raiz) {
    throw new Error('Directorio de trabajo fuera de la zona permitida');
  }
  return dir;
}

function etiquetaSegmento(indice, total) {
  return total > 1 ? ' (clip ' + indice + '/' + total + ')' : '';
}

async function procesarSegmento({ clipId, trabajo, video, segmento, indice, total, dirSegmento, signal }) {
  const avanzar = crearAvance(clipId);
  const { inicio, duracion } = segmento;
  const token = crypto.randomBytes(16).toString('hex');
  const salida = path.join(config.clipsDir, token + '.mp4');
  let exito = false;

  try {
    await fs.mkdir(dirSegmento, { recursive: true });

    // Transcripcion (30-55 %)
    let marca = Date.now();
    avanzar('Transcribiendo audio', 30);
    const palabras = await transcribirAudio(video.archivo, dirSegmento, {
      inicio,
      duracion,
      signal,
      onProgreso: (fraccion) => avanzar('Transcribiendo audio', 30 + fraccion * 25),
    });
    registrarTiempo(clipId, 'transcripcion', marca);

    // Subtitulos (55-60 %)
    avanzar('Generando subtitulos', 56);
    let subtitulos = null;
    if (palabras.length > 0) {
      subtitulos = await escribirAss(palabras, path.join(dirSegmento, 'subtitulos.ass'));
    } else {
      store.registrarIncidencia(
        'warn',
        'No se detecto voz en "' + video.titulo + '"' + etiquetaSegmento(indice, total) + '; el clip se genero sin subtitulos',
        'pipeline'
      );
    }

    // Render 9:16 con logo (60-97 %)
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
      onProgreso: (fraccion) => avanzar('Renderizando 9:16', 60 + fraccion * 37),
    });
    registrarTiempo(clipId, 'render', marca);

    if (resultado.logoOmitido && !avisoLogo) {
      avisoLogo = true;
      store.registrarIncidencia(
        'warn',
        'No se encontro el logo de Klikap (' + config.logoPath + '): los clips salen sin marca de agua',
        'render'
      );
    }

    // Metadatos de marketing (titulo gancho, descripcion con CTA, hashtags). Un fallo aqui no tumba el clip.
    const transcripcion = palabras.map((p) => p.texto).join(' ');
    let marketing = null;
    try {
      marketing = generarMarketing({
        tituloVideo: video.titulo,
        transcripcion,
        semilla: clipId + '|' + inicio,
        indice,
        total,
      });
    } catch (error) {
      store.registrarIncidencia('warn', 'No se pudieron generar los metadatos de marketing del clip', 'marketing', detalleDeError(error));
    }

    store.completar(clipId, {
      url: '/clips/' + token + '.mp4',
      duracion: resultado.duracion,
      bytes: resultado.bytes,
      ancho: resultado.ancho,
      alto: resultado.alto,
      modo: trabajo.modo,
      inicio,
      conLogo: resultado.conLogo,
      transcripcion,
      marketing,
      copy: marketing ? marketing.descripcion + '\n\n' + marketing.hashtags.join(' ') : '',
      cta: marketing ? marketing.cta : '',
    });
    exito = true;
    await podarClips();
  } finally {
    if (!exito) await fs.rm(salida, { force: true });
    await fs.rm(dirSegmento, { recursive: true, force: true });
  }
}

export async function procesarClip(trabajo, signal) {
  const id = trabajo.id;
  const dirTrabajo = directorioDeTrabajo(id);
  const avanzarJob = crearAvance(id);

  try {
    await fs.mkdir(config.clipsDir, { recursive: true });
    await fs.mkdir(dirTrabajo, { recursive: true });

    // 1. Descarga unica del video fuente (0-30 % del primer clip)
    const marca = Date.now();
    avanzarJob('Descargando video', 2);
    const video = await descargarVideo(trabajo.url, dirTrabajo, {
      signal,
      onProgreso: (fraccion) => avanzarJob('Descargando video', 2 + fraccion * 28),
    });
    store.actualizar(id, { titulo: video.titulo });
    registrarTiempo(id, 'descarga', marca);

    // 2. Plan de cortes
    let segmentos;
    let pasada = 0;
    let reiniciado = false;

    if (trabajo.auto && video.duracion) {
      const historial = await leerHistorial(video.id);
      pasada = historial.pasadas;
      const plan = planificarSegmentos({
        duracionVideo: video.duracion,
        historial: historial.rangos,
        pasada,
        semilla: video.id,
        cantidad: trabajo.cantidad,
      });
      segmentos = plan.segmentos;
      reiniciado = plan.reiniciado;
      if (reiniciado) {
        store.registrarIncidencia(
          'info',
          'Todos los momentos de "' + video.titulo + '" ya se habian usado: se abre un ciclo nuevo de cortes',
          'pipeline'
        );
      }
      if (plan.faltantes > 0) {
        store.registrarIncidencia(
          'info',
          'Solo se encontraron ' + segmentos.length + ' momentos libres en "' + video.titulo + '" (se pedian ' + (segmentos.length + plan.faltantes) + ')',
          'pipeline'
        );
      }
    } else {
      // Corte manual (inicio/duracion indicados) o duracion del video desconocida.
      const inicio = trabajo.inicio;
      if (video.duracion && inicio >= video.duracion - 1) {
        throw new Error(
          'El inicio indicado (' + inicio + ' s) supera la duracion del video (' + Math.floor(video.duracion) + ' s)'
        );
      }
      const disponible = video.duracion ? video.duracion - inicio : trabajo.duracion;
      segmentos = [{ inicio, duracion: Math.max(1, Math.min(trabajo.duracion, disponible, config.maxClipSeconds)) }];
    }

    if (segmentos.length === 0) {
      throw new Error('No se pudo planificar ningun corte para este video');
    }

    // 3. Un registro de clip por segmento: el primero reutiliza el del trabajo, el resto se crean.
    const total = segmentos.length;
    const registros = segmentos.map((segmento, i) => {
      const base = { titulo: video.titulo + etiquetaSegmento(i + 1, total), segmento: { indice: i + 1, total, inicio: segmento.inicio, duracion: segmento.duracion } };
      if (i === 0) {
        store.actualizar(id, { ...base, etapa: total > 1 ? 'En cola (clip 1/' + total + ')' : 'En cola' });
        return store.buscar(id);
      }
      return store.crearHijo(id, { ...base, etapa: 'En cola (clip ' + (i + 1) + '/' + total + ')' });
    });

    // 4. Render secuencial (un solo FFmpeg a la vez para no saturar la CPU)
    const exitosos = [];
    let ultimoError = null;
    for (let i = 0; i < total; i++) {
      if (signal && signal.aborted) throw new Error('Trabajo cancelado');
      const clipId = registros[i].id;
      try {
        await procesarSegmento({
          clipId,
          trabajo,
          video,
          segmento: segmentos[i],
          indice: i + 1,
          total,
          dirSegmento: path.join(dirTrabajo, 'seg-' + (i + 1)),
          signal,
        });
        exitosos.push(segmentos[i]);
      } catch (error) {
        if (signal && signal.aborted) throw error;
        // Un clip fallido no detiene a los demas: se registra y se continua.
        ultimoError = error;
        logger.error('Clip fallido', { id: clipId, indice: i + 1, mensaje: error.message });
        store.fallar(clipId, error.message, detalleDeError(error));
      }
    }

    // 5. Historial anti-duplicados: solo los rangos que realmente se renderizaron.
    if (exitosos.length > 0 && trabajo.auto && video.duracion) {
      try {
        await registrarPasada(
          video.id,
          exitosos.map((r) => ({ inicio: r.inicio, fin: r.inicio + r.duracion })),
          { reiniciar: reiniciado }
        );
      } catch (error) {
        store.registrarIncidencia('warn', 'No se pudo guardar el historial de cortes (podrian repetirse momentos)', 'historial', detalleDeError(error));
      }
    }

    if (exitosos.length === 0 && ultimoError) {
      // Todos fallaron y cada uno ya dejo su incidencia: no se duplica el aviso.
      logger.warn('Ningun clip del trabajo pudo generarse', { id });
    }
  } finally {
    await fs.rm(dirTrabajo, { recursive: true, force: true });
  }
}
