// ---------------------------------------------------------------------------
// En Vivo: captura ligera de una transmision y "momentos" (cortes) listos para el motor normal.
//
//  - UNA sola captura a la vez (pensado para 8 GB de RAM). Nada de video vive en memoria: ffmpeg copia la transmision a
//    segmentos .ts de unos 20 s en un anillo de disco (ventana de ~10 min; lo viejo se borra solo).
//  - Un "momento" = los ultimos N segundos: se unen los segmentos con `-c copy` (sin recodificar), el mp4 resultante se guarda
//    en la carpeta de subidas y se encola como un archivo local en la cola EXISTENTE. Titulo, descripcion, subtitulos y
//    marketing los genera el pipeline de siempre; este modulo no toca pipeline.js, upload.js ni la rotacion.
//  - Cookies/sesion: SOLO se usan para pedir el enlace de medios a yt-dlp (conSesion: archivo temporal que se borra al
//    terminar). La captura posterior no necesita cookies y ningun enlace firmado se guarda, se registra ni se devuelve.
//  - Deteccion automatica (opcional): sube el volumen medio de un segmento muy por encima de la mediana reciente.
//  - Todas las dependencias se inyectan (crearGestorEnVivo) para probarlo con dobles, sin ffmpeg ni red.
// ---------------------------------------------------------------------------
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { run } from '../utils/run.js';
import { parsearUrlYoutube } from '../utils/youtube.js';
import { conSesion, esBloqueoAntiBot } from '../sesion/gestor.js';
import { store } from '../storage/store.js';
import { agregarTrabajo, cargaActual } from './cola.js';
import { validarVideo, dirUploads, borrarUpload } from '../upload.js';
import { AUTO, pedirEstilo, pedirModo } from './rotacion-flujo.js';
import { sanear } from '../instruccion.js';

export class ErrorEnVivo extends Error {
  constructor(mensaje, status = 500) {
    super(mensaje);
    this.name = 'ErrorEnVivo';
    this.status = status;
  }
}

/* ---------- Funciones puras ---------- */

export function parsearMeanVolume(texto) {
  const m = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(String(texto || ''));
  return m ? Number(m[1]) : null;
}

/** true si `valor` (dB medios del ultimo segmento) supera la mediana reciente en `umbralDb` o mas. */
export function detectarPico(historial, valor, { umbralDb = 6, minMuestras = 6, piso = -50 } = {}) {
  if (!Number.isFinite(valor) || valor < piso) return false;
  const base = (Array.isArray(historial) ? historial : []).filter(Number.isFinite);
  if (base.length < minMuestras) return false;
  const orden = [...base].sort((a, b) => a - b);
  return valor - orden[Math.floor(orden.length / 2)] >= umbralDb;
}

/** Los ultimos segmentos completos que cubren `segundos` (al menos 1, a lo sumo `tope`). */
export function elegirSegmentos(completos, segundos, segmentoSeg, tope = Infinity) {
  const n = Math.min(completos.length, Math.max(1, tope), Math.max(1, Math.ceil(segundos / segmentoSeg)));
  return completos.slice(completos.length - n);
}

/** Salida de yt-dlp con --print is_live, id, title, urls (una por linea). */
export function parsearManifiesto(stdout) {
  const l = String(stdout || '').split('\n').map((x) => x.trim());
  const urlMedia = /^https?:\/\//i.test(l[3] || '') ? l[3] : '';
  return { envivo: l[0] === 'True', id: l[1] || '', titulo: l[2] || '', urlMedia };
}

