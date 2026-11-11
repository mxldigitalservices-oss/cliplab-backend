const CLAVE_STORAGE = 'cliplab.masterKey';
const TIMEOUT_MS = 8000;

export function leerLlave() {
  try {
    return localStorage.getItem(CLAVE_STORAGE) || '';
  } catch {
    return '';
  }
}

export function guardarLlave(valor) {
  try {
    if (valor) {
      localStorage.setItem(CLAVE_STORAGE, valor);
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
  const { metodo = 'GET', cuerpo, signal } = opciones;

  const controlador = new AbortController();
  let vencido = false;
  const temporizador = setTimeout(() => {
    vencido = true;
    controlador.abort();
  }, TIMEOUT_MS);

  if (signal) {
    if (signal.aborted) {
      clearTimeout(temporizador);
      throw new ApiError('Solicitud cancelada', 0, true);
    }
    signal.addEventListener('abort', () => controlador.abort(), { once: true });
  }

  const cabeceras = { Accept: 'application/json' };
  const llave = leerLlave();
  if (llave) {
    cabeceras['x-master-key'] = llave;
  }
  if (cuerpo !== undefined) {
    cabeceras['Content-Type'] = 'application/json';
  }

  let respuesta;
  try {
    respuesta = await fetch(ruta, {
      method: metodo,
      headers: cabeceras,
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
      signal: controlador.signal,
      cache: 'no-store',
    });
  } catch {
    if (signal?.aborted && !vencido) {
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

  if (!respuesta.ok) {
    throw new ApiError((datos && datos.error) || 'Error ' + respuesta.status, respuesta.status);
  }

  return datos;
}

export function obtenerEstado(signal) {
  return solicitar('/api/panel/estado', { signal });
}

export function encolarVideo(url) {
  return solicitar('/api/panel/encolar', { metodo: 'POST', cuerpo: { url } });
}
