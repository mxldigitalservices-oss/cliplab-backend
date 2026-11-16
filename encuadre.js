// Encuadre dinámico del sujeto para clips 9:16.
//   1) ffmpeg saca un proxy diminuto (sin audio, 4 fps) del tramo del clip
//   2) scripts/sujeto.py (OpenCV) dice dónde está el rostro principal en cada muestra
//   3) suavizar() convierte esas posiciones en un movimiento de cámara estable (zona muerta, velocidad máxima, pocas claves)
//   4) exprCentro()/parteFiltro() lo traducen a una expresión de FFmpeg: el recorte sigue al sujeto en la MISMA pasada de render
// Si algo falla (sin python/opencv, sin rostros, video vertical) calcularEncuadre() devuelve null y video.js usa el
// reencuadre de siempre: este módulo nunca rompe un corte.
//
// REENCUADRE = blur (defecto) | crop | sujeto | blur_sujeto
//   sujeto      → recorte vertical 9:16 a pantalla completa que sigue al sujeto (amplía ~1.8x un video de 720p)
//   blur_sujeto → fondo difuminado + primer plano (cuadrado por defecto) que sigue al sujeto; sin ampliar, mejor calidad
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cfg } from "./config.js";
import { correr } from "./proc.js";

const SCRIPT = fileURLToPath(new URL("../scripts/sujeto.py", import.meta.url));
const num = (k, d) => { const r = process.env[k]; const v = Number(r); return r === undefined || r === "" || !Number.isFinite(v) ? d : v; };
const entre = (v, a, b) => Math.min(b, Math.max(a, v));

export const MODOS = Object.freeze(["blur", "crop", "sujeto", "blur_sujeto"]);
export const modoEncuadre = () => (MODOS.includes(process.env.REENCUADRE) ? process.env.REENCUADRE : "blur");
export const esDinamico = modo => modo === "sujeto" || modo === "blur_sujeto";

const ajustes = () => ({
  fps: entre(num("ENCUADRE_FPS", 4), 1, 8),                         // muestras por segundo
  zonaMuerta: entre(num("ENCUADRE_ZONA_MUERTA", 0.05), 0, 0.3),     // fracción del ancho: por debajo, la cámara no se mueve
  velMax: entre(num("ENCUADRE_VEL_MAX", 0.3), 0.05, 2),             // anchos de cuadro por segundo: sin movimientos bruscos
  minDeteccion: entre(num("ENCUADRE_MIN_DETECCION", 0.35), 0, 1),   // con menos rostros que esto, se usa el encuadre estático
  ratioFg: entre(num("ENCUADRE_FG_RATIO", 1), 0.5625, 1.25),        // ancho/alto del primer plano en blur_sujeto (1 = cuadrado)
  timeoutMs: num("ENCUADRE_TIMEOUT_MS", 120000)
});

// ---------- Funciones puras (se prueban sin ffmpeg ni opencv) ----------

const mediana = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Ramer–Douglas–Peucker sobre (t, cx): deja solo los puntos que cambian de verdad la trayectoria.
function rdp(p, eps) {
  if (p.length < 3) return p;
  const a = p[0], b = p.at(-1);
  let maxD = 0, idx = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const y = a.cx + (b.cx - a.cx) * (p[i].t - a.t) / ((b.t - a.t) || 1);
    const d = Math.abs(p[i].cx - y);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  return [...rdp(p.slice(0, idx + 1), eps).slice(0, -1), ...rdp(p.slice(idx), eps)];
}

