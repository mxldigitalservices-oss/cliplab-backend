import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const INVISIBLES = /[\u200B-\u200D\u2060\uFEFF]/g;
const AVISO_CADA_MS = 30000;

let ultimoAviso = 0;

export function normalizarLlave(valor) {
  let limpio = String(valor ?? '').replace(INVISIBLES, '').trim();
  const comilla = limpio.charAt(0);
  if (limpio.length >= 2 && (comilla === '"' || comilla === "'") && limpio.endsWith(comilla)) {
    limpio = limpio.slice(1, -1).trim();
  }
  return limpio;
}

if (config.masterKey && config.masterKey !== normalizarLlave(config.masterKey)) {
  logger.warn('MASTER_KEY tiene espacios, saltos de linea o comillas en los extremos. Se normaliza sola, pero conviene corregir la variable en Railway.');
}

function extraerLlave(req) {
  const directa = normalizarLlave(req.get('x-master-key'));
  if (directa) {
    return { valor: directa, cabecera: 'x-master-key' };
  }

  const autorizacion = req.get('authorization');
  if (autorizacion) {
    const valor = normalizarLlave(autorizacion.replace(/^Bearer\s+/i, ''));
    if (valor) {
      return { valor, cabecera: 'authorization' };
    }
  }

  return { valor: '', cabecera: null };
}

function iguales(a, b) {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB);
}

export function requireMasterKey(req, res, next) {
  const esperada = normalizarLlave(config.masterKey);

  if (!esperada) {
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

  const recibida = extraerLlave(req);
  if (recibida.valor && iguales(recibida.valor, esperada)) {
    next();
    return;
  }

  const ahora = Date.now();
  if (ahora - ultimoAviso > AVISO_CADA_MS) {
    ultimoAviso = ahora;
    logger.warn('Llave maestra rechazada', {
      motivo: recibida.cabecera ? 'no coincide' : 'cabecera ausente',
      cabecera: recibida.cabecera,
      longitudRecibida: recibida.valor.length,
      longitudEsperada: esperada.length,
      ruta: req.originalUrl,
    });
  }

  res.status(401).json({
    ok: false,
    error: recibida.cabecera
      ? 'La llave maestra no coincide'
      : 'Falta la llave maestra (cabecera x-master-key)',
    requiereLlave: true,
  });
}
