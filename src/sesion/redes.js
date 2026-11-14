import { guardarCifrado, leerCifrado, borrarCifrado, infoAlmacen } from './almacen.js';
import { parsearCookies, normalizar, errorHttp } from './cookies.js';
import { config } from '../config/index.js';
import { store } from '../storage/store.js';
import { logger } from '../utils/logger.js';

/**
 * Sesiones de TikTok, Instagram y Facebook.
 * - Se guardan cifradas (AES-256-GCM, clave derivada de SESSION_KEY || MASTER_KEY) en el volumen.
 * - Nunca se devuelve ni se registra el valor de una cookie.
 * - "Verificar" es una comprobacion local (presencia y caducidad de las cookies de login);
 *   no se conecta a la red social.
 */
export const REDES = {
  tiktok: {
    nombre: 'TikTok',
    dominio: /(^|\.)tiktok\.com$/i,
    obligatorias: [['sessionid', 'sessionid_ss']],
    cuenta: null,
  },
  instagram: {
    nombre: 'Instagram',
    dominio: /(^|\.)instagram\.com$/i,
    obligatorias: [['sessionid']],
    cuenta: 'ds_user_id',
  },
  facebook: {
    nombre: 'Facebook',
    dominio: /(^|\.)facebook\.com$/i,
    obligatorias: [['c_user'], ['xs']],
    cuenta: 'c_user',
  },
};

export const PLATAFORMAS = Object.keys(REDES);

const NOMBRE_ARCHIVO = (plataforma) => 'red-' + plataforma;

let cola = Promise.resolve();
function exclusivo(fn) {
  const turno = cola.then(fn, fn);
  cola = turno.catch(() => {});
  return turno;
}

export function validarPlataforma(plataforma) {
  if (!Object.hasOwn(REDES, plataforma)) throw errorHttp(404, 'Plataforma desconocida.');
  return REDES[plataforma];
}

export function filtrarDominio(plataforma, cookies) {
  const { dominio } = REDES[plataforma];
  return cookies.filter((c) => dominio.test(String(c.dominio).replace(/^\./, '')));
}

/** Evalua las cookies guardadas. Devuelve un parche para store.conexiones (sin valores). */
export function evaluar(plataforma, cookies, ahora = Date.now()) {
  const red = REDES[plataforma];
  const faltan = [];
  let vence = null;
  let vencida = false;

  for (const grupo of red.obligatorias) {
    const halladas = cookies.filter((c) => grupo.includes(c.nombre) && c.valor);
    if (halladas.length === 0) {
      faltan.push(grupo[0]);
      continue;
    }
    // Con alternativas basta la que dure mas.
    const caducidades = halladas.map((c) => c.expira);
    if (caducidades.every((e) => e > 0)) {
      const maxima = Math.max(...caducidades);
      if (maxima * 1000 < ahora) vencida = true;
      vence = vence === null ? maxima : Math.min(vence, maxima);
    }
  }

  const cuentaCookie = red.cuenta ? cookies.find((c) => c.nombre === red.cuenta && c.valor) : null;
  const base = {
    cuenta: cuentaCookie ? 'ID ' + cuentaCookie.valor : null,
    cookies: cookies.length,
    venceEn: vence ? new Date(vence * 1000).toISOString() : null,
  };

  if (faltan.length > 0) {
    return { ...base, estado: 'incompleta', detalle: 'Faltan cookies de login: ' + faltan.join(', ') };
  }
  if (vencida) {
    return { ...base, estado: 'expirada', detalle: 'La sesion caduco. Vuelve a exportar las cookies.' };
  }
  return { ...base, estado: 'activa', detalle: 'Cookies de login presentes' };
}

const SIN_SESION = { estado: 'sin_sesion', cuenta: null, cookies: 0, venceEn: null, detalle: 'Sin cuenta vinculada' };

async function refrescar(plataforma) {
  let parche;
  try {
    const guardado = await leerCifrado(NOMBRE_ARCHIVO(plataforma));
    parche = guardado ? evaluar(plataforma, guardado.cookies || []) : { ...SIN_SESION };
  } catch (error) {
    parche = {
      ...SIN_SESION,
      estado: error.codigo === 'ILEGIBLE' ? 'ilegible' : 'sin_sesion',
      detalle: error.message,
    };
  }
  store.actualizarConexion(plataforma, { ...parche, ultimaVerificacion: new Date().toISOString() });
  return parche;
}

export function hidratar() {
  return exclusivo(async () => {
    for (const plataforma of PLATAFORMAS) await refrescar(plataforma);
  });
}

export async function infoPersistencia() {
  try {
    const { persistente } = await infoAlmacen();
    return { persistente, claveConfigurada: Boolean(config.sessionKey) };
  } catch {
    return { persistente: false, claveConfigurada: Boolean(config.sessionKey) };
  }
}

export async function importar(plataforma, texto) {
  const red = validarPlataforma(plataforma);
  return exclusivo(async () => {
    if (!config.sessionKey) {
      throw errorHttp(503, 'Falta SESSION_KEY (o MASTER_KEY) en el servidor: no se puede cifrar la sesion.');
    }
    const todas = parsearCookies(texto);
    const propias = normalizar(filtrarDominio(plataforma, todas));
    if (propias.length === 0) {
      throw errorHttp(400, 'Ninguna cookie pertenece a ' + red.nombre + '. Exporta las cookies estando dentro de su sitio web.');
    }

    const evaluacion = evaluar(plataforma, propias);
    if (evaluacion.estado === 'incompleta') {
      throw errorHttp(400, 'Las cookies de ' + red.nombre + ' no incluyen una sesion iniciada. ' + evaluacion.detalle + '.');
    }
    if (evaluacion.estado === 'expirada') {
      throw errorHttp(400, 'Las cookies de ' + red.nombre + ' ya estan caducadas. Inicia sesion y exportalas de nuevo.');
    }

    await guardarCifrado(NOMBRE_ARCHIVO(plataforma), {
      plataforma,
      importadoEn: new Date().toISOString(),
      cookies: propias,
    });
    store.actualizarConexion(plataforma, { ...evaluacion, ultimaVerificacion: new Date().toISOString() });
    store.registrarIncidencia('info', red.nombre + ': sesion vinculada (' + propias.length + ' cookies)', 'conexiones');
    logger.info('Sesion de red vinculada', { plataforma, cookies: propias.length });
    return { plataforma, ...evaluacion, descartadas: todas.length - propias.length };
  });
}

export async function verificar(plataforma) {
  validarPlataforma(plataforma);
  return exclusivo(async () => ({ plataforma, ...(await refrescar(plataforma)) }));
}

export async function quitar(plataforma) {
  const red = validarPlataforma(plataforma);
  return exclusivo(async () => {
    await borrarCifrado(NOMBRE_ARCHIVO(plataforma));
    store.actualizarConexion(plataforma, { ...SIN_SESION, ultimaVerificacion: new Date().toISOString() });
    store.registrarIncidencia('info', red.nombre + ': sesion eliminada', 'conexiones');
    return { plataforma };
  });
}

export async function listar() {
  await hidratar();
  const { conexiones } = store.snapshot();
  return { conexiones, ...(await infoPersistencia()) };
}

let temporizador = null;
export function iniciarRedes(minutos = 15) {
  hidratar().catch((e) => logger.warn('No se pudieron cargar las sesiones de redes', { mensaje: e.message }));
  clearInterval(temporizador);
  temporizador = setInterval(() => hidratar().catch(() => {}), minutos * 60_000);
  temporizador.unref();
}

export function detenerRedes() {
  clearInterval(temporizador);
}
