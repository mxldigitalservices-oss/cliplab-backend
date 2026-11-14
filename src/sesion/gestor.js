import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { run } from '../utils/run.js';
import { store } from '../storage/store.js';
import {
  guardarPerfil, leerPerfil, leerEstado, guardarEstado, borrarTodo, infoAlmacen,
} from './almacen.js';
import {
  parsearCookies, parsearNetscape, filtrarRelevantes, normalizar, serializar, resumir, errorHttp,
} from './cookies.js';

const ANTIBOT = /confirm you.?re not a bot|Sign in to confirm|HTTP Error 429|cookies are no longer valid|LOGIN_REQUIRED/i;
const TIMEOUT_SONDEO_MS = 90_000;
const VERIFICANDO_MAX_MS = 3 * 60_000;

export const esBloqueoAntiBot = (texto) => ANTIBOT.test(String(texto || ''));

const ultimaLinea = (texto) =>
  String(texto || '').trim().split('\n').filter(Boolean).pop()?.slice(0, 300) || 'sin detalle';

/* ---------- Exclusion mutua: un solo yt-dlp a la vez usa el perfil ---------- */

let cola = Promise.resolve();

function exclusivo(fn) {
  const turno = cola.then(() => fn());
  cola = turno.catch(() => {});
  return turno;
}

/* ---------- Estado publico (sin valores de cookies) ---------- */

let escrituraEstado = Promise.resolve();

function actualizarEstado(parche) {
  const turno = escrituraEstado.then(async () => {
    let actual = {};
    try {
      actual = (await leerEstado()) || {};
    } catch {
      actual = {};
    }
    const nuevo = { ...actual, ...parche };
    try {
      await guardarEstado(nuevo);
    } catch (error) {
      logger.error('No se pudo guardar el estado de la sesion', error);
    }
    return nuevo;
  });
  escrituraEstado = turno.catch(() => {});
  return turno;
}

function notificarTransicion(previo, nuevo, detalle) {
  if (nuevo === 'bloqueada' && previo !== 'bloqueada') {
    store.registrarIncidencia('error', 'Sesion de YouTube: ' + detalle, 'sesion');
  } else if (nuevo === 'activa' && previo === 'bloqueada') {
    store.registrarIncidencia('info', 'La sesion de YouTube se recupero.', 'sesion');
  }
}

/* ---------- Perfil: carga, uso temporal y recogida de cookies renovadas ---------- */

async function cargarPerfil() {
  try {
    const guardado = await leerPerfil();
    if (guardado && guardado.cookies) return guardado;
  } catch (error) {
    logger.error('Sesion guardada ilegible', error);
    await actualizarEstado({ estado: 'sin_sesion', detalle: error.message });
    return null;
  }

  if (config.ytdlpCookies) {
    try {
      const texto = await fs.readFile(config.ytdlpCookies, 'utf8');
      const lista = normalizar(filtrarRelevantes(parsearNetscape(texto)));
      if (lista.length > 0) return { cookies: serializar(lista), origen: 'env' };
    } catch (error) {
      logger.warn('No se pudo leer YTDLP_COOKIES', { mensaje: error.message });
    }
  }
  return null;
}

async function recoger(ruta, perfil) {
  try {
    const texto = await fs.readFile(ruta, 'utf8');
    const nuevas = normalizar(filtrarRelevantes(parsearNetscape(texto)));
    if (nuevas.length === 0) return false;

    const previas = normalizar(parsearNetscape(perfil.cookies));
    if (!resumir(nuevas).autenticada && resumir(previas).autenticada) return false;

    const serial = serializar(nuevas);
    if (serial === serializar(previas) && perfil.origen !== 'env') return false;

    await guardarPerfil({ cookies: serial, actualizadoEn: new Date().toISOString() });
    await actualizarEstado({ ultimaRenovacion: new Date().toISOString(), cookies: resumir(nuevas) });
    return true;
  } catch (error) {
    logger.warn('No se pudieron recoger las cookies renovadas', { mensaje: error.message });
    return false;
  }
}

