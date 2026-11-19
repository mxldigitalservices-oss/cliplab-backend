#!/usr/bin/env bash
# Aplica la Parte 1 (programador + publicador) en ~/cliplab-backend. No hace commit, push ni deploy.
# Uso:  cd ~/cliplab-backend && bash aplicar-parte1.sh
set -euo pipefail
if ! grep -q '"name": "cliplab-pro"' package.json 2>/dev/null; then
  echo "Ejecuta este script dentro de ~/cliplab-backend (K)." >&2; exit 1
fi
mkdir -p src/engine tests
cat > src/engine/programador.js << 'CLIPLAB_EOF'
// ---------------------------------------------------------------------------
// Programador de publicaciones (cola sobre clips ya generados).
//
//  - Cada trabajo: { id, clipId, rutaVideo, descripcion, etiquetas, scheduledAt (ISO), platforms[], status, attempts,
//    lastError, resultados{ red: {ok,...} }, creadoEn, actualizadoEn, publicadoEn }
//    status: 'queued' | 'running' | 'published' | 'failed' | 'cancelled'
//  - Persistencia: MongoDB (MONGODB_URI) con respaldo automatico a JSON en dataDir/programador.json si no hay URI,
//    el modulo `mongodb` no esta instalado o falla la conexion. Si Mongo falla DESPUES (una escritura), tambien pasa a JSON.
//  - Ritmo: tope DURO de 2 ejecuciones por ventana deslizante de 60 min (aunque la config pida mas), plan diario/semanal
//    aleatorio (1..3 envios o dia inactivo), esperas irregulares entre ejecuciones y ejecucion estrictamente secuencial.
//  - Un fallo transitorio reprograma SOLO ese trabajo con backoff exponencial + jitter; los demas siguen su curso.
//    En un reintento solo se publica en las plataformas que aun no salieron bien (no se duplica).
// Nada aqui toca pipeline.js, upload.js ni la rotacion.
// ---------------------------------------------------------------------------
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { store } from '../storage/store.js';

export const PLATAFORMAS = ['tiktok', 'instagram', 'facebook'];
export const ESTADOS = ['queued', 'running', 'published', 'failed', 'cancelled'];
export const TOPE_DURO_POR_VENTANA = 2;
export const VENTANA_MS = 60 * 60 * 1000;

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const MAX_JOBS_MEMORIA = 1000;
const MAX_HISTORIAL = 500;

const num = (valor, porDefecto) => {
  const n = Number(valor);
  return valor !== undefined && valor !== '' && Number.isFinite(n) ? n : porDefecto;
};

/** Config por defecto desde variables de entorno (PROG_*). Siempre pasa por normalizar(). */
export function leerConfigProgramador(env = process.env) {
  return normalizar({
    cicloMs: num(env.PROG_CICLO_SEG, 30) * 1000,
    maxPorVentana: num(env.PROG_MAX_POR_HORA, TOPE_DURO_POR_VENTANA),
    enviosDiaMin: num(env.PROG_ENVIOS_DIA_MIN, 1),
    enviosDiaMax: num(env.PROG_ENVIOS_DIA_MAX, 3),
    probDiaInactivo: num(env.PROG_PROB_DIA_INACTIVO, 0.12),
    maxDiasInactivosSemana: num(env.PROG_MAX_DIAS_INACTIVOS_SEMANA, 2),
    horaDesde: num(env.PROG_HORA_DESDE, 8),
    horaHasta: num(env.PROG_HORA_HASTA, 23),
    utcOffsetHoras: num(env.PROG_UTC_OFFSET, -4), // Republica Dominicana: UTC-4 todo el ano
    arranqueMaxMs: num(env.PROG_ARRANQUE_MAX_MIN, 90) * MIN,
    gapMinMs: num(env.PROG_GAP_MIN_MIN, 15) * MIN,
    gapMaxMs: num(env.PROG_GAP_MAX_MIN, 50) * MIN,
    probPausaLarga: num(env.PROG_PROB_PAUSA_LARGA, 0.2),
    pausaLargaMinMs: num(env.PROG_PAUSA_LARGA_MIN_MIN, 45) * MIN,
    pausaLargaMaxMs: num(env.PROG_PAUSA_LARGA_MAX_MIN, 150) * MIN,
    maxIntentos: num(env.PROG_MAX_INTENTOS, 4),
    backoffBaseMs: num(env.PROG_BACKOFF_BASE_SEG, 120) * 1000,
    backoffMaxMs: num(env.PROG_BACKOFF_MAX_MIN, 60) * MIN,
    timeoutMs: num(env.PROG_TIMEOUT_PUBLICACION_MIN, 10) * MIN,
  });
}

/** Sanea la config: el tope de 2/hora NUNCA se puede superar, y los rangos quedan coherentes. */
export function normalizar(c) {
  const r = { ...c };
  r.cicloMs = Math.max(1, Math.round(r.cicloMs));
  r.maxPorVentana = Math.min(TOPE_DURO_POR_VENTANA, Math.max(1, Math.floor(r.maxPorVentana)));
  r.enviosDiaMin = Math.max(1, Math.floor(r.enviosDiaMin));
  r.enviosDiaMax = Math.max(r.enviosDiaMin, Math.floor(r.enviosDiaMax));
  r.probDiaInactivo = Math.min(1, Math.max(0, r.probDiaInactivo));
  r.maxDiasInactivosSemana = Math.min(6, Math.max(0, Math.floor(r.maxDiasInactivosSemana)));
  r.horaDesde = Math.min(23, Math.max(0, r.horaDesde));
  r.horaHasta = Math.min(24, Math.max(r.horaDesde + 1, r.horaHasta));
  r.arranqueMaxMs = Math.max(0, r.arranqueMaxMs);
  r.gapMinMs = Math.max(0, r.gapMinMs);
  r.gapMaxMs = Math.max(r.gapMinMs, r.gapMaxMs);
  r.probPausaLarga = Math.min(1, Math.max(0, r.probPausaLarga));
  r.pausaLargaMinMs = Math.max(0, r.pausaLargaMinMs);
  r.pausaLargaMaxMs = Math.max(r.pausaLargaMinMs, r.pausaLargaMaxMs);
  r.maxIntentos = Math.max(1, Math.floor(r.maxIntentos));
  r.backoffBaseMs = Math.max(0, r.backoffBaseMs);
  r.backoffMaxMs = Math.max(r.backoffBaseMs, r.backoffMaxMs);
  r.timeoutMs = Math.max(1000, r.timeoutMs);
  return Object.freeze(r);
}

const iso = (ms) => new Date(ms).toISOString();
const nuevoId = () => 'prog_' + crypto.randomBytes(4).toString('hex');
const copia = (o) => JSON.parse(JSON.stringify(o));

function errorCodigo(codigo, mensaje) {
  return Object.assign(new Error(mensaje), { codigo });
}

