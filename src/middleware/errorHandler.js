import { logger } from '../utils/logger.js';
import { detalleDeError } from '../utils/run.js';

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = Number.isInteger(err.status) ? err.status : 500;

  logger.error('Error no controlado en request', err);

  let mensaje = status === 500 ? 'Error interno del servidor' : err.message;
  if (err.type === 'entity.parse.failed') mensaje = 'El cuerpo de la peticion no es un JSON valido';
  if (err.type === 'entity.too.large') mensaje = 'El cuerpo de la peticion es demasiado grande';

  const cuerpo = { ok: false, error: mensaje };
  // El stderr completo viaja con el error (la pestana de Incidencias y los clientes lo muestran).
  const stderr = err.detalle || (err.stderr ? detalleDeError(err) : '');
  if (stderr) cuerpo.stderr = stderr;

  if (res.headersSent) return;
  res.status(status).json(cuerpo);
}
