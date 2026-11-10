import express, { Router } from "express";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, readdir, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { processVideo } from "./engine/pipeline.mjs";
import { renderAll } from "./engine/render.mjs";

const MEDIA = path.resolve(process.env.MOTOR_MEDIA_DIR || "media");
const OUT = path.resolve(process.env.MOTOR_OUT_DIR || "out");
const EXT = /\.(mp4|mkv|mov|webm|m4v)$/i;
const NOMBRE = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,119}$/;
const MAX_TRABAJOS = 50;
const MAX_ACTIVOS = 10;

const trabajos = new Map();
let cola = Promise.resolve();

function existe(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("close", () => resolve(true));
  });
}

function correr(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} falló (${c}): ${err.slice(-400)}`))));
  });
}

async function descargar(job) {
  await mkdir(MEDIA, { recursive: true });
  await correr("yt-dlp", [
    "--no-playlist", "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
    "--merge-output-format", "mp4",
    "-o", path.join(MEDIA, `${job.id}.%(ext)s`), "--", job.url,
  ]);
  const f = (await readdir(MEDIA)).find((n) => n.startsWith(`${job.id}.`) && EXT.test(n));
  if (!f) throw new Error("yt-dlp no produjo el archivo de video.");
  return path.join(MEDIA, f);
}

async function ejecutar(job) {
  try {
    let video = job.video;
    if (job.url) { job.estado = "descargando"; video = await descargar(job); job.nombre = path.parse(video).name; }
    job.estado = "transcribiendo";
    await processVideo(video, { outDir: OUT, lang: job.lang });
    job.estado = "renderizando";
    const r = await renderAll(video, { outDir: OUT });
    job.clips = r.manifest.length;
    job.estado = "listo";
  } catch (e) {
    job.estado = "error";
    job.error = String(e.message || e).slice(0, 500);
  }
}

const publico = (j) => ({
  id: j.id, fuente: j.url || j.archivo, estado: j.estado, nombre: j.nombre,
  clips: j.clips ?? null, error: j.error ?? null, creado: j.creado,
});

const r = Router();

r.get("/salud", async (_req, res) => {
  const [ffmpeg, whisper, ytdlp] = await Promise.all([
    existe("ffmpeg", ["-version"]),
    existe(process.env.WHISPER_BIN || "whisper-cli", ["--help"]),
    existe("yt-dlp", ["--version"]),
  ]);
  res.json({ ffmpeg, whisper, ytdlp });
});

r.get("/trabajos", (_req, res) => {
  res.json([...trabajos.values()].reverse().map(publico));
});

r.post("/trabajos", express.json({ limit: "4kb" }), async (req, res) => {
  const { url, archivo, lang } = req.body || {};
  const activos = [...trabajos.values()].filter((j) => !["listo", "error"].includes(j.estado)).length;
  if (activos >= MAX_ACTIVOS) return res.status(429).json({ error: "Demasiados trabajos en curso." });

  const job = {
    id: randomBytes(4).toString("hex"),
    estado: "en_cola",
    creado: new Date().toISOString(),
    lang: typeof lang === "string" && /^([a-z]{2,3}|auto)$/.test(lang) ? lang : "es",
  };

  if (typeof url === "string" && url) {
    if (url.length > 500 || !/^https?:\/\/\S+$/.test(url)) return res.status(400).json({ error: "URL inválida." });
    job.url = url;
    job.nombre = job.id;
  } else if (typeof archivo === "string" && archivo) {
    if (!NOMBRE.test(archivo) || !EXT.test(archivo)) return res.status(400).json({ error: "Nombre de archivo inválido." });
    job.archivo = archivo;
    job.video = path.join(MEDIA, archivo);
    job.nombre = path.parse(archivo).name;
    try { await stat(job.video); } catch { return res.status(404).json({ error: "No existe ese archivo en media/." }); }
  } else {
    return res.status(400).json({ error: "Indica url o archivo." });
  }

  trabajos.set(job.id, job);
  if (trabajos.size > MAX_TRABAJOS) {
    for (const [k, v] of trabajos) {
      if (trabajos.size <= MAX_TRABAJOS) break;
      if (["listo", "error"].includes(v.estado)) trabajos.delete(k);
    }
  }
  cola = cola.then(() => ejecutar(job));
  res.status(202).json(publico(job));
});

r.get("/biblioteca", async (_req, res) => {
  const lista = [];
  try {
    for (const d of await readdir(OUT, { withFileTypes: true })) {
      if (!d.isDirectory() || !NOMBRE.test(d.name)) continue;
      try {
        const clips = JSON.parse(await readFile(path.join(OUT, d.name, "final", "manifest.json"), "utf8"));
        lista.push({ nombre: d.name, clips });
      } catch { /* sin render todavía */ }
    }
  } catch { /* out/ aún no existe */ }
  res.json(lista);
});

r.get("/archivo/:nombre/:file", async (req, res) => {
  const { nombre, file } = req.params;
  if (!NOMBRE.test(nombre) || !NOMBRE.test(file)) return res.status(400).json({ error: "Nombre inválido." });
  try {
    const dir = path.join(OUT, nombre, "final");
    const man = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    if (!man.some((m) => m.file === file || m.subtitles === file)) throw new Error("fuera del manifiesto");
    res.sendFile(file, { root: dir, dotfiles: "deny" });
  } catch {
    res.status(404).json({ error: "No encontrado." });
  }
});

export default r;
