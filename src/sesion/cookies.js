const AUTENTICACION = ['SID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO', 'SAPISID'];
const DOMINIO_VALIDO = /(^|\.)(youtube\.com|google\.com|googlevideo\.com|ytimg\.com)$/i;

export const ENCABEZADO = '# Netscape HTTP Cookie File';

export function errorHttp(status, mensaje) {
  const error = new Error(mensaje);
  error.status = status;
  return error;
}

const limpio = (texto) => String(texto ?? '').replace(/[\t\r\n]/g, '');

function entero(valor) {
  const numero = Math.floor(Number(valor));
  return Number.isFinite(numero) && numero > 0 ? numero : 0;
}

export function parsearNetscape(texto) {
  const salida = [];
  for (const cruda of String(texto ?? '').split('\n')) {
    let linea = cruda.replace(/\r$/, '');
    if (!linea.trim()) continue;

    let httpOnly = false;
    if (linea.startsWith('#HttpOnly_')) {
      httpOnly = true;
      linea = linea.slice('#HttpOnly_'.length);
    } else if (linea.trimStart().startsWith('#')) {
      continue;
    }

    let partes = linea.split('\t');
    if (partes.length < 7) partes = linea.trim().split(/\s+/);
    if (partes.length < 7) continue;

    const [dominio, subdominios, ruta, seguro, expira, nombre, ...resto] = partes;
    salida.push({
      dominio,
      subdominios: subdominios.toUpperCase() === 'TRUE',
      ruta: ruta || '/',
      seguro: seguro.toUpperCase() === 'TRUE',
      expira: entero(expira),
      nombre,
      valor: resto.join('\t'),
      httpOnly,
    });
  }
  return salida;
}

export function parsearJson(texto) {
  let datos = JSON.parse(texto);
  if (!Array.isArray(datos)) {
    datos = datos && Array.isArray(datos.cookies) ? datos.cookies : [];
  }
  return datos
    .filter((c) => c && c.name && c.domain)
    .map((c) => ({
      dominio: String(c.domain),
      subdominios: String(c.domain).startsWith('.') || c.hostOnly === false,
      ruta: c.path || '/',
      seguro: Boolean(c.secure),
      expira: entero(c.expirationDate ?? c.expires),
      nombre: String(c.name),
      valor: String(c.value ?? ''),
      httpOnly: Boolean(c.httpOnly),
    }));
}

export function parsearCookies(texto) {
  const contenido = String(texto ?? '').trim();
  let lista;

  if (contenido.startsWith('[') || contenido.startsWith('{')) {
    try {
      lista = parsearJson(contenido);
    } catch {
      throw errorHttp(400, 'El JSON de cookies no es valido.');
    }
  } else {
    lista = parsearNetscape(contenido);
  }

  if (lista.length === 0) {
    throw errorHttp(400, 'No se reconocio ninguna cookie. Usa el formato cookies.txt (Netscape) o el JSON exportado del navegador.');
  }
  return lista;
}

export function filtrarRelevantes(cookies) {
  return cookies.filter((c) => DOMINIO_VALIDO.test(String(c.dominio).replace(/^\./, '')));
}

export function normalizar(cookies) {
  const unicas = new Map();
  for (const c of cookies) {
    unicas.set(c.dominio + '|' + c.ruta + '|' + c.nombre, c);
  }
  return [...unicas.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, c]) => c);
}

export function serializar(cookies) {
  const lineas = [ENCABEZADO, ''];
  for (const c of cookies) {
    let dominio = limpio(c.dominio);
    if (c.subdominios && !dominio.startsWith('.')) dominio = '.' + dominio;
    lineas.push([
      (c.httpOnly ? '#HttpOnly_' : '') + dominio,
      c.subdominios ? 'TRUE' : 'FALSE',
      limpio(c.ruta || '/'),
      c.seguro ? 'TRUE' : 'FALSE',
      String(c.expira || 0),
      limpio(c.nombre),
      limpio(c.valor),
    ].join('\t'));
  }
  return lineas.join('\n') + '\n';
}

export function resumir(cookies) {
  const auth = cookies.filter((c) => AUTENTICACION.includes(c.nombre));
  const caducidades = auth.map((c) => c.expira).filter((e) => e > 0);
  const vence = caducidades.length > 0 ? Math.min(...caducidades) : null;

  return {
    total: cookies.length,
    dominios: new Set(cookies.map((c) => String(c.dominio).replace(/^\./, ''))).size,
    autenticada: auth.length > 0,
    venceAuth: vence ? new Date(vence * 1000).toISOString() : null,
    vencida: vence !== null && vence * 1000 < Date.now(),
  };
}
