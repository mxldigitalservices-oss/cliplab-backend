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
//  - Deteccion automatica (opcional, `auto`): cada vez que se completan segmentos nuevos se transcribe (whisper local, ventana
//    corta de ~40 s, UNA a la vez, 1-2 hilos) la cola reciente y se evalua con `puntuarIntensidad` del cerebro: si es un
//    momento de `tension_reality` o `chisme_confidencia` se marca solo. El audio se normaliza antes de transcribir para que
//    los chismes/confidencias en voz baja se entiendan. El volumen (pico sobre la mediana, o voz claramente mas baja que la
//    mediana) refuerza la decision. SIN transcripcion (whisper/modelo ausente o fallando) se vuelve al criterio de volumen.
//  - Control de recursos (laptop 16 GB / 4 hilos, margen ~8 GB): un solo analisis a la vez, tope de cortes automaticos por
//    sesion (`cantidad`), tope de trabajos pendientes en la cola y enfriamiento entre cortes. Nada de video vive en memoria.
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
import { puntuarIntensidad } from './cerebro-marketing.js';
import { whisperNoDisponible } from './transcribe.js';

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

/**
 * true si el segmento suena MUCHO mas bajo que la mediana reciente pero no es silencio: habla a media voz
 * (confidencias, cuchicheo). Sirve para bajar el umbral de texto cuando el contenido parece un chisme.
 */
export function detectarVozBaja(historial, valor, { caidaDb = 4, minMuestras = 6, piso = -50 } = {}) {
  if (!Number.isFinite(valor) || valor < piso) return false;
  const base = (Array.isArray(historial) ? historial : []).filter(Number.isFinite);
  if (base.length < minMuestras) return false;
  const orden = [...base].sort((a, b) => a - b);
  return orden[Math.floor(orden.length / 2)] - valor >= caidaDb;
}

/** Ruta lista para un archivo de lista de `ffmpeg -f concat` (barras normales, comillas simples escapadas): vale en Windows y Linux. */
export function rutaParaConcat(ruta) {
  return String(ruta).replace(/\\/g, '/').replace(/'/g, "'\\''");
}

/** Contenido de una lista de `concat` para esos archivos. */
export function listaConcat(rutas) {
  return rutas.map((r) => "file '" + rutaParaConcat(r) + "'").join('\n') + '\n';
}

/**
 * Limpia la salida de whisper (sin timestamps) para el cerebro: quita marcas de ruido/musica/silencio y convierte las de
 * susurro en "(susurrando)", que `puntuarIntensidad` reconoce como habla a media voz.
 */
export function limpiarTextoVoz(texto) {
  return String(texto || '')
    .replace(/[\[(]\s*(?:whisper\w*|susurr\w*|en voz baja|bajito|murmur\w*)\s*[\])]/gi, ' (susurrando) ')
    .replace(/[\[(]\s*(?:blank[_ ]audio|silence|silencio|m[uú]sica|music|musique|applause|aplausos|risas|laughter|noise|ruido|inaudible)[^\])]{0,20}[\])]/gi, ' ')
    .replace(/[♪♫]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decide si un texto transcrito es un momento caliente (tension_reality / chisme_confidencia).
 *  - Solo texto: la intensidad de `puntuarIntensidad` debe llegar a `intensidadMin` (~2 senales densas o 3 en una ventana corta).
 *  - Con refuerzo de audio (pico de volumen; o voz baja si es chisme): basta `intensidadRefuerzo` (cualquier momento ya
 *    clasificado), porque el audio confirma lo que el texto solo insinua.
 * Un pico de volumen SIN senales en el texto nunca dispara (podria ser musica o aplausos).
 * @returns {{ dispara: boolean, tipo: string|null, intensidad: number, motivo: string, palabras: number }}
 */
export function evaluarMomento(texto, { pico = false, vozBaja = false, intensidadMin = 50, intensidadRefuerzo = 30, minPalabras = 6 } = {}) {
  const limpio = limpiarTextoVoz(texto);
  const palabras = limpio.replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean).length;
  const vacio = { dispara: false, tipo: null, intensidad: 0, motivo: 'sin_senales', palabras };
  if (palabras < minPalabras) return { ...vacio, motivo: 'poco_texto' };
  const m = puntuarIntensidad(limpio);
  if (!m.tipo) return vacio;
  const base = { tipo: m.tipo, intensidad: m.intensidad, palabras };
  if (m.intensidad >= intensidadMin) return { ...base, dispara: true, motivo: 'texto' };
  const refuerzo = pico || (vozBaja && m.tipo === 'chisme_confidencia');
  if (refuerzo && m.intensidad >= intensidadRefuerzo) return { ...base, dispara: true, motivo: pico ? 'texto+volumen' : 'texto+voz_baja' };
  return { ...base, dispara: false, motivo: 'intensidad_baja' };
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
    deteccion: clip.envivo && clip.envivo.deteccion ? clip.envivo.deteccion : null,
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
    // Deteccion por contenido (transcripcion corta + puntuarIntensidad)
    asr: (process.env.ENVIVO_ASR || '').toLowerCase() !== 'off',
    ventanaAnalisisSeg: Math.max(15, num('ENVIVO_ANALISIS_SEG', 40)),
    intensidadMin: num('ENVIVO_INTENSIDAD_MIN', 50),
    intensidadRefuerzo: num('ENVIVO_INTENSIDAD_REFUERZO', 30),
    cantidad: Math.floor(num('ENVIVO_CANTIDAD', 5)),                // cortes automaticos por sesion (0 = sin tope)
    maxPendientes: Math.max(1, Math.floor(num('ENVIVO_MAX_PENDIENTES', 2))),   // render en curso + a lo sumo uno esperando
    asrHilos: Math.max(1, Math.floor(num('ENVIVO_ASR_HILOS', 2))),
    asrTimeoutMs: Math.max(10000, num('ENVIVO_ASR_TIMEOUT_MS', 120000)),
    duracionAuto: Math.max(10, num('ENVIVO_DURACION_AUTO', 55)),
  };
}

