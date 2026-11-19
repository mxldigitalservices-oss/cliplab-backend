// ---------------------------------------------------------------------------
// Persistencia ligera de la rotacion ciclica: un JSON diminuto en dataDir (DATA_DIR; en Railway, el volumen).
//   { "version": 1, "canales": { "estilo": { usadas, ultima, ciclo, total }, ... }, "actualizado": "ISO" }
// El archivo se lee UNA vez (queda en memoria), las operaciones se encadenan para que dos jobs no se pisen, y solo se escribe
// cuando algo cambio (un valor manual no escribe nada). La escritura es atomica (temporal + rename); si el archivo esta
// corrupto se empieza limpio sin lanzar errores.
// ---------------------------------------------------------------------------
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { NOMBRE_CANAL, estadoInicial, resumenCiclo, siguiente, tanda } from './rotacion.js';

const VERSION = 1;
const MAX_CANALES = 50;

export const rutaPorDefecto = () => path.join(config.dataDir, 'rotacion.json');

function validarCanal(canal) {
  if (typeof canal !== 'string' || !NOMBRE_CANAL.test(canal)) {
    throw new Error('Nombre de canal invalido: empieza con una letra y usa hasta 32 letras, numeros, guion o guion bajo');
  }
  return canal.toLowerCase();
}

/**
 * Crea un rotador con su propio archivo. En la app se usa el singleton `rotador`; las pruebas crean uno por carpeta temporal.
 * @param {object} [o]
 * @param {string|(() => string)} [o.ruta]  ruta del JSON (o funcion que la calcula); por defecto dataDir/rotacion.json
 * @param {() => number} [o.azar]  fuente de azar (Math.random por defecto)
 */
export function crearRotador({ ruta = rutaPorDefecto, azar = Math.random } = {}) {
  const archivo = () => (typeof ruta === 'function' ? ruta() : ruta);
  let canales = null; // { [canal]: estado }, cargado de forma perezosa
  let cola = Promise.resolve();
  let escrituras = 0;

  async function cargar() {
    if (canales) return canales;
    canales = Object.create(null);
    try {
      const datos = JSON.parse(await fs.readFile(archivo(), 'utf8'));
      const guardados = datos && typeof datos === 'object' && datos.canales && typeof datos.canales === 'object' ? datos.canales : {};
      for (const nombre of Object.keys(guardados).slice(0, MAX_CANALES)) {
        if (NOMBRE_CANAL.test(nombre)) canales[nombre.toLowerCase()] = guardados[nombre];
      }
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn('Estado de rotacion ilegible: se empieza limpio', { mensaje: error.message });
    }
    return canales;
  }

  async function guardar() {
    const destino = archivo();
    await fs.mkdir(path.dirname(destino), { recursive: true });
    const temporal = destino + '.' + process.pid + '.tmp';
    await fs.writeFile(temporal, JSON.stringify({ version: VERSION, canales, actualizado: new Date().toISOString() }));
    await fs.rename(temporal, destino);
    escrituras++;
  }

  // Las operaciones se encadenan: una falla no frena a las siguientes.
  function serializar(tarea) {
    const resultado = cola.then(tarea, tarea);
    cola = resultado.then(() => undefined, () => undefined);
    return resultado;
  }

  /** Siguiente opcion del canal. Con `manual` valido devuelve esa opcion sin consumir el ciclo ni escribir a disco. */
  async function elegir(canal, opciones, { manual } = {}) {
    const nombre = validarCanal(canal);
    return serializar(async () => {
      const todos = await cargar();
      const r = siguiente(todos[nombre] ?? estadoInicial(), opciones, { manual, azar });
      if (r.origen === 'rotacion') {
        todos[nombre] = r.estado;
        await guardar();
      }
      return { valor: r.valor, origen: r.origen, reinicio: r.reinicio, ciclo: r.estado.ciclo };
    });
  }

  /** n opciones seguidas (una por clip), con una sola escritura a disco. Con `manual` valido, n veces esa opcion. */
  async function elegirTanda(canal, opciones, n, { manual } = {}) {
    const nombre = validarCanal(canal);
    return serializar(async () => {
      const todos = await cargar();
      const r = tanda(todos[nombre] ?? estadoInicial(), opciones, n, { manual, azar });
      const fijo = String(manual ?? '').trim();
      if (!fijo || fijo.toLowerCase() === 'auto') {
        todos[nombre] = r.estado;
        await guardar();
      }
      return { valores: r.valores, reinicios: r.reinicios };
    });
  }

  /** Estado del ciclo del canal (solo lectura). */
  async function estado(canal, opciones) {
    const nombre = validarCanal(canal);
    return serializar(async () => resumenCiclo((await cargar())[nombre] ?? estadoInicial(), opciones));
  }

  /** Reinicia un canal (o todos si no se indica) y borra su rastro del disco. */
  async function reiniciar(canal) {
    const nombre = canal === undefined ? null : validarCanal(canal);
    return serializar(async () => {
      const todos = await cargar();
      if (nombre) delete todos[nombre];
      else for (const k of Object.keys(todos)) delete todos[k];
      await guardar();
    });
  }

  return {
    elegir,
    elegirTanda,
    estado,
    reiniciar,
    get escrituras() { return escrituras; },
    /** Solo para pruebas: olvida la copia en memoria para forzar una lectura nueva del archivo. */
    _soltarCache() { canales = null; },
  };
}

/** Rotador de la aplicacion (archivo dataDir/rotacion.json). */
export const rotador = crearRotador();
