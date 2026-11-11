'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const secreto = () => process.env.WEBHOOK_SECRET || process.env.MASTER_KEY || '';
const hmac = (txt) => crypto.createHmac('sha256', secreto()).update(txt).digest('hex');

/** Enlace de descarga temporal: el receptor externo nunca ve la llave maestra. */
function firmarDescarga(clipId, ttlSeg = 3600) {
  if (!secreto()) throw new Error('Define WEBHOOK_SECRET (o MASTER_KEY) para firmar enlaces');
  const exp = Math.floor(Date.now() / 1000) + ttlSeg;
  return { exp, sig: hmac(`${clipId}.${exp}`) };
}

function verificarDescarga(clipId, exp, sig) {
  if (!secreto()) return false;
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Math.floor(Date.now() / 1000)) return false;
  const esperado = Buffer.from(hmac(`${clipId}.${e}`));
  const recibido = Buffer.from(String(sig || ''));
  return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
}

/**
 * Envía clip + copy al webhook externo (n8n, Make, Zapier, Buffer, tu propio servicio…).
 *  DISTRIBUCION_MODO=enlace  (defecto) → JSON con URL de descarga firmada
 *  DISTRIBUCION_MODO=archivo           → multipart: campo "metadata" (JSON) + campo "archivo" (mp4)
 * Cabeceras: X-ClipLab-Event, X-ClipLab-Signature (sha256=HMAC del JSON de metadata).
 */
async function enviarADistribucion({ clip, copy, urlArchivo, rutaArchivo, expiraEn }) {
  const destino = process.env.DISTRIBUCION_WEBHOOK_URL;
  if (!destino) throw new Error('DISTRIBUCION_WEBHOOK_URL no está configurada');
  if (!/^https?:\/\//i.test(destino)) throw new Error('DISTRIBUCION_WEBHOOK_URL debe empezar por http(s)://');
  if (!secreto()) throw new Error('Define WEBHOOK_SECRET para firmar el webhook');

  const modo = (process.env.DISTRIBUCION_MODO || 'enlace').toLowerCase();
  const metadata = JSON.stringify({
    evento: 'clip.listo',
    enviado_en: new Date().toISOString(),
    clip: {
      id: clip.id,
      lote_id: clip.trabajo_id,
      titulo: clip.titulo,
      resumen: clip.resumen,
      inicio: clip.marca_tiempo,
      fin: clip.marca_fin,
      duracion: clip.marca_fin - clip.marca_tiempo,
      formato: '9:16',
      origen: { url: clip.origen_url, titulo: clip.origen_titulo },
    },
    marketing: copy,
    archivo: { url: urlArchivo, expira_en: new Date(expiraEn * 1000).toISOString() },
  });

  const headers = { 'X-ClipLab-Event': 'clip.listo', 'X-ClipLab-Signature': `sha256=${hmac(metadata)}` };
  if (process.env.DISTRIBUCION_TOKEN) headers.Authorization = `Bearer ${process.env.DISTRIBUCION_TOKEN}`;

  let body;
  if (modo === 'archivo') {
    const maxMb = Number(process.env.DISTRIBUCION_MAX_MB || 100);
    const { size } = await fs.promises.stat(rutaArchivo);
    if (size > maxMb * 1024 * 1024) throw new Error(`El clip supera ${maxMb} MB; usa DISTRIBUCION_MODO=enlace`);
    const blob = fs.openAsBlob
      ? await fs.openAsBlob(rutaArchivo, { type: 'video/mp4' })
      : new Blob([await fs.promises.readFile(rutaArchivo)], { type: 'video/mp4' });
    body = new FormData();
    body.append('metadata', new Blob([metadata], { type: 'application/json' }), 'metadata.json');
    body.append('archivo', blob, path.basename(rutaArchivo));
  } else {
    headers['Content-Type'] = 'application/json';
    body = metadata;
  }

  const r = await fetch(destino, {
    method: 'POST', headers, body,
    signal: AbortSignal.timeout(modo === 'archivo' ? 120000 : 15000),
  });
  if (!r.ok) throw new Error(`El destino respondió HTTP ${r.status}`);
  return r.status;
}

module.exports = { enviarADistribucion, firmarDescarga, verificarDescarga };