/** Quita cualquier URL (los enlaces de medios van firmados) de un texto que se guarda o se muestra. */
export function ocultarUrls(texto) {
  return String(texto || '').replace(/https?:\/\/[^\s'"]+/gi, '[url]');
}

/** Ficha publica de un clip-momento (misma precedencia que el panel: ficha > marketing > titulo). */
export function momentoPublico(clip) {
  const f = clip.ficha || {};
  const m = clip.marketing || {};
  const descripcion = f.descripcion || clip.copy ||
    (m.descripcion ? [m.descripcion, m.cta, Array.isArray(m.hashtags) ? m.hashtags.join(' ') : ''].filter(Boolean).join('\n\n') : '');
  return {
    id: clip.id,
    titulo: f.titulo || m.titulo || clip.titulo || 'Clip sin título',
    descripcion,
    estado: clip.estado,
    etapa: clip.etapa,
    progreso: clip.progreso,
    url: clip.url || null,
    duracion: clip.duracion ?? null,
    creadoEn: clip.creadoEn,
    origenMomento: clip.envivo ? clip.envivo.origen : null,
    enviadoEn: clip.enviadoEn || null,
    descargadoEn: clip.descargadoEn || null,
  };
}

/* ---------- Gestor ---------- */

const num = (nombre, defecto, minimo = 0) => {
  const crudo = process.env[nombre];
  const n = Number(crudo);
  return crudo !== undefined && crudo !== '' && Number.isFinite(n) && n >= minimo ? n : defecto;
};

function opcionesBase() {
  return {
    segmentoSeg: Math.max(5, num('ENVIVO_SEGMENTO_SEG', 20)),
    ventanaSeg: Math.max(60, num('ENVIVO_VENTANA_SEG', 600)),
    maxMin: num('ENVIVO_MAX_MIN', 240),
    umbralDb: num('ENVIVO_UMBRAL_DB', 6),
    cooldownSeg: num('ENVIVO_COOLDOWN_SEG', 90),
    duracionDefecto: 45,
    tickMs: 5000,
  };
}

const ACTIVOS = ['iniciando', 'grabando'];
const REGEX_SEGMENTO = /^seg_\d+\.ts$/;
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

export function crearGestorEnVivo(deps = {}) {
  const d = {
    run, conSesion, esBloqueoAntiBot, store, agregarTrabajo, cargaActual, validarVideo, dirUploads, borrarUpload,
    config, logger, ahora: () => Date.now(), ...deps,
  };
  const opts = () => ({ ...opcionesBase(), ...(deps.opciones || {}) });
  const dirBase = () => d.dirBase || path.join(d.config.tmpDir, 'envivo');

  let sesion = null;

  function detenerTemporizadores(s) {
    clearInterval(s.vigilante);
    clearTimeout(s.limite);
    clearTimeout(s.expira);
    s.vigilante = s.limite = s.expira = null;
  }

  async function listarSegmentos(s) {
    let nombres = [];
    try {
      nombres = (await fs.readdir(s.dir)).filter((n) => REGEX_SEGMENTO.test(n)).sort();
    } catch {
      nombres = [];
    }
    // Mientras ffmpeg sigue escribiendo, el ultimo archivo esta incompleto.
    const completos = s.estado === 'grabando' ? nombres.slice(0, -1) : nombres;
    return { todos: nombres, completos };
  }

  function estadoPublico() {
    if (!sesion) return { activa: false, estado: 'inactivo' };
    const s = sesion;
    return {
      activa: ACTIVOS.includes(s.estado),
      estado: s.estado,
      videoId: s.videoId,
      titulo: s.titulo,
      desde: s.desde,
      segundosGrabados: Math.round((d.ahora() - s.inicioMs) / 1000),
      auto: s.auto,
      ultimoPico: s.ultimoPico,
      momentos: s.momentos,
      marcando: s.marcando,
      error: s.error,
    };
  }

  async function obtenerManifiesto(url, signal) {
    const args = [
      '--no-playlist', '--no-warnings', '--no-colors', '--js-runtimes', 'node', '--socket-timeout', '20',
      '-f', 'best[height<=720]/best',
      '--print', '%(is_live)s', '--print', '%(id)s', '--print', '%(title)s', '--print', '%(urls)s',
    ];
    if (d.config.ytdlpProxy) args.push('--proxy', d.config.ytdlpProxy);
    let resultado;
    try {
      resultado = await d.conSesion((rutaCookies) => {
        const a = [...args];
        if (rutaCookies) a.push('--cookies', rutaCookies);
        a.push('--', url);
        return d.run(d.config.ytdlpPath, a, { timeoutMs: 90000, signal });
      });
    } catch (error) {
      const stderr = String(error.stderr || '');
      if (d.esBloqueoAntiBot(stderr)) {
        throw new ErrorEnVivo('YouTube pidió verificación anti-bot. Importa cookies frescas en /sesion.html.', 502);
      }
      const ultima = stderr.trim().split('\n').filter(Boolean).pop() || error.message;
      throw new ErrorEnVivo('No se pudo leer la transmisión: ' + ocultarUrls(ultima).slice(0, 300), 502);
    }
    const info = parsearManifiesto(resultado.stdout);
    if (!info.envivo) throw new ErrorEnVivo('Ese enlace no es una transmisión en vivo activa ahora mismo.', 422);
    if (!info.urlMedia) throw new ErrorEnVivo('YouTube no entregó un enlace de video para esta transmisión.', 502);
    return info;
  }

  async function indiceSiguiente(s) {
    const { todos } = await listarSegmentos(s);
    const ultimo = todos.length ? Number(/\d+/.exec(todos[todos.length - 1])[0]) : -1;
    return ultimo + 1;
  }

  async function lanzarGrabador(s, urlMedia) {
    const o = opts();
    const controlador = new AbortController();
    s.controlador = controlador;
    const args = [
      '-hide_banner', '-loglevel', 'warning', '-nostdin',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
      '-i', urlMedia,
      '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy',
      '-f', 'segment', '-segment_time', String(o.segmentoSeg), '-segment_format', 'mpegts', '-reset_timestamps', '1',
      '-segment_start_number', String(await indiceSiguiente(s)),
      path.join(s.dir, 'seg_%06d.ts'),
    ];
    s.grabador = d.run(d.config.ffmpegPath, args, { signal: controlador.signal })
      .then(() => ({ ok: true }), (err) => ({ ok: false, err }))
      .then((r) => alTerminarGrabador(s, r));
  }

  async function alTerminarGrabador(s, r) {
    if (s.estado !== 'grabando') return;   // detenido a proposito
    if (r.ok) {
      s.estado = 'terminado';              // la transmision termino: aun se pueden marcar los ultimos momentos
      clearInterval(s.vigilante);
      s.expira = setTimeout(() => detener().catch(() => {}), 30 * 60 * 1000);
      s.expira.unref?.();
      return;
    }
    s.reinicios += 1;
    if (s.reinicios > 3) return fallar(s, 'La captura se cortó: ' + ocultarUrls(r.err && r.err.message));
    try {
      const info = await obtenerManifiesto(s.urlOriginal);   // el enlace firmado caduca: se pide uno nuevo
      if (s.estado === 'grabando') await lanzarGrabador(s, info.urlMedia);
    } catch (error) {
      fallar(s, error.message);
    }
  }

  function fallar(s, mensaje) {
    s.estado = 'error';
    s.error = String(mensaje).slice(0, 400);
    detenerTemporizadores(s);
    d.logger.warn('En Vivo: captura con error', { mensaje: s.error });
  }

  async function arrancar(s) {
    try {
      const info = await obtenerManifiesto(s.urlOriginal, s.cancelar.signal);
      if (s.estado !== 'iniciando') return;   // se detuvo mientras se esperaba a yt-dlp
      s.videoId = info.id;
      s.titulo = info.titulo;
      await fs.rm(s.dir, { recursive: true, force: true });
      await fs.mkdir(s.dir, { recursive: true });
      s.estado = 'grabando';
      s.inicioMs = d.ahora();
      await lanzarGrabador(s, info.urlMedia);
      const o = opts();
      s.vigilante = setInterval(() => tick(s).catch((e) => d.logger.warn('En Vivo: fallo en el vigilante', { mensaje: e.message })), o.tickMs);
      s.vigilante.unref?.();
      if (o.maxMin > 0) {
        s.limite = setTimeout(() => detener().catch(() => {}), o.maxMin * 60 * 1000);   // red de seguridad: no queda grabando para siempre
        s.limite.unref?.();
      }
    } catch (error) {
      if (s.estado === 'iniciando' || s.estado === 'grabando') fallar(s, error.message);
    }
  }

  async function iniciar(url, { auto = false } = {}) {
    if (sesion && ACTIVOS.includes(sesion.estado)) {
      throw new ErrorEnVivo('Ya hay una transmisión en captura. Deténla antes de iniciar otra.', 409);
    }
    const parsed = parsearUrlYoutube(url);
    if (!parsed) throw new ErrorEnVivo('Solo se aceptan enlaces válidos de YouTube', 400);
    if (sesion) await detener();   // limpia restos de una sesion anterior (detenida, terminada o con error)

    const s = {
      id: 'vivo_' + crypto.randomBytes(4).toString('hex'),
      estado: 'iniciando',
      urlOriginal: parsed.toString(),   // solo en memoria; nunca sale en la API
      dir: path.join(dirBase(), 'sesion'),
      desde: new Date(d.ahora()).toISOString(),
      inicioMs: d.ahora(),
      videoId: null, titulo: null, auto: Boolean(auto), ultimoPico: null, momentos: 0, error: null,
      historial: [], analizados: new Set(), reinicios: 0, ultimoMomentoMs: 0,
      marcando: false, bloqueado: false, ocupadoTick: false,
      cancelar: new AbortController(), controlador: null, grabador: null, vigilante: null, limite: null, expira: null,
    };
    sesion = s;
    s.arranque = arrancar(s);   // en segundo plano: yt-dlp puede esperar el candado de sesion; el panel ve "iniciando"
    return estadoPublico();
  }

  async function medirVolumen(ruta) {
    try {
      const r = await d.run(d.config.ffmpegPath, ['-hide_banner', '-nostdin', '-i', ruta, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 60000 });
      return parsearMeanVolume(r.stderr);
    } catch {
      return null;
    }
  }

  async function podar(s) {
    const o = opts();
    const maxSegs = Math.max(3, Math.ceil(o.ventanaSeg / o.segmentoSeg));
    const { completos } = await listarSegmentos(s);
    for (const nombre of completos.slice(0, Math.max(0, completos.length - maxSegs))) {
      await fs.rm(path.join(s.dir, nombre), { force: true });
    }
  }

  async function tick(s) {
    if (sesion !== s || s.ocupadoTick || s.estado !== 'grabando') return;
    s.ocupadoTick = true;
    try {
      const o = opts();
      const { completos } = await listarSegmentos(s);
      const pendientes = completos.filter((n) => !s.analizados.has(n));
      for (const n of pendientes.slice(0, -2)) s.analizados.add(n);   // rezagados: no se analizan (CPU liviana)
      for (const nombre of pendientes.slice(-2)) {
        s.analizados.add(nombre);
        const db = await medirVolumen(path.join(s.dir, nombre));
        if (db === null) continue;
        const pico = detectarPico(s.historial, db, { umbralDb: o.umbralDb });
        s.historial.push(db);
        if (s.historial.length > 30) s.historial.shift();
        if (!pico) continue;
        s.ultimoPico = { db, en: new Date(d.ahora()).toISOString() };
        if (s.auto && !s.marcando && d.ahora() - s.ultimoMomentoMs >= o.cooldownSeg * 1000) {
          await marcar({ origen: 'auto' }).catch((e) => d.logger.warn('En Vivo: momento automatico omitido', { mensaje: e.message }));
        }
      }
      if (!s.bloqueado) await podar(s);
      for (const n of [...s.analizados]) if (!completos.includes(n)) s.analizados.delete(n);
    } finally {
      s.ocupadoTick = false;
    }
  }

  async function marcar({ segundosAtras, origen = 'manual' } = {}) {
    const s = sesion;
    if (!s || !['grabando', 'terminado'].includes(s.estado)) throw new ErrorEnVivo('No hay una transmisión en captura.', 409);
    if (s.marcando) throw new ErrorEnVivo('Ya se está preparando un momento; espera unos segundos.', 429);
    const o = opts();
    const pedido = Math.round(Number(segundosAtras) || o.duracionDefecto);
    if (!(pedido >= 10)) throw new ErrorEnVivo('Indica al menos 10 segundos.', 400);
    const objetivo = Math.min(pedido, d.config.maxClipSeconds);
    if (d.cargaActual() >= d.config.maxQueue) throw new ErrorEnVivo('La cola esta llena, espera a que terminen los trabajos en curso', 429);

    s.marcando = true;
    s.bloqueado = true;   // la poda no toca segmentos mientras se unen
    let ruta = null;
    let lista = null;
    let encolado = false;
    try {
      const { completos } = await listarSegmentos(s);
      if (!completos.length) throw new ErrorEnVivo('Aún no hay segmentos grabados; espera unos segundos.', 409);
      const maxSegs = Math.max(3, Math.ceil(o.ventanaSeg / o.segmentoSeg));
      const elegidos = elegirSegmentos(completos, objetivo, o.segmentoSeg, maxSegs - 1);

      const momentoId = 'momento_' + d.ahora().toString(36) + crypto.randomBytes(3).toString('hex');
      const dirSubidas = d.dirUploads();
      await fs.mkdir(dirSubidas, { recursive: true });
      ruta = path.join(dirSubidas, 'envivo_' + momentoId + '.mp4');
      lista = path.join(s.dir, momentoId + '.txt');
      await fs.writeFile(lista, elegidos.map((n) => "file '" + path.join(s.dir, n) + "'").join('\n') + '\n');
      await d.run(d.config.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', lista,
        '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', ruta,
      ], { timeoutMs: 120000 });

      const nombre = 'En vivo ' + (s.titulo || s.videoId || '') + ' ' + new Date(d.ahora()).toISOString().slice(11, 16);
      const archivo = await d.validarVideo(ruta, nombre);
      const real = Number(archivo.duracion) || elegidos.length * o.segmentoSeg;
      const duracion = Math.max(1, Math.min(objetivo, Math.floor(real)));
      const inicio = Math.max(0, Math.floor(real - duracion));   // corte manual: justo los ultimos `duracion` segundos

      const estilo = pedirEstilo(undefined);
      const clip = d.store.encolar('En vivo · ' + (s.titulo || s.videoId || 'transmisión'), {
        origen: 'archivo',   // el pipeline lo trata como archivo local (no hay descarga)
        instruccion: null,
        estiloSubtitulos: estilo === AUTO ? null : estilo,
      });
      d.store.actualizar(clip.id, { envivo: { sesionId: s.id, momentoId, origen, creadoEn: new Date(d.ahora()).toISOString() } });
      try {
        d.agregarTrabajo({
          id: clip.id, url: null, archivo, auto: false, inicio, duracion,
          modo: pedirModo(undefined), instruccion: sanear(undefined), estiloSubtitulos: estilo, ajustes: null,
        });
      } catch (error) {
        d.store.fallar(clip.id, error.message, '');
        throw error;
      }
      encolado = true;
      s.momentos += 1;
      s.ultimoMomentoMs = d.ahora();
      return { clipId: clip.id, momentoId, duracion, origen };
    } catch (error) {
      if (!encolado && ruta) await d.borrarUpload(ruta);   // no queda un mp4 huerfano si algo fallo antes de encolar
      throw error;
    } finally {
      if (lista) await fs.rm(lista, { force: true });
      s.marcando = false;
      s.bloqueado = false;
    }
  }

  function configurarAuto(activo) {
    if (!sesion || !['grabando', 'iniciando'].includes(sesion.estado)) throw new ErrorEnVivo('No hay una transmisión en captura.', 409);
    sesion.auto = Boolean(activo);
    return estadoPublico();
  }

  async function detener() {
    const s = sesion;
    if (!s) return estadoPublico();
    if (s.estado !== 'detenido') {
      if (['iniciando', 'grabando', 'terminado'].includes(s.estado)) s.estado = 'detenido';
      detenerTemporizadores(s);
      s.cancelar.abort();
      if (s.controlador) s.controlador.abort();
    }
    for (let i = 0; s.marcando && i < 100; i += 1) await dormir(50);
    try { await s.arranque; } catch { /* ya se reporto */ }
    try { await s.grabador; } catch { /* cancelado a proposito */ }
    await fs.rm(s.dir, { recursive: true, force: true }).catch(() => {});
    return estadoPublico();
  }

  return { iniciar, detener, marcar, configurarAuto, estado: estadoPublico, listo: () => (sesion && sesion.arranque) || Promise.resolve() };
}

export const gestorEnVivo = crearGestorEnVivo();
