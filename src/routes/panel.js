import { Router } from 'express';
import { config } from '../config/index.js';
import { requireMasterKey } from '../middleware/auth.js';
import { store } from '../storage/store.js';
import { agregarTrabajo, cargaActual } from '../engine/cola.js';
import { parsearUrlYoutube, segundosDesdeUrl } from '../utils/youtube.js';
import { subidaOpcional, origenDeEncolar, descartarSubida } from '../upload.js';
import { sanear } from '../instruccion.js';
import { normalizarEstilo } from '../estilos-subtitulos.js';

const router = Router();
const MODOS = ['recorte', 'blur'];
const subida = subidaOpcional();

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

// Acepta JSON { url, ... } o multipart/form-data con el campo "archivo" (mp4, mov, mkv, webm) y los mismos campos de texto.
// Ademas: instruccion (que buscar, opcional) y estiloSubtitulos (dinamico | clasico | minimal).
router.post('/encolar', subida, async (req, res, next) => {
  try {
    const cuerpo = req.body || {};
    const rechazar = async (mensaje) => {
      await descartarSubida(req);   // si ya se recibio un archivo y la peticion no es valida, no queda huerfano en disco
      res.status(400).json({ ok: false, error: mensaje });
    };

    const origen = origenDeEncolar(req);   // lanza ErrorSubida (400) si faltan ambos o vienen ambos
    const esArchivo = origen.tipo === 'archivo';

    const parsed = esArchivo ? null : parsearUrlYoutube(origen.url);
    if (!esArchivo && !parsed) return await rechazar('Solo se aceptan enlaces validos de YouTube');

    const inicioCuerpo = numeroOpcional(cuerpo.inicio);
    if (Number.isNaN(inicioCuerpo) || (inicioCuerpo !== null && inicioCuerpo < 0)) {
      return await rechazar('El inicio debe ser un numero de segundos mayor o igual a 0');
    }

    const duracionCuerpo = numeroOpcional(cuerpo.duracion);
    if (
      Number.isNaN(duracionCuerpo) ||
      (duracionCuerpo !== null && (duracionCuerpo < 1 || duracionCuerpo > config.maxClipSeconds))
    ) {
      return await rechazar('La duracion debe estar entre 1 y ' + config.maxClipSeconds + ' segundos');
    }

    const cantidadCuerpo = numeroOpcional(cuerpo.cantidad);
    if (
      Number.isNaN(cantidadCuerpo) ||
      (cantidadCuerpo !== null && (!Number.isInteger(cantidadCuerpo) || cantidadCuerpo < 1 || cantidadCuerpo > config.segmentsMax))
    ) {
      return await rechazar('La cantidad de clips debe ser un entero entre 1 y ' + config.segmentsMax);
    }

    const modo = cuerpo.modo === undefined || cuerpo.modo === '' ? config.defaultRenderMode : cuerpo.modo;
    if (!MODOS.includes(modo)) return await rechazar('El modo debe ser recorte o blur');

    let estiloSubtitulos;
    try {
      estiloSubtitulos = normalizarEstilo(cuerpo.estiloSubtitulos);
    } catch (error) {
      return await rechazar(error.message);
    }
    const instruccion = sanear(cuerpo.instruccion);

    if (cargaActual() >= config.maxQueue) {
      await descartarSubida(req);
      res.status(429).json({ ok: false, error: 'La cola esta llena, espera a que terminen los trabajos en curso' });
      return;
    }

    // Por defecto el sistema elige solo 4-5 momentos distintos del video (modo automatico). Si la peticion
    // indica un inicio o una duracion concretos (o el enlace trae ?t=), se respeta como corte manual unico.
    const inicioUrl = esArchivo ? 0 : segundosDesdeUrl(parsed);
    const manual = inicioCuerpo !== null || duracionCuerpo !== null || inicioUrl > 0;

    const fuente = esArchivo ? origen.nombreOriginal || 'Archivo local' : parsed.toString();
    const clip = store.encolar(fuente, { origen: origen.tipo, instruccion, estiloSubtitulos });
    agregarTrabajo({
      id: clip.id,
      url: esArchivo ? null : parsed.toString(),
      archivo: esArchivo ? origen : null,
      auto: !manual,
      cantidad: cantidadCuerpo !== null ? cantidadCuerpo : undefined,
      inicio: inicioCuerpo !== null ? inicioCuerpo : inicioUrl,
      duracion: duracionCuerpo !== null ? duracionCuerpo : Math.min(config.defaultClipSeconds, config.maxClipSeconds),
      modo,
      instruccion,
      estiloSubtitulos,
    });

    res.status(201).json({ ok: true, clip });
  } catch (error) {
    await descartarSubida(req);
    next(error);
  }
});

export default router;