const ACTIVOS = ['iniciando', 'grabando'];
const REGEX_SEGMENTO = /^seg_\d+\.ts$/;
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

export function crearGestorEnVivo(deps = {}) {
  const d = {
    run, conSesion, esBloqueoAntiBot, store, agregarTrabajo, cargaActual, validarVideo, dirUploads, borrarUpload,
    config, logger, ahora: () => Date.now(),
    // transcribirReciente(rutasSegmentos, { s, signal }) -> texto | null (null = sin transcripcion disponible). Inyectable en pruebas.
    transcribirReciente: null,
    ...deps,
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

  // Cantidad de cortes automaticos por sesion: entero >= 1 (maximo 50); 0 = sin tope; sin valor, el predeterminado.
  function cantidadValida(valor, defecto) {
    if (valor === undefined || valor === null || valor === '') return defecto;
    const n = Math.floor(Number(valor));
    if (!Number.isFinite(n) || n < 0) return defecto;
    return Math.min(50, n);
  }

  function cuposRestantes(s) {
    return s.cantidadAuto > 0 ? Math.max(0, s.cantidadAuto - s.autoMarcados) : Infinity;
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
      deteccion: {
        asr: s.asr,                                   // activo | no_disponible | desactivado
        ultimoAnalisis: s.ultimoAnalisis,
        cantidad: s.cantidadAuto,
        automaticos: s.autoMarcados,
        restantes: cuposRestantes(s) === Infinity ? null : cuposRestantes(s),
      },
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

  async function iniciar(url, { auto = false, cantidad } = {}) {
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
      cantidadAuto: cantidadValida(cantidad, opts().cantidad), autoMarcados: 0,
      asr: opts().asr ? 'activo' : 'desactivado', fallosAsr: 0, ultimoAnalisis: null,
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

  /* ---------- Transcripcion corta de la cola reciente ---------- */

  const asrConfigurado = () => Boolean(d.config.whisperPath && d.config.whisperModel);

  // Une los segmentos recientes en un wav mono 16 kHz con la voz normalizada (sube el habla baja) y lo transcribe con whisper.
  // Devuelve el texto o null si no hay transcripcion disponible. Nunca lanza.
  async function transcribirRecienteDefecto(rutas, { s, signal }) {
    if (!asrConfigurado() || !rutas.length) return null;
    const o = opts();
    const id = crypto.randomBytes(4).toString('hex');
    const lista = path.join(s.dir, 'asr_' + id + '.txt');
    const wav = path.join(s.dir, 'asr_' + id + '.wav');
    try {
      await fs.writeFile(lista, listaConcat(rutas));
      await d.run(d.config.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', lista,
        '-vn', '-ac', '1', '-ar', '16000',
        '-af', 'highpass=f=70,dynaudnorm=f=200:g=15:m=30:p=0.9',   // voz baja -> audible para whisper
        '-c:a', 'pcm_s16le', '-threads', '1', wav,
      ], { timeoutMs: 60000, signal });
      const hilos = Math.max(1, Math.min(o.asrHilos, Number(d.config.cpuThreads) || o.asrHilos));
      const r = await d.run(d.config.whisperPath, [
        '-m', d.config.whisperModel, '-f', wav, '-l', d.config.whisperLang || 'auto',
        '-t', String(hilos), '-bs', '1', '-nt', '-np',
      ], { timeoutMs: o.asrTimeoutMs, signal });
      s.fallosAsr = 0;
      return String(r.stdout || '');
    } catch (error) {
      if (signal && signal.aborted) return null;
      if (whisperNoDisponible(error)) {
        s.asr = 'no_disponible';
        d.logger.warn('En Vivo: whisper no esta disponible; la deteccion automatica usara solo el volumen', { motivo: ocultarUrls(String(error.stderr || error.message)).trim().split('\n').pop() });
        return null;
      }
      s.fallosAsr += 1;
      d.logger.warn('En Vivo: fallo la transcripcion corta', { mensaje: ocultarUrls(error.message).slice(0, 200), seguidos: s.fallosAsr });
      if (s.fallosAsr >= 3) s.asr = 'no_disponible';   // no insistir: se usa el respaldo por volumen
      return null;
    } finally {
      await fs.rm(lista, { force: true }).catch(() => {});
      await fs.rm(wav, { force: true }).catch(() => {});
    }
  }

  async function transcribir(s, nombres) {
    const rutas = nombres.map((n) => path.join(s.dir, n));
    try {
      const f = d.transcribirReciente || transcribirRecienteDefecto;
      const texto = await f(rutas, { s, signal: s.cancelar.signal });
      return typeof texto === 'string' ? texto : null;
    } catch (error) {
      d.logger.warn('En Vivo: la transcripcion fallo', { mensaje: ocultarUrls(error.message).slice(0, 200) });
      return null;
    }
  }

  const asrActivo = (s) => opts().asr && s.asr === 'activo' && (d.transcribirReciente || asrConfigurado());

  async function tick(s) {
    if (sesion !== s || s.ocupadoTick || s.estado !== 'grabando') return;
    s.ocupadoTick = true;
    try {
      const o = opts();
      const { completos } = await listarSegmentos(s);
      const pendientes = completos.filter((n) => !s.analizados.has(n));
      for (const n of pendientes.slice(0, -2)) s.analizados.add(n);   // rezagados: no se analizan (CPU liviana)
      let picoNuevo = false;
      let vozBajaNueva = false;
      let hayNuevos = false;
      for (const nombre of pendientes.slice(-2)) {
        s.analizados.add(nombre);
        hayNuevos = true;
        const db = await medirVolumen(path.join(s.dir, nombre));
        if (db === null) continue;
        const pico = detectarPico(s.historial, db, { umbralDb: o.umbralDb });
        const bajo = detectarVozBaja(s.historial, db);
        s.historial.push(db);
        if (s.historial.length > 30) s.historial.shift();
        if (bajo) vozBajaNueva = true;
        if (!pico) continue;
        picoNuevo = true;
        s.ultimoPico = { db, en: new Date(d.ahora()).toISOString() };
      }
      if (hayNuevos && s.auto) await decidirAuto(s, o, completos, { picoNuevo, vozBajaNueva });
      if (!s.bloqueado) await podar(s);
      for (const n of [...s.analizados]) if (!completos.includes(n)) s.analizados.delete(n);
    } finally {
      s.ocupadoTick = false;
    }
  }

  // Decide (y encola) un momento automatico. Orden de las compuertas: cupo, enfriamiento, cola. Luego contenido.
  async function decidirAuto(s, o, completos, { picoNuevo, vozBajaNueva }) {
    if (s.marcando || cuposRestantes(s) <= 0) return;
    if (d.ahora() - s.ultimoMomentoMs < o.cooldownSeg * 1000) return;
    // Cola saturada: no se gasta CPU en transcribir algo que no se podria encolar ahora.
    if (d.cargaActual() >= Math.min(o.maxPendientes, d.config.maxQueue || Infinity)) return;

    let deteccion = null;
    if (asrActivo(s)) {
      const n = Math.min(completos.length, Math.max(1, Math.ceil(o.ventanaAnalisisSeg / o.segmentoSeg)), 4);
      const texto = await transcribir(s, completos.slice(completos.length - n));
      if (sesion !== s || s.estado !== 'grabando') return;   // se detuvo mientras se transcribia
      if (texto !== null) {
        const ev = evaluarMomento(texto, { pico: picoNuevo, vozBaja: vozBajaNueva, intensidadMin: o.intensidadMin, intensidadRefuerzo: o.intensidadRefuerzo });
        s.ultimoAnalisis = { en: new Date(d.ahora()).toISOString(), tipo: ev.tipo, intensidad: ev.intensidad, motivo: ev.motivo };
        if (!ev.dispara) return;
        deteccion = { metodo: 'contenido', tipo: ev.tipo, intensidad: ev.intensidad, motivo: ev.motivo };
      }
    }
    if (!deteccion) {
      // Respaldo sin transcripcion: criterio de volumen de siempre.
      if (!picoNuevo) return;
      deteccion = { metodo: 'volumen', tipo: null, intensidad: null, motivo: 'pico_volumen' };
    }
    await marcar({ origen: 'auto', segundosAtras: o.duracionAuto, deteccion })
      .catch((e) => d.logger.warn('En Vivo: momento automatico omitido', { mensaje: e.message }));
  }

  async function marcar({ segundosAtras, origen = 'manual', deteccion = null } = {}) {
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
      await fs.writeFile(lista, listaConcat(elegidos.map((n) => path.join(s.dir, n))));
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
      d.store.actualizar(clip.id, {
        envivo: { sesionId: s.id, momentoId, origen, creadoEn: new Date(d.ahora()).toISOString(), ...(deteccion ? { deteccion } : {}) },
      });
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
      if (origen === 'auto') s.autoMarcados += 1;
      s.ultimoMomentoMs = d.ahora();
      return { clipId: clip.id, momentoId, duracion, origen, ...(deteccion ? { deteccion } : {}) };
    } catch (error) {
      if (!encolado && ruta) await d.borrarUpload(ruta);   // no queda un mp4 huerfano si algo fallo antes de encolar
      throw error;
    } finally {
      if (lista) await fs.rm(lista, { force: true });
      s.marcando = false;
      s.bloqueado = false;
    }
  }

  function configurarAuto(activo, { cantidad } = {}) {
    if (!sesion || !['grabando', 'iniciando'].includes(sesion.estado)) throw new ErrorEnVivo('No hay una transmisión en captura.', 409);
    sesion.auto = Boolean(activo);
    if (cantidad !== undefined && cantidad !== null && cantidad !== '') {
      sesion.cantidadAuto = cantidadValida(cantidad, sesion.cantidadAuto);
      sesion.autoMarcados = 0;   // una cantidad nueva abre una tanda nueva
    }
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
