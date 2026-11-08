import express from "express";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cfg } from "./config.js";
import { q, db, iniciarDb } from "./db.js";
import { assertConfig, securityHeaders, rateLimit, isAuthed, requireAuth, login, logout, loginPage, renovarSesion, CSP_PANEL } from "./security.js";
import { PLATAFORMAS, listarSesiones, guardarSesion, borrarSesion, tieneSesion, marcarTest, normalizarSesion, validarSesion } from "./sesiones.js";
import { encolar, iniciarWorker, recuperarJobs } from "./queue.js";
import { hAnalizar, hCortar, hPublicar, ytUrl } from "./pipeline.js";
import { probarSesion, agenteOcupado } from "./agent/index.js";
import { limpiar, usoDiscoMb, borrarArchivoClip } from "./janitor.js";
import { hLoteItem, iniciarDespachador } from "./lotes.js";
import { rutasLotes } from "./rutas-lotes.js";
import { hVivoSegmento, prepararVivo, detenerCapturas } from "./vivo.js";
import { rutasVivo } from "./rutas-vivo.js";
import { rutasCookies } from "./rutas-cookies.js";
import { prepararCookies } from "./cookies-repo.js";
import { hAutoVariantes } from "./auto-variantes.js";
import { prepararCookiesYoutube } from "./yt-cookies.js";

assertConfig();   // sin MASTER_KEY no arranca
process.on("unhandledRejection", e => console.error("unhandledRejection:", e));

