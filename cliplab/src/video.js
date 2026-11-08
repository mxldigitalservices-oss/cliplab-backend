// Servicio FFmpeg: corte exacto + reencuadre 9:16 + marca de agua + subtítulos ASS en una sola pasada.
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cfg } from "./config.js";
import { correr } from "./proc.js";
import { construirAss } from "./subtitulos.js";

export const W = 720, H = 1280;
// Zonas que la interfaz de TikTok / Reels / Shorts tapa sobre un lienzo 720x1280.
export const ZONAS = Object.freeze({ arriba: 140, abajo: 340, lateral: 24, rielDerecho: { ancho: 120, desdeY: 480 } });

const LOGO_DEFECTO = fileURLToPath(new URL("../assets/logo.png", import.meta.url));
const COORD_DEFECTO = Object.freeze({ x: 36, y: 150, w: 130 });
const FORMATO = "bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/b";
const BASE = () => ["--no-playlist", "--no-warnings", ...(cfg.ytCookies ? ["--cookies", cfg.ytCookies] : [])];

export async function urlsDirectas(videoUrl) {
  const out = await correr("yt-dlp", [...BASE(), "-g", "-f", FORMATO, videoUrl], 90000);
  const l = out.split("\n").map(s => s.trim()).filter(s => s.startsWith("http"));
  if (!l.length) throw new Error("yt-dlp no devolvió URLs.");
  return l.slice(0, 2);
}

// ---------- Marca de agua: coordenadas fijas validadas ----------

// Devuelve { ok, motivo }. El logo debe caber en el lienzo y no pisar la interfaz de la plataforma.
export function validarMarca({ x, y, w, h }) {
  const { arriba, abajo, lateral, rielDerecho } = ZONAS;
  if (![x, y, w, h].every(Number.isFinite) || w < 20 || h < 8) return { ok: false, motivo: "medidas inválidas" };
  if (x < lateral || x + w > W - lateral) return { ok: false, motivo: `se sale de los márgenes laterales (${lateral}px)` };
  if (y < arriba) return { ok: false, motivo: `invade la barra superior (primeros ${arriba}px)` };
  if (y + h > H - abajo) return { ok: false, motivo: `invade la zona de descripción (últimos ${abajo}px)` };
  if (x + w > W - rielDerecho.ancho && y + h > rielDerecho.desdeY) return { ok: false, motivo: "invade la columna de botones de la derecha" };
  return { ok: true, motivo: "" };
}

const dimsCache = new Map();
async function dimsLogo(ruta) {
  const st = await fs.stat(ruta);
  const clave = `${ruta}:${st.mtimeMs}`;
  if (!dimsCache.has(clave)) {
    const out = await correr("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", ruta], 15000);
    const [ancho, alto] = out.trim().split(",").map(Number);
    if (!(ancho > 0 && alto > 0)) throw new Error("no pude leer las medidas del logo");
    dimsCache.set(clave, { ancho, alto });
  }
  return dimsCache.get(clave);
}

// Prepara la marca: coordenadas de la configuración si son válidas; si no, las de fábrica; si tampoco, sin marca.
export async function prepararMarca() {
  const ruta = cfg.logoPath || LOGO_DEFECTO;
  if (!existsSync(ruta)) return null;
  try {
    const { ancho, alto } = await dimsLogo(ruta);
    const alturaDe = w => Math.round(w * alto / ancho);
    for (const [origen, c] of [["configuradas", { x: cfg.logoX, y: cfg.logoY, w: cfg.logoAncho }], ["de fábrica", COORD_DEFECTO]]) {
      const v = validarMarca({ ...c, h: alturaDe(c.w) });
      if (v.ok) return { archivo: ruta, ...c, opacidad: cfg.logoOpacidad };
      console.warn(`Marca de agua: coordenadas ${origen} rechazadas (${v.motivo}).`);
    }
  } catch (e) { console.warn("Marca de agua omitida:", e.message); }
  return null;
}

// ---------- Filtro y argumentos de FFmpeg ----------

