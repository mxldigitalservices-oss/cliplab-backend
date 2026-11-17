import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import { construirTrayectoria, expresionLineal, CAM } from './trayectoria.js';
import { personasDe, objetivosInterlocutor } from './interlocutor.js';

// ---------------------------------------------------------------------------
// Seguimiento de rostros para el render (Frente A: encuadre sobre el rostro; Frente B: split-screen).
// Mide los rostros UNA vez por clip con scripts/sujeto.py (OpenCV Haar -> JSON { muestras: [{ t, x, l, r, n }] }) y
// entrega, por cada corte, `sujeto = { n, x, l, r, cx, kf, estable2, ratio2, dur, split }`.
//   - `kf` es la trayectoria suavizada de la camara (keyframes { t, cx }, ver trayectoria.js): render.js la
//     convierte en un crop 9:16 con inercia, sin micro-saltos por gestos.
//   - `split` arma el doble pantallazo con histeresis (Schmitt) entre cortes.
//   FACE_TRACK=off        desactiva todo (vuelve al recorte centrado)
//   SPLIT_SCREEN=off      desactiva solo el doble pantallazo
//   PYTHON_BIN            ejecutable de Python (por defecto python3)
//   SPLIT_SEP_ON / _OFF   separacion l..r para ENTRAR / SEGUIR en split (0.20 / 0.14)
//   SPLIT_MIN_S           duracion minima de un corte para ENTRAR en split (1.5 s)
//   SPLIT_MIN_RUN_S       un tramo de split aislado mas corto que esto se descarta (2.0 s)
//   SPLIT_SEP_INTER       separacion minima para ENTRAR en split cuando las dos personas interactuan (0.16)
//   (interlocutor.js: PERSONA_*, ACTIVO_*)  quien esta activo y cuando la camara cambia de persona
//   CAM_*                 inercia de la camara (ver trayectoria.js)
// ---------------------------------------------------------------------------

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../scripts/sujeto.py', import.meta.url));
const PYTHON = process.env.PYTHON_BIN || 'python3';
const ACTIVO = process.env.FACE_TRACK !== 'off';
const SPLIT = process.env.SPLIT_SCREEN !== 'off';
const FPS_MUESTREO = 4;
const GRUPO_MAX = CAM.grupoMax;
const num = (v, def) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : def);
export const UMBRALES = {
  sepOn: num(process.env.SPLIT_SEP_ON, 0.2), // separacion minima l..r para considerar dos personas distintas
  sepOff: num(process.env.SPLIT_SEP_OFF, 0.14), // una vez en split, se sigue mientras haya al menos esto
  ratioEntra: 0.6, // fraccion de cuadros con rostro que deben tener exactamente 2 para entrar
  ratioSigue: 0.3, // ...y para seguir en split
  ratioTres: 0.15, // tolerancia a cuadros con 3+ rostros (falsos positivos)
  sepInter: num(process.env.SPLIT_SEP_INTER, 0.16), // pareja que interactua: umbral de entrada mas bajo (prioridad de split)
  cambiosInter: 2, // cambios de interlocutor dentro del corte que cuentan como "interaccion cruzada"
  minEntradaS: num(process.env.SPLIT_MIN_S, 1.5),
  minTramoS: num(process.env.SPLIT_MIN_RUN_S, 2.0),
};

const cacheDim = new Map();
async function dimensiones(video) {
  if (cacheDim.has(video)) return cacheDim.get(video);
  let d = { ancho: 0, alto: 0 };
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', video], { timeout: 15000 });
    const [ancho, alto] = stdout.trim().split('x').map(Number);
    if (ancho > 0 && alto > 0) d = { ancho, alto };
  } catch { /* sin ffprobe: no hay seguimiento */ }
  cacheDim.set(video, d);
  return d;
}

