// Utilidades puras de En Vivo (sin DOM propio: reciben nodos o dobles) para poder probarlas con node --test.

/** Parte una lista en tandas de `tam` (por defecto 5). */
export function tandas(lista, tam = 5) {
  const n = Math.max(1, Math.floor(Number(tam)) || 5);
  const salida = [];
  for (let i = 0; i < (lista || []).length; i += n) salida.push(lista.slice(i, i + n));
  return salida;
}

/** Suelta los videos de un contenedor (pausa, quita el src y fuerza al navegador a liberar el buffer) y los saca del DOM. */
export function liberarVideos(raiz) {
  if (!raiz || typeof raiz.querySelectorAll !== 'function') return 0;
  let n = 0;
  for (const v of raiz.querySelectorAll('video')) {
    try {
      v.pause();
      v.removeAttribute('src');
      v.load();
    } finally {
      if (typeof v.remove === 'function') v.remove();
      n += 1;
    }
  }
  return n;
}

export function textoSegundos(seg) {
  const s = Math.max(0, Math.floor(Number(seg) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + r : m + ':' + r;
}

const ETIQUETAS = { inactivo: 'Sin captura', iniciando: 'Conectando…', grabando: 'Capturando en vivo', terminado: 'Transmisión terminada', detenido: 'Detenido', error: 'Error' };

export function textoEstado(sesion) {
  const s = sesion || { estado: 'inactivo' };
  const partes = [ETIQUETAS[s.estado] || s.estado];
  if (s.estado === 'grabando' || s.estado === 'terminado') {
    partes.push(textoSegundos(s.segundosGrabados) + ' capturados');
    partes.push(s.momentos + (s.momentos === 1 ? ' momento' : ' momentos'));
    partes.push('Auto: ' + (s.auto ? 'sí' : 'no'));
  }
  if (s.estado === 'error' && s.error) partes.push(s.error);
  return partes.join(' · ');
}

export const slug = (texto) => String(texto || 'clip').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).toLowerCase() || 'clip';
