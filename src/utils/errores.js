// ---------------------------------------------------------------------------
// Errores estandar de ClipLab Pro.
//  - AppError: lleva `status` (HTTP), `codigo` (estable, para el panel y los reintentos), `transitorio` (true = vale la
//    pena reintentar) y `detalle` (texto tecnico SIN secretos). El errorHandler de Express y el programador lo entienden.
//  - ocultarSecretos(): quita tokens/llaves de cualquier texto antes de registrarlo o devolverlo.
// ---------------------------------------------------------------------------
export class AppError extends Error {
  constructor(mensaje, { status = 500, codigo = 'ERROR', transitorio = false, detalle = '', causa } = {}) {
    super(mensaje);
    this.name = this.constructor.name;
    this.status = status;
    this.codigo = codigo;
    this.transitorio = transitorio;
    if (detalle) this.detalle = String(detalle);
    if (causa) this.causa = causa;
  }
}

/** Quita secretos de un texto. `extra` = valores concretos a ocultar (p. ej. el token y el app secret en uso). */
export function ocultarSecretos(texto, extra = []) {
  let salida = String(texto ?? '');
  for (const valor of extra) {
    if (valor && String(valor).length >= 6) salida = salida.split(String(valor)).join('[oculto]');
  }
  return salida
    .replace(/\b(access_token|appsecret_proof|client_secret|input_token|fb_exchange_token)=[^&\s"']+/gi, '$1=[oculto]')
    .replace(/("(?:access_token|client_secret)"\s*:\s*")[^"]+(")/gi, '$1[oculto]$2')
    .replace(/\b(?:EA|IG)[A-Za-z0-9]{40,}\b/g, '[oculto]');   // forma habitual de los tokens de Meta
}

/** Normaliza cualquier cosa lanzada a un AppError (sin perder status/codigo/transitorio si ya los traia). */
export function comoAppError(error, porDefecto = {}) {
  if (error instanceof AppError) return error;
  const e = error instanceof Error ? error : new Error(String(error));
  return new AppError(e.message, {
    status: Number.isInteger(e.status) ? e.status : (porDefecto.status ?? 500),
    codigo: e.codigo || porDefecto.codigo || 'ERROR',
    transitorio: typeof e.transitorio === 'boolean' ? e.transitorio : Boolean(porDefecto.transitorio),
    detalle: e.detalle || '',
    causa: e,
  });
}

/** Forma de resultado por canal que entiende el programador: { ok, error, codigo, detalle, timestamp, transitorio }. */
export function resultadoDeError(error, ahora = () => new Date().toISOString()) {
  const e = comoAppError(error);
  return {
    ok: false,
    error: e.message,
    codigo: e.codigo,
    transitorio: e.transitorio,
    detalle: String(e.detalle || e.message).slice(0, 500),
    timestamp: ahora(),
  };
}
