import { logger } from '../utils/logger.js';
import { resumirStderr } from '../utils/run.js';

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = Number.isInteger(err.status) ? err.status : 500;

  logger.error('Error no controlado en request', err);

  const cuerpo = {
    ok: false,
    error: status === 500 ? 'Error interno del servidor' : err.message,
  };
  const stderr = err.detalle || resumirStderr(err.stderr);
  if (stderr) cuerpo.stderr = stderr;

  res.status(status).json(cuerpo);
}
