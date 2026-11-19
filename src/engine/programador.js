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
