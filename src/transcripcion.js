// Transcripción por clip: 1) subtítulos de YouTube (json3, con tiempo por palabra) 2) respaldo con Gemini.
// Nunca bloquea el corte: si todo falla devuelve [] y el clip sale sin subtítulos.
import fs from "node:fs/promises";
import { cfg } from "./config.js";
import { correr } from "./proc.js";
import { generar, ROL } from "./gemini.js";
import { parseJson3, aPalabras, normalizar, recortarPalabras } from "./subtitulos.js";

const TTL_MS = 30 * 60e3;
const cache = new Map();   // video_id → { t, palabras }: los 8 clips de un video comparten una sola descarga
const BASE = () => ["--no-playlist", "--no-warnings", ...(cfg.ytCookies ? ["--cookies", cfg.ytCookies] : [])];

async function palabrasYouTube(videoId, url) {
  const hit = cache.get(videoId);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.palabras;
  const dir = `${cfg.clipsDir}/tr-${videoId}`;
  await fs.mkdir(dir, { recursive: true });
  try {
    const langs = cfg.subIdiomas.split(",").map(s => s.trim()).filter(Boolean);
    await correr("yt-dlp", [...BASE(), "--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", langs.join(","),
      "--sub-format", "json3", "-o", `${dir}/t`, url], 90000);
    const archivos = await fs.readdir(dir);
    const elegido = langs.map(l => archivos.find(n => n === `t.${l}.json3`)).find(Boolean) || archivos.find(n => n.endsWith(".json3"));
    if (!elegido) throw new Error("el video no tiene subtítulos");
    const palabras = parseJson3(JSON.parse(await fs.readFile(`${dir}/${elegido}`, "utf8")));
    cache.set(videoId, { t: Date.now(), palabras });
    for (const [k, v] of cache) if (Date.now() - v.t > TTL_MS) cache.delete(k);
    return palabras;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const SCHEMA = {
  type: "ARRAY",
  items: { type: "OBJECT", properties: { t: { type: "STRING" }, i: { type: "NUMBER" }, f: { type: "NUMBER" } }, required: ["t", "i", "f"] }
};

async function palabrasGemini(c, url) {
  const ini = Number(c.inicio_seg), dur = Number(c.fin_seg) - ini;
  const { data } = await generar(ROL.ANALISIS, {
    contents: [{ parts: [
      { fileData: { fileUri: url }, videoMetadata: { startOffset: `${Math.floor(ini)}s`, endOffset: `${Math.ceil(ini + dur)}s` } },
      { text: `Transcribe literalmente lo que se habla en este fragmento, en su idioma original. Devuelve un arreglo JSON de frases cortas (máximo 6 palabras) con "t" (texto), "i" (segundo de inicio) y "f" (segundo de fin). Los tiempos son decimales RELATIVOS al inicio del fragmento (0.0 = primer instante). No inventes texto ni incluyas descripciones de sonidos.` }
    ] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 }
  });
  const txt = data.candidates?.[0]?.content?.parts?.[0]?.text;
  const frases = (txt ? JSON.parse(txt) : []).filter(x => x && Number(x.i) >= 0 && Number(x.f) > Number(x.i) && Number(x.f) <= dur + 2);
  return normalizar(aPalabras(frases.map(x => ({ t: x.t, i: Number(x.i), f: Math.min(Number(x.f), dur) }))));
}

// Palabras del clip con tiempos relativos a su inicio. Reusa las ya guardadas en PostgreSQL (c.palabras).
export async function palabrasDelClip(c, url) {
  if (!cfg.subtitulos) return [];
  if (Array.isArray(c.palabras) && c.palabras.length) return c.palabras;
  const ini = Number(c.inicio_seg), fin = Number(c.fin_seg);
  try {
    const rel = recortarPalabras(await palabrasYouTube(c.video_id, url), ini, fin);
    if (rel.length >= 3) return rel;
  } catch (e) { console.warn(`Subtítulos de YouTube no disponibles (${c.video_id}): ${e.message.split("\n")[0]}`); }
  try { return await palabrasGemini(c, url); }
  catch (e) { console.warn(`Transcripción con Gemini falló (clip ${c.id}): ${e.message.split("\n")[0]}`); return []; }
}
