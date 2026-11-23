import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const PLATAFORMAS = ['tiktok', 'instagram', 'facebook'];
const LIMITE = 500;
const LIMITE_INCIDENCIAS = 200;
const MAX_DETALLE = 64 * 1024;
const DETALLE_INLINE = 1500;

const datos = {
  clips: [],
  lotes: [],
  incidencias: [],
  conexiones: PLATAFORMAS.map((plataforma) => ({
    plataforma,
    estado: 'sin_sesion',
    cuenta: null,
    ultimaVerificacion: null,
  })),
};

// ---------------------------------------------------------------------------
// Persistencia: clips (con ficha, copy y marketing), lotes e incidencias sobreviven a reinicios y redeploys.
// JSON en dataDir/store.json (en Railway monta un volumen y fija DATA_DIR para que sobreviva al redeploy).
// Escritura atomica (tmp + rename) y agrupada (debounce). Las conexiones NO se guardan: se re-sincronizan al arrancar.
//   STORE_FILE=ruta         cambia el archivo
//   STORE_PERSISTENCIA=off  la desactiva  (en `node --test` esta apagada salvo STORE_PERSISTENCIA=on)
// ---------------------------------------------------------------------------
const DEBOUNCE_MS = 1000;
let temporizadorGuardado = null;
let sucio = false;

const persistenciaActiva = () =>
  process.env.STORE_PERSISTENCIA === 'on' || (process.env.STORE_PERSISTENCIA !== 'off' && !process.env.NODE_TEST_CONTEXT);
const rutaStore = () => process.env.STORE_FILE || path.join(config.dataDir, 'store.json');

function guardarSync() {
  if (!persistenciaActiva()) return false;
  const ruta = rutaStore();
  const tmp = ruta + '.' + process.pid + '.tmp';
  try {
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, guardadoEn: ahora(), clips: datos.clips, lotes: datos.lotes, incidencias: datos.incidencias }));
    fs.renameSync(tmp, ruta);
    sucio = false;
    return true;
  } catch (error) {
    logger.warn('No se pudo guardar el store en disco', { ruta, mensaje: error.message });
    try { fs.rmSync(tmp, { force: true }); } catch { /* sin tmp */ }
    return false;
  }
}

function marcarSucio() {
  if (!persistenciaActiva()) return;
  sucio = true;
  if (temporizadorGuardado) return;
  temporizadorGuardado = setTimeout(() => {
    temporizadorGuardado = null;
    guardarSync();
  }, DEBOUNCE_MS);
  if (temporizadorGuardado.unref) temporizadorGuardado.unref();
}

function guardarYa() {
  if (temporizadorGuardado) clearTimeout(temporizadorGuardado);
  temporizadorGuardado = null;
  return guardarSync();
}

/** Carga el store desde disco. Un clip que estaba 'procesando' cuando murio el proceso queda como error (no se reanuda solo). */
function recargar() {
  if (!persistenciaActiva()) return false;
  const ruta = rutaStore();
  let crudo;
  try {
    crudo = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn('store.json ilegible: se arranca vacio (el archivo original se conserva como .corrupto)', { ruta, mensaje: error.message });
    if (error.code !== 'ENOENT') { try { fs.renameSync(ruta, ruta + '.corrupto'); } catch { /* sin archivo */ } }
    return false;
  }
  datos.clips = Array.isArray(crudo.clips) ? crudo.clips.filter((c) => c && typeof c === 'object' && c.id) : [];
  datos.lotes = Array.isArray(crudo.lotes) ? crudo.lotes : [];
  datos.incidencias = Array.isArray(crudo.incidencias) ? crudo.incidencias : [];
  let interrumpidos = 0;
  for (const clip of datos.clips) {
    if (clip.estado === 'procesando') {
      Object.assign(clip, { estado: 'error', etapa: 'Interrumpido por reinicio del servidor', actualizadoEn: ahora() });
      interrumpidos++;
    }
  }
  if (interrumpidos) {
    datos.incidencias.unshift({
      id: 'inc_' + crypto.randomBytes(4).toString('hex'), nivel: 'warn', origen: 'sistema', resuelta: false, creadoEn: ahora(), detalle: null,
      mensaje: interrumpidos + ' clip(s) quedaron a medias por un reinicio del servidor. Vuelve a encolarlos.',
    });
    sucio = true;
  }
  return true;
}

