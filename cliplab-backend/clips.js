import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { toSec } from "./gemini.js";

const DIR = process.env.CLIPS_DIR || "/tmp/clips";
export const TTL_DIAS = 15;

// Un solo trabajo pesado a la vez: protege la RAM y la CPU de Railway.
let cola = Promise.resolve();
export function enCola(fn) { const p = cola.then(fn); cola = p.catch(() => {}); return p; }

const run = (cmd, args) => new Promise((ok, no) => {
  const p = spawn(cmd, args); let err = "";
  p.stderr.on("data", d => { err = (err + d).slice(-800); });
  p.on("error", no);
  p.on("close", c => c === 0 ? ok() : no(new Error(`${cmd} terminó con código ${c}: ${err}`)));
});

async function generar(c) {
  await fs.mkdir(DIR, { recursive: true });
  const out = `${DIR}/clip-${c.token}.mp4`;
  try {
    // Solo se descarga el tramo del clip, no el video completo.
    await run("yt-dlp", ["--no-playlist", "--download-sections", `*${toSec(c.timestamp_inicio)}-${toSec(c.timestamp_fin)}`,
      "-f", "bv*[height<=720]+ba/b[height<=720]", "--merge-output-format", "mp4", "-o", `${DIR}/raw-${c.token}.%(ext)s`,
      ...(process.env.YT_COOKIES ? ["--cookies", process.env.YT_COOKIES] : []), c.youtube_url]);
    const raw = (await fs.readdir(DIR)).find(n => n.startsWith(`raw-${c.token}`));
    if (!raw) throw new Error("yt-dlp no produjo archivo.");
    await run("ffmpeg", ["-y", "-i", `${DIR}/${raw}`, "-vf", "crop=ih*9/16:ih,scale=720:1280",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out]);
  } finally {
    for (const n of await fs.readdir(DIR).catch(() => [])) if (n.startsWith(`raw-${c.token}`)) await fs.unlink(`${DIR}/${n}`).catch(() => {});
  }
  return out;
}

const listo = (db, id, f) => db.query("UPDATE clips SET estado='listo', archivo_path=$2, error=NULL WHERE id=$1", [id, f]);

export async function procesarClip(db, c) {
  try { await listo(db, c.id, await enCola(() => generar(c))); }
  catch (e) { await db.query("UPDATE clips SET estado='error', error=$2 WHERE id=$1", [c.id, String(e.message).slice(0, 500)]); }
}

// Si el archivo ya no está (borrado o reinicio), se regenera al vuelo con los timestamps de SQL.
export async function asegurarArchivo(db, c) {
  if (c.archivo_path && existsSync(c.archivo_path)) return c.archivo_path;
  const f = await enCola(() => generar(c)); await listo(db, c.id, f); return f;
}

export async function borrarArchivo(db, id) {
  const { rows: [c] } = await db.query("SELECT archivo_path FROM clips WHERE id=$1", [id]);
  if (c?.archivo_path) await fs.unlink(c.archivo_path).catch(() => {});
  await db.query("UPDATE clips SET archivo_path=NULL, estado='expirado' WHERE id=$1", [id]);
}

export async function limpiar(db) {
  const { rows } = await db.query(`SELECT id FROM clips WHERE archivo_path IS NOT NULL AND creado_en < now() - interval '${TTL_DIAS} days'`);
  for (const c of rows) await borrarArchivo(db, c.id);
  for (const n of await fs.readdir(DIR).catch(() => [])) {   // restos de procesos interrumpidos
    const st = await fs.stat(`${DIR}/${n}`).catch(() => null);
    if (st && n.startsWith("raw-") && Date.now() - st.mtimeMs > 3600e3) await fs.unlink(`${DIR}/${n}`).catch(() => {});
  }
}
