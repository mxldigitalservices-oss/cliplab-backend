'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { generarCopy } = require('./marketing');
const { enviarADistribucion, firmarDescarga, verificarDescarga } = require('./distribucion');

const SQL_CLIP = `
  SELECT c.*, t.url AS origen_url, t.video_titulo AS origen_titulo, t.palabras_clave
  FROM vivo_clips c JOIN trabajos_cola t ON t.id = c.trabajo_id
  WHERE c.id = $1`;

const parseId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const cargarClip = async (pool, id) => (await pool.query(SQL_CLIP, [id])).rows[0] || null;
const vistaDist = (c) => ({ estado: c.distribucion_estado, at: c.distribucion_at, error: c.distribucion_error });
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('[marketing]', e);
  res.status(500).json({ error: 'Error interno' });
});

/** Genera (o regenera) y persiste el copy. Úsala también desde el worker al completar un clip. */
async function generarYGuardarCopy(pool, id, { regenerar = false } = {}) {
  const clip = await cargarClip(pool, id);
  if (!clip) return null;
  if (clip.copy_marketing && !regenerar) return clip;
  const variante = regenerar ? clip.copy_variante + 1 : clip.copy_variante;
  const copy = generarCopy(clip, variante);
  const { rows } = await pool.query(
    'UPDATE vivo_clips SET copy_marketing = $2, copy_variante = $3 WHERE id = $1 RETURNING copy_marketing, copy_variante',
    [id, copy, variante]
  );
  return { ...clip, ...rows[0] };
}

function crearRutasMarketing({ pool, baseUrl = process.env.PUBLIC_BASE_URL, resolverArchivo } = {}) {
  // AJUSTA si tu columna con la ruta del mp4 se llama distinto.
  const rutaDe = resolverArchivo || ((c) => c.ruta_archivo || c.archivo || c.ruta);
  const base = (req) => (baseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

  const privado = express.Router();
  const publico = express.Router();

  privado.get('/clips/:id/copy', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const clip = id && await generarYGuardarCopy(pool, id);
    if (!clip) return res.status(404).json({ error: 'Clip no encontrado' });
    res.json({ copy: clip.copy_marketing, distribucion: vistaDist(clip) });
  }));

  privado.post('/clips/:id/copy/regenerar', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const clip = id && await generarYGuardarCopy(pool, id, { regenerar: true });
    if (!clip) return res.status(404).json({ error: 'Clip no encontrado' });
    res.json({ copy: clip.copy_marketing, distribucion: vistaDist(clip) });
  }));

  privado.post('/clips/:id/distribuir', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const clip = id && await cargarClip(pool, id);
    if (!clip) return res.status(404).json({ error: 'Clip no encontrado' });
    if (clip.estado !== 'completado') return res.status(409).json({ error: 'El clip aún no está completado' });

    const lock = await pool.query(
      `UPDATE vivo_clips SET distribucion_estado = 'enviando', distribucion_error = NULL
       WHERE id = $1 AND COALESCE(distribucion_estado, '') <> 'enviando' RETURNING id`, [id]);
    if (!lock.rowCount) return res.status(409).json({ error: 'Ya hay un envío en curso' });

    try {
      const conCopy = await generarYGuardarCopy(pool, id);
      const ruta = rutaDe(conCopy);
      if (!ruta || !fs.existsSync(ruta)) throw new Error('Archivo del clip no encontrado en disco');
      const { exp, sig } = firmarDescarga(id);
      const urlArchivo = `${base(req)}/api/clips/${id}/archivo?exp=${exp}&sig=${sig}`;
      await enviarADistribucion({ clip: conCopy, copy: conCopy.copy_marketing, urlArchivo, rutaArchivo: ruta, expiraEn: exp });
      const { rows } = await pool.query(
        `UPDATE vivo_clips SET distribucion_estado = 'enviado', distribucion_at = now(), distribucion_error = NULL
         WHERE id = $1 RETURNING distribucion_estado, distribucion_at, distribucion_error`, [id]);
      res.json({ distribucion: vistaDist(rows[0]) });
    } catch (e) {
      await pool.query(`UPDATE vivo_clips SET distribucion_estado = 'error', distribucion_error = $2 WHERE id = $1`,
        [id, String(e.message).slice(0, 300)]);
      res.status(502).json({ error: `Distribución fallida: ${e.message}` });
    }
  }));

  // Pública, pero protegida por firma HMAC con caducidad (la consume el webhook externo).
  publico.get('/clips/:id/archivo', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id || !verificarDescarga(id, req.query.exp, req.query.sig)) {
      return res.status(403).json({ error: 'Enlace inválido o expirado' });
    }
    const clip = await cargarClip(pool, id);
    const ruta = clip && clip.estado === 'completado' && rutaDe(clip);
    if (!ruta || !fs.existsSync(ruta)) return res.status(404).json({ error: 'Archivo no disponible' });
    res.download(ruta, `clip-${id}${path.extname(ruta) || '.mp4'}`);
  }));

  return { privado, publico };
}

module.exports = { crearRutasMarketing, generarYGuardarCopy };
