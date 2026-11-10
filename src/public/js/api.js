const KEY_STORE = 'mk';
const TIMEOUT_MS = 8000;

let llave = sessionStorage.getItem(KEY_STORE) || '';

export const getLlave = () => llave;

export function setLlave(valor) {
  llave = String(valor || '').trim();
  if (llave) sessionStorage.setItem(KEY_STORE, llave);
  else sessionStorage.removeItem(KEY_STORE);
}

export class ApiError extends Error {
  constructor(mensaje, status = 0) {
    super(mensaje);
    this.status = status;
  }
}

async function pedir(ruta, { method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers = { 'Content-Type': 'application/json' };
  if (llave) headers['x-master-key'] = llave;
  try {
    const r = await fetch(ruta, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    let data = {};
    try { data = await r.json(); } catch (_) { /* respuesta sin JSON */ }
    if (!r.ok) throw new ApiError(data.error || `Error HTTP ${r.status}`, r.status);
    return data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e.name === 'AbortError') throw new ApiError('Tiempo de espera agotado');
    throw new ApiError('Sin conexión con el servidor');
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  salud: () => pedir('/api/salud'),
  estado: () => pedir('/api/estado'),
  instantanea: () => pedir('/api/panel/instantanea'),
  encolar: (url) => pedir('/api/trabajos', { method: 'POST', body: { url } }),
  reintentar: (id) => pedir(`/api/trabajos/${encodeURIComponent(id)}/reintentar`, { method: 'POST' }),
  urlDescarga: (id) => `/api/clips/${encodeURIComponent(id)}/descargar${llave ? `?key=${encodeURIComponent(llave)}` : ''}`,
};