function conTiempoLimite(promesa, ms) {
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    // Sin unref: mientras una publicacion esta en curso el proceso NO debe darse por ocioso; se limpia en finally.
    temporizador = setTimeout(() => rechazar(errorCodigo('TIMEOUT', 'Tiempo de publicacion agotado')), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

// ----------------------------- persistencia ---------------------------------

function datosVacios() {
  return { jobs: [], historial: [], estado: estadoVacio() };
}

function estadoVacio() {
  return { ejecuciones: [], proximaEjecucionMin: 0, planes: {}, semanas: {}, actualizadoEn: null };
}

/** Respaldo local: un solo JSON, escritura atomica (temporal + rename), encadenada para que no se pisen. */
function crearAlmacenJson(ruta, obtenerDatos) {
  let cadena = Promise.resolve();
  const volcar = () => {
    cadena = cadena
      .then(async () => {
        await fs.mkdir(path.dirname(ruta), { recursive: true });
        const temporal = ruta + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
        const d = obtenerDatos();
        await fs.writeFile(temporal, JSON.stringify({ version: 1, ...d, actualizado: new Date().toISOString() }));
        await fs.rename(temporal, ruta);
      })
      .catch((error) => logger.error('No se pudo escribir el JSON del programador', { ruta, mensaje: error.message }));
    return cadena;
  };
  return {
    tipo: 'json',
    ruta,
    async cargar() {
      let texto;
      try {
        texto = await fs.readFile(ruta, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return datosVacios();
        throw error;
      }
      try {
        const d = JSON.parse(texto);
        return {
          jobs: Array.isArray(d.jobs) ? d.jobs : [],
          historial: Array.isArray(d.historial) ? d.historial : [],
          estado: { ...estadoVacio(), ...(d.estado || {}) },
        };
      } catch {
        // Archivo corrupto: se aparta (no se pierde) y se empieza limpio.
        await fs.rename(ruta, ruta + '.corrupto-' + Date.now()).catch(() => {});
        logger.warn('programador.json ilegible: se aparto y se empieza limpio', { ruta });
        return datosVacios();
      }
    },
    guardarJob: volcar,
    guardarEstado: volcar,
    agregarHistorial: volcar,
    volcarTodo: volcar,
    async cerrar() {
      await cadena;
    },
  };
}

const sinId = ({ _id, ...resto }) => resto;

/** Mongo: cola, historial y estado en tres colecciones. `cargarModulo` es inyectable (pruebas). */
async function crearAlmacenMongo({ uri, cargarModulo, nombreBd }) {
  const modulo = await cargarModulo();
  const MongoClient = modulo.MongoClient || (modulo.default && modulo.default.MongoClient);
  if (!MongoClient) throw new Error('El modulo mongodb no exporta MongoClient');
  const cliente = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
  await cliente.connect();
  try {
    const bd = nombreBd ? cliente.db(nombreBd) : cliente.db();
    await bd.command({ ping: 1 });
    const jobs = bd.collection('cliplab_cola');
    const historial = bd.collection('cliplab_historial');
    const estado = bd.collection('cliplab_programador');
    await Promise.resolve(jobs.createIndex({ status: 1, scheduledAt: 1 })).catch(() => {});
    await Promise.resolve(historial.createIndex({ jobId: 1 })).catch(() => {});
    return {
      tipo: 'mongo',
      async cargar() {
        const activos = await jobs.find({ status: { $in: ['queued', 'running'] } }).toArray();
        const cerrados = await jobs
          .find({ status: { $in: ['published', 'failed', 'cancelled'] } })
          .sort({ creadoEn: -1 })
          .limit(500)
          .toArray();
        const hist = await historial.find({}).sort({ inicio: -1 }).limit(MAX_HISTORIAL).toArray();
        const est = await estado.findOne({ _id: 'estado' });
        return {
          jobs: [...activos, ...cerrados].map(sinId),
          historial: hist.map(sinId),
          estado: { ...estadoVacio(), ...(est ? sinId(est) : {}) },
        };
      },
      guardarJob: (job) => jobs.replaceOne({ _id: job.id }, { ...job, _id: job.id }, { upsert: true }),
      guardarEstado: (e) => estado.replaceOne({ _id: 'estado' }, { ...e, _id: 'estado' }, { upsert: true }),
      agregarHistorial: (h) => historial.insertOne({ ...h, _id: h.id }),
      volcarTodo: async () => {},
      cerrar: () => cliente.close(),
    };
  } catch (error) {
    await Promise.resolve(cliente.close()).catch(() => {});
    throw error;
  }
}

// ------------------------------- programador --------------------------------

/**
 * @param {object} [o]
 * @param {object} [o.config]        sobrescribe campos de leerConfigProgramador() (siempre se normaliza)
 * @param {() => number} [o.ahora]   reloj en ms (Date.now por defecto)
 * @param {() => number} [o.azar]    fuente de azar en [0,1) (Math.random por defecto)
 * @param {(spec) => Promise<object>} [o.publicar]  publica un clip; por defecto publicador.publicarClip
 * @param {string} [o.rutaJson]      ruta del JSON de respaldo
 * @param {string|null} [o.mongoUri] por defecto process.env.MONGODB_URI
 * @param {() => Promise<object>} [o.cargarMongo]   por defecto import('mongodb')
 */
export function crearProgramador(o = {}) {
  const cfg = normalizar({ ...leerConfigProgramador(), ...(o.config || {}) });
  const ahora = o.ahora || Date.now;
  const azar = o.azar || Math.random;
  const rutaJson = o.rutaJson || path.join(config.dataDir, 'programador.json');
  const mongoUri = o.mongoUri !== undefined ? o.mongoUri : process.env.MONGODB_URI || '';
  const cargarMongo = o.cargarMongo || (() => import('mongodb'));
  const publicarPorDefecto = async (spec) => (await import('./publicador.js')).publicarClip(spec);
  const publicar = o.publicar || publicarPorDefecto;

  let datos = datosVacios();
  let almacen = null;
  let respaldoJson = null;
  let cargada = null;
  let temporizador = null;
  let ocupado = false;
  let ejecucionActual = Promise.resolve();
  let detenido = true;

  // ---- persistencia con degradacion automatica a JSON ----
  const jsonDe = () => (respaldoJson ||= crearAlmacenJson(rutaJson, () => datos));

  async function persistir(operacion, ...args) {
    try {
      await almacen[operacion](...args);
    } catch (error) {
      if (almacen.tipo !== 'mongo') throw error;
      logger.warn('Fallo MongoDB en el programador: se pasa al respaldo JSON local', { operacion, mensaje: error.message });
      const roto = almacen;
      almacen = jsonDe();
      Promise.resolve(roto.cerrar()).catch(() => {});
      await almacen.volcarTodo();
    }
  }
  const guardarJob = (job) => persistir('guardarJob', job);
  const guardarEstado = async () => {
    datos.estado.actualizadoEn = iso(ahora());
    await persistir('guardarEstado', datos.estado);
  };

  async function abrirAlmacen() {
    if (mongoUri) {
      try {
        const m = await crearAlmacenMongo({ uri: mongoUri, cargarModulo: cargarMongo, nombreBd: process.env.MONGODB_DB });
        logger.info('Programador: persistencia en MongoDB');
        return m;
      } catch (error) {
        logger.warn('Programador: MongoDB no disponible, se usa el respaldo JSON local', { mensaje: error.message, ruta: rutaJson });
      }
    } else {
      logger.info('Programador: sin MONGODB_URI, se usa el respaldo JSON local', { ruta: rutaJson });
    }
    return jsonDe();
  }

  async function inicializar() {
    almacen = await abrirAlmacen();
    try {
      datos = await almacen.cargar();
    } catch (error) {
      if (almacen.tipo !== 'mongo') throw error;
      logger.warn('Programador: no se pudo leer MongoDB, se usa el respaldo JSON local', { mensaje: error.message });
      almacen = jsonDe();
      datos = await almacen.cargar();
    }
    // Un trabajo 'running' al arrancar = el proceso murio a mitad de publicar. NO se reintenta solo: podria duplicar el post.
    const marca = iso(ahora());
    for (const job of datos.jobs) {
      if (job.status === 'running') {
        job.status = 'failed';
        job.lastError = 'Interrumpido durante la publicacion (reinicio del proceso). Revisa las redes y usa reintentar().';
        job.actualizadoEn = marca;
        await guardarJob(job);
      }
    }
    datos.estado.ejecuciones = (datos.estado.ejecuciones || []).filter((t) => t > ahora() - 48 * HORA);
  }

  // ---- fechas locales (la jornada se mide en hora local, p. ej. UTC-4) ----
  const desplazado = (ms) => new Date(ms + cfg.utcOffsetHoras * HORA);
  const fechaLocal = (ms) => desplazado(ms).toISOString().slice(0, 10);
  const horaLocal = (ms) => {
    const d = desplazado(ms);
    return d.getUTCHours() + d.getUTCMinutes() / 60;
  };
  const inicioDiaLocal = (ms) => {
    const d = desplazado(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - cfg.utcOffsetHoras * HORA;
  };
  const lunesDe = (ms) => {
    const d = desplazado(ms);
    const atras = (d.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - atras)).toISOString().slice(0, 10);
  };

  function podar(mapa, conservar) {
    const claves = Object.keys(mapa).sort();
    for (const k of claves.slice(0, Math.max(0, claves.length - conservar))) delete mapa[k];
  }

  /** Plan del dia (se decide una vez, queda guardado y sobrevive reinicios). */
  function planDe(ms) {
    const fecha = fechaLocal(ms);
    const existente = datos.estado.planes[fecha];
    if (existente) return { plan: existente, nuevo: false };

    const semana = lunesDe(ms);
    let sem = datos.estado.semanas[semana];
    if (!sem) {
      const k = Math.floor(azar() * (cfg.maxDiasInactivosSemana + 1));
      const dias = [0, 1, 2, 3, 4, 5, 6];
      for (let i = dias.length - 1; i > 0; i--) {
        const j = Math.floor(azar() * (i + 1));
        [dias[i], dias[j]] = [dias[j], dias[i]];
      }
      sem = { diasInactivos: dias.slice(0, k) };
      datos.estado.semanas[semana] = sem;
      podar(datos.estado.semanas, 6);
    }
    const inactivo = sem.diasInactivos.includes(desplazado(ms).getUTCDay()) || azar() < cfg.probDiaInactivo;
    const plan = {
      fecha,
      activo: !inactivo,
      objetivo: cfg.enviosDiaMin + Math.floor(azar() * (cfg.enviosDiaMax - cfg.enviosDiaMin + 1)),
      desde: Math.round(inicioDiaLocal(ms) + cfg.horaDesde * HORA + azar() * cfg.arranqueMaxMs),
    };
    datos.estado.planes[fecha] = plan;
    podar(datos.estado.planes, 14);
    return { plan, nuevo: true };
  }

  function siguienteEspera() {
    // Sesgo a esperas cortas con cola larga + pausa larga ocasional + jitter de segundos: sin intervalos repetitivos.
    let espera = cfg.gapMinMs + (cfg.gapMaxMs - cfg.gapMinMs) * Math.pow(azar(), 1.3);
    if (azar() < cfg.probPausaLarga) espera += cfg.pausaLargaMinMs + (cfg.pausaLargaMaxMs - cfg.pausaLargaMinMs) * azar();
    espera += Math.floor(azar() * 45000);
    return Math.round(espera);
  }

  function backoff(intentos) {
    const base = Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * Math.pow(2, Math.max(0, intentos - 1)));
    return Math.round(base * (0.75 + azar() * 0.5));
  }

  const ejecucionesEnVentana = (ms) => datos.estado.ejecuciones.filter((t) => t >= ms - VENTANA_MS && t <= ms).length;
  const ejecucionesDelDia = (ms) => datos.estado.ejecuciones.filter((t) => fechaLocal(t) === fechaLocal(ms)).length;

  /** Decide si toca ejecutar algo ahora. No modifica trabajos; solo puede crear/guardar el plan del dia. */
  function evaluar(ms) {
    // 1) Tope duro por hora (siempre primero).
    if (ejecucionesEnVentana(ms) >= cfg.maxPorVentana) return { ok: false, motivo: 'cupo-horario' };
    // 2) Plan diario/semanal y horario.
    const { plan, nuevo } = planDe(ms);
    const sucio = nuevo;
    if (!plan.activo) return { ok: false, motivo: 'dia-inactivo', sucio };
    const hora = horaLocal(ms);
    if (hora < cfg.horaDesde || hora >= cfg.horaHasta) return { ok: false, motivo: 'fuera-de-horario', sucio };
    if (ms < plan.desde) return { ok: false, motivo: 'fuera-de-horario', sucio };
    if (ejecucionesDelDia(ms) >= plan.objetivo) return { ok: false, motivo: 'cupo-diario', sucio };
    // 3) Cadencia irregular entre ejecuciones.
    if (ms < datos.estado.proximaEjecucionMin) return { ok: false, motivo: 'espera-cadencia', sucio };
    // 4) Trabajo vencido mas antiguo.
    const job = datos.jobs
      .filter((j) => j.status === 'queued' && Date.parse(j.scheduledAt) <= ms)
      .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0];
    if (!job) return { ok: false, motivo: 'sin-pendientes', sucio };
    return { ok: true, job, sucio };
  }

  async function ejecutar(job, inicio) {
    const pendientes = job.platforms.filter((p) => !(job.resultados[p] && job.resultados[p].ok));
    job.status = 'running';
    job.attempts += 1;
    job.iniciadoEn = iso(inicio);
    job.actualizadoEn = iso(inicio);
    // La ejecucion cuenta contra el tope desde el INICIO (aunque el proceso muera a mitad, no hay rafaga al reiniciar).
    datos.estado.ejecuciones.push(inicio);
    datos.estado.ejecuciones = datos.estado.ejecuciones.filter((t) => t > inicio - 48 * HORA);
    datos.estado.proximaEjecucionMin = inicio + cfg.gapMinMs;
    await guardarJob(job);
    await guardarEstado();

    let respuesta;
    try {
      respuesta = await conTiempoLimite(
        Promise.resolve(publicar({ jobId: job.id, clipId: job.clipId, intento: job.attempts, rutaVideo: job.rutaVideo, descripcion: job.descripcion, etiquetas: job.etiquetas, plataformas: pendientes })),
        cfg.timeoutMs
      );
    } catch (error) {
      const marca = iso(ahora());
      respuesta = {
        resultados: Object.fromEntries(
          pendientes.map((p) => [p, { ok: false, error: error.message, detalle: error.codigo || error.name, timestamp: marca, transitorio: true }])
        ),
      };
    }

    const fin = ahora();
    const marcaFin = iso(fin);
    for (const p of pendientes) {
      const r = respuesta && respuesta.resultados && respuesta.resultados[p];
      job.resultados[p] = {
        ...(r || { ok: false, error: 'El publicador no devolvio resultado para ' + p, detalle: '', timestamp: marcaFin, transitorio: true }),
        intento: job.attempts,
      };
    }
    const fallidas = job.platforms.filter((p) => !(job.resultados[p] && job.resultados[p].ok));
    job.actualizadoEn = marcaFin;
    if (fallidas.length === 0) {
      job.status = 'published';
      job.publicadoEn = marcaFin;
      job.lastError = null;
    } else {
      job.lastError = fallidas.map((p) => p + ': ' + (job.resultados[p].error || 'error')).join('; ');
      const hayTransitorio = fallidas.some((p) => job.resultados[p].transitorio !== false);
      if (hayTransitorio && job.attempts < cfg.maxIntentos) {
        job.status = 'queued';
        job.scheduledAt = iso(fin + backoff(job.attempts));
      } else {
        job.status = 'failed';
      }
    }

    const entrada = {
      id: 'hist_' + crypto.randomBytes(4).toString('hex'),
      jobId: job.id,
      clipId: job.clipId,
      intento: job.attempts,
      inicio: iso(inicio),
      fin: marcaFin,
      plataformas: pendientes,
      resultados: copia(Object.fromEntries(pendientes.map((p) => [p, job.resultados[p]]))),
      estadoFinal: job.status,
    };
    datos.historial.unshift(entrada);
    datos.historial.length = Math.min(datos.historial.length, MAX_HISTORIAL);
    datos.estado.proximaEjecucionMin = fin + siguienteEspera();
    await guardarJob(job);
    await persistir('agregarHistorial', entrada);
    await guardarEstado();
    return { ejecutado: true, jobId: job.id, status: job.status, resultados: copia(job.resultados) };
  }

  /** Un ciclo: evalua y, si toca, publica UN clip. Estrictamente secuencial (nunca dos a la vez). */
  async function tick() {
    if (!cargada) return { ejecutado: false, motivo: 'no-iniciado' };
    if (ocupado) return { ejecutado: false, motivo: 'ocupado' };
    ocupado = true; // sincrono, antes de cualquier await: dos tick() simultaneos no pueden entrar los dos
    const ciclo = (async () => {
      try {
        await cargada;
        const ms = ahora();
        const decision = evaluar(ms);
        if (decision.sucio) await guardarEstado();
        if (!decision.ok) return { ejecutado: false, motivo: decision.motivo };
        return await ejecutar(decision.job, ms);
      } finally {
        ocupado = false;
      }
    })();
    ejecucionActual = ciclo.catch(() => {});
    return ciclo;
  }

  // ---- API publica ----
  function resolverClip(spec) {
    let { rutaVideo, descripcion, etiquetas } = spec;
    if (spec.clipId && !rutaVideo) {
      const clip = store.buscar(spec.clipId);
      if (!clip) throw errorCodigo('CLIP_NO_ENCONTRADO', 'No existe el clip ' + spec.clipId);
      if (clip.estado !== 'listo' || !clip.url) throw errorCodigo('CLIP_NO_LISTO', 'El clip ' + spec.clipId + ' aun no esta listo');
      rutaVideo = path.join(config.clipsDir, path.basename(clip.url));
      if (descripcion === undefined) descripcion = clip.copy || '';
      if (etiquetas === undefined) etiquetas = (clip.marketing && clip.marketing.hashtags) || [];
    }
    if (!rutaVideo || typeof rutaVideo !== 'string') throw errorCodigo('SIN_VIDEO', 'Indica clipId o rutaVideo');
    return { rutaVideo, descripcion: String(descripcion || ''), etiquetas: Array.isArray(etiquetas) ? etiquetas.map(String) : [] };
  }

  async function encolar(spec = {}) {
    await cargada;
    const plataformas = [...new Set((Array.isArray(spec.platforms) ? spec.platforms : []).map((p) => String(p).toLowerCase()))];
    if (plataformas.length === 0) throw errorCodigo('SIN_PLATAFORMAS', 'Indica al menos una plataforma: ' + PLATAFORMAS.join(', '));
    const invalida = plataformas.find((p) => !PLATAFORMAS.includes(p));
    if (invalida) throw errorCodigo('PLATAFORMA_INVALIDA', 'Plataforma no soportada: ' + invalida);
    let programadoMs = ahora();
    if (spec.scheduledAt !== undefined) {
      programadoMs = Date.parse(spec.scheduledAt);
      if (!Number.isFinite(programadoMs)) throw errorCodigo('FECHA_INVALIDA', 'scheduledAt debe ser una fecha ISO valida');
    }
    const clip = resolverClip(spec);
    if (spec.clipId && datos.jobs.some((j) => j.clipId === spec.clipId && (j.status === 'queued' || j.status === 'running'))) {
      throw errorCodigo('DUPLICADO', 'El clip ' + spec.clipId + ' ya esta en la cola');
    }
    const marca = iso(ahora());
    const job = {
      id: nuevoId(),
      clipId: spec.clipId || null,
      ...clip,
      scheduledAt: iso(programadoMs),
      platforms: plataformas,
      status: 'queued',
      attempts: 0,
      lastError: null,
      resultados: {},
      creadoEn: marca,
      actualizadoEn: marca,
      publicadoEn: null,
    };
    datos.jobs.unshift(job);
    // Memoria acotada: solo se descartan trabajos ya cerrados y antiguos.
    while (datos.jobs.length > MAX_JOBS_MEMORIA) {
      const i = datos.jobs.map((j) => j.status).lastIndexOf('published');
      const k = i >= 0 ? i : datos.jobs.map((j) => j.status).findLastIndex((s) => s === 'failed' || s === 'cancelled');
      if (k < 0) break;
      datos.jobs.splice(k, 1);
    }
    await guardarJob(job);
    return copia(job);
  }

  async function cancelar(id) {
    await cargada;
    const job = datos.jobs.find((j) => j.id === id);
    if (!job) throw errorCodigo('NO_ENCONTRADO', 'No existe el trabajo ' + id);
    if (job.status === 'running') throw errorCodigo('EN_CURSO', 'El trabajo esta publicando ahora mismo; no se puede cancelar');
    if (job.status !== 'queued') throw errorCodigo('NO_CANCELABLE', 'Solo se cancelan trabajos en cola (estado: ' + job.status + ')');
    job.status = 'cancelled';
    job.actualizadoEn = iso(ahora());
    await guardarJob(job);
    return copia(job);
  }

  /** Vuelve a encolar un trabajo fallido/cancelado. Conserva las plataformas que ya salieron bien (no se duplican). */
  async function reintentar(id) {
    await cargada;
    const job = datos.jobs.find((j) => j.id === id);
    if (!job) throw errorCodigo('NO_ENCONTRADO', 'No existe el trabajo ' + id);
    if (job.status !== 'failed' && job.status !== 'cancelled') throw errorCodigo('NO_REINTENTABLE', 'Solo se reintenta un trabajo fallido o cancelado');
    job.status = 'queued';
    job.attempts = 0;
    job.scheduledAt = iso(ahora());
    job.actualizadoEn = iso(ahora());
    await guardarJob(job);
    return copia(job);
  }

  const obtener = (id) => {
    const job = datos.jobs.find((j) => j.id === id);
    return job ? copia(job) : null;
  };
  const listar = (filtro = {}) =>
    copia(datos.jobs.filter((j) => !filtro.status || j.status === filtro.status).sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt)));
  const historial = (limite = 50) => copia(datos.historial.slice(0, limite));

  function estadoActual() {
    const ms = ahora();
    const plan = datos.estado.planes[fechaLocal(ms)] || null;
    return {
      backend: almacen ? almacen.tipo : null,
      rutaJson: almacen && almacen.tipo === 'json' ? rutaJson : null,
      activo: !detenido,
      ocupado,
      cupoHorario: { usados: ejecucionesEnVentana(ms), maximo: cfg.maxPorVentana },
      hoy: plan ? { ...plan, ejecutados: ejecucionesDelDia(ms) } : null,
      proximaEjecucionMin: datos.estado.proximaEjecucionMin ? iso(datos.estado.proximaEjecucionMin) : null,
      enCola: datos.jobs.filter((j) => j.status === 'queued').length,
    };
  }

  async function iniciar() {
    if (!detenido) return;
    detenido = false;
    cargada ||= inicializar();
    await cargada;
    temporizador = setInterval(() => {
      tick().catch((error) => logger.error('Error en el ciclo del programador', error));
    }, cfg.cicloMs);
    if (temporizador.unref) temporizador.unref();
  }

  async function detener() {
    detenido = true;
    if (temporizador) clearInterval(temporizador);
    temporizador = null;
    await ejecucionActual;
    if (almacen) await Promise.resolve(almacen.cerrar()).catch(() => {});
  }

  /** Para pruebas y para usar el modulo sin ticker: carga el almacen sin arrancar el ciclo periodico. */
  async function cargar() {
    cargada ||= inicializar();
    await cargada;
  }

  return { iniciar, detener, cargar, tick, encolar, cancelar, reintentar, obtener, listar, historial, estado: estadoActual, config: cfg };
}

