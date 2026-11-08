// Servicio FFmpeg: corte exacto + reencuadre 9:16, sin descargar el video completo.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cfg } from "./config.js";

const LOGO = fileURLToPath(new URL("../assets/logo.png", import.meta.url));
const FORMATO = "bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/b";
const BASE = () => ["--no-playlist", "--no-warnings", ...(cfg.ytCookies ? ["--cookies", cfg.ytCookies] : [])];

function correr(cmd, args, timeoutMs = cfg.ffmpegTimeoutMs) {
  return new Promise((ok, no) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); no(new Error(`${cmd} excedió ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    p.stdout.on("data", d => { out = (out + d).slice(-20000); });
    p.stderr.on("data", d => { err = (err + d).slice(-1200); });
    p.on("error", e => { clearTimeout(t); no(e); });
    p.on("close", c => { clearTimeout(t); c === 0 ? ok(out) : no(new Error(`${cmd} terminó con código ${c}: ${err.slice(-500)}`)); });
  });
}

export async function urlsDirectas(videoUrl) {
  const out = await correr("yt-dlp", [...BASE(), "-g", "-f", FORMATO, videoUrl], 90000);
  const l = out.split("\n").map(s => s.trim()).filter(s => s.startsWith("http"));
  if (!l.length) throw new Error("yt-dlp no devolvió URLs.");
  return l.slice(0, 2);
}

export function construirFiltro({ modo, logo, idxLogo }) {
  const base = modo === "crop"
    ? "[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1[v0]"
    : "[0:v]split=2[a][b];[a]scale=360:640:force_original_aspect_ratio=increase,crop=360:640,boxblur=8:2,scale=720:1280[bg];" +
      "[b]scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v0]";
  return logo
    ? `${base};[${idxLogo}:v]scale=140:-1[lg];[v0][lg]overlay=W-w-24:24[v]`
    : base.replace(/\[v0\]$/, "[v]");
}

export function construirArgs({ urls, inicio, dur, out, logo }) {
  const ent = [];
  for (const u of urls) {
    if (/^https?:/.test(u)) ent.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
    ent.push("-ss", String(inicio), "-i", u);
  }
  if (logo) ent.push("-i", logo);
  return [
    "-y", "-hide_banner", "-loglevel", "error", ...ent, "-t", String(dur),
    "-filter_complex", construirFiltro({ modo: cfg.reencuadre, logo, idxLogo: urls.length }),
    "-map", "[v]", "-map", urls.length > 1 ? "1:a:0" : "0:a:0?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-r", "30", "-threads", String(cfg.ffmpegThreads),
    "-c:a", "aac", "-b:a", "96k", "-ar", "44100", "-movflags", "+faststart", out
  ];
}

async function viaDescarga(c, videoUrl, out, dur, logo) {
  const base = `${cfg.clipsDir}/raw-${c.token}`;
  try {
    await correr("yt-dlp", [...BASE(), "--download-sections", `*${c.inicio_seg}-${c.fin_seg}`, "--force-keyframes-at-cuts",
      "-f", FORMATO, "--merge-output-format", "mp4", "-o", `${base}.%(ext)s`, videoUrl]);
    const raw = (await fs.readdir(cfg.clipsDir)).find(n => n.startsWith(`raw-${c.token}`));
    if (!raw) throw new Error("yt-dlp no produjo archivo.");
    await correr("ffmpeg", construirArgs({ urls: [`${cfg.clipsDir}/${raw}`], inicio: 0, dur, out, logo }));
  } finally {
    for (const n of await fs.readdir(cfg.clipsDir).catch(() => [])) {
      if (n.startsWith(`raw-${c.token}`)) await fs.unlink(`${cfg.clipsDir}/${n}`).catch(() => {});
    }
  }
}

export async function cortarClip(c, videoUrl) {
  await fs.mkdir(cfg.clipsDir, { recursive: true });
  const out = `${cfg.clipsDir}/clip-${c.token}.mp4`;
  const dur = Number(c.fin_seg) - Number(c.inicio_seg);
  const logo = existsSync(LOGO) ? LOGO : null;
  try {
    const urls = await urlsDirectas(videoUrl);
    await correr("ffmpeg", construirArgs({ urls, inicio: Number(c.inicio_seg), dur, out, logo }));
  } catch (e) {
    console.warn("Corte directo falló, uso descarga del tramo:", e.message);
    await fs.unlink(out).catch(() => {});
    await viaDescarga(c, videoUrl, out, dur, logo);
  }
  const st = await fs.stat(out);
  if (st.size < 50000) throw new Error("El clip resultó vacío.");
  return out;
}
