const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cfg = require('./config');
const db = require('./db');

const router = express.Router();
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function igual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function auth(req, res, next) {
  if (!cfg.masterKey) return next();
  const k = req.get('x-master-key') || req.query.key || '';
  if (k && igual(k, cfg.masterKey)) return next();
  res.status(401).json({ error: 'No autorizado' });
}

router.get('/salud', h(async (_req, res) => {
  await db.query('SELECT 1');
  res.json({ ok: true });
}));

router.use(auth);

router.get('/estado', h(async (_req, res) => {
  const [trabajos, clips, conteo] = await Promise.all([
    db.query(
      `SELECT id, url, estado, intentos, error, video_titulo, palabras_clave, resumen, created_at, updated_at
         FROM trabajos_cola ORDER BY id DESC LIMIT 30`
    ),
    db.query(
      `SELECT id, trabajo_id, titulo, estado, marca_tiempo, marca_fin, resumen, archivo, error, created_at
         FROM vivo_clips ORDER BY id DESC LIMIT 60`
    ),
    db.query('SELECT estado, count(*)::int AS total FROM trabajos_cola GROUP BY estado'),
  ]);
  res.json({
    hora: new Date().toISOString(),
    conteo: Object.fromEntries(conteo.rows.map((r) => [r.estado, r.total])),
    trabajos: trabajos.rows,
    clips: clips.rows,
  });
}));

router.post('/trabajos', h(async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  let u;
  try { u = new URL(url); } catch (_) { return res.status(400).json({ error: 'URL inválida' }); }
  if (!/^https?:$/.test(u.protocol) || url.length > 2048) {
    return res.status(400).json({ error: 'Solo se permiten URLs http/https' });
  }
  const { rows } = await db.query('INSERT INTO trabajos_cola (url) VALUES ($1) RETURNING id, estado', [url]);
  res.status(201).json(rows[0]);
}));

router.post('/trabajos/:id/reintentar', h(async (req, res) => {
  const { rowCount } = await db.query(
    `UPDATE trabajos_cola SET estado='pendiente', intentos=0, error=NULL, updated_at=now()
      WHERE id=$1 AND estado='error'`,
    [Number(req.params.id)]
  );
  if (!rowCount) return res.status(404).json({ error: 'Trabajo no encontrado o no está en error' });
  res.json({ ok: true });
}));

router.get('/clips/:id/descargar', h(async (req, res) => {
  const { rows } = await db.query(
    "SELECT archivo FROM vivo_clips WHERE id=$1 AND estado='completado'",
    [Number(req.params.id)]
  );
  if (!rows.length || !rows[0].archivo) return res.status(404).json({ error: 'Clip no disponible' });
  const ruta = path.join(cfg.exportDir, path.basename(rows[0].archivo));
  if (!fs.existsSync(ruta)) return res.status(410).json({ error: 'Archivo ya no existe en el servidor' });
  res.download(ruta);
}));

module.exports = router;