export const programador = crearProgramador();
CLIPLAB_EOF
cat > src/engine/publicador.js << 'CLIPLAB_EOF'
// ---------------------------------------------------------------------------
// Publicador: sube un clip ya renderizado a TikTok / Instagram / Facebook usando las cookies de sesion que guarda el
// modulo de conexiones (src/sesion/cookiesRedes.js). Devuelve un resultado ESTRUCTURADO por canal.
//
//   publicarClip({ rutaVideo, descripcion, etiquetas, plataformas }, opciones?)
//     -> { ok, modo, inicio, fin, resultados: { [red]: { ok, error, codigo, detalle, timestamp, transitorio } } }
//
//  - Un canal que falla no impide los demas; nunca lanza (todo error queda en su canal).
//  - Ritmo humano: la descripcion se teclea por bloques con esperas variables (mas largas tras espacios, signos y saltos
//    de linea, con pausas de "pensar" ocasionales) y hay pausas aleatorias entre cada accion (adjuntar, escribir, publicar).
//  - Navegador: Playwright (`playwright-core`, carga perezosa) o un driver inyectado. Sin el, el error es DRIVER_NO_DISPONIBLE
//    (no transitorio): nunca publica "a medias" ni finge un exito. Modo 'seco' (PUBLICADOR_MODO=seco) recorre el flujo sin red.
//  - Los selectores de cada red viven en SELECTORES y se pueden ajustar sin tocar codigo con PUBLICADOR_SELECTORES (JSON).
//    OJO: las webs cambian; los selectores por defecto son un punto de partida y deben validarse contra la UI real.
// ---------------------------------------------------------------------------
import fs from 'node:fs/promises';
import { logger } from '../utils/logger.js';

export const REDES_SOPORTADAS = ['tiktok', 'instagram', 'facebook'];

export class ErrorPublicador extends Error {
  constructor(codigo, mensaje, transitorio = true) {
    super(mensaje);
    this.name = 'ErrorPublicador';
    this.codigo = codigo;
    this.transitorio = transitorio;
  }
}

// ------------------------------ ritmo humano --------------------------------

const PAUSA_DEFECTO = [600, 2400];

/**
 * @param {object} [o]
 * @param {() => number} [o.azar]
 * @param {(ms:number) => Promise<void>} [o.dormir]
 */