process.on('exit', () => { if (sucio) guardarSync(); });

function ahora() {
  return new Date().toISOString();
}

function nuevoId(prefijo) {
  return prefijo + '_' + crypto.randomBytes(4).toString('hex');
}

function recortar(lista, limite = LIMITE) {
  if (lista.length > limite) {
    lista.length = limite;
  }
}

function buscar(id) {
  return datos.clips.find((clip) => clip.id === id) || null;
}

function encolar(url, extra = {}) {
  const marca = ahora();
  const clip = {
    id: nuevoId('clip'),
    jobId: null,
    titulo: url,
    fuente: url,
    origen: extra.origen || 'url',
    instruccion: extra.instruccion || null,
    estiloSubtitulos: extra.estiloSubtitulos || null,
    url: null,
    estado: 'procesando',
    etapa: 'En cola',
    progreso: 0,
    duracion: null,
    copy: '',
    cta: '',
    marketing: null,
    segmento: null,
    transcripcion: '',
    plataformas: [],
    creadoEn: marca,
    actualizadoEn: marca,
    publicadoEn: null,
  };
  clip.jobId = clip.id;
  datos.clips.unshift(clip);
  recortar(datos.clips);
  marcarSucio();
  return clip;
}

/** Crea un clip adicional del mismo trabajo (extraccion multiple: un video -> varios clips). */
function crearHijo(jobId, campos = {}) {
  const padre = buscar(jobId);
  const marca = ahora();
  const clip = {
    ...(padre || {}),
    ...campos,
    id: nuevoId('clip'),
    jobId,
    url: null,
    estado: 'procesando',
    etapa: 'En cola',
    progreso: 0,
    duracion: null,
    copy: '',
    cta: '',
    marketing: null,
    transcripcion: '',
    plataformas: [],
    creadoEn: marca,
    actualizadoEn: marca,
    publicadoEn: null,
  };
  datos.clips.unshift(clip);
  recortar(datos.clips);
  marcarSucio();
  return clip;
}

function actualizar(id, parche) {
  const clip = buscar(id);
  if (!clip) return null;
  Object.assign(clip, parche, { actualizadoEn: ahora() });
  marcarSucio();
  return clip;
}

function completar(id, campos) {
  return actualizar(id, { ...campos, estado: 'listo', etapa: 'Listo', progreso: 100 });
}

function registrarIncidencia(nivel, mensaje, origen, detalle) {
  const incidencia = {
    id: nuevoId('inc'),
    nivel,
    mensaje,
    origen: origen || 'sistema',
    detalle: detalle ? String(detalle).slice(-MAX_DETALLE) : null,
    resuelta: false,
    creadoEn: ahora(),
  };
  datos.incidencias.unshift(incidencia);
  recortar(datos.incidencias, LIMITE_INCIDENCIAS);
  marcarSucio();
  return incidencia;
}

/** Actualiza la tarjeta de una red social en la pestana Conexiones (estado, cuenta, ultimaVerificacion...). */
function actualizarConexion(plataforma, campos) {
  const conexion = datos.conexiones.find((c) => c.plataforma === plataforma);
  if (!conexion) return null;
  Object.assign(conexion, campos);
  return conexion;
}

function obtenerIncidencia(id) {
  return datos.incidencias.find((i) => i.id === id) || null;
}

// Vista ligera para el sondeo: los detalles cortos (<= DETALLE_INLINE, el tope historico) siguen viajando en
// /estado; los largos (stderr completo, hasta 64 KB) NO, para que el sondeo cada 4 s no se infle. El panel
// los pide bajo demanda a GET /api/panel/incidencias/:id.
function resumenIncidencia(incidencia) {
  const { detalle, ...resto } = incidencia;
  const lineas = detalle ? detalle.split('\n') : [];
  return {
    ...resto,
    detalle: detalle && detalle.length <= DETALLE_INLINE ? detalle : null,
    tieneDetalle: lineas.length > 0,
    detalleResumen: lineas.slice(-2).join('\n').slice(-240),
    detalleBytes: detalle ? detalle.length : 0,
  };
}

