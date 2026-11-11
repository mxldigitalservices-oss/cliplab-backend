import { logger } from '../utils/logger.js';

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = Number.isInteger(err.status) ? err.status : 500;

  logger.error('Error no controlado en request', err);

  res.status(status).json({
    ok: false,
    error: status === 500 ? 'Error interno del servidor' : err.message,
  });
}
