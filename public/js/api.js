const CLAVE_STORAGE = 'cliplab.masterKey';
const TIMEOUT_MS = 8000;
const TIMEOUT_SUBIDA_MS = 15 * 60 * 1000;   // subir un video pesado tarda mucho mas que una consulta normal
const INVISIBLES = /[\u200B-\u200D\u2060\uFEFF]/g;
const CABECERA_VALIDA = /^[\x20-\x7E]+$/;

function limpiarLlave(valor) {
  let limpio = String(valor || '').replace(INVISIBLES, '').trim();
  const comilla = limpio.charAt(0);
  if (limpio.length >= 2 && (comilla === '"' || comilla === "'") && limpio.endsWith(comilla)) {
    limpio = limpio.slice(1, -1).trim();
  }
  return limpio;
}

export function leerLlave() {
  try {
    return limpiarLlave(localStorage.getItem(CLAVE_STORAGE));
  } catch {
    return '';
  }
}

export function guardarLlave(valor) {
  try {
    const limpia = limpiarLlave(valor);
    if (limpia) {
      localStorage.setItem(CLAVE_STORAGE, limpia);
    } else {
      localStorage.removeItem(CLAVE_STORAGE);
    }
  } catch {
    // Navegador sin almacenamiento disponible: se ignora.
  }
}

export class ApiError extends Error {
  constructor(mensaje, status, cancelado = false) {
    super(mensaje);
    this.name = 'ApiError';
    this.status = status;
    this.cancelado = cancelado;
    this.requiereLlave = status === 401;
  }
}

async function solicitar(ruta, opciones = {}) {
  const { metodo = 'GET', cuerpo, formulario, signal, timeoutMs = TIMEOUT_MS } = opciones;

  const cabeceras = { Accept: 'application/json' };
  const llave = leerLlave();
  if (llave) {
    if (!CABECERA_VALIDA.test(llave)) {
      throw new ApiError('La llave guardada tiene caracteres no validos (acentos o comillas curvas). Borrala y pega la correcta.', 401);
    }
    cabeceras['x-master-key'] = llave;
  }
  // Con FormData NO se fija Content-Type: el navegador lo pone con el boundary del multipart.
  if (cuerpo !== undefined && formulario === undefined) {
    cabeceras['Content-Type'] = 'application/json';
  }

  const controlador = new AbortController();
  let vencido = false;
  const temporizador = setTimeout(() => {
    vencido = true;
    controlador.abort();
  }, timeoutMs);

  if (signal) {
    if (signal.aborted) {
      clearTimeout(temporizador);
      throw new ApiError('Solicitud cancelada', 0, true);
    }
    signal.addEventListener('abort', () => controlador.abort(), { once: true });
  }

  let respuesta;
  try {
    respuesta = await fetch(ruta, {
      method: metodo,
      headers: cabeceras,
      body: formulario !== undefined ? formulario : cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
      signal: controlador.signal,
      cache: 'no-store',
    });
  } catch {
    if (signal && signal.aborted && !vencido) {
      throw new ApiError('Solicitud cancelada', 0, true);
    }
    throw new ApiError(vencido ? 'El servidor no respondio a tiempo' : 'Sin conexion con el servidor', 0);
  } finally {
    clearTimeout(temporizador);
  }

  let datos = null;
  try {
    datos = await respuesta.json();
  } catch {
    datos = null;
  }

  if (!respuesta.ok || (datos && datos.success === false)) {
    throw new ApiError((datos && datos.error) || 'Error ' + respuesta.status, respuesta.status);
  }

  // Respuesta estandar { success, data, error }: el resto del panel sigue recibiendo { ok, ...campos }.
  if (datos && typeof datos === 'object' && 'success' in datos) {
    return { ok: true, ...(datos.data || {}) };
  }

  return datos;
}

export function obtenerEstado(signal) {
  return solicitar('/api/panel/estado', { signal });
}

/**
 * Encola un video. Con `archivo` (File) envia multipart/form-data con el campo "archivo" y los demas campos de texto
 * (sin url: el backend acepta enlace o archivo, nunca ambos). Sin archivo envia JSON como siempre.
 * opciones: modo, cantidad, instruccion, estiloSubtitulos (y inicio/duracion).
 */
export function encolarVideo(url, opciones = {}, archivo = null) {
  if (!archivo) {
    return solicitar('/api/panel/encolar', { metodo: 'POST', cuerpo: { url, ...opciones } });
  }
  const formulario = new FormData();
  for (const [clave, valor] of Object.entries(opciones)) {
    if (valor !== undefined && valor !== null && valor !== '') formulario.append(clave, String(valor));
  }
  formulario.append('archivo', archivo, archivo.name);   // el archivo va al final: los campos de texto llegan antes
  return solicitar('/api/panel/encolar', { metodo: 'POST', formulario, timeoutMs: TIMEOUT_SUBIDA_MS });
}

export function obtenerIncidencia(id, signal) {
  return solicitar('/api/panel/incidencias/' + encodeURIComponent(id), { signal });
}

export function guardarCookiesRed(red, cookies) {
  return solicitar('/api/panel/cookies-redes/' + encodeURIComponent(red), { metodo: 'POST', cuerpo: { cookies } });
}

export function quitarCookiesRed(red) {
  return solicitar('/api/panel/cookies-redes/' + encodeURIComponent(red), { metodo: 'DELETE' });
}
