import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Planificador de segmentos (puro y determinista). Dado el video y los rangos que ya se usaron en
// pasadas anteriores, devuelve de 4 a 5 rangos de 30-60 s que NO se solapan entre si ni con el historial.
// ---------------------------------------------------------------------------

function crearRng(semilla) {
  // mulberry32 sembrado con md5: misma semilla -> misma secuencia (reproducible en pruebas).
  let a = parseInt(crypto.createHash('md5').update(String(semilla)).digest('hex').slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function solapa(a, b, margen) {
  return a.inicio < b.fin + margen && b.inicio < a.fin + margen;
}

function ocupado(candidato, listas, margen) {
  return listas.some((lista) => lista.some((r) => solapa(candidato, r, margen)));
}

function cantidadObjetivo(duracion, cantidad, { minSeg, minClips, maxClips }) {
  const cabe = Math.max(1, Math.floor(duracion / minSeg));
  const pedido = Number.isInteger(cantidad)
    ? Math.min(maxClips, Math.max(1, cantidad))
    : duracion >= 5 * minSeg * 2 ? maxClips : minClips; // videos de 5 min o mas: 5 clips; menos: 4
  return Math.min(pedido, cabe);
}

function intentar({ duracion, n, usados, rng, minSeg, maxSeg, margen }) {
  const elegidos = [];
  const largoAleatorio = () => minSeg + Math.floor(rng() * (maxSeg - minSeg + 1));
  const probar = (inicio, largo) => {
    const candidato = { inicio, fin: inicio + largo };
    if (inicio < 0 || candidato.fin > duracion) return false;
    if (ocupado(candidato, [usados, elegidos], margen)) return false;
    elegidos.push(candidato);
    return true;
  };

  // Primera fase: un clip por "franja" del video, para repartir los cortes a lo largo de toda la charla.
  const franja = duracion / n;
  for (let i = 0; i < n; i++) {
    const centro0 = i * franja;
    for (let intento = 0; intento < 40; intento++) {
      const largo = largoAleatorio();
      const centro = centro0 + rng() * franja;
      const inicio = Math.round(Math.min(duracion - largo, Math.max(0, centro - largo / 2)));
      if (probar(inicio, largo)) break;
    }
  }

  // Segunda fase: si alguna franja quedo bloqueada por el historial, se busca en cualquier hueco libre.
  for (let intento = 0; intento < 400 && elegidos.length < n; intento++) {
    const largo = intento < 200 ? largoAleatorio() : minSeg;
    probar(Math.floor(rng() * (duracion - largo + 1)), largo);
  }

  return elegidos.sort((a, b) => a.inicio - b.inicio);
}

/**
 * @param {object} p
 * @param {number} p.duracionVideo  segundos del video fuente
 * @param {Array<{inicio:number,fin:number}>} [p.historial]  rangos ya usados en pasadas previas
 * @param {number} [p.pasada]       cuantas veces se proceso ya este video (varia la semilla)
 * @param {string} [p.semilla]      normalmente el id del video
 * @param {number} [p.cantidad]     1-5; por defecto 4 o 5 segun la duracion
 */
export function planificarSegmentos({
  duracionVideo,
  historial = [],
  pasada = 0,
  semilla = '',
  cantidad,
  minSeg = config.segmentMinSeconds,
  maxSeg = config.segmentMaxSeconds,
  minClips = config.segmentsMin,
  maxClips = config.segmentsMax,
  margen = 1,
} = {}) {
  const duracion = Math.floor(Number(duracionVideo));
  if (!Number.isFinite(duracion) || duracion < 1) {
    throw new Error('Duracion de video invalida para planificar los cortes');
  }

  // Video mas corto que un clip minimo: se aprovecha completo (un solo clip).
  if (duracion < minSeg) {
    return { segmentos: [{ inicio: 0, duracion }], reiniciado: false, faltantes: 0 };
  }

  const n = cantidadObjetivo(duracion, cantidad, { minSeg, minClips, maxClips });
  const usados = (Array.isArray(historial) ? historial : [])
    .map((r) => ({ inicio: Number(r.inicio), fin: Number(r.fin) }))
    .filter((r) => Number.isFinite(r.inicio) && Number.isFinite(r.fin) && r.fin > r.inicio);

  // Varios intentos con la misma secuencia pseudoaleatoria: en videos justos de duracion un reparto
  // al azar puede desperdiciar huecos, asi que se conserva el que logre mas clips.
  // En videos justos de duracion se acota el largo maximo para que los n clips quepan sin solaparse.
  const tope = Math.max(minSeg, Math.min(maxSeg, Math.floor((duracion - (n - 1) * margen) / n)));

  const ejecutar = (rangosUsados) => {
    const rng = crearRng(semilla + '|' + pasada);
    let mejor = [];
    for (let k = 0; k < 40 && mejor.length < n; k++) {
      const propuesta = intentar({ duracion, n, usados: rangosUsados, minSeg, maxSeg: tope, margen, rng });
      if (propuesta.length > mejor.length) mejor = propuesta;
    }
    // Video justo de duracion y sin historial que respetar: reparto uniforme garantizado (n * tope + huecos <= duracion).
    if (mejor.length < n && rangosUsados.length === 0 && n > 1) {
      const uniforme = [];
      for (let i = 0; i < n; i++) {
        const inicio = Math.floor((i * (duracion - tope)) / (n - 1));
        uniforme.push({ inicio, fin: inicio + tope });
      }
      return uniforme;
    }
    return mejor;
  };

  let elegidos = ejecutar(usados);
  let reiniciado = false;

  // Video "agotado": ya no quedan huecos libres. Se abre un ciclo nuevo (sin historial) y se avisa.
  if (elegidos.length === 0 && usados.length > 0) {
    elegidos = ejecutar([]);
    reiniciado = true;
  }

  return {
    segmentos: elegidos.map((r) => ({ inicio: r.inicio, duracion: r.fin - r.inicio })),
    reiniciado,
    faltantes: Math.max(0, n - elegidos.length),
  };
}

// ---------------------------------------------------------------------------
// Historial persistente de rangos por video (anti-duplicados entre re-procesos y reinicios).
// ---------------------------------------------------------------------------

const MAX_RANGOS_POR_VIDEO = 500;
const MAX_VIDEOS = 2000;

let cache = null;
let cola = Promise.resolve();

function rutaHistorial() {
  return path.join(config.dataDir, 'historial-cortes.json');
}

async function cargar() {
  if (cache) return cache;
  try {
    const datos = JSON.parse(await fs.readFile(rutaHistorial(), 'utf8'));
    cache = datos && typeof datos === 'object' && !Array.isArray(datos) ? datos : {};
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn('Historial de cortes ilegible: se empieza vacio', { mensaje: error.message });
    }
    cache = {};
  }
  return cache;
}

async function guardar() {
  const ruta = rutaHistorial();
  await fs.mkdir(path.dirname(ruta), { recursive: true });
  const temporal = ruta + '.' + process.pid + '.tmp';
  await fs.writeFile(temporal, JSON.stringify(cache));
  await fs.rename(temporal, ruta);
}

// Las escrituras se encadenan para que dos jobs no se pisen el archivo.
function serializar(tarea) {
  const siguiente = cola.then(tarea, tarea);
  cola = siguiente.catch(() => {});
  return siguiente;
}

export async function leerHistorial(videoId) {
  await cola;
  const todo = await cargar();
  const entrada = todo[videoId];
  return entrada ? { pasadas: entrada.pasadas || 0, rangos: entrada.rangos || [] } : { pasadas: 0, rangos: [] };
}

/** Registra una pasada: suma los rangos realmente renderizados (o abre ciclo nuevo si `reiniciar`). */
export function registrarPasada(videoId, rangos, { reiniciar = false } = {}) {
  return serializar(async () => {
    const todo = await cargar();
    const previo = todo[videoId] || { pasadas: 0, rangos: [] };
    const base = reiniciar ? [] : previo.rangos;
    delete todo[videoId]; // se reinserta al final: el orden de claves sirve como LRU
    todo[videoId] = {
      pasadas: previo.pasadas + 1,
      rangos: base.concat(rangos.map((r) => ({ inicio: r.inicio, fin: r.fin }))).slice(-MAX_RANGOS_POR_VIDEO),
      actualizadoEn: new Date().toISOString(),
    };
    for (const clave of Object.keys(todo).slice(0, Math.max(0, Object.keys(todo).length - MAX_VIDEOS))) {
      delete todo[clave];
    }
    await guardar();
  });
}

/** Solo para pruebas: descarta la cache en memoria. */
export function _reiniciarCache() {
  cache = null;
  cola = Promise.resolve();
}
