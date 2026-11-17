// ---------------------------------------------------------------------------
// Trayectoria de camara virtual para el crop 9:16 (suavizado de `cx`).
//
// Entrada: muestras densas de rostro dentro de UN corte ({ t, n, x, l, r }, t relativo al inicio del corte).
// Salida: keyframes { t, cx } que render.js convierte en una expresion `x` de FFmpeg (interpolacion lineal).
//
// La camara se simula hacia adelante, como un operador humano:
//   1. Objetivo por muestra: centro del grupo si cabe en el crop; si no, el rostro principal.
//   2. Huecos (sin deteccion) se mantienen en la ultima posicion: la camara NUNCA se va al centro por un parpadeo.
//   3. Filtro de mediana: un falso positivo o un cuadro fallido no mueve la camara.
//   4. Zona muerta con histeresis: no se mueve hasta que el sujeto sale de +-ZONA_ON; una vez en marcha,
//      sigue hasta quedar a menos de ZONA_OFF (asi no arranca y se detiene a cada gesto).
//   5. Inercia: aproximacion exponencial (constante TAU) con velocidad maxima VMAX.
//   6. Se simplifican los keyframes (Ramer-Douglas-Peucker) para que la expresion de FFmpeg sea corta.
//
// Todo en fracciones del ancho del frame (0..1). Ajustable por entorno:
//   CAM_ZONA_ON, CAM_ZONA_OFF, CAM_TAU (s), CAM_VMAX (frame/s), CAM_MEDIANA (impar)
// ---------------------------------------------------------------------------

const num = (v, def) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : def);

export const CAM = {
  zonaOn: num(process.env.CAM_ZONA_ON, 0.05),
  zonaOff: num(process.env.CAM_ZONA_OFF, 0.012),
  tau: num(process.env.CAM_TAU, 0.55),
  vmax: num(process.env.CAM_VMAX, 0.22),
  mediana: num(process.env.CAM_MEDIANA, 5),
  grupoMax: 0.25, // un grupo mas ancho que esto (fraccion del frame) no cabe en el crop 9:16
  tolerancia: 0.003, // error maximo al simplificar keyframes
  maxKeyframes: 16,
};

const mediana = (a) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];
const acotar = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Objetivo horizontal de una muestra: centro del grupo si cabe en el crop, si no el rostro principal. */
export function objetivoDe(s, grupoMax = CAM.grupoMax) {
  if (!s || !(s.n > 0) || !Number.isFinite(s.x)) return null;
  if (s.n >= 2 && Number.isFinite(s.l) && Number.isFinite(s.r) && s.r - s.l <= grupoMax) return (s.l + s.r) / 2;
  return s.x;
}

/** Mediana movil de ventana impar sobre una serie (ignora bordes recortando la ventana). */
export function medianaMovil(serie, ventana = CAM.mediana) {
  const h = Math.floor(ventana / 2);
  if (h < 1) return [...serie];
  return serie.map((_, i) => mediana(serie.slice(Math.max(0, i - h), Math.min(serie.length, i + h + 1))));
}

/** Rellena nulls: hacia adelante con la ultima posicion; los nulls iniciales toman el primer valor visto. */
export function rellenarHuecos(serie) {
  const primero = serie.find((v) => v != null);
  if (primero === undefined) return null;
  let ultimo = primero;
  return serie.map((v) => {
    if (v != null) ultimo = v;
    return ultimo;
  });
}

/**
 * Simula la camara virtual. `objetivos` y `tiempos` van emparejados (tiempos crecientes, en segundos).
 * Devuelve la posicion de la camara en cada instante.
 */
export function simularCamara(objetivos, tiempos, cfg = CAM) {
  const pos = [objetivos[0]];
  let p = objetivos[0];
  let moviendo = false;
  for (let i = 1; i < objetivos.length; i++) {
    const dt = Math.max(1e-3, tiempos[i] - tiempos[i - 1]);
    const err = objetivos[i] - p;
    if (!moviendo && Math.abs(err) > cfg.zonaOn) moviendo = true;
    if (moviendo && Math.abs(err) < cfg.zonaOff) moviendo = false;
    if (moviendo) {
      const alfa = 1 - Math.exp(-dt / cfg.tau);
      const paso = acotar(err * alfa, -cfg.vmax * dt, cfg.vmax * dt);
      p += paso;
    }
    pos.push(p);
  }
  return pos;
}