// muestras [{t, x|null}] (x = centro horizontal del sujeto, 0..1) → claves [{t, cx}] del centro de la cámara, o null
// si hay muy pocas detecciones. `mitad` = mitad del ancho del recorte como fracción del ancho del video.
export function suavizar(muestras, { dur, mitad = 0.2, ventana = 5, zonaMuerta = 0.05, velMax = 0.3, minDeteccion = 0.35, maxClaves = 40 } = {}) {
  const m = (Array.isArray(muestras) ? muestras : []).filter(s => s && Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  const validas = m.filter(s => Number.isFinite(s.x));
  if (!m.length || !validas.length || validas.length / m.length < minDeteccion) return null;
  const lo = Math.min(mitad, 0.5), hi = 1 - lo;
  const clamp = v => Math.min(hi, Math.max(lo, v));

  let ult = validas[0].x;                                              // huecos: se mantiene la última posición conocida
  const xs = m.map(s => (Number.isFinite(s.x) ? (ult = s.x) : ult));
  const h = Math.floor(ventana / 2);                                   // mediana móvil: descarta falsos positivos sueltos
  const med = xs.map((_, i) => mediana(xs.slice(Math.max(0, i - h), i + h + 1)));

  let cam = clamp(med[0]);
  const pts = [{ t: m[0].t, cx: cam }];
  for (let i = 1; i < m.length; i++) {                                 // zona muerta + límite de velocidad
    const dt = Math.max(0, m[i].t - m[i - 1].t);
    const dif = clamp(med[i]) - cam;
    if (Math.abs(dif) > zonaMuerta) cam += Math.sign(dif) * Math.min(Math.abs(dif) - zonaMuerta, velMax * dt);
    pts.push({ t: m[i].t, cx: clamp(cam) });
  }
  const fin = Number.isFinite(dur) ? dur : pts.at(-1).t;
  if (pts[0].t > 0) pts.unshift({ t: 0, cx: pts[0].cx });
  if (pts.at(-1).t < fin) pts.push({ t: fin, cx: pts.at(-1).cx });

  let eps = 0.008, claves = rdp(pts, eps);
  while (claves.length > maxClaves && eps < 0.2) { eps *= 1.5; claves = rdp(pts, eps); }
  return claves.map(c => ({ t: +c.t.toFixed(3), cx: +c.cx.toFixed(4) }));
}

// Claves → expresión de FFmpeg (interpolación lineal) para el centro normalizado en función de `t`.
export function exprCentro(c) {
  const f = n => String(+n.toFixed(4));
  if (!c?.length) throw new Error("exprCentro: sin claves");
  let e = f(c.at(-1).cx);
  for (let i = c.length - 2; i >= 0; i--) {
    const a = c[i], b = c[i + 1];
    e = `if(lt(t,${f(b.t)}),${f(a.cx)}+(${f(b.cx - a.cx)})*(t-${f(a.t)})/${f(Math.max(0.001, b.t - a.t))},${e})`;
  }
  return e;
}

// Primer segmento del filtergraph (hasta la etiqueta [v0]); video.js le añade marca de agua y subtítulos.
export function parteFiltro({ modo, expr, ratio }, W = 720, H = 1280) {
  const x = `x='clip((${expr})*iw-out_w/2,0,iw-out_w)'`;
  if (modo === "sujeto")
    return `[0:v]crop=w='trunc(ih*9/16/2)*2':h=ih:${x}:y=0,scale=${W}:${H}:flags=lanczos,setsar=1[v0]`;
  const fgH = Math.round(W / ratio / 2) * 2;
  return `[0:v]split=2[a][b];[a]scale=360:640:force_original_aspect_ratio=increase,crop=360:640,boxblur=8:2,scale=${W}:${H}[bg];` +
    `[b]crop=w='trunc(ih*${ratio}/2)*2':h=ih:${x}:y=0,scale=${W}:${fgH}:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v0]`;
}

// ---------- Análisis (ffmpeg + python) ----------

let avisado = false;
const avisar = msg => { if (!avisado) { avisado = true; console.warn(`Encuadre dinámico no disponible, se usa el estático: ${msg}`); } };

// entrada = archivo local o URL del video; (inicio, dur) = tramo del clip. Devuelve { modo, expr, ratio, claves } o null.
export async function calcularEncuadre({ entrada, inicio = 0, dur }) {
  const modo = modoEncuadre();
  if (!esDinamico(modo) || !(dur > 0)) return null;
  const a = ajustes();
  const ratio = modo === "sujeto" ? 9 / 16 : a.ratioFg;
  const tmp = `${cfg.clipsDir}/enc-${process.pid}-${Date.now()}.mp4`;
  try {
    await fs.mkdir(cfg.clipsDir, { recursive: true });
    await correr("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
      ...(/^https?:/.test(entrada) ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"] : []),
      "-ss", String(inicio), "-t", String(dur), "-i", entrada, "-an", "-vf", `fps=${a.fps},scale=480:-2`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-threads", String(cfg.ffmpegThreads), tmp], a.timeoutMs);
    const r = JSON.parse(await correr(process.env.PYTHON_BIN || "python3", [SCRIPT, tmp, "--fps", String(a.fps)], a.timeoutMs));
    if (r.error) throw new Error(r.error);
    if (!(r.ancho > 0 && r.alto > 0) || r.ancho / r.alto <= ratio * 1.02) return null;   // video ya vertical/estrecho: nada que seguir
    const claves = suavizar(r.muestras, { ...a, dur, mitad: ratio * r.alto / r.ancho / 2 });
    if (!claves) { console.warn("Encuadre: no hay rostros suficientes, se usa el estático."); return null; }
    const hits = r.muestras.filter(s => Number.isFinite(s.x)).length;
    console.log(`Encuadre dinámico (${modo}): ${claves.length} claves, rostro en ${Math.round(100 * hits / r.muestras.length)} % de las muestras`);
    return { modo, expr: exprCentro(claves), ratio, claves: claves.length };
  } catch (e) {
    avisar(String(e.message).split("\n")[0].slice(0, 200));
    return null;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}