function fallar(id, mensaje, detalle) {
  const clip = actualizar(id, { estado: 'error', etapa: 'Error' });
  const nombre = clip ? clip.titulo : id;
  registrarIncidencia('error', 'Clip "' + nombre + '": ' + mensaje, 'cola', detalle);
  return clip;
}

/** Marca como fallidos todos los clips aun en proceso de un trabajo (p. ej. fallo de descarga) con UNA incidencia. */
function fallarTrabajo(jobId, mensaje, detalle) {
  const afectados = datos.clips.filter((c) => c.jobId === jobId && c.estado === 'procesando');
  for (const clip of afectados) {
    Object.assign(clip, { estado: 'error', etapa: 'Error', actualizadoEn: ahora() });
  }
  const nombre = afectados[0] ? afectados[0].titulo : jobId;
  registrarIncidencia('error', 'Clip \"' + nombre + '\": ' + mensaje, 'cola', detalle);
  marcarSucio();
  return afectados;
}

function retirarVideo(rutaUrl) {
  for (const clip of datos.clips) {
    if (clip.url === rutaUrl) {
      clip.url = null;
      clip.etapa = 'Archivo eliminado por limite de almacenamiento';
      clip.actualizadoEn = ahora();
    }
  }
  marcarSucio();
}

/** Clips que cumplen `pred` (referencias vivas: no mutarlos; usar actualizar). Incluye archivados. */
function clipsDonde(pred) {
  return datos.clips.filter(pred);
}

/** Saca clips de la bandeja activa sin borrarlos. Nunca archiva uno en proceso. Devuelve cuantos archivo. */
function archivar(ids) {
  const set = new Set(ids);
  const marca = ahora();
  let n = 0;
  for (const clip of datos.clips) {
    if (set.has(clip.id) && !clip.archivadoEn && clip.estado !== 'procesando') {
      clip.archivadoEn = marca;
      n += 1;
    }
  }
  if (n) marcarSucio();
  return n;
}

function desarchivar() {
  let n = 0;
  for (const clip of datos.clips) {
    if (clip.archivadoEn) {
      delete clip.archivadoEn;
      n += 1;
    }
  }
  if (n) marcarSucio();
  return n;
}

function snapshot() {
  // Los archivados no viajan al panel: menos JSON, menos DOM y menos videos en el navegador.
  const clips = datos.clips.filter((c) => !c.archivadoEn);
  const hoy = new Date().toISOString().slice(0, 10);
  const enProceso = clips.filter((c) => c.estado === 'procesando');

  return {
    generadoEn: ahora(),
    resumen: {
      kpis: {
        clipsListos: clips.filter((c) => c.estado === 'listo').length,
        enProceso: enProceso.length,
        lotesActivos: datos.lotes.filter((l) => l.estado === 'activo').length,
        incidenciasAbiertas: datos.incidencias.filter((i) => !i.resuelta).length,
        publicadosHoy: clips.filter(
          (c) => c.estado === 'publicado' && c.publicadoEn && c.publicadoEn.startsWith(hoy)
        ).length,
      },
      trabajosActivos: enProceso.slice(0, 10),
    },
    conexiones: datos.conexiones,
    lotes: datos.lotes,
    incidencias: datos.incidencias.map(resumenIncidencia),
    clips,
  };
}

recargar();

export const store = {
  recargar,
  guardarYa,
  encolar,
  crearHijo,
  buscar,
  fallarTrabajo,
  obtenerIncidencia,
  actualizarConexion,
  actualizar,
  completar,
  fallar,
  retirarVideo,
  clipsDonde,
  archivar,
  desarchivar,
  registrarIncidencia,
  snapshot,
};
