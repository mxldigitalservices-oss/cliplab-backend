import { config } from '../config/index.js';

// ---------------------------------------------------------------------------
// Criterio editorial (funciones puras, sin FFmpeg ni disco).
//   1) ajustarAFrases: el corte nace y termina en limites de frase y arranca en la frase con mas gancho.
//   2) cortesEnCaliente: elimina pausas muertas dejando un colchon corto (ritmo agil, sin comerse letras).
//   3) planDePlanos: parte los tramos largos en "beats" y alterna plano medio / plano cerrado (punch-in).
// Todas las palabras son { texto, inicio, fin } en segundos, relativas al audio transcrito.
// ---------------------------------------------------------------------------

const FIN_DE_FRASE = /[.!?…]["')\]»”]*$/u;
const PAUSA_DE_FRASE = 0.6;

const GANCHO = new Set([
  'secreto', 'secretos', 'error', 'errores', 'verdad', 'nadie', 'nunca', 'siempre', 'gratis', 'dinero',
  'millones', 'ganar', 'perder', 'cuidado', 'atencion', 'importante', 'clave', 'truco', 'razon', 'porque',
  'mentira', 'increible', 'imposible', 'rapido', 'facil', 'resultado', 'resultados', 'ventas', 'clientes',
  'secret', 'mistake', 'truth', 'never', 'always', 'free', 'money', 'million', 'warning', 'why',
]);

function normalizar(texto) {
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function esInicioDeFrase(palabras, i) {
  if (i === 0) return true;
  return FIN_DE_FRASE.test(palabras[i - 1].texto) || palabras[i].inicio - palabras[i - 1].fin >= PAUSA_DE_FRASE;
}

function esFinDeFrase(palabras, i) {
  if (i === palabras.length - 1) return true;
  return FIN_DE_FRASE.test(palabras[i].texto) || palabras[i + 1].inicio - palabras[i].fin >= PAUSA_DE_FRASE;
}

/** Peso informativo de la frase que empieza en la palabra i (0 = plana, mayor = mas gancho). */
export function puntuarGancho(palabras, i) {
  let fin = i;
  while (fin < palabras.length - 1 && !esFinDeFrase(palabras, fin)) fin++;
  const frase = palabras.slice(i, Math.min(fin, i + 14) + 1);

  let puntos = 0;
  if (frase.some((p) => /\?$/.test(p.texto))) puntos += 2;
  if (frase.some((p) => /\d/.test(p.texto))) puntos += 1.5;
  for (const p of frase) if (GANCHO.has(normalizar(p.texto))) puntos += 1;
  if (frase.length >= 4 && frase.length <= 12) puntos += 0.5;
  return puntos;
}

/**
 * Ajusta una ventana candidata a frases completas.
 * @param {Array} palabras  palabras de un audio MAS ANCHO que la ventana (con colchon a ambos lados)
 * @param {object} o  { objetivoInicio, objetivoFin, minSeg, maxSeg, alcance }  tiempos relativos al audio
 * @returns {{ inicio:number, fin:number, ajustado:boolean }}
 */
export function ajustarAFrases(palabras, { objetivoInicio, objetivoFin, minSeg, maxSeg, alcance = 8 }) {
  const original = { inicio: objetivoInicio, fin: objetivoFin, ajustado: false };
  if (!Array.isArray(palabras) || palabras.length < 3) return original;

  // Inicio: la frase cercana con mejor gancho (penaliza alejarse del objetivo).
  let mejor = null;
  for (let i = 0; i < palabras.length; i++) {
    if (!esInicioDeFrase(palabras, i)) continue;
    const distancia = Math.abs(palabras[i].inicio - objetivoInicio);
    if (distancia > alcance) continue;
    const valor = puntuarGancho(palabras, i) - 0.15 * distancia;
    if (!mejor || valor > mejor.valor) mejor = { i, valor };
  }
  if (!mejor) return original;
  const inicio = Math.max(0, palabras[mejor.i].inicio - 0.12);

  // Fin: la frase que cierra mas cerca del objetivo, respetando el rango de duracion.
  let finElegido = null;
  for (let j = mejor.i + 1; j < palabras.length; j++) {
    if (!esFinDeFrase(palabras, j)) continue;
    const largo = palabras[j].fin - inicio;
    if (largo < minSeg) continue;
    if (largo > maxSeg) break;
    const distancia = Math.abs(palabras[j].fin - objetivoFin);
    if (!finElegido || distancia < finElegido.distancia) finElegido = { j, distancia };
  }
  if (!finElegido) return original;

  return { inicio, fin: palabras[finElegido.j].fin + 0.3, ajustado: true };
}

/**
 * Tramos a conservar: se eliminan las pausas mayores que `umbral`, dejando `colchon` a cada lado.
 * Devuelve tramos {desde, hasta} (relativos al audio) y las palabras con tiempos remapeados a la linea final.
 */
export function cortesEnCaliente(palabras, { umbral = config.hotCutGap, colchon = config.hotCutPad, desde = 0, hasta } = {}) {
  const lista = (palabras || []).filter((p) => p.fin > desde && p.inicio < (hasta ?? Infinity));
  if (lista.length === 0) return { tramos: [], palabras: [], eliminado: 0 };

  const tramos = [];
  let actual = { desde: Math.max(desde, lista[0].inicio - colchon), hasta: lista[0].fin + colchon };
  for (let i = 1; i < lista.length; i++) {
    const hueco = lista[i].inicio - lista[i - 1].fin;
    if (hueco > umbral) {
      tramos.push(actual);
      actual = { desde: lista[i].inicio - colchon, hasta: lista[i].fin + colchon };
    } else {
      actual.hasta = lista[i].fin + colchon;
    }
  }
  tramos.push(actual);
  if (hasta !== undefined) tramos[tramos.length - 1].hasta = Math.min(tramos[tramos.length - 1].hasta + 0.2, hasta);

  // Evita que el colchon de un tramo invada al siguiente.
  for (let i = 1; i < tramos.length; i++) {
    if (tramos[i].desde < tramos[i - 1].hasta) tramos[i].desde = tramos[i - 1].hasta;
  }

  const remapeadas = lista.map((p) => ({ texto: p.texto, inicio: mapear(tramos, p.inicio), fin: mapear(tramos, p.fin) }));
  const total = tramos.reduce((s, t) => s + (t.hasta - t.desde), 0);
  const original = tramos[tramos.length - 1].hasta - tramos[0].desde;
  return { tramos, palabras: remapeadas, eliminado: Math.max(0, original - total) };
}

function mapear(tramos, t) {
  let acumulado = 0;
  for (const tr of tramos) {
    if (t <= tr.hasta) return acumulado + Math.max(0, t - tr.desde);
    acumulado += tr.hasta - tr.desde;
  }
  return acumulado;
}

/**
 * Parte los tramos largos en beats (pausa de ritmo cada ~beatObjetivo s, siempre entre palabras) y asigna plano.
 * @returns {Array<{desde:number,hasta:number,plano:'medio'|'cerrado'}>}
 */
export function planDePlanos(tramos, palabras, { beatObjetivo = config.beatSeconds, beatMin = 2.2 } = {}) {
  const beats = [];
  for (const tr of tramos) {
    const dentro = palabras.filter((p) => p.inicio >= tr.desde - 0.01 && p.fin <= tr.hasta + 0.01);
    let desde = tr.desde;
    for (let k = 0; k < dentro.length - 1; k++) {
      const corte = (dentro[k].fin + dentro[k + 1].inicio) / 2;
      const falta = tr.hasta - corte;
      if (corte - desde >= beatObjetivo && falta >= beatMin) {
        beats.push({ desde, hasta: corte });
        desde = corte;
      }
    }
    beats.push({ desde, hasta: tr.hasta });
  }
  return beats.map((b, i) => ({ ...b, plano: i % 2 === 0 ? 'medio' : 'cerrado' }));
}

/** Tramos del plan ya en LINEA DE TIEMPO DE SALIDA (para alinear subtitulos y marketing). */
export function duracionDePlan(plan) {
  return plan.reduce((s, b) => s + (b.hasta - b.desde), 0);
}