const PUB = fileURLToPath(new URL("./public/", import.meta.url));
const ID = /^\d{1,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const YT = /(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([\w-]{11})/;
const h = fn => (req, res, next) => fn(req, res).catch(next);
const plats = v => [...new Set((Array.isArray(v) ? v : []).filter(p => PLATAFORMAS.includes(p)))];

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);   // Railway = un salto de proxy

// ===== 1. Cabeceras anti-indexación en TODO =====
app.use(securityHeaders);

// ===== 2. Únicas rutas públicas =====
app.get("/health", (_, res) => res.type("text").send("ok"));
app.get("/robots.txt", (_, res) => res.type("text").send("User-agent: *\nDisallow: /\n"));
app.post("/auth/login", express.urlencoded({ extended: false, limit: "2kb" }), login);
app.post("/auth/logout", logout);
app.get("/", (req, res) => {
  if (!isAuthed(req)) return loginPage(res, req.query.e ? "Llave incorrecta." : "");
  renovarSesion(req, res);
  res.set("Content-Security-Policy", CSP_PANEL);
  res.sendFile(PUB + "index.html");
});

// ===== 3. Todo lo demás exige la llave maestra =====
app.use(requireAuth);
app.use(express.static(PUB, { index: false, dotfiles: "deny" }));

app.get("/media/:token.mp4", h(async (req, res) => {
  if (!UUID.test(req.params.token)) return res.sendStatus(404);
  const { rows: [c] } = await q("SELECT archivo FROM clips WHERE token=$1", [req.params.token]);
  if (!c?.archivo) return res.sendStatus(404);
  res.sendFile(c.archivo, { dotfiles: "deny" }, e => { if (e && !res.headersSent) res.sendStatus(404); });
}));

app.get("/evidencia/:n", (req, res) => {
  if (!/^[\w.-]+\.png$/.test(req.params.n)) return res.sendStatus(404);
  res.sendFile(`${cfg.dataDir}/evidencias/${req.params.n}`, { dotfiles: "deny" }, e => { if (e && !res.headersSent) res.sendStatus(404); });
});

const api = express.Router();
api.use(rateLimit({ windowMs: 60e3, max: 240 }));

// Sesiones (cookies exportadas con scripts/login-local.js): cuerpo grande, solo en esta ruta.
api.put("/sesiones/:p", express.json({ limit: "6mb" }), h(async (req, res) => {
  const p = req.params.p;
  if (!PLATAFORMAS.includes(p)) return res.sendStatus(404);
  let estado;
  try { estado = normalizarSesion(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  const v = validarSesion(p, estado);
  if (!v.ok) return res.status(400).json({ error: v.errores.join(" ") });
  await guardarSesion(p, estado);
  res.json({ ok: true, cookies: estado.cookies.length, expira: v.expira, avisos: v.avisos });
}));

api.use(express.json({ limit: "50kb" }));

api.get("/estado", h(async (req, res) => {
  const [ses, fu] = await Promise.all([
    listarSesiones(),
    q("SELECT id, url, video_id, estado, error, creado_en FROM fuentes ORDER BY id DESC LIMIT 6")
  ]);
  const evid = (await fs.readdir(`${cfg.dataDir}/evidencias`).catch(() => [])).filter(n => n.endsWith(".png")).sort().reverse().slice(0, 12);
  res.json({ publicarReal: cfg.publicarReal, agenteOcupado: agenteOcupado(), discoMb: await usoDiscoMb(), plataformas: PLATAFORMAS, sesiones: ses.rows, fuentes: fu.rows, evidencias: evid });
}));

api.get("/clips", h(async (req, res) => {
  const { rows } = await q(`
    SELECT c.id, c.token, c.titulo, c.gancho, c.descripcion, c.cta, c.hashtags, c.inicio_seg, c.fin_seg, c.categoria, c.angulo,
           c.puntaje, c.estado, c.error, c.creado_en, (c.archivo IS NOT NULL) AS tiene_archivo, f.video_id,
           (SELECT json_agg(json_build_object('p', plataforma, 'e', estado, 'd', detalle, 't', creado_en) ORDER BY id)
              FROM publicaciones WHERE clip_id = c.id AND variante_id IS NULL AND estado <> 'descartado') AS pubs
    FROM clips c JOIN fuentes f ON f.id = c.fuente_id
    ORDER BY c.creado_en DESC, c.id DESC LIMIT 60`);
  res.json(rows);
}));

api.post("/fuentes", rateLimit({ windowMs: 60e3, max: 10 }), h(async (req, res) => {
  const id = String(req.body?.url || "").match(YT)?.[1];
  if (!id) return res.status(400).json({ error: "Pega un enlace válido de YouTube." });
  const { rows: [dup] } = await q("SELECT 1 FROM fuentes WHERE video_id=$1 AND estado IN ('pendiente','analizando')", [id]);
  if (dup) return res.status(409).json({ error: "Ese video ya se está analizando." });
  const { rows: [f] } = await q("INSERT INTO fuentes(url, video_id, plataformas) VALUES($1,$2,$3) RETURNING *", [ytUrl(id), id, plats(req.body?.plataformas)]);
  await encolar("analizar", f.id, {}, 0, 2);
  res.status(202).json(f);
}));

api.post("/clips/:id/publicar", rateLimit({ windowMs: 60e3, max: 20 }), h(async (req, res) => {
  if (!ID.test(req.params.id)) return res.sendStatus(404);
  const lista = plats(req.body?.plataformas);
  if (!lista.length) return res.status(400).json({ error: "Elige al menos una plataforma." });
  const { rows: [c] } = await q("SELECT estado FROM clips WHERE id=$1", [req.params.id]);
  if (!c) return res.sendStatus(404);
  if (["cortando", "publicando"].includes(c.estado)) return res.status(409).json({ error: "El clip está ocupado." });
  for (const p of lista) if (!(await tieneSesion(p))) return res.status(400).json({ error: `Falta la sesión de ${p}. Súbela en la sección Sesiones.` });
  await encolar("publicar", Number(req.params.id), { plataformas: lista }, 0, 1);
  res.status(202).json({ ok: true });
}));

const clipOcupado = async id => ["cortando", "publicando"].includes((await q("SELECT estado FROM clips WHERE id=$1", [id])).rows[0]?.estado);

// Resuelve una publicación "incierta": ya se publicó (se cuenta como hecha) o hay que reintentarla.
api.post("/clips/:id/resolver", h(async (req, res) => {
  if (!ID.test(req.params.id)) return res.sendStatus(404);
  const p = req.body?.plataforma, accion = req.body?.accion;
  if (!PLATAFORMAS.includes(p) || !["publicado", "reintentar"].includes(accion)) return res.status(400).json({ error: "Datos inválidos." });
  const { rowCount } = await q("UPDATE publicaciones SET estado='descartado' WHERE clip_id=$1 AND variante_id IS NULL AND plataforma=$2 AND estado='incierto'", [req.params.id, p]);
  if (!rowCount) return res.status(404).json({ error: "No hay publicación incierta para resolver." });
  if (accion === "publicado") await q("INSERT INTO publicaciones(clip_id, plataforma, estado, detalle) VALUES($1,$2,'ok','Confirmado manualmente')", [req.params.id, p]);
  await q("UPDATE clips SET error=NULL WHERE id=$1 AND estado='listo'", [req.params.id]);
  res.json({ ok: true });
}));

api.post("/clips/:id/recortar", h(async (req, res) => {
  if (!ID.test(req.params.id)) return res.sendStatus(404);
  if (await clipOcupado(req.params.id)) return res.status(409).json({ error: "El clip está ocupado." });
  await borrarArchivoClip(req.params.id, "pendiente", { forzar: true });
  await q("UPDATE clips SET estado='pendiente', error=NULL WHERE id=$1 AND estado <> 'publicado'", [req.params.id]);
  await encolar("cortar", Number(req.params.id), {}, 0, 2);
  res.status(202).json({ ok: true });
}));

api.delete("/clips/:id/archivo", h(async (req, res) => {
  if (!ID.test(req.params.id)) return res.sendStatus(404);
  if (await clipOcupado(req.params.id)) return res.status(409).json({ error: "El clip está ocupado." });
  await borrarArchivoClip(req.params.id, "expirado", { forzar: true });
  res.json({ ok: true });
}));

api.post("/sesiones/:p/probar", h(async (req, res) => {
  const p = req.params.p;
  if (!PLATAFORMAS.includes(p)) return res.sendStatus(404);
  if (agenteOcupado()) return res.status(409).json({ error: "El agente está ocupado; intenta en unos minutos." });
  const r = await probarSesion(p);
  await marcarTest(p, r.ok, r.detalle);
  res.json(r);
}));

api.delete("/sesiones/:p", h(async (req, res) => {
  if (!PLATAFORMAS.includes(req.params.p)) return res.sendStatus(404);
  await borrarSesion(req.params.p);
  res.json({ ok: true });
}));

api.use(rutasLotes);   // Fase 4: lotes, ciclos, reciclaje y variantes
api.use(rutasVivo);    // Fase 6: transmisiones en vivo
api.use(rutasCookies); // cookies de redes sociales (importación y sincronización)
app.use("/api", api);
app.use((req, res) => res.status(404).json({ error: "No encontrado." }));
app.use((e, req, res, next) => {
  console.error(`[${req.method} ${req.path}]`, e);
  if (res.headersSent) return next(e);
  res.status(e.status || 500).json({ error: String(e.message || "Error interno.").split("\n")[0].slice(0, 300) });
});

// ===== 4. Arranque =====
await iniciarDb();
await recuperarJobs();
await prepararVivo();   // tablas de vivo + reanuda capturas que seguían en curso
prepararCookiesYoutube();   // cookies de YouTube (YT_COOKIES_B64) para que yt-dlp no sea bloqueado
await prepararCookies().catch(e => console.error("cookies:", e.message));   // importa cookies/*.json si cambiaron
await limpiar().catch(console.error);
setInterval(() => limpiar().catch(console.error), 600e3).unref();   // cada 10 min
spawn("yt-dlp", ["-U"], { stdio: "ignore" }).on("error", () => {});   // YouTube cambia seguido: se actualiza al arrancar

// Los elementos de lote comparten worker con su equivalente (medios / agente): FFmpeg y el navegador nunca corren dos tareas a la vez.
const despachar = job => ({ analizar: hAnalizar, cortar: hCortar, lote_medios: hLoteItem, vivo_segmento: hVivoSegmento, auto_variantes: hAutoVariantes }[job.tipo])(job);
iniciarWorker("medios", ["analizar", "cortar", "lote_medios", "vivo_segmento", "auto_variantes"], despachar);
iniciarWorker("agente", ["publicar", "lote_agente"], job => (job.tipo === "publicar" ? hPublicar : hLoteItem)(job), 4000);
const detenerLotes = iniciarDespachador();   // ciclos de 10-20 elementos

const srv = app.listen(cfg.port, () => console.log(`ClipLab listo (modo ${cfg.publicarReal ? "REAL" : "PRUEBA"})`));
srv.keepAliveTimeout = 65e3;
srv.headersTimeout = 66e3;

const apagar = () => {
  console.log("Apagando…");
  detenerLotes();
  detenerCapturas();   // ffmpeg se cierra limpio; las capturas se reanudan al arrancar
  srv.close(() => db.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10e3).unref();
};
process.on("SIGTERM", apagar);
process.on("SIGINT", apagar);