export function crearRitmoHumano({ azar = Math.random, dormir = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const entre = (min, max) => Math.round(min + azar() * (max - min));

  /** Plan de tecleo: bloques de 1-5 caracteres con su espera. Unir los `texto` devuelve exactamente la entrada. */
  function planearTecleo(texto) {
    const t = Array.from(String(texto ?? '')); // por codigo de punto: un emoji nunca se parte en dos bloques
    const partes = [];
    let i = 0;
    let palabras = 0;
    let siguientePensar = entre(6, 14);
    while (i < t.length) {
      const tam = azar() < 0.35 ? 1 : entre(2, 5);
      const bloque = t.slice(i, i + tam).join('');
      i += tam;
      let espera = Array.from(bloque).length * entre(45, 170);
      const ultimo = Array.from(bloque).pop();
      if (ultimo === ' ') {
        espera += entre(60, 220);
        palabras += 1;
        if (palabras >= siguientePensar) {
          espera += entre(500, 1400); // pausa de "pensar"
          palabras = 0;
          siguientePensar = entre(6, 14);
        }
      } else if (/[.,;:!?]/.test(ultimo)) espera += entre(150, 500);
      else if (ultimo === '\n') espera += entre(250, 700);
      partes.push({ texto: bloque, espera });
    }
    return partes;
  }

  return {
    entre,
    planearTecleo,
    pausa: async (min = PAUSA_DEFECTO[0], max = PAUSA_DEFECTO[1]) => {
      const ms = entre(min, max);
      await dormir(ms);
      return ms;
    },
    /** Teclea `texto` llamando a `teclear(bloque)` con esperas variables entre bloques. */
    escribir: async (texto, teclear) => {
      const partes = planearTecleo(texto);
      for (const parte of partes) {
        await teclear(parte.texto);
        await dormir(parte.espera);
      }
      return partes.length;
    },
    dormir,
  };
}

/** Descripcion final: texto + etiquetas que aun no estan dentro del texto (limpias, sin repetir, con tope de longitud). */
export function armarTexto(descripcion, etiquetas, { maxCaracteres = 2200, maxEtiquetas = 15 } = {}) {
  const base = String(descripcion || '').trim();
  const presentes = new Set((base.match(/#[\p{L}\p{N}_]+/gu) || []).map((h) => h.toLowerCase()));
  const nuevas = [];
  for (const crudo of Array.isArray(etiquetas) ? etiquetas : []) {
    const limpia = String(crudo).replace(/[^\p{L}\p{N}_]/gu, '');
    if (!limpia) continue;
    const etiqueta = '#' + limpia;
    if (presentes.has(etiqueta.toLowerCase())) continue;
    presentes.add(etiqueta.toLowerCase());
    nuevas.push(etiqueta);
  }
  const extra = nuevas.slice(0, maxEtiquetas).join(' ');
  const texto = [base, extra].filter(Boolean).join('\n\n');
  return texto.length > maxCaracteres ? texto.slice(0, maxCaracteres).trimEnd() : texto;
}

// -------------------------------- selectores --------------------------------

export const SELECTORES = {
  tiktok: {
    url: 'https://www.tiktok.com/tiktokstudio/upload',
    archivo: ['input[type="file"]'],
    descripcion: ['div[contenteditable="true"].public-DraftEditor-content', 'div[contenteditable="true"]'],
    publicar: ['button[data-e2e="post_video_button"]:not([disabled]):not([aria-disabled="true"])'],
    exito: /tiktokstudio\/content|tiktokstudio\/manage|upload.*success/i,
  },
  instagram: {
    url: 'https://www.instagram.com/',
    crear: ['a:has(svg[aria-label="New post"])', 'a:has(svg[aria-label="Nueva publicación"])', 'a:has(svg[aria-label="Create"])', 'a:has(svg[aria-label="Crear"])'],
    archivo: ['input[type="file"]'],
    siguiente: ['div[role="button"]:has-text("Next")', 'div[role="button"]:has-text("Siguiente")'],
    descripcion: ['div[aria-label="Write a caption..."]', 'div[aria-label="Escribe una descripción..."]', 'div[role="textbox"][contenteditable="true"]'],
    publicar: ['div[role="button"]:has-text("Share")', 'div[role="button"]:has-text("Compartir")'],
    exito: ['text=/has been shared|se ha compartido/i'],
  },
  facebook: {
    url: 'https://www.facebook.com/reels/create',
    archivo: ['input[type="file"][accept*="video"]', 'input[type="file"]'],
    siguiente: ['div[aria-label="Next"][role="button"]', 'div[aria-label="Siguiente"][role="button"]'],
    descripcion: ['div[role="textbox"][contenteditable="true"]'],
    publicar: ['div[aria-label="Publish"][role="button"]', 'div[aria-label="Publicar"][role="button"]'],
    exito: ['text=/shared|compartid|published|publicad/i'],
  },
};

function selectoresEfectivos(env = process.env) {
  if (!env.PUBLICADOR_SELECTORES) return SELECTORES;
  try {
    const extra = JSON.parse(env.PUBLICADOR_SELECTORES);
    const fusion = {};
    for (const red of REDES_SOPORTADAS) fusion[red] = { ...SELECTORES[red], ...((extra && extra[red]) || {}) };
    return fusion;
  } catch (error) {
    logger.warn('PUBLICADOR_SELECTORES no es JSON valido; se usan los selectores por defecto', { mensaje: error.message });
    return SELECTORES;
  }
}

/** Pasos de cada red. Cada paso es una accion simple del driver; el ritmo humano se aplica entre pasos. */
export function construirPasos(red, sel = SELECTORES) {
  const s = sel[red];
  if (!s) throw new ErrorPublicador('RED_NO_SOPORTADA', 'Red no soportada: ' + red, false);
  if (red === 'tiktok') {
    return [
      { accion: 'ir', url: s.url },
      { accion: 'adjuntar', sel: s.archivo },
      { accion: 'esperar', sel: s.descripcion, subida: true },
      { accion: 'revisar', pausa: [1500, 4500] },
      { accion: 'escribir', sel: s.descripcion, limpiar: true },
      { accion: 'esperar', sel: s.publicar, subida: true },
      { accion: 'revisar', pausa: [1200, 3500] },
      { accion: 'clic', sel: s.publicar },
      { accion: 'esperarUrl', patron: s.exito, subida: true },
    ];
  }
  if (red === 'instagram') {
    return [
      { accion: 'ir', url: s.url },
      { accion: 'clic', sel: s.crear },
      { accion: 'adjuntar', sel: s.archivo },
      { accion: 'esperar', sel: s.siguiente, subida: true },
      { accion: 'clic', sel: s.siguiente },
      { accion: 'esperar', sel: s.siguiente },
      { accion: 'clic', sel: s.siguiente },
      { accion: 'esperar', sel: s.descripcion },
      { accion: 'escribir', sel: s.descripcion },
      { accion: 'revisar', pausa: [1200, 3500] },
      { accion: 'clic', sel: s.publicar },
      { accion: 'esperar', sel: s.exito, subida: true },
    ];
  }
  return [
    { accion: 'ir', url: s.url },
    { accion: 'adjuntar', sel: s.archivo },
    { accion: 'esperar', sel: s.siguiente, subida: true },
    { accion: 'clic', sel: s.siguiente },
    { accion: 'esperar', sel: s.siguiente },
    { accion: 'clic', sel: s.siguiente },
    { accion: 'esperar', sel: s.descripcion },
    { accion: 'escribir', sel: s.descripcion },
    { accion: 'revisar', pausa: [1200, 3500] },
    { accion: 'clic', sel: s.publicar },
    { accion: 'esperar', sel: s.exito, subida: true },
  ];
}

async function correrPasos(pasos, { sesion, humano, texto, rutaVideo, timeouts }) {
  let hechos = 0;
  for (const paso of pasos) {
    if (hechos > 0) await humano.pausa(...(paso.pausa || PAUSA_DEFECTO));
    const ms = paso.subida ? timeouts.subidaMs : timeouts.pasoMs;
    switch (paso.accion) {
      case 'ir':
        await sesion.ir(paso.url);
        break;
      case 'adjuntar':
        await sesion.adjuntar(paso.sel, rutaVideo);
        break;
      case 'esperar':
        await sesion.esperar(paso.sel, ms);
        break;
      case 'esperarUrl':
        await sesion.esperarUrl(paso.patron, ms);
        break;
      case 'clic':
        await sesion.clic(paso.sel);
        break;
      case 'escribir':
        await sesion.enfocar(paso.sel);
        await humano.pausa(300, 1100);
        if (paso.limpiar) {
          await sesion.tecla('Control+A');
          await humano.pausa(150, 500);
          await sesion.tecla('Backspace');
          await humano.pausa(300, 900);
        }
        await humano.escribir(texto, (bloque) => sesion.teclear(bloque));
        break;
      case 'revisar':
        break; // solo la pausa previa: simula mirar la pantalla
      default:
        throw new ErrorPublicador('PASO_DESCONOCIDO', 'Paso desconocido: ' + paso.accion, false);
    }
    hechos += 1;
  }
  return hechos;
}

// -------------------------------- drivers -----------------------------------

/** Driver de ensayo: no abre nada ni toca la red; anota cada accion en `registro`. */
export function crearDriverSeco({ registro = [] } = {}) {
  const anotar = (accion, datos) => {
    registro.push({ accion, ...datos });
    logger.debug('Publicador (seco)', { accion, ...datos });
  };
  return {
    tipo: 'seco',
    registro,
    async abrir({ red, cookies }) {
      anotar('abrir', { red, cookies: Array.isArray(cookies) ? cookies.length : 0 });
      return {
        ir: async (url) => anotar('ir', { url }),
        adjuntar: async (sel, ruta) => anotar('adjuntar', { sel, ruta }),
        esperar: async (sel, ms) => anotar('esperar', { sel, ms }),
        esperarUrl: async (patron, ms) => anotar('esperarUrl', { patron: String(patron), ms }),
        clic: async (sel) => anotar('clic', { sel }),
        enfocar: async (sel) => anotar('enfocar', { sel }),
        tecla: async (combo) => anotar('tecla', { combo }),
        teclear: async (texto) => anotar('teclear', { texto }),
        cerrar: async () => anotar('cerrar', {}),
      };
    },
    async cerrar() {},
  };
}

/** Driver real con playwright-core (carga perezosa). Un navegador por llamada a publicarClip. */
export async function crearDriverPlaywright({ azar = Math.random, importar = () => import('playwright-core') } = {}) {
  let modulo;
  try {
    modulo = await importar();
  } catch (error) {
    throw new ErrorPublicador('DRIVER_NO_DISPONIBLE', 'Falta el paquete playwright-core (npm i playwright-core) y un Chromium instalado: ' + error.message, false);
  }
  const chromium = modulo.chromium || (modulo.default && modulo.default.chromium);
  if (!chromium) throw new ErrorPublicador('DRIVER_NO_DISPONIBLE', 'playwright-core no expone chromium', false);
  let navegador;
  try {
    navegador = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox'],
    });
  } catch (error) {
    throw new ErrorPublicador('DRIVER_NO_DISPONIBLE', 'No se pudo abrir Chromium (define CHROMIUM_PATH o instala el navegador): ' + error.message, false);
  }
  return {
    tipo: 'playwright',
    async abrir({ cookies }) {
      const contexto = await navegador.newContext({ viewport: { width: 1366, height: 768 }, locale: 'es-DO', timezoneId: 'America/Santo_Domingo' });
      await contexto.addCookies(cookies);
      const pagina = await contexto.newPage();
      const lista = (sel) => (Array.isArray(sel) ? sel.join(', ') : sel);
      const loc = (sel) => pagina.locator(lista(sel)).first();
      const clicHumano = async (sel) => {
        const el = loc(sel);
        await el.waitFor({ state: 'visible', timeout: 30000 });
        const caja = await el.boundingBox();
        if (!caja) return el.click({ timeout: 30000 });
        const x = caja.x + caja.width * (0.25 + 0.5 * azar());
        const y = caja.y + caja.height * (0.25 + 0.5 * azar());
        await pagina.mouse.move(x, y, { steps: 8 + Math.floor(azar() * 12) });
        await pagina.mouse.click(x, y);
      };
      return {
        ir: (url) => pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }),
        adjuntar: (sel, ruta) => loc(sel).setInputFiles(ruta),
        esperar: (sel, ms) => loc(sel).waitFor({ state: 'visible', timeout: ms }),
        esperarUrl: (patron, ms) => pagina.waitForURL(patron, { timeout: ms }),
        clic: clicHumano,
        enfocar: clicHumano,
        tecla: (combo) => pagina.keyboard.press(combo),
        teclear: (texto) => pagina.keyboard.type(texto),
        cerrar: () => contexto.close(),
      };
    },
    cerrar: () => navegador.close(),
  };
}

// ------------------------------ resultado por canal --------------------------

function clasificar(error) {
  if (error instanceof ErrorPublicador) return { codigo: error.codigo, transitorio: error.transitorio };
  const nombre = (error && error.name) || '';
  if (nombre === 'TimeoutError') return { codigo: 'TIMEOUT', transitorio: true };
  return { codigo: 'ERROR', transitorio: true };
}

const fallo = (error, reloj) => ({
  ok: false,
  error: error.message,
  ...clasificar(error),
  detalle: String((error && error.stack) || error.message).split('\n').slice(0, 3).join(' | ').slice(0, 500),
  timestamp: reloj(),
});

async function cookiesDe(red, { leerCookies, obligatorias }) {
  let cookies;
  try {
    cookies = await leerCookies(red);
  } catch (error) {
    throw new ErrorPublicador('SESION_ILEGIBLE', error.message, false);
  }
  if (!cookies || cookies.length === 0) {
    throw new ErrorPublicador('SIN_SESION', 'No hay sesion guardada de ' + red + '. Pega las cookies en la pestana Conexiones.', false);
  }
  const ahoraSeg = Date.now() / 1000;
  const vivas = new Set(cookies.filter((c) => c.expires === -1 || c.expires > ahoraSeg).map((c) => c.name));
  for (const grupo of obligatorias[red] || []) {
    if (!grupo.some((nombre) => vivas.has(nombre))) {
      throw new ErrorPublicador('SESION_EXPIRADA', 'La sesion de ' + red + ' vencio (' + grupo.join(' o ') + '). Vuelve a exportar las cookies.', false);
    }
  }
  return cookies;
}

// ---------------------------------- API ---------------------------------------

/**
 * Publica un clip en UNA red. Nunca lanza: devuelve el resultado del canal.
 * @param {string} red
 * @param {{rutaVideo:string, texto:string}} clip
 * @param {object} ctx  { driver, humano, leerCookies, obligatorias, selectores, timeouts, reloj }
 */