function distanciaPerpendicular(a, b, p) {
  // error vertical (en cx) entre p y la recta a-b, en el eje del tiempo
  if (b.t === a.t) return Math.abs(p.cx - a.cx);
  const cx = a.cx + ((b.cx - a.cx) * (p.t - a.t)) / (b.t - a.t);
  return Math.abs(p.cx - cx);
}

/** Ramer-Douglas-Peucker sobre keyframes { t, cx }. Conserva siempre los extremos. */
export function simplificar(kf, tol) {
  if (kf.length <= 2) return kf;
  let max = 0;
  let idx = 0;
  for (let i = 1; i < kf.length - 1; i++) {
    const d = distanciaPerpendicular(kf[0], kf[kf.length - 1], kf[i]);
    if (d > max) { max = d; idx = i; }
  }
  if (max <= tol) return [kf[0], kf[kf.length - 1]];
  const izq = simplificar(kf.slice(0, idx + 1), tol);
  const der = simplificar(kf.slice(idx), tol);
  return [...izq.slice(0, -1), ...der];
}

/**
 * Construye los keyframes de un corte.
 * @param muestras  [{ t, n, x, l, r }] con t en segundos RELATIVOS al inicio del corte
 * @param duracion  largo del corte en segundos
 * @returns [{ t, cx }] (t=0 y t=duracion siempre presentes) o null si no hubo ningun rostro
 */
export function construirTrayectoria(muestras, duracion, cfg = CAM) {
  if (!Array.isArray(muestras) || muestras.length === 0 || !(duracion > 0)) return null;
  const ordenadas = [...muestras].sort((a, b) => a.t - b.t);
  const crudo = rellenarHuecos(ordenadas.map((s) => objetivoDe(s, cfg.grupoMax)));
  if (!crudo) return null;

  const limpio = medianaMovil(crudo, cfg.mediana).map((v) => acotar(v, 0, 1));
  const tiempos = ordenadas.map((s) => acotar(s.t, 0, duracion));
  const camara = simularCamara(limpio, tiempos, cfg);

  let kf = tiempos.map((t, i) => ({ t, cx: camara[i] }));
  // anclar extremos: arranca en el primer valor y se mantiene hasta el final del corte
  if (kf[0].t > 0) kf.unshift({ t: 0, cx: kf[0].cx });
  if (kf[kf.length - 1].t < duracion) kf.push({ t: duracion, cx: kf[kf.length - 1].cx });
  // tiempos duplicados (por acotar) romperian la interpolacion
  kf = kf.filter((k, i) => i === 0 || k.t > kf[i - 1].t);

  let tol = cfg.tolerancia;
  let simple = simplificar(kf, tol);
  while (simple.length > cfg.maxKeyframes && tol < 0.05) {
    tol *= 1.6;
    simple = simplificar(kf, tol);
  }
  return simple.map((k) => ({ t: Number(k.t.toFixed(3)), cx: Number(k.cx.toFixed(4)) }));
}

/**
 * Expresion FFmpeg (variable `t` = segundo dentro del corte, tras setpts=PTS-STARTPTS) que interpola
 * linealmente entre keyframes. Un solo keyframe (o todos iguales) produce una constante.
 */
export function expresionLineal(kf) {
  const f = (v) => v.toFixed(4);
  if (!kf || kf.length === 0) return '0.5';
  if (kf.length === 1 || kf.every((k) => k.cx === kf[0].cx)) return f(kf[0].cx);
  let expr = f(kf[kf.length - 1].cx);
  for (let i = kf.length - 2; i >= 0; i--) {
    const a = kf[i];
    const b = kf[i + 1];
    const dt = b.t - a.t;
    if (a.cx === b.cx && expr === f(a.cx)) continue; // tramo plano que ya es el valor final: no hace falta otro if
    const tramo = dt <= 0 || a.cx === b.cx
      ? f(a.cx)
      : f(a.cx) + '+(' + ((b.cx - a.cx) / dt).toFixed(6) + ')*(t-' + a.t.toFixed(3) + ')';
    expr = 'if(lt(t,' + b.t.toFixed(3) + '),' + tramo + ',' + expr + ')';
  }
  return expr;
}