// UNICO punto que conoce la CLI de sujeto.py: una sola llamada por clip con rango de tiempo.
// Devuelve las muestras (t absoluto en el video) o null si el detector no pudo correr (se registra el motivo).
async function muestrearClip(video, desde, hasta) {
  try {
    const timeout = Math.min(300000, 30000 + Math.ceil(hasta - desde) * 2000);
    const { stdout } = await run(PYTHON, [SCRIPT, video, '--desde', desde.toFixed(3), '--hasta', hasta.toFixed(3), '--fps', String(FPS_MUESTREO)], { timeout, maxBuffer: 16 << 20 });
    const j = JSON.parse(stdout.trim().split('\n').pop());
    if (!Array.isArray(j.muestras)) throw new Error(j.error || 'respuesta sin muestras');
    return j.muestras
      .filter((m) => Number.isFinite(Number(m.t)))
      .map((m) => {
        const n = Number(m.n) || 0;
        if (n < 1 || !Number.isFinite(Number(m.x))) return { t: Number(m.t), n: 0 };
        const f = (v) => Math.min(1, Math.max(0, Number(v)));
        const rostros = Array.isArray(m.rostros)
          ? m.rostros.filter((q) => Number.isFinite(Number(q.x))).map((q) => ({ x: f(q.x), w: f(q.w ?? 0.06), act: Number.isFinite(Number(q.act)) ? Number(q.act) : null }))
          : undefined;
        return { t: Number(m.t), n, x: f(m.x), l: f(m.l ?? m.x), r: f(m.r ?? m.x), ...(rostros ? { rostros } : {}) };
      });
  } catch (error) {
    // Antes este fallo era silencioso y el clip salia centrado sin explicacion.
    const detalle = (error.stdout && String(error.stdout).trim().split('\n').pop()) || error.message;
    logger.warn('Seguimiento de rostro no disponible: el clip sale centrado', { detalle: String(detalle).slice(0, 300) });
    return null;
  }
}

const mediana = (a) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];

/**
 * Resume las muestras de un corte en { n, x, l, r, cx, estable2, ratio2 }. null si ninguna vio un rostro.
 * Funciona con cualquier numero de muestras (3 en pruebas antiguas, ~4 por segundo en produccion).
 */
export function resumirMuestras(m) {
  const con = m.filter((s) => s.n > 0);
  if (con.length === 0) return null;
  const grupo = con.filter((s) => s.n >= 2);
  const dos = m.filter((s) => s.n === 2);
  const tres = con.filter((s) => s.n > 2);
  const ratio2 = dos.length / con.length;
  const r = {
    n: mediana(con.map((s) => s.n)),
    x: mediana(con.map((s) => s.x)),
    ratio2,
    // 2 rostros estables: la mayoria de los cuadros con rostro ven exactamente 2 y casi ninguno ve mas
    // (tolera cuadros sueltos en que Haar pierde a uno por luz o postura)
    estable2: dos.length >= 2 && ratio2 >= UMBRALES.ratioEntra && tres.length / con.length <= UMBRALES.ratioTres,
  };
  const base = dos.length ? dos : grupo;
  if (base.length) {
    r.l = mediana(base.map((s) => s.l));
    r.r = mediana(base.map((s) => s.r));
  }
  // Personas persistentes (interlocutor.js): una persona que Haar solo ve en parte de los cuadros sigue contando.
  const pers = personasDe(m);
  if (pers) {
    r.personas = pers.length;
    if (pers.length === 2) {
      r.estable2 = true;
      r.l = pers[0].l;
      r.r = pers[1].r;
    } else if (pers.length > 2) {
      r.estable2 = false; // mesa redonda: no cabe en dos mitades
    }
  }
  // Un grupo que cabe en el crop se centra completo; si no cabe, se sigue el centro reportado (x).
  r.cx = r.l != null && r.r - r.l <= GRUPO_MAX ? (r.l + r.r) / 2 : r.x;
  return r;
}

const separacion = (s) => (s && s.l != null && s.r != null ? s.r - s.l : 0);

/**
 * Decide que cortes van en split-screen con histeresis de Schmitt (umbral de ENTRADA mas alto que el de
 * PERMANENCIA), duracion minima para entrar y descarte de tramos aislados demasiado cortos.
 */
export function marcarSplit(res, apaisado, activo = true, opt = {}) {
  const U = { ...UMBRALES, ...opt };
  const puede = Boolean(activo && apaisado);
  const interactuan = (s) => Boolean(s && s.personas === 2 && s.cambios >= U.cambiosInter);
  // Una pareja que se alterna el foco entra con un umbral de separacion mas bajo: panear de uno a otro cada
  // pocos segundos es peor que mostrar a los dos.
  const entra = (s) => Boolean(s && !(s.dur < U.minEntradaS) &&
    ((s.estable2 && separacion(s) >= U.sepOn) || (interactuan(s) && separacion(s) >= U.sepInter)));
  const sigue = (s) => Boolean(s && (s.ratio2 ?? (s.estable2 ? 1 : 0)) >= U.ratioSigue && separacion(s) >= U.sepOff);

  // 1) Schmitt hacia adelante
  let dentro = false;
  const sp = res.map((s) => {
    if (!puede) return false;
    dentro = dentro ? sigue(s) || entra(s) : entra(s);
    return dentro;
  });
  const salida = res.map((s, i) => (s ? { ...s, split: sp[i] } : null));

  // 2) un corte flojo entre dos split se queda en split (con la posicion promedio de sus vecinos)
  res.forEach((s, i) => {
    if (sp[i] || !sp[i - 1] || !sp[i + 1]) return;
    const a = res[i - 1];
    const b = res[i + 1];
    salida[i] = { ...(s || {}), l: (a.l + b.l) / 2, r: (a.r + b.r) / 2, split: true };
  });

  // 3) un tramo de split aislado y breve es un parpadeo, no una decision editorial
  const durOk = res.every((s) => s && Number.isFinite(s.dur));
  if (durOk) {
    let i = 0;
    while (i < salida.length) {
      if (!salida[i] || !salida[i].split) { i++; continue; }
      let j = i;
      let total = 0;
      while (j < salida.length && salida[j] && salida[j].split) { total += salida[j].dur; j++; }
      if (total < U.minTramoS) for (let k = i; k < j; k++) salida[k] = { ...salida[k], split: false };
      i = j;
    }
  }
  return salida;
}

