// src/server.js — ClipLab (búnker privado)
import express from "express";
import pg from "pg";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { analizar } from "./gemini.js";
import { procesarClip, limpiar } from "./clips.js";
import { publicar, PLATAFORMAS } from "./publish.js";
import {
  assertConfig, securityHeaders, cors, rateLimit, isAuthed, requireAuth,
  login, logout, loginPage, panelCsp, mediaUrl, verifyMedia
} from "./security.js";

assertConfig();   // sin MASTER_KEY no arranca
process.on("unhandledRejection", e => console.error("unhandledRejection:", e));

const PANEL = fileURLToPath(new URL("./public/index.html", import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^\d{1,18}$/;

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
db.on("error", e => console.error("pg:", e.message));

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);   // Railway = un salto de proxy

const h = fn => (req, res, next) => fn(req, res).catch(next);
const base = req => (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const vivo = c => c.archivo_path && fs.existsSync(c.archivo_path);
const pub = (c, b) => ({
  id: c.id, youtube_url: c.youtube_url, clip_titulo: c.clip_titulo, gancho: c.gancho,
  timestamp_inicio: c.timestamp_inicio, timestamp_fin: c.timestamp_fin, puntaje_viral: c.puntaje_viral, categoria: c.categoria,
  angulo: c.angulo, es_parte: c.es_parte, serie_id: c.serie_id, error: c.error,
  estado: c.estado === "listo" && !vivo(c) ? "expirado" : c.estado,
  video_url: vivo(c) ? mediaUrl(b, c.token, 3600) : null
});

// ================= 1. CABECERAS (noindex en todo) =================
app.use(securityHeaders);
app.use(cors);

// ================= 2. ÚNICAS RUTAS PÚBLICAS =================
app.get("/health", (_, res) => res.type("text").send("ok"));
app.get("/robots.txt", (_, res) => res.type("text").send("User-agent: *\nDisallow: /\n"));

// Video: solo con URL firmada y vigente (Instagram lo descarga desde aquí).
app.get("/media/:token.mp4", rateLimit({ windowMs: 60e3, max: 120 }), h(async (req, res) => {
  const { token } = req.params;
  if (!UUID.test(token) || !verifyMedia(token, req.query.exp, req.query.sig)) return res.sendStatus(404);
  const { rows: [c] } = await db.query("SELECT archivo_path FROM clips WHERE token=$1", [token]);
  if (!c || !vivo(c)) return res.sendStatus(404);
  res.sendFile(c.archivo_path, { dotfiles: "deny" }, e => { if (e && !res.headersSent) res.sendStatus(404); });
}));

app.post("/auth/login", express.urlencoded({ extended: false, limit: "2kb" }), login);
app.post("/auth/logout", logout);

// Raíz: login si no hay sesión; panel si la hay.
app.get("/", (req, res) => {
  if (!isAuthed(req)) return loginPage(res, req.query.e ? "Llave incorrecta." : "");
  res.set("Content-Security-Policy", panelCsp());
  if (fs.existsSync(PANEL)) return res.sendFile(PANEL);
  res.type("text").send("ClipLab activo. Falta src/public/index.html (el panel).");
});

// ================= 3. TODO LO DEMÁS: AUTENTICACIÓN OBLIGATORIA =================
app.use(requireAuth);

const api = express.Router();
api.use(rateLimit({ windowMs: 60e3, max: 240 }));
api.use(express.json({ limit: "50kb" }));

api.get("/clips", h(async (req, res) => {
  const { rows } = await db.query("SELECT * FROM clips ORDER BY creado_en DESC, id DESC LIMIT 60");
  res.json(rows.map(c => pub(c, base(req))));
}));

const enAnalisis = new Set();   // evita gastar tokens dos veces con el mismo video
api.post("/procesar", rateLimit({ windowMs: 60e3, max: 10 }), h(async (req, res) => {
  const vid = String(req.body?.url || "").match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/)?.[1];
  if (!vid) return res.status(400).json({ error: "Por ahora solo se aceptan enlaces de YouTube." });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "Falta GEMINI_API_KEY en el servidor." });
  if (enAnalisis.has(vid)) return res.status(409).json({ error: "Ese video ya se está analizando." });
  enAnalisis.add(vid);
  try {
    const url = `https://www.youtube.com/watch?v=${vid}`, run = Date.now().toString(36);
    const clips = await analizar(url);
    if (!clips.length) return res.status(422).json({ error: "La IA no devolvió clips válidos. Prueba con otro video." });
    const rows = [];
    for (const c of clips) {
      const { rows: [r] } = await db.query(
        `INSERT INTO clips(youtube_url,clip_titulo,gancho,timestamp_inicio,timestamp_fin,puntaje_viral,categoria,angulo,es_parte,serie_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [url, c.clip_titulo, c.gancho, c.timestamp_inicio, c.timestamp_fin, c.puntaje_viral, c.categoria, c.angulo, c.es_parte,
         c.serie ? `${vid}:${run}:${c.serie}` : null]);
      rows.push(r);
    }
    for (const r of rows) procesarClip(db, r).catch(console.error);   // segundo plano, uno a la vez
    res.status(202).json(rows.map(r => pub(r, base(req))));
  } finally {
    enAnalisis.delete(vid);
  }
}));

api.post("/clips/:id/regenerar", h(async (req, res) => {
  if (!ID.test(req.params.id)) return res.sendStatus(404);
  const { rows: [c] } = await db.query("UPDATE clips SET estado='procesando', error=NULL WHERE id=$1 RETURNING *", [req.params.id]);
  if (!c) return res.sendStatus(404);
  procesarClip(db, c).catch(console.error);
  res.sendStatus(202);
}));

api.post("/clips/:id/publicar", rateLimit({ windowMs: 60e3, max: 20 }), h(async (req, res) => {
  if (!ID.test(req.params.id)) return res.sendStatus(404);
  const plats = [...new Set(Array.isArray(req.body?.plataformas) ? req.body.plataformas : [])];
  if (!plats.length || plats.some(p => !PLATAFORMAS[p])) {
    return res.status(400).json({ error: "Plataformas válidas: " + Object.keys(PLATAFORMAS).join(", ") });
  }
  const { rows: [c] } = await db.query("SELECT * FROM clips WHERE id=$1", [req.params.id]);
  if (!c) return res.sendStatus(404);
  res.json(await publicar(db, c, plats));
}));

app.use("/api", api);
app.use((req, res) => res.status(404).json({ error: "No encontrado." }));
app.use((e, req, res, next) => {
  console.error(`[${req.method} ${req.path}]`, e);
  if (res.headersSent) return next(e);
  res.status(e.status || 500).json({ error: String(e.message || "Error interno.").slice(0, 300) });
});

// ================= 4. ARRANQUE =================
await db.query(fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
await db.query("UPDATE clips SET estado='error', error='Interrumpido por un reinicio del servidor.' WHERE estado='procesando'");
await limpiar(db).catch(console.error);
setInterval(() => limpiar(db).catch(console.error), 3600e3).unref();

const srv = app.listen(process.env.PORT || 3000, () => console.log("ClipLab búnker listo"));
srv.keepAliveTimeout = 65e3;
srv.headersTimeout = 66e3;

const apagar = () => {
  console.log("Apagando…");
  srv.close(() => db.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10e3).unref();
};
process.on("SIGTERM", apagar);
process.on("SIGINT", apagar);