async function usarSesion(fn) {
  const perfil = await cargarPerfil();
  if (!perfil) return fn(null);

  const dir = path.join(config.tmpDir, 'sesion');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const ruta = path.join(dir, 'c-' + crypto.randomBytes(6).toString('hex') + '.txt');
  await fs.writeFile(ruta, perfil.cookies, { mode: 0o600 });

  try {
    return await fn(ruta);
  } finally {
    await recoger(ruta, perfil);
    await fs.rm(ruta, { force: true });
  }
}

/** Ejecuta fn(rutaCookies | null) con el perfil descifrado en un archivo temporal que se borra al terminar. */
export function conSesion(fn) {
  return exclusivo(() => usarSesion(fn));
}

/* ---------- Verificacion ---------- */

async function sondear(rutaCookies) {
  const args = [
    '--no-warnings', '--no-colors', '--no-playlist', '--skip-download', '--simulate',
    '--js-runtimes', 'node', '--socket-timeout', '20', '--print', '%(id)s',
  ];
  if (rutaCookies) args.push('--cookies', rutaCookies);
  args.push('--', config.sessionProbeUrl);

  try {
    await run(config.ytdlpPath, args, { timeoutMs: TIMEOUT_SONDEO_MS });
    return { ok: true };
  } catch (error) {
    return { ok: false, bloqueo: esBloqueoAntiBot(error.stderr), detalle: ultimaLinea(error.stderr || error.message) };
  }
}

export function verificar({ motivo = 'manual' } = {}) {
  return exclusivo(async () => {
    const previo = (await leerEstado().catch(() => null)) || {};
    let conSesionGuardada = false;
    const sondeo = await usarSesion((ruta) => {
      conSesionGuardada = Boolean(ruta);
      return sondear(ruta);
    });

    let estado;
    let detalle;
    if (!conSesionGuardada) {
      estado = 'sin_sesion';
      detalle = sondeo.ok
        ? 'No hay sesion guardada, pero la IP actual no esta bloqueada.'
        : sondeo.bloqueo
          ? 'No hay sesion guardada y YouTube bloquea esta IP: importa cookies.'
          : 'No hay sesion guardada. No se pudo comprobar la IP: ' + sondeo.detalle;
    } else if (sondeo.ok) {
      estado = 'activa';
      detalle = 'La sesion funciona.';
    } else if (sondeo.bloqueo) {
      estado = 'bloqueada';
      detalle = 'YouTube exige verificacion: las cookies caducaron o la IP fue marcada. Importa cookies frescas.';
    } else {
      estado = 'sin_verificar';
      detalle = 'No se pudo comprobar: ' + sondeo.detalle;
    }

    const guardado = await actualizarEstado({
      estado, detalle, ultimaVerificacion: new Date().toISOString(), motivoVerificacion: motivo,
    });
    notificarTransicion(previo.estado, estado, detalle);
    logger.info('Sesion verificada', { estado, motivo });
    return { ...guardado, sondeoOk: sondeo.ok };
  });
}

/** Fuerza una verificacion (y con ella la rotacion de cookies) tras un bloqueo anti-bot. */
export const renovar = (motivo = 'antibot') => verificar({ motivo });

const enSegundoPlano = new Set();

export function verificarEnSegundoPlano(motivo) {
  const tarea = actualizarEstado({ verificandoDesde: new Date().toISOString() })
    .then(() => verificar({ motivo }))
    .catch((error) => logger.error('Fallo la verificacion de la sesion', error))
    .finally(() => actualizarEstado({ verificandoDesde: null }))
    .finally(() => enSegundoPlano.delete(tarea));
  enSegundoPlano.add(tarea);
  return tarea;
}

