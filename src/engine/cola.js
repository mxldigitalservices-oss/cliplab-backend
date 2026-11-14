import { logger } from '../utils/logger.js';
import { store } from '../storage/store.js';
import { procesarClip } from './pipeline.js';
import { resumirStderr } from '../utils/run.js';

const pendientes = [];
let ejecutando = false;
let detenido = false;
let controladorActual = null;

async function ejecutar(trabajo) {
  const controlador = new AbortController();
  controladorActual = controlador;
  logger.info('Trabajo iniciado', { id: trabajo.id, inicio: trabajo.inicio, duracion: trabajo.duracion, modo: trabajo.modo });

  try {
    await procesarClip(trabajo, controlador.signal);
    logger.info('Trabajo completado', { id: trabajo.id });
  } catch (error) {
    const detalle = error.detalle || resumirStderr(error.stderr);
    logger.error('Trabajo fallido', { id: trabajo.id, mensaje: error.message, detalle });
    store.fallar(trabajo.id, error.message, detalle);
  } finally {
    controladorActual = null;
  }
}

async function bucle() {
  try {
    while (!detenido && pendientes.length > 0) {
      const trabajo = pendientes.shift();
      await ejecutar(trabajo);
    }
  } finally {
    ejecutando = false;
  }
}

function despertar() {
  if (ejecutando || detenido) return;
  ejecutando = true;
  setImmediate(() => {
    bucle().catch((error) => logger.error('Error en el bucle de la cola', error));
  });
}

export function agregarTrabajo(trabajo) {
  pendientes.push(trabajo);
  despertar();
}

export function cargaActual() {
  return pendientes.length + (controladorActual ? 1 : 0);
}

export function detenerCola() {
  detenido = true;
  if (controladorActual) {
    controladorActual.abort();
  }
}