export async function publicarEnRed(red, clip, ctx) {
  let sesion = null;
  try {
    if (!REDES_SOPORTADAS.includes(red)) throw new ErrorPublicador('RED_NO_SOPORTADA', 'Red no soportada: ' + red, false);
    const cookies = await cookiesDe(red, ctx);
    const pasos = construirPasos(red, ctx.selectores);
    sesion = await ctx.driver.abrir({ red, cookies });
    const hechos = await correrPasos(pasos, { sesion, humano: ctx.humano, texto: clip.texto, rutaVideo: clip.rutaVideo, timeouts: ctx.timeouts });
    return {
      ok: true,
      error: null,
      codigo: 'OK',
      detalle: (ctx.driver.tipo === 'seco' ? 'SIMULACION: ' : '') + 'Publicado en ' + red + ' (' + hechos + ' pasos)',
      timestamp: ctx.reloj(),
      transitorio: false,
      simulado: ctx.driver.tipo === 'seco',
    };
  } catch (error) {
    return fallo(error, ctx.reloj);
  } finally {
    if (sesion) await Promise.resolve(sesion.cerrar()).catch(() => {});
  }
}

/**
 * Publica un clip en las plataformas indicadas, una tras otra (con pausa aleatoria entre redes).
 * @param {{rutaVideo:string, descripcion?:string, etiquetas?:string[], plataformas:string[]}} clip
 * @param {object} [o]  inyectables: driver, modo ('real'|'seco'), azar, dormir, leerCookies, obligatorias, selectores, timeouts, reloj, pausaEntreRedes
 */
export async function publicarClip(clip, o = {}) {
  const reloj = o.reloj || (() => new Date().toISOString());
  const inicio = reloj();
  const plataformas = [...new Set((clip.plataformas || []).map((p) => String(p).toLowerCase()))];
  const resultados = {};
  const modo = o.modo || process.env.PUBLICADOR_MODO || 'real';
  const humano = o.humano || crearRitmoHumano({ azar: o.azar, dormir: o.dormir });

  const cerrar = (extra = {}) => {
    const ok = plataformas.length > 0 && plataformas.every((p) => resultados[p] && resultados[p].ok);
    return { ok, modo, inicio, fin: reloj(), resultados, ...extra };
  };
  const marcarTodas = (error) => {
    for (const p of plataformas) resultados[p] = fallo(error, reloj);
    return cerrar();
  };

  if (plataformas.length === 0) return marcarTodas(new ErrorPublicador('SIN_PLATAFORMAS', 'No se indicaron plataformas', false));
  if (!clip.rutaVideo) return marcarTodas(new ErrorPublicador('SIN_VIDEO', 'Falta rutaVideo', false));
  try {
    await fs.access(clip.rutaVideo);
  } catch {
    return marcarTodas(new ErrorPublicador('ARCHIVO_NO_ENCONTRADO', 'No existe el video: ' + clip.rutaVideo, false));
  }

  let leerCookies = o.leerCookies;
  let obligatorias = o.obligatorias;
  if (!leerCookies || !obligatorias) {
    const modulo = await import('../sesion/cookiesRedes.js');
    leerCookies ||= modulo.leerCookies;
    obligatorias ||= Object.fromEntries(Object.entries(modulo.REDES).map(([red, def]) => [red, def.obligatorias]));
  }

  let driver = o.driver;
  let driverPropio = false;
  if (!driver) {
    try {
      driver = modo === 'seco' ? crearDriverSeco() : await crearDriverPlaywright({ azar: o.azar });
      driverPropio = true;
    } catch (error) {
      return marcarTodas(error);
    }
  }

  const ctx = {
    driver,
    humano,
    leerCookies,
    obligatorias,
    selectores: o.selectores || selectoresEfectivos(),
    timeouts: { pasoMs: 30000, subidaMs: 180000, ...(o.timeouts || {}) },
    reloj,
  };
  const material = { rutaVideo: clip.rutaVideo, texto: armarTexto(clip.descripcion, clip.etiquetas) };

  try {
    for (const [i, red] of plataformas.entries()) {
      if (i > 0) await humano.pausa(...(o.pausaEntreRedes || [8000, 30000]));
      resultados[red] = await publicarEnRed(red, material, ctx);
    }
  } finally {
    if (driverPropio) await Promise.resolve(driver.cerrar()).catch(() => {});
  }
  return cerrar();
}
CLIPLAB_EOF
cat > tests/programador.test.js << 'CLIPLAB_EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-prog-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.CLIPS_DIR = path.join(raiz, 'clips');
process.env.LOG_LEVEL = 'error';
delete process.env.MONGODB_URI;

const { crearProgramador, leerConfigProgramador, normalizar, VENTANA_MS, TOPE_DURO_POR_VENTANA } = await import('../src/engine/programador.js');
const { publicarClip, crearDriverSeco } = await import('../src/engine/publicador.js');
const { store } = await import('../src/storage/store.js');

const MIN = 60000;
const HORA = 3600000;
const LUNES_8AM_RD = Date.UTC(2026, 10, 16, 12, 0, 0); // lunes 16-nov-2026, 08:00 en UTC-4

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let n = 0;
const ruta = () => path.join(raiz, 'prog-' + ++n + '.json');
const okPublicador = (plataformas) => ({
  ok: true,
  resultados: Object.fromEntries(plataformas.map((p) => [p, { ok: true, error: null, detalle: 'ok', timestamp: new Date().toISOString(), transitorio: false }])),
});
const falla = (codigo, transitorio) => ({ ok: false, error: 'fallo ' + codigo, codigo, detalle: 'd', timestamp: new Date().toISOString(), transitorio });

/** Programador con reloj simulado y publicador falso que anota cada llamada. */
async function crear(extra = {}) {
  const reloj = { ms: extra.t0 ?? LUNES_8AM_RD };
  const llamadas = [];
  const publicar = extra.publicar || (async (spec) => {
    llamadas.push({ ms: reloj.ms, ...spec });
    return okPublicador(spec.plataformas);
  });
  const prog = crearProgramador({
    ahora: () => reloj.ms,
    azar: mulberry32(extra.seed ?? 1),
    publicar,
    rutaJson: extra.rutaJson || ruta(),
    mongoUri: extra.mongoUri ?? '',
    cargarMongo: extra.cargarMongo,
    config: extra.config || {},
  });
  await prog.cargar();
  return { prog, reloj, llamadas };
}

async function avanzar(prog, reloj, hasta, paso = MIN) {
  while (reloj.ms < hasta) {
    reloj.ms += paso;
    await prog.tick();
  }
}

const encolarN = async (prog, cantidad, plataformas = ['tiktok']) => {
  for (let i = 0; i < cantidad; i++) await prog.encolar({ rutaVideo: '/tmp/v' + i + '.mp4', descripcion: 'clip ' + i, platforms: plataformas });
};

function mongoFalso({ fallarConexion = false } = {}) {
  const colecciones = new Map();
  const estado = { fallarEscrituras: false };
  const col = (nombre) => {
    if (!colecciones.has(nombre)) colecciones.set(nombre, new Map());
    return colecciones.get(nombre);
  };
  const coincide = (doc, filtro) => Object.entries(filtro).every(([k, v]) => (v && v.$in ? v.$in.includes(doc[k]) : doc[k] === v));
  class Cursor {
    constructor(docs) { this.docs = docs; }
    sort(o) { const [k, d] = Object.entries(o)[0]; this.docs.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * d); return this; }
    limit(c) { this.docs = this.docs.slice(0, c); return this; }
    async toArray() { return structuredClone(this.docs); }
  }
  const coleccion = (nombre) => ({
    createIndex: async () => {},
    find: (f) => new Cursor([...col(nombre).values()].filter((d) => coincide(d, f))),
    findOne: async (f) => { const d = [...col(nombre).values()].find((x) => coincide(x, f)); return d ? structuredClone(d) : null; },
    replaceOne: async (f, doc) => { if (estado.fallarEscrituras) throw new Error('mongo caido'); col(nombre).set(f._id, structuredClone(doc)); },
    insertOne: async (doc) => { if (estado.fallarEscrituras) throw new Error('mongo caido'); col(nombre).set(doc._id, structuredClone(doc)); },
  });
  class MongoClient {
    constructor(uri) { this.uri = uri; }
    async connect() { if (fallarConexion) throw new Error('ECONNREFUSED 127.0.0.1:27017'); }
    db() { return { command: async () => ({ ok: 1 }), collection: coleccion }; }
    async close() {}
  }
  return { modulo: { MongoClient }, colecciones, estado };
}

// ------------------------------ configuracion --------------------------------

test('el tope de 2 ejecuciones por hora no se puede subir por configuracion', () => {
  assert.equal(TOPE_DURO_POR_VENTANA, 2);
  assert.equal(VENTANA_MS, HORA);
  assert.equal(leerConfigProgramador({ PROG_MAX_POR_HORA: '10' }).maxPorVentana, 2);
  assert.equal(leerConfigProgramador({}).maxPorVentana, 2);
  assert.equal(leerConfigProgramador({ PROG_MAX_POR_HORA: '1' }).maxPorVentana, 1);
  const c = normalizar({ ...leerConfigProgramador({}), maxPorVentana: 99, enviosDiaMin: 0, enviosDiaMax: -3, gapMinMs: 10, gapMaxMs: 5, horaDesde: 20, horaHasta: 3 });
  assert.equal(c.maxPorVentana, 2);
  assert.equal(c.enviosDiaMin, 1);
  assert.ok(c.enviosDiaMax >= c.enviosDiaMin);
  assert.ok(c.gapMaxMs >= c.gapMinMs);
  assert.ok(c.horaHasta > c.horaDesde);
});

// ------------------------------- persistencia --------------------------------

test('sin MONGODB_URI usa el respaldo JSON local y la cola sobrevive a un reinicio', async () => {
  const rutaJson = ruta();
  const a = await crear({ rutaJson, mongoUri: '' });
  assert.equal(a.prog.estado().backend, 'json');
  const job = await a.prog.encolar({ rutaVideo: '/tmp/a.mp4', descripcion: 'hola', etiquetas: ['x'], platforms: ['tiktok', 'instagram'] });
  assert.equal(job.status, 'queued');
  assert.equal(job.attempts, 0);
  assert.equal(job.lastError, null);
  assert.deepEqual(job.platforms, ['tiktok', 'instagram']);
  assert.ok(!Number.isNaN(Date.parse(job.scheduledAt)));
  const enDisco = JSON.parse(await fs.readFile(rutaJson, 'utf8'));
  assert.equal(enDisco.jobs.length, 1);
  assert.equal(enDisco.jobs[0].id, job.id);
  const b = await crear({ rutaJson });
  assert.equal(b.prog.obtener(job.id).descripcion, 'hola');
});

test('con MONGODB_URI pero sin el modulo mongodb instalado (caso real de este repo): respaldo JSON', async () => {
  const { prog } = await crear({ mongoUri: 'mongodb://127.0.0.1:27017/x' }); // cargarMongo por defecto = import('mongodb')
  assert.equal(prog.estado().backend, 'json');
  await encolarN(prog, 1);
  assert.equal(prog.listar().length, 1);
});

test('si la conexion a MongoDB falla: respaldo JSON automatico', async () => {
  const m = mongoFalso({ fallarConexion: true });
  const { prog } = await crear({ mongoUri: 'mongodb://x', cargarMongo: async () => m.modulo });
  assert.equal(prog.estado().backend, 'json');
  assert.equal(m.colecciones.size, 0);
});

