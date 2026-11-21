import { Router } from 'express';
import multer from 'multer';
import { config } from '../config/index.js';
import { requireMasterKey } from '../middleware/auth.js';
import { store } from '../storage/store.js';
import { agregarTrabajo, cargaActual } from '../engine/cola.js';
import { parsearUrlYoutube } from '../utils/youtube.js';
import { ErrorAjustes, sanearAjustes, esNeutro, resumen } from '../ajustes.js';
import { guardarLogo, rutaLogo, borrarLogo, MAX_LOGO_BYTES } from '../logos.js';

// Controles de lote del panel: logo/foto propio y "Aplicar a todos" (re-render de clips ya hechos con nuevos ajustes).
const router = Router();
router.use(requireMasterKey);

const MAX_IDS = 20;

const recibirLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_BYTES, files: 1, fields: 4, parts: 8 },
}).single('logo');

function traducir(err) {
  if (err && err.code === 'LIMIT_FILE_SIZE') return new ErrorAjustes('La imagen supera los ' + MAX_LOGO_BYTES / 1048576 + ' MB');
  return new ErrorAjustes('No pude procesar la subida: envia una sola imagen en el campo "logo"');
}

// POST /api/panel/logo  (multipart, campo "logo": png, jpg o webp) -> { logo: { id, ancho, alto, conAlfa, fondoDetectado, fondoColor } }
router.post('/logo', (req, res, next) => {
  if (!req.is('multipart/form-data')) return next(new ErrorAjustes('Envia la imagen como multipart/form-data en el campo "logo"'));
  recibirLogo(req, res, (err) => (err ? next(traducir(err)) : next()));
}, async (req, res, next) => {
  try {
    if (!req.file) throw new ErrorAjustes('Falta la imagen (campo "logo")');
    res.status(201).json({ ok: true, logo: await guardarLogo(req.file.buffer) });
  } catch (error) {
    next(error);
  }
});

// GET /api/panel/logo/:id[?sinFondo=1]  -> PNG (el panel lo pide con la llave y lo muestra como blob)
router.get('/logo/:id', async (req, res) => {
  const ruta = (await rutaLogo(req.params.id, req.query.sinFondo === '1')) || null;
  if (!ruta) {
    res.status(404).json({ ok: false, error: 'Logo no encontrado' });
    return;
  }
  res.set('Cache-Control', 'private, max-age=3600');
  res.type('png');
  res.sendFile(ruta, { dotfiles: 'allow' });
});

router.delete('/logo/:id', async (req, res) => {
  await borrarLogo(req.params.id);
  res.status(200).json({ ok: true });
});

// POST /api/panel/lote/aplicar  { ids: [clipId...], ajustes }
// Cada clip listo se vuelve a renderizar DESDE EL VIDEO ORIGINAL con los ajustes (asi subtitulos y logos salen bien con
// espejo o velocidad). El resultado es un clip NUEVO (variante): el original no se toca. Un clip que no se puede
// repetir (video subido, sin datos del corte, cola llena) se devuelve en `omitidos` con el motivo.
router.post('/lote/aplicar', (req, res, next) => {
  try {
    const cuerpo = req.body || {};
    const ids = [...new Set(Array.isArray(cuerpo.ids) ? cuerpo.ids.map(String) : [])];
    if (ids.length === 0) throw new ErrorAjustes('Selecciona al menos un clip');
    if (ids.length > MAX_IDS) throw new ErrorAjustes('Aplica a ' + MAX_IDS + ' clips como maximo por vez');
    const ajustes = sanearAjustes(cuerpo.ajustes);
    if (!ajustes || esNeutro(ajustes)) throw new ErrorAjustes('No hay ajustes que aplicar: cambia algun control primero');

    const encolados = [];
    const omitidos = [];
    for (const id of ids) {
      const clip = store.buscar(id);
      const parsed = clip && clip.origen !== 'archivo' ? parsearUrlYoutube(clip.fuente) : null;
      let motivo = null;
      if (!clip) motivo = 'El clip ya no existe';
      else if (clip.estado !== 'listo' && clip.estado !== 'publicado') motivo = 'Todavia no esta listo';
      else if (clip.origen === 'archivo') motivo = 'Es un video subido: el original ya no se conserva en el servidor';
      else if (!parsed || !clip.segmento) motivo = 'Faltan los datos del video original o del corte';
      else if (cargaActual() >= config.maxQueue) motivo = 'La cola esta llena';
      if (motivo) {
        omitidos.push({ id, motivo });
        continue;
      }

      const nuevo = store.encolar(parsed.toString(), { origen: 'url', instruccion: clip.instruccion, estiloSubtitulos: clip.estiloSubtitulos });
      store.actualizar(nuevo.id, { ajustes, varianteDe: clip.id });
      agregarTrabajo({
        id: nuevo.id,
        url: parsed.toString(),
        archivo: null,
        auto: false,
        inicio: clip.segmento.inicio,
        duracion: clip.segmento.duracion,
        modo: clip.modo === 'blur' ? 'blur' : 'recorte',
        instruccion: clip.instruccion || null,
        estiloSubtitulos: clip.estiloSubtitulos || 'auto',
        ajustes,
      });
      encolados.push({ origen: id, id: nuevo.id });
    }
    res.status(encolados.length ? 201 : 200).json({ ok: true, encolados, omitidos, ajustes: resumen(ajustes) });
  } catch (error) {
    next(error);
  }
});

export default router;