/** Anade `sujeto` a cada corte. Si todos ya lo traen (pruebas) se respetan. Nunca lanza. */
export async function analizarCortes(entrada, cortes, inicio) {
  if (!ACTIVO || !Array.isArray(cortes) || cortes.length === 0) return cortes;
  if (cortes.every((c) => c.sujeto !== undefined)) return cortes;
  const { ancho, alto } = await dimensiones(entrada);
  if (!ancho) return cortes;

  const fin = Math.max(...cortes.map((c) => c.hasta));
  const muestras = await muestrearClip(entrada, inicio + Math.min(...cortes.map((c) => c.desde)), inicio + fin);
  if (!muestras) return cortes;

  const resumenes = cortes.map((c) => {
    const largo = c.hasta - c.desde;
    const t0 = inicio + c.desde;
    let del = muestras.filter((m) => m.t >= t0 - 0.02 && m.t <= t0 + largo + 0.02);
    if (del.length === 0 && muestras.length) {
      // corte mas corto que el intervalo de muestreo: se usa la muestra mas cercana
      const medio = t0 + largo / 2;
      del = [muestras.reduce((p, q) => (Math.abs(q.t - medio) < Math.abs(p.t - medio) ? q : p))];
    }
    const res = resumirMuestras(del);
    if (!res) return null;
    res.dur = largo;
    const rel = del.map((m) => ({ ...m, t: m.t - t0 }));
    // Con dos personas persistentes la camara sigue al interlocutor activo (o al par si caben en el crop)
    const pers = personasDe(rel);
    let objetivos = null;
    if (pers && pers.length === 2) {
      const o = objetivosInterlocutor(rel, pers, GRUPO_MAX);
      objetivos = o.objetivos;
      res.cambios = o.cambios;
    }
    const kf = construirTrayectoria(rel, largo, CAM, objetivos);
    if (kf) res.kf = kf;
    return res;
  });
  const sujetos = marcarSplit(resumenes, ancho / alto >= 1.2, SPLIT);
  return cortes.map((c, i) => ({ ...c, sujeto: sujetos[i] }));
}

/**
 * Expresion X del crop 9:16 (en coordenadas del video ya escalado). Sin rostro: centrado.
 * Con trayectoria (`kf`) la camara se mueve suavemente durante el corte; sin ella, queda fija en `cx`.
 */
export function xRostro(s) {
  const kf = s && Array.isArray(s.kf) ? s.kf : null;
  const movil = kf && kf.length >= 2 && kf.some((k) => k.cx !== kf[0].cx);
  const cx = movil ? null : (kf && kf.length ? kf[0].cx : s && s.cx);
  if (!movil && !Number.isFinite(cx)) return '(in_w-out_w)/2';
  const valor = movil ? expresionLineal(kf) : Math.min(1, Math.max(0, cx)).toFixed(4);
  return "'clip(" + valor + "*in_w-out_w/2,0,in_w-out_w)'";
}

/** Fragmento de filtro (continua tras trim/setpts) que arma el doble pantallazo y termina en [v<i>]. */
export function filtroSplit(i, s, ANCHO, ALTO) {
  const mitad = ALTO / 2;
  const asp = ANCHO / mitad;
  const lim = (v) => Math.min(0.95, Math.max(0.05, v));
  const crop = (cx) => "crop=w='ih*" + asp + "':h='ih':x='clip(" + lim(cx).toFixed(4) + "*iw-out_w/2,0,iw-out_w)':y=0";
  return 'split=2[sa' + i + '][sb' + i + '];' +
    '[sa' + i + ']' + crop(s.l + 0.06) + ',scale=' + ANCHO + ':' + mitad + ',setsar=1[sta' + i + '];' +
    '[sb' + i + ']' + crop(s.r - 0.06) + ',scale=' + ANCHO + ':' + mitad + ',setsar=1[stb' + i + '];' +
    '[sta' + i + '][stb' + i + ']vstack=inputs=2,setsar=1[v' + i + ']';
}