test('con MongoDB disponible: cola, historial y estado van a sus colecciones y se recuperan en otra instancia', async () => {
  const m = mongoFalso();
  const cargarMongo = async () => m.modulo;
  const a = await crear({ mongoUri: 'mongodb://x', cargarMongo, config: { gapMinMs: 0, gapMaxMs: 0, probPausaLarga: 0, probDiaInactivo: 0, maxDiasInactivosSemana: 0, arranqueMaxMs: 0 } });
  assert.equal(a.prog.estado().backend, 'mongo');
  const job = await a.prog.encolar({ rutaVideo: '/tmp/m.mp4', platforms: ['facebook'] });
  await avanzar(a.prog, a.reloj, a.reloj.ms + 5 * MIN);
  assert.equal(a.prog.obtener(job.id).status, 'published');
  assert.equal(m.colecciones.get('cliplab_cola').get(job.id).status, 'published');
  assert.equal(m.colecciones.get('cliplab_historial').size, 1);
  assert.ok(m.colecciones.get('cliplab_programador').get('estado').ejecuciones.length === 1);
  const b = await crear({ mongoUri: 'mongodb://x', cargarMongo, t0: a.reloj.ms });
  assert.equal(b.prog.obtener(job.id).status, 'published');
  assert.equal(b.prog.historial().length, 1);
  assert.equal(b.prog.historial()[0].resultados.facebook.ok, true);
});

test('si MongoDB se cae a mitad de camino, pasa al JSON local sin perder la cola', async () => {
  const m = mongoFalso();
  const rutaJson = ruta();
  const { prog } = await crear({ rutaJson, mongoUri: 'mongodb://x', cargarMongo: async () => m.modulo });
  assert.equal(prog.estado().backend, 'mongo');
  await encolarN(prog, 1);
  m.estado.fallarEscrituras = true;
  await encolarN(prog, 1);
  assert.equal(prog.estado().backend, 'json');
  const disco = JSON.parse(await fs.readFile(rutaJson, 'utf8'));
  assert.equal(disco.jobs.length, 2);
});

test('un trabajo que quedo en running tras un reinicio NO se reintenta solo (evita duplicar el post)', async () => {
  const rutaJson = ruta();
  const { prog, reloj } = await crear({ rutaJson });
  const job = await prog.encolar({ rutaVideo: '/tmp/r.mp4', platforms: ['tiktok'] });
  const disco = JSON.parse(await fs.readFile(rutaJson, 'utf8'));
  disco.jobs[0].status = 'running';
  await fs.writeFile(rutaJson, JSON.stringify(disco));
  const otra = await crear({ rutaJson, t0: reloj.ms });
  const recuperado = otra.prog.obtener(job.id);
  assert.equal(recuperado.status, 'failed');
  assert.match(recuperado.lastError, /Interrumpido/);
  const re = await otra.prog.reintentar(job.id);
  assert.equal(re.status, 'queued');
});

// ----------------------------------- ritmo -----------------------------------

const CONFIG_SATURADO = { gapMinMs: 0, gapMaxMs: 0, probPausaLarga: 0, probDiaInactivo: 0, maxDiasInactivosSemana: 0, arranqueMaxMs: 0, enviosDiaMin: 50, enviosDiaMax: 50, maxPorVentana: 99 };

test('tope duro: nunca mas de 2 ejecuciones en 60 min, aunque la config lo permita y haya cola de sobra', async () => {
  const { prog, reloj, llamadas } = await crear({ config: CONFIG_SATURADO });
  assert.equal(prog.config.maxPorVentana, 2);
  await encolarN(prog, 30);
  await avanzar(prog, reloj, LUNES_8AM_RD + 6 * HORA);
  const t = llamadas.map((l) => l.ms);
  assert.ok(t.length >= 10, 'debe aprovechar el cupo: ' + t.length);
  assert.ok(t.length <= 12 + 2, 'no puede pasar de 2 por hora: ' + t.length);
  for (let i = 0; i + 2 < t.length; i++) assert.ok(t[i + 2] - t[i] > HORA, 'tres ejecuciones dentro de una hora en ' + i);
  assert.equal(prog.estado().cupoHorario.maximo, 2);
});

test('tope duro con 25 semillas y la config por defecto, 7 dias de cola abundante', async () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { prog, reloj, llamadas } = await crear({ seed });
    await encolarN(prog, 60, ['tiktok', 'instagram']);
    await avanzar(prog, reloj, LUNES_8AM_RD + 7 * 24 * HORA, 2 * MIN);
    const t = llamadas.map((l) => l.ms);
    for (let i = 0; i + 2 < t.length; i++) assert.ok(t[i + 2] - t[i] > HORA, 'semilla ' + seed + ': 3 ejecuciones en <=60 min');
  }
});

test('cadencia irregular: las esperas entre ejecuciones varian y respetan el minimo configurado', async () => {
  const gaps = [];
  for (const seed of [3, 11, 42]) {
    const { prog, reloj, llamadas } = await crear({ seed });
    await encolarN(prog, 80);
    await avanzar(prog, reloj, LUNES_8AM_RD + 21 * 24 * HORA, 30000);
    const t = llamadas.map((l) => l.ms);
    for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
  }
  assert.ok(gaps.length > 40);
  const minutos = gaps.map((g) => Math.round(g / 1000));
  assert.ok(gaps.every((g) => g >= 15 * MIN), 'nunca menos del gap minimo (15 min)');
  assert.ok(new Set(minutos).size > gaps.length * 0.8, 'casi todas las esperas distintas');
  const media = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const desv = Math.sqrt(gaps.reduce((a, b) => a + (b - media) ** 2, 0) / gaps.length);
  assert.ok(desv > 5 * MIN, 'desviacion tipica alta: ' + Math.round(desv / MIN) + ' min');
});

test('plan diario/semanal: 1 a 3 envios por dia activo, dias inactivos aleatorios, solo en horario', async () => {
  const { prog, reloj, llamadas } = await crear({ seed: 5 });
  await encolarN(prog, 200);
  await avanzar(prog, reloj, LUNES_8AM_RD + 28 * 24 * HORA, 60000);
  const porDia = {};
  for (const l of llamadas) {
    const local = new Date(l.ms - 4 * HORA);
    const dia = local.toISOString().slice(0, 10);
    porDia[dia] = (porDia[dia] || 0) + 1;
    const h = local.getUTCHours() + local.getUTCMinutes() / 60;
    assert.ok(h >= 8 && h < 23, 'fuera de horario: ' + h);
  }
  const conteos = Object.values(porDia);
  assert.ok(conteos.every((c) => c >= 1 && c <= 3), 'dias activos con 1..3 envios: ' + JSON.stringify(porDia));
  const diasConEnvio = Object.keys(porDia).length;
  assert.ok(diasConEnvio < 28, 'debe haber dias inactivos (hubo envios en ' + diasConEnvio + ' de 28)');
  assert.ok(diasConEnvio >= 14, 'pero no quedarse casi sin actividad: ' + diasConEnvio);
  assert.ok(new Set(conteos).size >= 2, 'el numero de envios por dia debe variar');
  const semanas = {};
  for (const dia of Object.keys(porDia)) {
    const d = new Date(dia + 'T00:00:00Z');
    const lunes = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 24 * HORA).toISOString().slice(0, 10);
    semanas[lunes] = (semanas[lunes] || 0) + porDia[dia];
  }
  assert.ok(new Set(Object.values(semanas)).size >= 2, 'el total semanal tambien varia');
});

test('el plan del dia queda guardado: reiniciar el proceso no regenera cupos ni permite una rafaga', async () => {
  const rutaJson = ruta();
  const a = await crear({ rutaJson, seed: 8, config: { ...CONFIG_SATURADO, enviosDiaMin: 2, enviosDiaMax: 2 } });
  await encolarN(a.prog, 10);
  await avanzar(a.prog, a.reloj, LUNES_8AM_RD + 3 * HORA);
  assert.equal(a.llamadas.length, 2);
  const b = await crear({ rutaJson, seed: 99, t0: a.reloj.ms, config: { ...CONFIG_SATURADO, enviosDiaMin: 2, enviosDiaMax: 2 }, publicar: async (s) => okPublicador(s.plataformas) });
  const ya = b.prog.estado();
  assert.equal(ya.hoy.ejecutados, 2);
  assert.equal(ya.cupoHorario.usados > 0 || ya.hoy.ejecutados === 2, true);
  const r = await b.prog.tick();
  assert.equal(r.ejecutado, false);
});

test('ejecucion estrictamente secuencial: tick simultaneos no se solapan', async () => {
  let activos = 0;
  let maximo = 0;
  let total = 0;
  const publicar = async (spec) => {
    activos++;
    total++;
    maximo = Math.max(maximo, activos);
    await new Promise((r) => setTimeout(r, 25));
    activos--;
    return okPublicador(spec.plataformas);
  };
  const { prog, reloj } = await crear({ publicar, config: CONFIG_SATURADO });
  await encolarN(prog, 5);
  reloj.ms += MIN;
  const resultados = await Promise.all([prog.tick(), prog.tick(), prog.tick(), prog.tick()]);
  assert.equal(resultados.filter((r) => r.ejecutado).length, 1);
  assert.equal(resultados.filter((r) => r.motivo === 'ocupado').length, 3);
  for (let i = 0; i < 6; i++) {
    reloj.ms += 2 * MIN;
    await Promise.all([prog.tick(), prog.tick()]);
  }
  assert.equal(maximo, 1);
  assert.ok(total >= 2);
});

test('scheduledAt en el futuro no se ejecuta hasta su hora', async () => {
  const { prog, reloj, llamadas } = await crear({ config: CONFIG_SATURADO });
  const luego = new Date(LUNES_8AM_RD + 3 * HORA).toISOString();
  await prog.encolar({ rutaVideo: '/tmp/f.mp4', platforms: ['tiktok'], scheduledAt: luego });
  await avanzar(prog, reloj, LUNES_8AM_RD + 2 * HORA);
  assert.equal(llamadas.length, 0);
  await avanzar(prog, reloj, LUNES_8AM_RD + 4 * HORA);
  assert.equal(llamadas.length, 1);
  assert.ok(llamadas[0].ms >= Date.parse(luego));
});

// ----------------------------- reintentos / backoff ---------------------------

test('fallo transitorio: backoff con jitter, no bloquea a otros clips, y luego se publica', async () => {
  const intentos = {};
  const publicar = async (spec) => {
    intentos[spec.rutaVideo] = (intentos[spec.rutaVideo] || 0) + 1;
    if (spec.rutaVideo === '/tmp/A.mp4' && intentos[spec.rutaVideo] === 1) {
      return { ok: false, resultados: { tiktok: falla('TIMEOUT', true) } };
    }
    return okPublicador(spec.plataformas);
  };
  const { prog, reloj } = await crear({ publicar, config: CONFIG_SATURADO });
  const a = await prog.encolar({ rutaVideo: '/tmp/A.mp4', platforms: ['tiktok'], scheduledAt: new Date(LUNES_8AM_RD).toISOString() });
  const b = await prog.encolar({ rutaVideo: '/tmp/B.mp4', platforms: ['tiktok'], scheduledAt: new Date(LUNES_8AM_RD + 1000).toISOString() });
  reloj.ms += MIN;
  await prog.tick();
  const trasPrimero = prog.obtener(a.id);
  assert.equal(trasPrimero.status, 'queued');
  assert.equal(trasPrimero.attempts, 1);
  assert.match(trasPrimero.lastError, /tiktok: fallo TIMEOUT/);
  const espera = Date.parse(trasPrimero.scheduledAt) - reloj.ms;
  assert.ok(espera >= 90000 && espera <= 150000, 'backoff base 120 s +-25%: ' + espera);
  for (let i = 0; i < 4; i++) { reloj.ms += MIN; await prog.tick(); }
  assert.equal(prog.obtener(b.id).status, 'published', 'B no queda bloqueado por A');
  // A y B ya gastaron el cupo de la hora: el reintento de A espera aunque su backoff (~2 min) ya vencio.
  await avanzar(prog, reloj, reloj.ms + 30 * MIN);
  assert.equal(prog.obtener(a.id).status, 'queued', 'el tope de 2/hora manda sobre el backoff');
  await avanzar(prog, reloj, reloj.ms + 45 * MIN);
  const fin = prog.obtener(a.id);
  assert.equal(fin.status, 'published');
  assert.equal(fin.attempts, 2);
  assert.equal(fin.lastError, null);
});