export async function esperarInactivo() {
  let ultima;
  do {
    await Promise.allSettled([...enSegundoPlano]);
    ultima = cola;
    await ultima.catch(() => {});
  } while (ultima !== cola || enSegundoPlano.size > 0);
}

/* ---------- API para las rutas ---------- */

export async function importar(texto) {
  if (!config.sessionKey) {
    throw errorHttp(503, 'Define SESSION_KEY (o MASTER_KEY) en el servidor para poder cifrar la sesion.');
  }

  const lista = normalizar(filtrarRelevantes(parsearCookies(texto)));
  if (lista.length === 0) {
    throw errorHttp(400, 'El archivo no tiene cookies de YouTube ni de Google.');
  }

  const resumen = resumir(lista);
  if (!resumen.autenticada) {
    throw errorHttp(400, 'Faltan las cookies de inicio de sesion (SID o __Secure-1PSID). Exporta con la sesion iniciada.');
  }
  if (resumen.vencida) {
    throw errorHttp(400, 'Las cookies de inicio de sesion ya vencieron. Exporta unas nuevas.');
  }

  await exclusivo(async () => {
    await guardarPerfil({ cookies: serializar(lista), actualizadoEn: new Date().toISOString() });
    await actualizarEstado({
      estado: 'sin_verificar',
      detalle: 'Sesion importada; verificando...',
      cookies: resumen,
      ultimaImportacion: new Date().toISOString(),
    });
  });

  verificarEnSegundoPlano('importacion');
  return { cookies: resumen };
}

export async function borrar() {
  await exclusivo(async () => {
    await borrarTodo();
  });
}

export async function obtenerEstado() {
  const [info, estado] = await Promise.all([
    infoAlmacen().catch(() => null),
    leerEstado().catch(() => null),
  ]);

  let tienePerfil = false;
  try {
    tienePerfil = Boolean(await leerPerfil());
  } catch {
    tienePerfil = false;
  }

  const desde = estado && estado.verificandoDesde ? Date.parse(estado.verificandoDesde) : 0;
  return {
    estado: (estado && estado.estado) || (tienePerfil ? 'sin_verificar' : 'sin_sesion'),
    detalle: (estado && estado.detalle) || null,
    ultimaVerificacion: (estado && estado.ultimaVerificacion) || null,
    ultimaRenovacion: (estado && estado.ultimaRenovacion) || null,
    ultimaImportacion: (estado && estado.ultimaImportacion) || null,
    cookies: (estado && estado.cookies) || null,
    verificando: desde > 0 && Date.now() - desde < VERIFICANDO_MAX_MS,
    tienePerfil,
    claveConfigurada: Boolean(config.sessionKey),
    persistente: info ? info.persistente : false,
    vigilanciaMinutos: config.sessionCheckMinutes,
    origenEnv: Boolean(config.ytdlpCookies),
  };
}

/* ---------- Vigilancia periodica ---------- */

let temporizadores = [];

async function hayPerfil() {
  if (config.ytdlpCookies) return true;
  try {
    return Boolean(await leerPerfil());
  } catch {
    return false;
  }
}

export function iniciarVigilancia() {
  const cadaMs = config.sessionCheckMinutes * 60_000;
  if (cadaMs <= 0) {
    logger.info('Vigilancia de la sesion desactivada (SESSION_CHECK_MIN=0)');
    return;
  }

  actualizarEstado({ verificandoDesde: null }).catch(() => {});

  const tic = async () => {
    if (await hayPerfil()) verificarEnSegundoPlano('programada');
  };
  const primero = setTimeout(tic, 60_000);
  const periodico = setInterval(tic, cadaMs);
  primero.unref();
  periodico.unref();
  temporizadores = [primero, periodico];
  logger.info('Vigilancia de la sesion activa', { cadaMinutos: config.sessionCheckMinutes });
}

export function detenerVigilancia() {
  for (const t of temporizadores) clearTimeout(t);
  temporizadores = [];
}
