import { Router } from 'express';
import { config } from '../config/index.js';
import { requireMasterKey } from '../middleware/auth.js';
import { store } from '../storage/store.js';
import { agregarTrabajo, cargaActual } from '../engine/cola.js';
import { parsearUrlYoutube, segundosDesdeUrl } from '../utils/youtube.js';

const router = Router();
const MODOS = ['recorte', 'blur'];

router.use(requireMasterKey);

function numeroOpcional(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : NaN;
}

router.get('/estado', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, ...store.snapshot() });
});

// stderr completo de una incidencia (el sondeo de /estado solo lleva un resumen).
router.get('/incidencias/:id', (req, res) => {
  const incidencia = store.obtenerIncidencia(req.params.id);
  if (!incidencia) {
    res.status(404).json({ ok: false, error: 'Incidencia no encontrada' });
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, incidencia });
});

router.post('/encolar', (req, res) => {
  const cuerpo = req.body || {};
  const parsed = parsearUrlYoutube(cuerpo.url);

  if (!parsed) {
    res.status(400).json({ ok: false, error: 'Solo se aceptan enlaces validos de YouTube' });
    return;
  }

  const inicioCuerpo = numeroOpcional(cuerpo.inicio);
  if (Number.isNaN(inicioCuerpo) || (inicioCuerpo !== null && inicioCuerpo < 0)) {
    res.status(400).json({ ok: false, error: 'El inicio debe ser un numero de segundos mayor o igual a 0' });
    return;
  }

  const duracionCuerpo = numeroOpcional(cuerpo.duracion);
  if (
    Number.isNaN(duracionCuerpo) ||
    (duracionCuerpo !== null && (duracionCuerpo < 1 || duracionCuerpo > config.maxClipSeconds))
  ) {
    res.status(400).json({ ok: false, error: 'La duracion debe estar entre 1 y ' + config.maxClipSeconds + ' segundos' });
    return;
  }

  const cantidadCuerpo = numeroOpcional(cuerpo.cantidad);
  if (
    Number.isNaN(cantidadCuerpo) ||
    (cantidadCuerpo !== null && (!Number.isInteger(cantidadCuerpo) || cantidadCuerpo < 1 || cantidadCuerpo > config.segmentsMax))
  ) {
    res.status(400).json({ ok: false, error: 'La cantidad de clips debe ser un entero entre 1 y ' + config.segmentsMax });
    return;
  }

  const modo = cuerpo.modo === undefined ? config.defaultRenderMode : cuerpo.modo;
  if (!MODOS.includes(modo)) {
    res.status(400).json({ ok: false, error: 'El modo debe ser recorte o blur' });
    return;
  }

  if (cargaActual() >= config.maxQueue) {
    res.status(429).json({ ok: false, error: 'La cola esta llena, espera a que terminen los trabajos en curso' });
    return;
  }

  // Por defecto el sistema elige solo 4-5 momentos distintos del video (modo automatico). Si la peticion
  // indica un inicio o una duracion concretos (o el enlace trae ?t=), se respeta como corte manual unico.
  const inicioUrl = segundosDesdeUrl(parsed);
  const manual = inicioCuerpo !== null || duracionCuerpo !== null || inicioUrl > 0;

  const clip = store.encolar(parsed.toString());
  agregarTrabajo({
    id: clip.id,
    url: parsed.toString(),
    auto: !manual,
    cantidad: cantidadCuerpo !== null ? cantidadCuerpo : undefined,
    inicio: inicioCuerpo !== null ? inicioCuerpo : inicioUrl,
    duracion: duracionCuerpo !== null ? duracionCuerpo : Math.min(config.defaultClipSeconds, config.maxClipSeconds),
    modo,
  });

  res.status(201).json({ ok: true, clip });
});

export default router;
