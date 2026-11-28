// ---------------------------------------------------------------------------
//  GET  /api/connections/status         verifica el token de Meta (sin publicar) y refresca las tarjetas Instagram/Facebook
//  POST /api/publish/instagram          publica un Reel por la Graph API: { clipId } o { videoUrl, caption }
//  GET  /api/publish/instagram/:id      estado de una publicacion en curso
// Todas exigen la llave maestra (x-master-key). La publicacion corre en segundo plano (Meta puede tardar minutos);
// con { esperar: true } la peticion espera el resultado. Las publicaciones se serializan: una a la vez.
// ---------------------------------------------------------------------------
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { config } from '../config/index.js';
import { requireMasterKey } from '../middleware/auth.js';
import { store } from '../storage/store.js';
import { logger } from '../utils/logger.js';
import { AppError, comoAppError } from '../utils/errores.js';
import { limpiarClipPublicado } from '../utils/tmpCleaner.js';
import { armarTexto } from '../engine/publicador.js';
import cliente, { urlPublicaDeClip, crosspostFacebookActivo } from '../services/instagramPublisher.js';
import { sincronizadorMeta } from '../services/conexionesMeta.js';

const envolver = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

export function crearRouterConexiones({ sincronizador = sincronizadorMeta } = {}) {
  const router = Router();
  router.use(requireMasterKey);
  router.get('/status', envolver(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const estado = await sincronizador.sincronizar();
    res.status(200).json(estado);
  }));
  return router;
}

/** Texto y rutas de un clip del panel. */
export function especificacionDeClip(clip, { clipsDir = config.clipsDir } = {}) {
  if (!clip) throw new AppError('Clip no encontrado', { status: 404, codigo: 'CLIP_NO_ENCONTRADO' });
  if (!clip.url) throw new AppError('El clip ya no tiene archivo de video.', { status: 409, codigo: 'SIN_VIDEO' });
  const rutaVideo = path.join(clipsDir, path.basename(clip.url));
  const f = clip.ficha || {};
  const m = clip.marketing || {};
  const serie = clip.serie || null;
  const descripcion = (serie && serie.caption) || f.descripcion || clip.copy || m.descripcion || f.titulo || m.titulo || clip.titulo || '';
  const etiquetas = f.hashtags || m.hashtags || [];
  return { rutaVideo, caption: armarTexto(descripcion, etiquetas) };
}

export function crearRouterPublicar({ api = cliente, almacen = store, limpiar = limpiarClipPublicado, urlPublica = urlPublicaDeClip, crosspost = crosspostFacebookActivo } = {}) {
  const router = Router();
  router.use(requireMasterKey);
  const trabajos = new Map();
  let cadena = Promise.resolve();

  const resumen = (t) => ({ id: t.id, estado: t.estado, fase: t.fase, clipId: t.clipId, creadoEn: t.creadoEn, resultado: t.resultado, error: t.error });

  async function ejecutar(t, spec) {
    t.estado = 'publicando';
    try {
      await fs.access(spec.rutaVideo).catch(() => { if (!spec.videoUrl) throw new AppError('No existe el archivo del clip en el servidor.', { status: 409, codigo: 'ARCHIVO_NO_ENCONTRADO' }); });
      const videoUrl = spec.videoUrl || urlPublica(spec.rutaVideo);
      const r = await api.publishInstagramReel({ videoUrl, caption: spec.caption, onProgreso: (p) => { t.fase = p.fase; } });
      t.estado = 'publicado';
      t.fase = 'listo';
      t.resultado = { mediaId: r.mediaId, permalink: r.permalink, containerId: r.containerId, crosspost_facebook: crosspost() };
      if (spec.clipId) {
        const clip = almacen.buscar(spec.clipId);
        almacen.actualizar(spec.clipId, {
          estado: 'publicado', publicadoEn: new Date().toISOString(),
          plataformas: [...new Set([...(clip && clip.plataformas) || [], 'instagram'])],
          instagram: { mediaId: r.mediaId, permalink: r.permalink, publicadoEn: new Date().toISOString() },
        });
        await limpiar({ rutaVideo: spec.rutaVideo, almacen });
      }
    } catch (error) {
      const e = comoAppError(error);
      t.estado = 'fallido';
      t.error = { mensaje: e.message, codigo: e.codigo, transitorio: e.transitorio };
      logger.warn('Instagram: publicacion fallida', { id: t.id, codigo: e.codigo, mensaje: e.message });
    }
  }

  router.post('/instagram', envolver(async (req, res) => {
    const cuerpo = req.body || {};
    let spec;
    if (cuerpo.clipId) {
      const clip = almacen.buscar(String(cuerpo.clipId));
      if (clip && clip.instagram && clip.instagram.mediaId && cuerpo.forzar !== true) {
        throw new AppError('Este clip ya se publico en Instagram. Envia { "forzar": true } para repetirlo.', { status: 409, codigo: 'YA_PUBLICADO' });
      }
      spec = { ...especificacionDeClip(clip), clipId: clip.id };
      if (typeof cuerpo.caption === 'string' && cuerpo.caption.trim()) spec.caption = cuerpo.caption.trim();
    } else if (cuerpo.videoUrl) {
      spec = { videoUrl: String(cuerpo.videoUrl), caption: String(cuerpo.caption || ''), rutaVideo: '' };
    } else {
      throw new AppError('Indica clipId (un clip del panel) o videoUrl (https publica) y caption.', { status: 400, codigo: 'PETICION_INVALIDA' });
    }

    const t = { id: 'pub_' + crypto.randomBytes(4).toString('hex'), estado: 'en_cola', fase: 'en_cola', clipId: spec.clipId || null, creadoEn: new Date().toISOString(), resultado: null, error: null };
    trabajos.set(t.id, t);
    while (trabajos.size > 50) trabajos.delete(trabajos.keys().next().value);
    const promesa = (cadena = cadena.then(() => ejecutar(t, spec)));
    res.set('Cache-Control', 'no-store');
    if (cuerpo.esperar === true) {
      await promesa;
      res.status(t.estado === 'publicado' ? 200 : (t.error && t.error.transitorio ? 502 : 422)).json({ ok: t.estado === 'publicado', ...resumen(t), error: t.error ? t.error.mensaje : undefined });
      return;
    }
    res.status(202).json({ ok: true, ...resumen(t) });
  }));

  router.get('/instagram/:id', (req, res) => {
    const t = trabajos.get(String(req.params.id));
    if (!t) return res.status(404).json({ ok: false, error: 'Publicacion no encontrada' });
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, ...resumen(t), error: t.error ? t.error.mensaje : undefined, codigo: t.error ? t.error.codigo : undefined });
  });

  return router;
}

export const routerConexiones = crearRouterConexiones();
export const routerPublicar = crearRouterPublicar();
