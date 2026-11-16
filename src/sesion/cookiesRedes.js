import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { store } from '../storage/store.js';
import { cifrar, descifrar, infoAlmacen } from './almacen.js';
import { errorHttp } from './cookies.js';
export const REDES = {
  tiktok: { nombre: 'TikTok', dominio: /(^|\.)tiktok\.com$/i, obligatorias: [['sessionid', 'sessionid_ss', 'sid_tt']] },
  instagram: { nombre: 'Instagram', dominio: /(^|\.)instagram\.com$/i, obligatorias: [['sessionid']] },
  facebook: { nombre: 'Facebook', dominio: /(^|\.)(facebook|messenger)\.com$/i, obligatorias: [['c_user'], ['xs']] },
};
const SAMESITE = { no_restriction: 'None', none: 'None', lax: 'Lax', strict: 'Strict' };
function definicion(red) {
  const def = REDES[red];
  if (!def) throw errorHttp(400, 'Red no soportada. Usa: ' + Object.keys(REDES).join(', '));
  return def;
}
function convertir(c) {
  const nombre = String((c && c.name) ?? '').trim();
  const dominio = String((c && c.domain) ?? '').trim();
  if (!nombre || !dominio) return null;
  const seguro = Boolean(c.secure);
  const sameSite = SAMESITE[String(c.sameSite ?? '').toLowerCase()];
  const expira = c.session ? -1 : Math.floor(Number(c.expirationDate ?? c.expires));
  return {
    name: nombre,
    value: String(c.value ?? ''),
    domain: dominio,
    path: c.path || '/',
    expires: Number.isFinite(expira) && expira > 0 ? expira : -1,
    httpOnly: Boolean(c.httpOnly),
    secure: seguro,
    ...(sameSite && !(sameSite === 'None' && !seguro) ? { sameSite } : {}),
  };
}
function leerLista(entrada) {
  let datos = entrada;
  if (typeof datos === 'string') {
    const texto = datos.trim();
    if (!texto) throw errorHttp(400, 'Pega el JSON de las cookies.');
    try {
      datos = JSON.parse(texto);
    } catch {
      throw errorHttp(400, 'Eso no es JSON. En Cookie Editor pulsa Exportar, elige JSON y copia.');
    }
  }
  if (datos && !Array.isArray(datos) && Array.isArray(datos.cookies)) datos = datos.cookies;
  if (!Array.isArray(datos) || datos.length === 0) {
    throw errorHttp(400, 'El JSON debe ser una lista de cookies, tal como la exporta Cookie Editor.');
  }
  return datos;
}
const vigente = (c) => c.expires === -1 || c.expires * 1000 > Date.now();
function resumir(cookies, def) {
  const nombresLogin = new Set(def.obligatorias.flat());
  const caducidades = cookies.filter((c) => nombresLogin.has(c.name) && c.expires > 0).map((c) => c.expires);
  return {
    total: cookies.length,
    vence: caducidades.length > 0 ? new Date(Math.min(...caducidades) * 1000).toISOString() : null,
  };
}
async function archivoDe(red) {
  const { dir } = await infoAlmacen();
  return path.join(dir, 'cookies-' + red + '.enc');
}
async function escribir(red, contenido) {
  const ruta = await archivoDe(red);
  const temporal = ruta + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  await fs.writeFile(temporal, cifrar(contenido), { mode: 0o600 });
  await fs.rename(temporal, ruta);
}
function marcarConexion(red, estado, extra = {}) {
  store.actualizarConexion(red, { estado, ultimaVerificacion: new Date().toISOString(), ...extra });
}
function estadoDe(resumen) {
  return resumen.vence && new Date(resumen.vence).getTime() < Date.now() ? 'expirada' : 'activa';
}

export async function guardarCookies(red, entrada) {
  const def = definicion(red);
  if (!config.sessionKey) {
    throw errorHttp(503, 'El servidor no puede cifrar la sesion: falta SESSION_KEY o MASTER_KEY en Railway.');
  }
  const convertidas = leerLista(entrada).map(convertir).filter(Boolean);
  const propias = convertidas.filter((c) => def.dominio.test(c.domain.replace(/^\./, '')));
  if (propias.length === 0) {
    throw errorHttp(400, 'Ninguna cookie es de ' + def.nombre + '. Exporta las cookies estando en ' + def.nombre + ' con la sesion iniciada.');
  }
  const vivas = new Set(propias.filter(vigente).map((c) => c.name));
  for (const grupo of def.obligatorias) {
    if (!grupo.some((nombre) => vivas.has(nombre))) {
      throw errorHttp(400, 'Faltan o vencieron las cookies de inicio de sesion de ' + def.nombre + ' (' + grupo.join(' o ') + '). Inicia sesion y vuelve a exportar.');
    }
  }
  const unicas = [...new Map(propias.map((c) => [c.domain + '|' + c.path + '|' + c.name, c])).values()];
  await escribir(red, { cookies: unicas, guardadoEn: new Date().toISOString() });
  const resumen = resumir(unicas, def);
  marcarConexion(red, 'activa', { cuenta: null, expiraEn: resumen.vence });
  store.registrarIncidencia('info', def.nombre + ': sesion vinculada (' + unicas.length + ' cookies)', 'conexiones');
  return resumen;
}
export async function leerCookies(red) {
  definicion(red);
  let texto;
  try {
    texto = await fs.readFile(await archivoDe(red), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const datos = descifrar(texto);
    return Array.isArray(datos.cookies) ? datos.cookies : null;
  } catch {
    throw new Error('No se pudo descifrar la sesion de ' + REDES[red].nombre + ' (cambio SESSION_KEY o MASTER_KEY?). Vuelve a pegar las cookies.');
  }
}
export async function estadoCookies(red) {
  const def = definicion(red);
  try {
    const cookies = await leerCookies(red);
    if (!cookies) return { guardada: false };
    return { guardada: true, ...resumir(cookies, def) };
  } catch (error) {
    return { guardada: false, error: error.message };
  }
}
export async function borrarCookies(red) {
  definicion(red);
  await fs.rm(await archivoDe(red), { force: true });
  marcarConexion(red, 'sin_sesion', { cuenta: null, expiraEn: null });
}
export async function listarCookiesRedes() {
  const redes = [];
  for (const red of Object.keys(REDES)) {
    redes.push({ red, nombre: REDES[red].nombre, ...(await estadoCookies(red)) });
  }
  return redes;
}
/** Al arrancar y cada cierto tiempo: las tarjetas reflejan lo guardado en disco (el store vive en memoria). */
export async function sincronizarCookiesRedes() {
  for (const red of await listarCookiesRedes()) {
    if (red.error) marcarConexion(red.red, 'ilegible', { detalle: red.error });
    else if (red.guardada) marcarConexion(red.red, estadoDe(red), { expiraEn: red.vence });
    else marcarConexion(red.red, 'sin_sesion', { cuenta: null, expiraEn: null });
  }
}