const escFiltro = s => String(s).replace(/\\/g, "\\\\").replace(/'/g, "'\\\\\\''").replace(/:/g, "\\:");

// marca = { idx, x, y, w, opacidad } | null    ass = { archivo, fontsDir? } | null
export function construirFiltro({ modo, marca, ass }) {
  const partes = [modo === "crop"
    ? `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[v0]`
    : `[0:v]split=2[a][b];[a]scale=360:640:force_original_aspect_ratio=increase,crop=360:640,boxblur=8:2,scale=${W}:${H}[bg];` +
      `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v0]`];
  let ult = "v0";
  if (marca) {
    // format=rgba conserva el canal alfa del PNG; colorchannelmixer=aa aplica la opacidad sin ensuciar los bordes.
    partes.push(`[${marca.idx}:v]format=rgba,scale=${marca.w}:-1:flags=lanczos,colorchannelmixer=aa=${marca.opacidad}[lg]`);
    partes.push(`[${ult}][lg]overlay=${marca.x}:${marca.y}:format=auto[v1]`);
    ult = "v1";
  }
  if (ass) partes.push(`[${ult}]ass=filename='${escFiltro(ass.archivo)}'${ass.fontsDir ? `:fontsdir='${escFiltro(ass.fontsDir)}'` : ""}[v2]`), ult = "v2";
  partes.push(`[${ult}]format=yuv420p[v]`);
  return partes.join(";");
}

export function construirArgs({ urls, inicio, dur, out, marca, ass }) {
  const ent = [];
  for (const u of urls) {
    if (/^https?:/.test(u)) ent.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
    ent.push("-ss", String(inicio), "-i", u);
  }
  if (marca) ent.push("-i", marca.archivo);
  return [
    "-y", "-hide_banner", "-loglevel", "error", ...ent, "-t", String(dur),
    "-filter_complex", construirFiltro({ modo: cfg.reencuadre, marca: marca && { ...marca, idx: urls.length }, ass }),
    "-map", "[v]", "-map", urls.length > 1 ? "1:a:0" : "0:a:0?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(cfg.crf), "-maxrate", "5M", "-bufsize", "10M",
    "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", "30", "-g", "60", "-threads", String(cfg.ffmpegThreads),
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-movflags", "+faststart", out
  ];
}

// ---------- Corte ----------

async function viaDescarga(c, videoUrl, out, dur, extra) {
  const base = `${cfg.clipsDir}/raw-${c.token}`;
  try {
    await correr("yt-dlp", [...BASE(), "--download-sections", `*${c.inicio_seg}-${c.fin_seg}`, "--force-keyframes-at-cuts",
      "-f", FORMATO, "--merge-output-format", "mp4", "-o", `${base}.%(ext)s`, videoUrl]);
    const raw = (await fs.readdir(cfg.clipsDir)).find(n => n.startsWith(`raw-${c.token}`));
    if (!raw) throw new Error("yt-dlp no produjo archivo.");
    await correr("ffmpeg", construirArgs({ urls: [`${cfg.clipsDir}/${raw}`], inicio: 0, dur, out, ...extra }));
  } finally {   // el video fuente pesado se borra siempre, salga bien o mal
    for (const n of await fs.readdir(cfg.clipsDir).catch(() => [])) {
      if (n.startsWith(`raw-${c.token}`)) await fs.unlink(`${cfg.clipsDir}/${n}`).catch(() => {});
    }
  }
}

// Devuelve metadatos ligeros para PostgreSQL: { archivo, bytes, ms, conSubtitulos, conMarca }.
export async function cortarClip(c, videoUrl, { palabras = [] } = {}) {
  const t0 = Date.now();
  await fs.mkdir(cfg.clipsDir, { recursive: true });
  const out = `${cfg.clipsDir}/clip-${c.token}.mp4`;
  const assRuta = `${cfg.clipsDir}/sub-${c.token}.ass`;
  const dur = Number(c.fin_seg) - Number(c.inicio_seg);
  if (!(dur > 0)) throw new Error("Rango de corte inválido.");
  const marca = await prepararMarca();

  let ass = null;
  if (palabras.length) {
    await fs.writeFile(assRuta, construirAss(palabras, { fuente: "DejaVu Sans", tamano: cfg.subTamano, margenV: cfg.subMargenV, max: cfg.subMaxPalabras }), "utf8");
    ass = { archivo: assRuta, fontsDir: existsSync(cfg.fontsDir) ? cfg.fontsDir : null };
  }

  const producir = async extra => {
    try {
      const urls = await urlsDirectas(videoUrl);
      await correr("ffmpeg", construirArgs({ urls, inicio: Number(c.inicio_seg), dur, out, ...extra }));
    } catch (e) {
      console.warn("Corte directo falló, uso descarga del tramo:", e.message);
      await fs.unlink(out).catch(() => {});
      await viaDescarga(c, videoUrl, out, dur, extra);
    }
  };

  let conSubtitulos = false;
  try {
    try {
      await producir({ marca, ass });
      conSubtitulos = !!ass;
    } catch (e) {
      // Si el problema fue el filtro de subtítulos (fuente, libass), el clip sale igual, sin ellos.
      if (!ass || !/\bass\b|subtit|filter|font/i.test(e.message)) throw e;
      console.warn("Subtítulos omitidos por error de FFmpeg:", e.message.split("\n")[0]);
      await fs.unlink(out).catch(() => {});
      await producir({ marca, ass: null });
    }
    const st = await fs.stat(out);
    if (st.size < 50000) throw new Error("El clip resultó vacío.");
    return { archivo: out, bytes: st.size, ms: Date.now() - t0, conSubtitulos, conMarca: !!marca };
  } catch (e) {
    await fs.unlink(out).catch(() => {});   // nunca queda un clip a medias ocupando disco
    throw e;
  } finally {
    await fs.unlink(assRuta).catch(() => {});
  }
}