test('reintento parcial: solo se vuelve a publicar donde falto (sin duplicar donde ya salio)', async () => {
  const peticiones = [];
  const publicar = async (spec) => {
    peticiones.push(spec.plataformas.slice());
    if (peticiones.length === 1) {
      return { ok: false, resultados: { tiktok: okPublicador(['tiktok']).resultados.tiktok, instagram: falla('TIMEOUT', true) } };
    }
    return okPublicador(spec.plataformas);
  };
  const { prog, reloj } = await crear({ publicar, config: CONFIG_SATURADO });
  const job = await prog.encolar({ rutaVideo: '/tmp/p.mp4', platforms: ['tiktok', 'instagram'] });
  await avanzar(prog, reloj, reloj.ms + 30 * MIN);
  assert.deepEqual(peticiones, [['tiktok', 'instagram'], ['instagram']]);
  const fin = prog.obtener(job.id);
  assert.equal(fin.status, 'published');
  assert.equal(fin.resultados.tiktok.ok, true);
  assert.equal(fin.resultados.instagram.ok, true);
  assert.equal(prog.historial().length, 2);
});

test('error definitivo => failed al primer intento; transitorio repetido => failed al agotar intentos', async () => {
  const { prog, reloj } = await crear({
    config: { ...CONFIG_SATURADO, maxIntentos: 3, backoffBaseMs: 1000, backoffMaxMs: 2000 },
    publicar: async (spec) => ({ ok: false, resultados: Object.fromEntries(spec.plataformas.map((p) => [p, p === 'tiktok' ? falla('SIN_SESION', false) : falla('TIMEOUT', true)])) }),
  });
  const definitivo = await prog.encolar({ rutaVideo: '/tmp/d.mp4', platforms: ['tiktok'] });
  const transitorio = await prog.encolar({ rutaVideo: '/tmp/t.mp4', platforms: ['facebook'] });
  await avanzar(prog, reloj, reloj.ms + 3 * HORA, 30000);
  const d = prog.obtener(definitivo.id);
  const t = prog.obtener(transitorio.id);
  assert.equal(d.status, 'failed');
  assert.equal(d.attempts, 1);
  assert.equal(t.status, 'failed');
  assert.equal(t.attempts, 3);
  assert.match(t.lastError, /facebook/);
});

test('si el publicador lanza una excepcion o se cuelga, el trabajo se reprograma y la cola sigue viva', async () => {
  let llamadas = 0;
  const { prog, reloj } = await crear({
    config: { ...CONFIG_SATURADO, timeoutMs: 1000 },
    publicar: (spec) => {
      llamadas++;
      if (llamadas === 1) return Promise.reject(new Error('explotó el navegador'));
      if (llamadas === 2) return new Promise(() => {}); // se cuelga para siempre
      return Promise.resolve(okPublicador(spec.plataformas));
    },
  });
  const job = await prog.encolar({ rutaVideo: '/tmp/x.mp4', platforms: ['tiktok'] });
  reloj.ms += MIN;
  await prog.tick();
  assert.equal(prog.obtener(job.id).status, 'queued');
  assert.match(prog.obtener(job.id).lastError, /explot/);
  reloj.ms += 10 * MIN;
  await prog.tick(); // se cuelga: debe liberarse por tiempo limite (1 s reales)
  assert.equal(prog.estado().ocupado, false);
  assert.match(prog.obtener(job.id).lastError, /Tiempo de publicacion agotado/);
  await avanzar(prog, reloj, reloj.ms + HORA);
  assert.equal(prog.obtener(job.id).status, 'published');
});

// ------------------------------ API de la cola --------------------------------

test('cancelar / reintentar / validaciones de encolar', async () => {
  const { prog } = await crear();
  const job = await prog.encolar({ rutaVideo: '/tmp/c.mp4', platforms: ['TikTok', 'tiktok', 'facebook'] });
  assert.deepEqual(job.platforms, ['tiktok', 'facebook']);
  assert.equal((await prog.cancelar(job.id)).status, 'cancelled');
  await assert.rejects(prog.cancelar(job.id), { codigo: 'NO_CANCELABLE' });
  await assert.rejects(prog.cancelar('nope'), { codigo: 'NO_ENCONTRADO' });
  assert.equal((await prog.reintentar(job.id)).status, 'queued');
  await assert.rejects(prog.reintentar(job.id), { codigo: 'NO_REINTENTABLE' });
  await assert.rejects(prog.encolar({ rutaVideo: '/tmp/c.mp4', platforms: [] }), { codigo: 'SIN_PLATAFORMAS' });
  await assert.rejects(prog.encolar({ rutaVideo: '/tmp/c.mp4', platforms: ['youtube'] }), { codigo: 'PLATAFORMA_INVALIDA' });
  await assert.rejects(prog.encolar({ rutaVideo: '/tmp/c.mp4', platforms: ['tiktok'], scheduledAt: 'ayer' }), { codigo: 'FECHA_INVALIDA' });
  await assert.rejects(prog.encolar({ platforms: ['tiktok'] }), { codigo: 'SIN_VIDEO' });
  assert.equal(prog.listar({ status: 'queued' }).length, 1);
});

test('encolar por clipId toma archivo, copy y hashtags del clip generado; exige que este listo; evita duplicados', async () => {
  const { prog } = await crear();
  const clip = store.encolar('https://youtu.be/xyz');
  await assert.rejects(prog.encolar({ clipId: clip.id, platforms: ['tiktok'] }), { codigo: 'CLIP_NO_LISTO' });
  await assert.rejects(prog.encolar({ clipId: 'clip_nada', platforms: ['tiktok'] }), { codigo: 'CLIP_NO_ENCONTRADO' });
  store.completar(clip.id, { url: '/clips/abc123.mp4', copy: 'Texto del clip', marketing: { hashtags: ['#viral', '#ia'] } });
  const job = await prog.encolar({ clipId: clip.id, platforms: ['tiktok', 'instagram'] });
  assert.equal(job.rutaVideo, path.join(process.env.CLIPS_DIR, 'abc123.mp4'));
  assert.equal(job.descripcion, 'Texto del clip');
  assert.deepEqual(job.etiquetas, ['#viral', '#ia']);
  await assert.rejects(prog.encolar({ clipId: clip.id, platforms: ['facebook'] }), { codigo: 'DUPLICADO' });
});

test('el ciclo periodico (iniciar/detener) ejecuta pendientes por si solo', async () => {
  const { prog } = await crear({ config: { ...CONFIG_SATURADO, cicloMs: 20, horaDesde: 0, horaHasta: 24 } });
  await prog.encolar({ rutaVideo: '/tmp/i.mp4', platforms: ['tiktok'] });
  await prog.iniciar();
  await new Promise((r) => setTimeout(r, 150));
  await prog.detener();
  assert.equal(prog.listar({ status: 'published' }).length, 1);
  assert.equal(prog.estado().activo, false);
});

// ------------------------------ integracion ----------------------------------

test('integracion programador + publicador (driver de ensayo): resultado por canal queda en el historial', async () => {
  const video = path.join(raiz, 'int.mp4');
  await fs.writeFile(video, 'x');
  const driver = crearDriverSeco();
  const FUTURO = Math.floor(Date.now() / 1000) + 86400;
  const cookies = { tiktok: [{ name: 'sessionid', value: 'a', domain: '.tiktok.com', expires: FUTURO }], instagram: [{ name: 'sessionid', value: 'b', domain: '.instagram.com', expires: FUTURO }] };
  const publicar = (spec) =>
    publicarClip(spec, {
      driver,
      azar: mulberry32(5),
      dormir: async () => {},
      leerCookies: async (red) => cookies[red] || null,
      obligatorias: { tiktok: [['sessionid']], instagram: [['sessionid']], facebook: [['c_user'], ['xs']] },
    });
  const { prog, reloj } = await crear({ publicar, config: { ...CONFIG_SATURADO, backoffBaseMs: 1000, backoffMaxMs: 1000 } });
  const job = await prog.encolar({ rutaVideo: video, descripcion: 'Integración', etiquetas: ['demo'], platforms: ['tiktok', 'instagram', 'facebook'] });
  await avanzar(prog, reloj, reloj.ms + 20 * MIN);
  const fin = prog.obtener(job.id);
  assert.equal(fin.resultados.tiktok.ok, true);
  assert.equal(fin.resultados.instagram.ok, true);
  assert.equal(fin.resultados.facebook.ok, false);
  assert.equal(fin.resultados.facebook.codigo, 'SIN_SESION');
  assert.equal(fin.status, 'failed', 'sin sesion de facebook es definitivo: no se reintenta en bucle');
  const h = prog.historial()[0];
  assert.equal(h.jobId, job.id);
  assert.equal(h.resultados.facebook.codigo, 'SIN_SESION');
  assert.ok(!Number.isNaN(Date.parse(h.resultados.tiktok.timestamp)));
});
CLIPLAB_EOF
cat > tests/publicador.test.js << 'CLIPLAB_EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-pub-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.LOG_LEVEL = 'error';
delete process.env.PUBLICADOR_MODO;

const { publicarClip, publicarEnRed, crearRitmoHumano, armarTexto, crearDriverSeco, crearDriverPlaywright, construirPasos, SELECTORES } =
  await import('../src/engine/publicador.js');

const video = path.join(raiz, 'clip.mp4');
await fs.writeFile(video, 'x');

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUTURO = Math.floor(Date.now() / 1000) + 86400;
const OBLIGATORIAS = { tiktok: [['sessionid']], instagram: [['sessionid']], facebook: [['c_user'], ['xs']] };
const cookiesOk = {
  tiktok: [{ name: 'sessionid', value: 'a', domain: '.tiktok.com', path: '/', expires: FUTURO }],
  instagram: [{ name: 'sessionid', value: 'b', domain: '.instagram.com', path: '/', expires: FUTURO }],
  facebook: [
    { name: 'c_user', value: 'c', domain: '.facebook.com', path: '/', expires: FUTURO },
    { name: 'xs', value: 'd', domain: '.facebook.com', path: '/', expires: -1 },
  ],
};
const lector = (mapa) => async (red) => (red in mapa ? mapa[red] : null);

function opciones(extra = {}) {
  const dormidos = [];
  const driver = crearDriverSeco();
  return {
    dormidos,
    driver,
    o: {
      driver,
      azar: mulberry32(7),
      dormir: async (ms) => void dormidos.push(ms),
      leerCookies: lector(cookiesOk),
      obligatorias: OBLIGATORIAS,
      ...extra,
    },
  };
}

test('armarTexto: etiquetas limpias, sin repetir las que ya estan en el texto, con tope de longitud', () => {
  const t = armarTexto('Mira esto #Viral', ['viral', '#negocios', 'ia!', '', 'ñandú tips']);
  assert.equal(t, 'Mira esto #Viral\n\n#negocios #ia #ñandútips');
  assert.equal(armarTexto('', ['a']), '#a');
  assert.ok(armarTexto('x'.repeat(5000), []).length <= 2200);
});

test('planearTecleo: reconstruye el texto exacto (emojis y saltos incluidos) con esperas variables y acotadas', () => {
  const texto = 'Hola mundo 🚀 esto es una prueba, con puntuacion. ¿Funciona?\n\n#uno #dos #tres ' + 'palabra '.repeat(40);
  const h = crearRitmoHumano({ azar: mulberry32(1) });
  const plan = h.planearTecleo(texto);
  assert.equal(plan.map((p) => p.texto).join(''), texto);
  assert.ok(!plan.some((p) => /[\ud800-\udfff]/.test(p.texto) && Array.from(p.texto).length === 0));
  assert.ok(plan.every((p) => Array.from(p.texto).length >= 1 && Array.from(p.texto).length <= 5));
  const esperas = plan.map((p) => p.espera);
  assert.ok(new Set(esperas).size > 20, 'las esperas deben variar');
  assert.ok(esperas.every((e) => e >= 40 && e <= 2800));
  assert.ok(esperas.some((e) => e >= 800), 'debe haber pausas de pensar');
  const otro = crearRitmoHumano({ azar: mulberry32(2) }).planearTecleo(texto).map((p) => p.espera);
  assert.notDeepEqual(esperas, otro);
  assert.deepEqual(crearRitmoHumano({ azar: mulberry32(1) }).planearTecleo(texto), plan, 'mismo azar => mismo plan');
});

