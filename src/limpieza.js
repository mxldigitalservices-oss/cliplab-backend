// Seleccion (pura) de los clips que salen de la bandeja activa. Un clip archivado NO se borra: solo deja de viajar en
// /api/panel/estado, asi el panel (DOM, videos, JSON de cada sondeo) se mantiene liviano. Nunca se archiva un clip en proceso.
export class ErrorLimpieza extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorLimpieza';
    this.status = 400;
  }
}

export const MODOS_LIMPIEZA = Object.freeze(['descargados', 'procesados']);

const terminado = (c) => !c.archivadoEn && (c.estado === 'listo' || c.estado === 'publicado');

/**
 * descargados: clips que ya se descargaron.
 * procesados: descargados + enviados a #clips (tanda) + publicados.
 */
export function seleccionarParaLimpiar(clips, modo) {
  const lista = Array.isArray(clips) ? clips : [];
  if (modo === 'descargados') return lista.filter((c) => terminado(c) && c.descargadoEn).map((c) => c.id);
  if (modo === 'procesados') {
    return lista.filter((c) => terminado(c) && (c.descargadoEn || c.enviadoEn || c.estado === 'publicado')).map((c) => c.id);
  }
  throw new ErrorLimpieza('El modo debe ser descargados o procesados');
}
