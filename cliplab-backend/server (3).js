import express from "express";
import pg from "pg";
import fs from "node:fs";
import { analizar } from "./gemini.js";
import { procesarClip, limpiar } from "./clips.js";
import { publicar, PLATAFORMAS } from "./publish.js";

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "50kb" }));
app.use((req, res, next) => {
  res.set({ "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*", "Access-Control-Allow-Headers": "Content-Type,x-api-key",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
  req.method === "OPTIONS" ? res.sendStatus(204) : next();
});
const auth = (req, res, next) => process.env.API_KEY && req.get("x-api-key") !== process.env.API_KEY ? res.status(401).json({ error: "Clave de acceso inválida." }) : next();
const h = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ error: e.message }));
const base = req => process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
const vivo = c => c.archivo_path && fs.existsSync(c.archivo_path);
const pub = (c, b) => ({ id: c.id, youtube_url: c.youtube_url, clip_titulo: c.clip_titulo, gancho: c.gancho,
  timestamp_inicio: c.timestamp_inicio, timestamp_fin: c.timestamp_fin, puntaje_viral: c.puntaje_viral, categoria: c.categoria,
  angulo: c.angulo, es_parte: c.es_parte, serie_id: c.serie_id, error: c.error,
  estado: c.estado === "listo" && !vivo(c) ? "expirado" : c.estado, video_url: vivo(c) ? `${b}/media/${c.token}.mp4` : null });

app.get("/health", (_, res) => res.send("ok"));

app.get("/media/:token.mp4", h(async (req, res) => {   // el token es un UUID no adivinable; sendFile soporta Range
  if (!/^[0-9a-f-]{36}$/.test(req.params.token)) return res.sendStatus(404);
  const { rows: [c] } = await db.query("SELECT archivo_path FROM clips WHERE token=$1", [req.params.token]);
  c && vivo(c) ? res.sendFile(c.archivo_path) : res.sendStatus(404);
}));

app.get("/api/clips", auth, h(async (req, res) => {
  const { rows } = await db.query("SELECT * FROM clips ORDER BY creado_en DESC, id DESC LIMIT 60");
  res.json(rows.map(c => pub(c, base(req))));
}));

app.post("/api/procesar", auth, h(async (req, res) => {
  const vid = String(req.body?.url || "").match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/)?.[1];
  if (!vid) return res.status(400).json({ error: "Por ahora solo se aceptan enlaces de YouTube." });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "Falta GEMINI_API_KEY en el servidor." });
  const url = `https://www.youtube.com/watch?v=${vid}`, run = Date.now().toString(36);
  const clips = await analizar(url);
  if (!clips.length) return res.status(422).json({ error: "La IA no devolvió clips válidos. Prueba con otro video." });
  const rows = [];
  for (const c of clips) {
    const { rows: [r] } = await db.query(`INSERT INTO clips(youtube_url,clip_titulo,gancho,timestamp_inicio,timestamp_fin,puntaje_viral,categoria,angulo,es_parte,serie_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [url, c.clip_titulo, c.gancho, c.timestamp_inicio, c.timestamp_fin, c.puntaje_viral, c.categoria, c.angulo, c.es_parte, c.serie ? `${vid}:${run}:${c.serie}` : null]);
    rows.push(r);
  }
  rows.forEach(r => procesarClip(db, r));   // en segundo plano, uno a la vez
  res.status(202).json(rows.map(r => pub(r, base(req))));
}));

app.post("/api/clips/:id/regenerar", auth, h(async (req, res) => {
  const { rows: [c] } = await db.query("UPDATE clips SET estado='procesando', error=NULL WHERE id=$1 RETURNING *", [req.params.id]);
  if (!c) return res.sendStatus(404);
  procesarClip(db, c); res.sendStatus(202);
}));

app.post("/api/clips/:id/publicar", auth, h(async (req, res) => {
  const plats = [...new Set(req.body?.plataformas || [])];
  if (!plats.length || plats.some(p => !PLATAFORMAS[p])) return res.status(400).json({ error: "Plataformas válidas: " + Object.keys(PLATAFORMAS).join(", ") });
  const { rows: [c] } = await db.query("SELECT * FROM clips WHERE id=$1", [req.params.id]);
  if (!c) return res.sendStatus(404);
  res.json(await publicar(db, c, plats));
}));

await db.query(fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
await db.query("UPDATE clips SET estado='error', error='Interrumpido por un reinicio del servidor.' WHERE estado='procesando'");
await limpiar(db); setInterval(() => limpiar(db).catch(console.error), 3600e3);
app.listen(process.env.PORT || 3000, () => console.log("ClipLab backend listo"));
