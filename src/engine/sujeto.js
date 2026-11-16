import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Seguimiento de rostros para el render: zoom/encuadre sobre la cara y split-screen (2 rostros).
// Usa scripts/sujeto.py (OpenCV Haar) -> JSON { x, l, r, n }.
//   FACE_TRACK=off     desactiva todo (vuelve al encuadre centrado)
//   SPLIT_SCREEN=off   desactiva solo el doble pantallazo
//   PYTHON_BIN         ejecutable de Python (por defecto python3)
// ---------------------------------------------------------------------------

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../scripts/sujeto.py', import.meta.url));
const PYTHON = process.env.PYTHON_BIN || 'python3';
const ACTIVO = process.env.FACE_TRACK !== 'off';
const SPLIT = process.env.SPLIT_SCREEN !== 'off';
const MUESTRAS = [0.2, 0.5, 0.8]; // posiciones dentro de cada beat
const GRUPO_MAX = 0.25; // si el grupo ocupa mas que esto del ancho, no cabe en el crop 9:16: se usa el rostro central
const SEPARACION_MIN = 0.2; // separacion minima l..r para considerar dos personas distintas

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

// UNICO punto que conoce la CLI de sujeto.py. Si cambia, se ajusta aqui.
async function muestrearRostro(video, t, ancho) {
  try {
    const { stdout } = await run(PYTHON, [SCRIPT, video, t.toFixed(3)], { timeout: 20000, maxBuffer: 1 << 20 });
    const j = JSON.parse(stdout.trim().split('\n').pop());
    const n = Number(j.n) || 0;
    if (n < 1) return { n: 0 };
    const enPixeles = [j.x, j.l, j.r].some((v) => Number(v) > 1.5);
    const f = (v) => Math.min(1, Math.max(0, Number(v) / (enPixeles ? ancho : 1)));
    return { n, x: f(j.x), l: f(j.l), r: f(j.r) };
  } catch {
    return { n: 0 };
  }
}

const mediana = (a) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];

/** Resume las muestras de un beat. Devuelve null si no hubo ningun rostro. */
export function resumirMuestras(m) {
  const con = m.filter((s) => s.n > 0);
  if (con.length === 0) return null;
  const grupo = con.filter((s) => s.n >= 2);
  const dos = m.filter((s) => s.n === 2);
  const r = {
    n: mediana(con.map((s) => s.n)),
    x: mediana(con.map((s) => s.x)),
    estable2: dos.length >= 2 && m.every((s) => s.n <= 2),
  };
  if (grupo.length) {
    r.l = mediana(grupo.map((s) => s.l));
    r.r = mediana(grupo.map((s) => s.r));
  }
  r.cx = r.l != null && r.r - r.l <= GRUPO_MAX ? (r.l + r.r) / 2 : r.x;
  return r;
}

/** Decide que beats van en split-screen (con histeresis para evitar parpadeo). */
export function marcarSplit(res, apaisado, activo = true) {
  const sp = res.map((s) => Boolean(activo && apaisado && s && s.estable2 && s.r - s.l >= SEPARACION_MIN));
  const salida = res.map((s, i) => (s ? { ...s, split: sp[i] } : null));
  res.forEach((s, i) => {
    if (sp[i] || !sp[i - 1] || !sp[i + 1]) return;
    const a = res[i - 1];
    const b = res[i + 1];
    salida[i] = { ...(s || {}), l: (a.l + b.l) / 2, r: (a.r + b.r) / 2, split: true };
  });
  return salida;
}

/** Anade `sujeto` a cada corte: { n, x, cx, l, r, split }. Si algo falla devuelve los cortes sin tocar. */
export async function analizarCortes(entrada, cortes, inicio) {
  if (!ACTIVO || !Array.isArray(cortes) || cortes.length === 0) return cortes;
  const { ancho, alto } = await dimensiones(entrada);
  if (!ancho) return cortes;

  const resumenes = [];
  for (const c of cortes) {
    const largo = c.hasta - c.desde;
    const m = await Promise.all(MUESTRAS.map((p) => muestrearRostro(entrada, inicio + c.desde + largo * p, ancho)));
    resumenes.push(resumirMuestras(m));
  }
  const sujetos = marcarSplit(resumenes, ancho / alto >= 1.2, SPLIT);
  return cortes.map((c, i) => ({ ...c, sujeto: sujetos[i] }));
}

/** Expresion X del crop 9:16 (en coordenadas del video ya escalado). Sin rostro: centrado. */
export function xRostro(s) {
  if (!s || !Number.isFinite(s.cx)) return '(in_w-out_w)/2';
  return "'clip(" + s.cx.toFixed(4) + "*in_w-out_w/2,0,in_w-out_w)'";
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
