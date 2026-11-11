import crypto from 'node:crypto';
import { config } from '../config/index.js';

function iguales(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export function requireMasterKey(req, res, next) {
  if (!config.masterKey) {
    if (config.env === 'production') {
      res.status(503).json({
        ok: false,
        error: 'MASTER_KEY no esta configurada en el servidor',
      });
      return;
    }
    next();
    return;
  }

  const enviada = req.get('x-master-key') || '';
  if (enviada && iguales(enviada, config.masterKey)) {
    next();
    return;
  }

  res.status(401).json({
    ok: false,
    error: 'Llave maestra invalida o ausente',
    requiereLlave: true,
  });
}