test('publicarClip: resultado estructurado por canal, cookies leidas por red, tecleo humano y archivo adjunto', async () => {
  const { o, driver, dormidos } = opciones();
  const r = await publicarClip({ rutaVideo: video, descripcion: 'Un clip genial', etiquetas: ['viral', 'ia'], plataformas: ['tiktok', 'instagram', 'facebook'] }, o);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.resultados), ['tiktok', 'instagram', 'facebook']);
  for (const red of Object.keys(r.resultados)) {
    const c = r.resultados[red];
    assert.equal(c.ok, true);
    assert.equal(c.error, null);
    assert.match(c.detalle, /Publicado en/);
    assert.ok(!Number.isNaN(Date.parse(c.timestamp)));
  }
  const abrir = driver.registro.filter((x) => x.accion === 'abrir');
  assert.deepEqual(abrir.map((x) => x.red), ['tiktok', 'instagram', 'facebook']);
  assert.equal(abrir[2].cookies, 2); // facebook entrego sus 2 cookies
  assert.equal(driver.registro.filter((x) => x.accion === 'adjuntar').every((x) => x.ruta === video), true);
  assert.equal(driver.registro.filter((x) => x.accion === 'adjuntar').length, 3);
  // Lo tecleado por red, unido, es la descripcion completa.
  const tecleado = driver.registro.filter((x) => ['abrir', 'teclear'].includes(x.accion));
  let actual = null;
  const porRed = {};
  for (const x of tecleado) {
    if (x.accion === 'abrir') {
      actual = x.red;
      porRed[actual] = '';
    } else porRed[actual] += x.texto;
  }
  for (const red of ['tiktok', 'instagram', 'facebook']) assert.equal(porRed[red], 'Un clip genial\n\n#viral #ia');
  assert.ok(driver.registro.filter((x) => x.accion === 'tecla').length >= 2, 'TikTok limpia el texto previo');
  assert.ok(new Set(dormidos).size > 50, 'pausas y esperas variables');
  assert.equal(driver.registro.filter((x) => x.accion === 'cerrar').length, 3);
});

test('un canal sin sesion o con sesion vencida falla solo, sin tumbar a los demas', async () => {
  const vencidas = { ...cookiesOk, instagram: [{ name: 'sessionid', value: 'b', domain: '.instagram.com', path: '/', expires: 1000 }] };
  const { o } = opciones({ leerCookies: lector({ tiktok: cookiesOk.tiktok, instagram: vencidas.instagram }) });
  const r = await publicarClip({ rutaVideo: video, plataformas: ['tiktok', 'instagram', 'facebook'], descripcion: 'x' }, o);
  assert.equal(r.ok, false);
  assert.equal(r.resultados.tiktok.ok, true);
  assert.equal(r.resultados.instagram.ok, false);
  assert.equal(r.resultados.instagram.codigo, 'SESION_EXPIRADA');
  assert.equal(r.resultados.instagram.transitorio, false);
  assert.equal(r.resultados.facebook.codigo, 'SIN_SESION');
  assert.equal(r.resultados.facebook.transitorio, false);
  assert.match(r.resultados.facebook.error, /Conexiones/);
});

test('cookies ilegibles (cambio de llave) y red no soportada son errores definitivos', async () => {
  const { o } = opciones({
    leerCookies: async (red) => {
      if (red === 'tiktok') throw new Error('No se pudo descifrar la sesion');
      return cookiesOk[red] || null;
    },
  });
  const r = await publicarClip({ rutaVideo: video, plataformas: ['tiktok', 'youtube'], descripcion: 'x' }, o);
  assert.equal(r.resultados.tiktok.codigo, 'SESION_ILEGIBLE');
  assert.equal(r.resultados.tiktok.transitorio, false);
  assert.equal(r.resultados.youtube.codigo, 'RED_NO_SOPORTADA');
  assert.equal(r.resultados.youtube.transitorio, false);
});

test('video inexistente o sin plataformas: error estructurado en cada canal, sin abrir navegador', async () => {
  const { o, driver } = opciones();
  const r = await publicarClip({ rutaVideo: path.join(raiz, 'no-existe.mp4'), plataformas: ['tiktok', 'facebook'] }, o);
  assert.equal(r.ok, false);
  assert.equal(r.resultados.tiktok.codigo, 'ARCHIVO_NO_ENCONTRADO');
  assert.equal(r.resultados.facebook.codigo, 'ARCHIVO_NO_ENCONTRADO');
  assert.equal(driver.registro.length, 0);
  const vacio = await publicarClip({ rutaVideo: video, plataformas: [] }, o);
  assert.equal(vacio.ok, false);
  assert.equal(vacio.resultados && Object.keys(vacio.resultados).length, 0);
});

test('un fallo del navegador es transitorio, cierra la sesion y deja seguir con la siguiente red', async () => {
  let cerradas = 0;
  const driver = {
    tipo: 'falso',
    async abrir({ red }) {
      const lanzar = red === 'tiktok';
      return {
        ir: async () => {},
        adjuntar: async () => {},
        esperar: async () => {
          if (lanzar) throw Object.assign(new Error('Timeout 30000ms esperando el boton'), { name: 'TimeoutError' });
        },
        esperarUrl: async () => {},
        clic: async () => {},
        enfocar: async () => {},
        tecla: async () => {},
        teclear: async () => {},
        cerrar: async () => void cerradas++,
      };
    },
    async cerrar() {},
  };
  const { o } = opciones({ driver });
  const r = await publicarClip({ rutaVideo: video, plataformas: ['tiktok', 'facebook'], descripcion: 'x' }, o);
  assert.equal(r.resultados.tiktok.ok, false);
  assert.equal(r.resultados.tiktok.codigo, 'TIMEOUT');
  assert.equal(r.resultados.tiktok.transitorio, true);
  assert.equal(r.resultados.facebook.ok, true);
  assert.equal(cerradas, 2);
});

test('modo seco sin driver: recorre el flujo sin red y lo marca como simulado', async () => {
  const r = await publicarClip(
    { rutaVideo: video, plataformas: ['tiktok'], descripcion: 'x' },
    { modo: 'seco', azar: mulberry32(3), dormir: async () => {}, leerCookies: lector(cookiesOk), obligatorias: OBLIGATORIAS }
  );
  assert.equal(r.ok, true);
  assert.equal(r.modo, 'seco');
  assert.equal(r.resultados.tiktok.simulado, true);
  assert.match(r.resultados.tiktok.detalle, /^SIMULACION/);
});

test('modo real sin Playwright instalado: DRIVER_NO_DISPONIBLE, definitivo y nunca finge un exito', async () => {
  await assert.rejects(crearDriverPlaywright({ importar: async () => { throw new Error('Cannot find package'); } }), (e) => e.codigo === 'DRIVER_NO_DISPONIBLE' && e.transitorio === false);
  const r = await publicarClip(
    { rutaVideo: video, plataformas: ['tiktok', 'instagram'], descripcion: 'x' },
    { modo: 'real', dormir: async () => {}, leerCookies: lector(cookiesOk), obligatorias: OBLIGATORIAS }
  );
  assert.equal(r.ok, false);
  for (const red of ['tiktok', 'instagram']) {
    assert.equal(r.resultados[red].ok, false);
    assert.equal(r.resultados[red].codigo, 'DRIVER_NO_DISPONIBLE');
    assert.equal(r.resultados[red].transitorio, false);
  }
});

test('driver Playwright (con modulo falso): cookies al contexto, archivo, tecleo por bloques, clic con movimiento de raton', async () => {
  const log = [];
  const pagina = {
    goto: async (u) => log.push(['goto', u]),
    waitForURL: async () => log.push(['waitForURL']),
    locator: (sel) => ({
      first: () => ({
        waitFor: async () => log.push(['waitFor', sel]),
        boundingBox: async () => ({ x: 10, y: 10, width: 100, height: 40 }),
        click: async () => log.push(['click']),
        setInputFiles: async (ruta) => log.push(['setInputFiles', ruta]),
      }),
    }),
    mouse: { move: async (x, y, o) => log.push(['move', o.steps]), click: async () => log.push(['mclick']) },
    keyboard: { type: async (t) => log.push(['type', t]), press: async (k) => log.push(['press', k]) },
  };
  const contexto = { addCookies: async (c) => log.push(['addCookies', c.length]), newPage: async () => pagina, close: async () => log.push(['ctxClose']) };
  const navegador = { newContext: async () => contexto, close: async () => log.push(['navClose']) };
  const modulo = { chromium: { launch: async () => navegador } };
  const driver = await crearDriverPlaywright({ azar: mulberry32(9), importar: async () => modulo });
  const r = await publicarClip(
    { rutaVideo: video, plataformas: ['tiktok'], descripcion: 'Hola' },
    { driver, azar: mulberry32(4), dormir: async () => {}, leerCookies: lector(cookiesOk), obligatorias: OBLIGATORIAS, selectores: SELECTORES }
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(log.find((x) => x[0] === 'addCookies'), ['addCookies', 1]);
  assert.deepEqual(log.find((x) => x[0] === 'setInputFiles'), ['setInputFiles', video]);
  assert.equal(log.filter((x) => x[0] === 'type').map((x) => x[1]).join(''), 'Hola');
  assert.ok(log.some((x) => x[0] === 'move' && x[1] >= 8), 'el raton se mueve antes de hacer clic');
  assert.ok(log.some((x) => x[0] === 'ctxClose'));
  await driver.cerrar();
  assert.ok(log.some((x) => x[0] === 'navClose'));
});

test('pasos por red: cada flujo adjunta el video, escribe la descripcion y publica', () => {
  for (const red of ['tiktok', 'instagram', 'facebook']) {
    const acciones = construirPasos(red).map((p) => p.accion);
    for (const a of ['ir', 'adjuntar', 'escribir', 'clic']) assert.ok(acciones.includes(a), red + ' sin ' + a);
    assert.ok(acciones.indexOf('adjuntar') < acciones.indexOf('escribir'));
  }
  assert.throws(() => construirPasos('x'), /no soportada/);
});

test('publicarEnRed nunca lanza', async () => {
  const r = await publicarEnRed('tiktok', { rutaVideo: video, texto: 'x' }, {
    driver: { abrir: async () => { throw new Error('boom'); }, tipo: 'falso' },
    humano: crearRitmoHumano({ dormir: async () => {} }),
    leerCookies: lector(cookiesOk),
    obligatorias: OBLIGATORIAS,
    selectores: SELECTORES,
    timeouts: { pasoMs: 1, subidaMs: 1 },
    reloj: () => new Date().toISOString(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'boom');
  assert.equal(r.transitorio, true);
});
CLIPLAB_EOF
# Registrar las pruebas nuevas en `npm test` (solo si faltan).
node -e "
const fs=require('fs');let s=fs.readFileSync('package.json','utf8');
if(!s.includes('tests/programador.test.js')){
  s=s.replace('tests/upload-respaldo.test.js\"','tests/upload-respaldo.test.js tests/programador.test.js tests/publicador.test.js\"');
  JSON.parse(s);fs.writeFileSync('package.json',s);console.log('package.json: pruebas registradas');
}else console.log('package.json: ya estaba registrado');"
for f in src/engine/programador.js src/engine/publicador.js tests/programador.test.js tests/publicador.test.js; do node -c "$f" && echo "node -c OK  $f"; done
echo "Listo. Prueba:  node --test tests/programador.test.js tests/publicador.test.js"
