// ---------------------------------------------------------------------------
// Limpieza de temporales (Railway tiene disco efimero y limitado).
//  - limpiarClipPublicado(): borra el mp4 renderizado una vez publicado y deja el clip sin enlace de descarga.
//  - barrerTmp(): quita carpetas de trabajo huerfanas (jobs/) y clips antiguos (clips/) que nadie va a publicar.
//  - Solo toca LISTAS BLANCAS (jobs, clips). Nunca datos/, sesion/, sesion-datos/ ni envivo/ (los gestionan sus modulos).
//  - Un archivo que sigue en una cola de publicacion pendiente nunca se borra (callback `protegidas`).
// Variables: LIMPIAR_TRAS_PUBLICAR=off (conserva el mp4), CLIPS_TTL_H=72 (0 = no borrar por antiguedad),
//            JOBS_TTL_H=12, BARRIDO_TMP_MIN=60.
// ---------------------------------------------------------------------------
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from './logger.js';
import { store } from '../storage/store.js';

const HORA = 3600 * 1000;
const horas = (nombre, defecto) => {
  const n = Number(process.env[nombre]);
  return process.env[nombre] !== undefined && process.env[nombre] !== '' && Number.isFinite(n) && n >= 0 ? n : defecto;
};

/** ¿`ruta` esta dentro de `raiz` (y no es la propia raiz)? */
export function dentroDe(raiz, ruta) {
  const rel = path.relative(path.resolve(raiz), path.resolve(ruta));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Borra un archivo o carpeta SOLO si esta dentro de alguna raiz permitida. Devuelve true si borro algo. */
export async function borrarSeguro(ruta, raices = [config.clipsDir, config.tmpDir]) {
  if (!ruta || !raices.some((r) => dentroDe(r, ruta))) return false;
  try {
    await fs.rm(ruta, { recursive: true, force: true });
    return true;
  } catch (error) {
    logger.warn('No se pudo borrar un temporal', { ruta: path.basename(String(ruta)), mensaje: error.message });
    return false;
  }
}

/** Borra el mp4 de un clip ya publicado y lo marca en el panel. Nunca lanza. */
export async function limpiarClipPublicado({ rutaVideo, almacen = store, activado = process.env.LIMPIAR_TRAS_PUBLICAR !== 'off' } = {}) {
  if (!activado || !rutaVideo) return false;
  const borrado = await borrarSeguro(rutaVideo, [config.clipsDir]);
  if (borrado) {
    try { almacen.retirarVideo('/clips/' + path.basename(rutaVideo), 'Publicado: archivo temporal eliminado'); } catch { /* el panel se actualiza en el siguiente sondeo */ }
  }
  return borrado;
}

/**
 * Barrido periodico. `protegidas` devuelve (o resuelve) un Set de nombres de archivo en /clips que NO se deben borrar.
 * @returns {{ jobs:number, clips:number }} cuantos elementos se borraron
 */
export async function barrerTmp({ ahora = Date.now, protegidas = () => new Set(), almacen = store } = {}) {
  const resultado = { jobs: 0, clips: 0 };
  const ttlJobs = horas('JOBS_TTL_H', 12) * HORA;
  const ttlClips = horas('CLIPS_TTL_H', 72) * HORA;
  const ahoraMs = ahora();

  try {
    const dirJobs = path.join(config.tmpDir, 'jobs');
    for (const nombre of await fs.readdir(dirJobs).catch(() => [])) {
      const ruta = path.join(dirJobs, nombre);
      const info = await fs.stat(ruta).catch(() => null);
      if (info && ahoraMs - info.mtimeMs > ttlJobs && (await borrarSeguro(ruta, [dirJobs]))) resultado.jobs += 1;
    }
  } catch (error) {
    logger.warn('Barrido de jobs fallido', { mensaje: error.message });
  }

  if (ttlClips > 0) {
    try {
      const resguardo = new Set(await protegidas());
      for (const nombre of await fs.readdir(config.clipsDir).catch(() => [])) {
        if (!nombre.endsWith('.mp4') || resguardo.has(nombre)) continue;
        const ruta = path.join(config.clipsDir, nombre);
        const info = await fs.stat(ruta).catch(() => null);
        if (info && ahoraMs - info.mtimeMs > ttlClips && (await borrarSeguro(ruta, [config.clipsDir]))) {
          resultado.clips += 1;
          almacen.retirarVideo('/clips/' + nombre, 'Archivo eliminado por antiguedad');
        }
      }
    } catch (error) {
      logger.warn('Barrido de clips fallido', { mensaje: error.message });
    }
  }
  if (resultado.jobs || resultado.clips) logger.info('Barrido de temporales', resultado);
  return resultado;
}

export function iniciarBarridoTmp({ protegidas, cadaMin = horas('BARRIDO_TMP_MIN', 60) } = {}) {
  const ciclo = () => barrerTmp({ protegidas }).catch((error) => logger.warn('Barrido de temporales fallido', { mensaje: error.message }));
  const primero = setTimeout(ciclo, 60 * 1000);
  const t = setInterval(ciclo, Math.max(5, cadaMin) * 60 * 1000);
  primero.unref?.();
  t.unref?.();
  return () => { clearTimeout(primero); clearInterval(t); };
}
