// ---------------------------------------------------------------------------
//  POST /api/series                       crea una serie de episodios de 60 s a partir de un enlace de YouTube o un archivo
//                                         (JSON o multipart con el campo "archivo"). Campos opcionales:
//                                         titulo, publicar (true = publica en Instagram en orden), inicio (ISO), intervaloMin,
//                                         hashtags, estiloSubtitulos, modo.
//  GET  /api/series/cola                  estado de la cola ordenada de publicacion
//  POST /api/series/:serieId/cancelar     cancela las partes que aun no se publicaron
//  POST /api/series/partes/:id/reintentar reintenta una parte caida (libera las siguientes de su serie)
// ---------------------------------------------------------------------------
import { Router } from 'express';
import { config } from '../config/index.js';
import { requireMasterKey } from '../middleware/auth.js';
import { store } from '../storage/store.js';
import { agregarTrabajo, cargaActual } from '../engine/cola.js';
import { parsearUrlYoutube } from '../utils/youtube.js';
import { subidaOpcional, origenDeEncolar, descartarSubida } from '../upload.js';
import { AUTO, pedirEstilo, pedirModo } from '../engine/rotacion-flujo.js';
import { AppError } from '../utils/errores.js';
import colaSeries from '../services/seriesQueue.js';

const envolver = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const verdadero = (v) => v === true || /^(1|true|si|on)$/i.test(String(v ?? ''));

export function crearRouterSeries({ cola = colaSeries, almacen = store, encolarTrabajo = agregarTrabajo, carga = cargaActual } = {}) {
  const router = Router();
  const subida = subidaOpcional();
  router.use(requireMasterKey);

  router.post('/', subida, async (req, res, next) => {
    try {
      const cuerpo = req.body || {};
      const origen = origenDeEncolar(req);
      const esArchivo = origen.tipo === 'archivo';
      const parsed = esArchivo ? null : parsearUrlYoutube(origen.url);
      if (!esArchivo && !parsed) throw new AppError('Solo se aceptan enlaces validos de YouTube', { status: 400, codigo: 'URL_INVALIDA' });
      if (carga() >= config.maxQueue) throw new AppError('La cola esta llena, espera a que terminen los trabajos en curso', { status: 429, codigo: 'COLA_LLENA', transitorio: true });
      if (cuerpo.inicio && !Number.isFinite(Date.parse(cuerpo.inicio))) throw new AppError('inicio debe ser una fecha ISO valida', { status: 400, codigo: 'PETICION_INVALIDA' });

      const modo = pedirModo(cuerpo.modo);
      const estiloSubtitulos = pedirEstilo(cuerpo.estiloSubtitulos);
      const hashtags = Array.isArray(cuerpo.hashtags) ? cuerpo.hashtags : String(cuerpo.hashtags || '').split(/[\s,]+/).filter(Boolean);
      const fuente = esArchivo ? origen.nombreOriginal || 'Archivo local' : parsed.toString();
      const clip = almacen.encolar(fuente, { origen: origen.tipo, instruccion: null, estiloSubtitulos: estiloSubtitulos === AUTO ? null : estiloSubtitulos });
      encolarTrabajo({
        id: clip.id, url: esArchivo ? null : parsed.toString(), archivo: esArchivo ? origen : null,
        auto: false, inicio: 0, duracion: 60, modo, instruccion: null, estiloSubtitulos, ajustes: null,
        serie: {
          titulo: String(cuerpo.titulo || '').trim().slice(0, 120) || null,
          publicarInstagram: verdadero(cuerpo.publicar),
          inicioPublicacion: cuerpo.inicio || null,
          intervaloMin: cuerpo.intervaloMin !== undefined ? Number(cuerpo.intervaloMin) : undefined,
          hashtags: hashtags.length ? hashtags : undefined,
        },
      });
      res.status(201).json({ ok: true, clip });
    } catch (error) {
      await descartarSubida(req);
      next(error);
    }
  });

  router.get('/cola', envolver(async (req, res) => {
    await cola.cargar();
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, ...cola.estado() });
  }));

  router.post('/:serieId/cancelar', envolver(async (req, res) => {
    res.status(200).json({ ok: true, canceladas: await cola.cancelarSerie(String(req.params.serieId)) });
  }));

  router.post('/partes/:id/reintentar', envolver(async (req, res) => {
    const item = await cola.reintentar(String(req.params.id));
    if (!item) throw new AppError('Parte no encontrada o no esta en estado fallido', { status: 404, codigo: 'NO_ENCONTRADA' });
    res.status(200).json({ ok: true, item });
  }));

  return router;
}

export default crearRouterSeries();
