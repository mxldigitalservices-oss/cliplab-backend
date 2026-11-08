// Fase 6: transmisiones en vivo.
// Flujo: yt-dlp (URL HLS) → ffmpeg -c copy en segmentos .ts → por cada segmento cerrado, un job "vivo_segmento"
// (proxy ligero → Gemini inline → clips) → los clips entran al flujo normal: job "cortar" → hCortar → procesarClip
// (que, para clips en vivo, corta desde el segmento local) → publicar. No importa pipeline.js (evita ciclos).
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { cfg } from "./config.js";
import { q, tx } from "./db.js";
import { correr } from "./proc.js";
import { ErrorHttp } from "./errores.js";
import { generar, ROL, validar } from "./gemini.js";
import { aPalabras, normalizar, recortarPalabras, construirAss } from "./subtitulos.js";
import { construirArgs, prepararMarca } from "./video.js";
import { PLATAFORMAS, tieneSesion } from "./sesiones.js";

// ---------- Configuración propia (no toca config.js) ----------
const num = (k, d) => { const r = process.env[k]; const v = Number(r); return r === undefined || r === "" || !Number.isFinite(v) ? d : v; };
const entre = (v, a, b) => Math.min(b, Math.max(a, v));
export const V = {
  segSeg: entre(Math.round(num("VIVO_SEG_SEG", 180)), 60, 240),   // tope 240: el proxy debe caber en una petición inline a Gemini (<20 MB)
  minSeg: num("VIVO_MIN_SEG", 30),                                  // segmentos más cortos se omiten
  clipsPorSeg: entre(Math.round(num("VIVO_CLIPS_POR_SEG", 2)), 1, 5),
  maxHoras: num("VIVO_MAX_HORAS", 8),
  retencionH: num("VIVO_RETENCION_H", 6),                           // horas que se conservan los segmentos tras terminar el directo
  maxMb: num("VIVO_MAX_MB", 2000),
  maxSimultaneos: Math.max(1, Math.round(num("VIVO_MAX_SIMULTANEOS", 1))),
  puntajeAuto: entre(Math.round(num("VIVO_PUNTAJE_AUTO", 80)), 1, 100)
};

const dormir = ms => new Promise(r => setTimeout(r, ms));
const ytUrl = id => `https://www.youtube.com/watch?v=${id}`;
const YT = /(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([\w-]{11})/;
const BASE = () => ["--no-playlist", "--no-warnings", ...(cfg.ytCookies ? ["--cookies", cfg.ytCookies] : [])];
const RAIZ = () => `${cfg.dataDir}/vivo`;   // fuera de clipsDir: el janitor no lo toca ni lo cuenta
export const dirVivo = id => `${RAIZ()}/${id}`;
const JOB = "INSERT INTO jobs(tipo, ref_id, payload, max_intentos, ejecutar_en) VALUES($1,$2,'{}',$3,now())";

// ---------- Tablas ----------
export async function prepararVivo() {
  await q(`
    CREATE TABLE IF NOT EXISTS vivos(
      id bigserial PRIMARY KEY, fuente_id bigint, url text NOT NULL, video_id text NOT NULL,
      estado text NOT NULL DEFAULT 'capturando', plataformas text[] NOT NULL DEFAULT '{}', auto_puntaje int NOT NULL DEFAULT 80,
      segmentos int NOT NULL DEFAULT 0, clips int NOT NULL DEFAULT 0, error text, purgado boolean NOT NULL DEFAULT false,
      inicio timestamptz NOT NULL DEFAULT now(), fin timestamptz);
    CREATE TABLE IF NOT EXISTS vivo_segmentos(
      id bigserial PRIMARY KEY, vivo_id bigint NOT NULL, n int NOT NULL, archivo text NOT NULL,
      estado text NOT NULL DEFAULT 'pendiente', dur_seg numeric, offset_seg numeric, error text,
      creado_en timestamptz NOT NULL DEFAULT now(), UNIQUE (vivo_id, n));
    CREATE TABLE IF NOT EXISTS vivo_clips(
      clip_id bigint PRIMARY KEY, vivo_id bigint NOT NULL, segmento_id bigint NOT NULL, ini_rel numeric NOT NULL, fin_rel numeric NOT NULL);
    CREATE INDEX IF NOT EXISTS vivo_clips_vivo ON vivo_clips(vivo_id);`);
  setInterval(() => purgar().catch(e => console.error("vivo purga:", e.message)), 600e3).unref();
  // Tras un reinicio, las capturas en curso se reanudan (si el directo sigue en vivo).
  const { rows } = await q("SELECT * FROM vivos WHERE estado='capturando'");
  for (const v of rows) lanzar(v);
}

// ---------- yt-dlp ----------
async function estadoLive(url) {
  const out = await correr("yt-dlp", [...BASE(), "--skip-download", "--print", "live_status", url], 60000);
  return out.trim().split("\n").pop().trim();   // is_live | is_upcoming | was_live | not_live
}
async function urlVivo(url) {
  const out = await correr("yt-dlp", [...BASE(), "-g", "-f", "best[height<=720]/best", url], 90000);
  const u = out.split("\n").map(s => s.trim()).find(s => s.startsWith("http"));
  if (!u) throw new Error("yt-dlp no devolvió la URL de la transmisión.");
  return u;
}

// ---------- Captura ----------
const capturas = new Map();   // vivo_id → { proc, detener, apagando, error }
const indiceDe = n => Number(/seg-(\d+)\.ts$/.exec(n)?.[1]);

async function siguienteIndice(id) {
  const archivos = await fs.readdir(dirVivo(id)).catch(() => []);
  const { rows: [r] } = await q("SELECT COALESCE(MAX(n) + 1, 0) AS n FROM vivo_segmentos WHERE vivo_id=$1", [id]);
  return Math.max(Number(r.n), ...archivos.map(indiceDe).filter(Number.isFinite).map(n => n + 1));
}

function grabar(ctl, url, dir, inicioN, restanteS) {
  return new Promise(ok => {
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10",
      "-i", url, "-t", String(Math.max(10, Math.ceil(restanteS))), "-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy",
      "-f", "segment", "-segment_time", String(V.segSeg), "-segment_format", "mpegts", "-segment_start_number", String(inicioN),
      "-reset_timestamps", "1", `${dir}/seg-%05d.ts`];
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    ctl.proc = p;
    let err = "";
    p.stderr.on("data", d => { err = (err + d).slice(-600); });
    p.on("error", e => { ctl.proc = null; ok({ code: -1, err: e.message }); });
    p.on("close", code => { ctl.proc = null; ok({ code, err }); });
  });
}

// Segmentos cerrados → tabla + job, en una sola transacción (nunca queda un segmento sin job).
async function barrer(id, ctl) {
  const nombres = (await fs.readdir(dirVivo(id)).catch(() => [])).filter(n => /^seg-\d+\.ts$/.test(n)).sort();
  const cerrados = ctl.proc ? nombres.slice(0, -1) : nombres;   // el último sigue escribiéndose mientras ffmpeg corre
  if (!cerrados.length) return;
  const { rows } = await q("SELECT archivo FROM vivo_segmentos WHERE vivo_id=$1", [id]);
  const conocidos = new Set(rows.map(r => r.archivo));
  for (const n of cerrados.filter(n => !conocidos.has(n))) {
    await tx(async c => {
      const { rows: [s] } = await c.query("INSERT INTO vivo_segmentos(vivo_id, n, archivo) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id", [id, indiceDe(n), n]);
      if (!s) return;
      await c.query(JOB, ["vivo_segmento", s.id, 2]);
      await c.query("UPDATE vivos SET segmentos = segmentos + 1 WHERE id=$1", [id]);
    });
  }
}

async function usoVivoBytes() {
  let total = 0;
  for (const d of await fs.readdir(RAIZ()).catch(() => []))
    for (const n of await fs.readdir(`${RAIZ()}/${d}`).catch(() => []))
      total += (await fs.stat(`${RAIZ()}/${d}/${n}`).catch(() => null))?.size || 0;
  return total;
}

async function vigilar(id, ctl) {
  await barrer(id, ctl);
  if (!ctl.detener && (await usoVivoBytes()) > V.maxMb * 1048576 * 1.25) {   // el purgador no alcanza a liberar: se corta la captura
    ctl.error = "Disco de captura lleno (VIVO_MAX_MB): se detuvo la grabación.";
    ctl.detener = true;
    ctl.proc?.kill("SIGINT");
  }
}

async function capturar(v) {
  const ctl = capturas.get(v.id);
  const dir = dirVivo(v.id);
  await fs.mkdir(dir, { recursive: true });
  const limite = new Date(v.inicio).getTime() + V.maxHoras * 3600e3;
  const timer = setInterval(() => vigilar(v.id, ctl).catch(e => console.error("vivo barrido:", e.message)), 5000);
  let fallos = 0;
  try {
    while (!ctl.detener && Date.now() < limite) {
      let url;
      try {
        if ((await estadoLive(v.url)) !== "is_live") break;   // el directo terminó
        url = await urlVivo(v.url);
      } catch (e) {
        if (++fallos >= 3) { ctl.error = e.message.split("\n")[0]; break; }
        await dormir(15000); continue;
      }
      const ini = await siguienteIndice(v.id);
      const r = await grabar(ctl, url, dir, ini, (limite - Date.now()) / 1000);
      if (ctl.detener || ctl.apagando) break;
      if (r.code === 0) break;   // fin normal de la transmisión (o tope de horas)
      fallos = (await siguienteIndice(v.id)) > ini ? 0 : fallos + 1;   // corte de red: se reintenta con URL nueva
      if (fallos >= 3) { ctl.error = `ffmpeg no pudo grabar: ${r.err.split("\n").pop()}`; break; }
      await dormir(5000);
    }
  } finally { clearInterval(timer); }
  if (ctl.apagando) return;   // apagado del servidor: el estado queda "capturando" y se reanuda al arrancar
  await barrer(v.id, ctl).catch(e => console.error("vivo barrido final:", e.message));
  const { rows: [{ n }] } = await q("SELECT count(*)::int AS n FROM vivo_segmentos WHERE vivo_id=$1", [v.id]);
  await q("UPDATE vivos SET estado=$2, error=$3, fin=now() WHERE id=$1", [v.id, ctl.error ? "error" : ctl.detener ? "detenido" : "finalizado", ctl.error]);
  await q("UPDATE fuentes SET estado=$2, error=$3 WHERE id=$1", [v.fuente_id, ctl.error && !n ? "error" : "listo", ctl.error]);
  capturas.delete(v.id);
}

function lanzar(v) {
  capturas.set(v.id, { proc: null, detener: false, apagando: false, error: null });
  capturar(v).catch(async e => {
    console.error(`vivo ${v.id}:`, e.message);
    capturas.delete(v.id);
    await q("UPDATE vivos SET estado='error', error=$2, fin=now() WHERE id=$1", [v.id, String(e.message).slice(0, 300)]).catch(() => {});
  });
}

export function detenerCapturas() {   // apagado del servidor
  for (const ctl of capturas.values()) { ctl.apagando = true; ctl.detener = true; ctl.proc?.kill("SIGINT"); }
}

// ---------- API ----------
export async function crearVivo({ url, plataformas = [], autoPuntaje }) {
  const id = String(url || "").match(YT)?.[1];
  if (!id) throw new ErrorHttp(400, "Pega un enlace válido de YouTube.");
  if (capturas.size >= V.maxSimultaneos) throw new ErrorHttp(409, `Ya hay ${capturas.size} captura(s) en curso (máximo ${V.maxSimultaneos}).`);
  const { rows: dup } = await q("SELECT 1 FROM vivos WHERE video_id=$1 AND estado='capturando'", [id]);
  if (dup.length) throw new ErrorHttp(409, "Esa transmisión ya se está capturando.");
  for (const p of plataformas) if (!(await tieneSesion(p))) throw new ErrorHttp(400, `Falta la sesión de ${p}. Súbela en la sección Sesiones.`);
  let estado;
  try { estado = await estadoLive(ytUrl(id)); } catch (e) { throw new ErrorHttp(502, `No pude consultar la transmisión: ${e.message.split("\n")[0].slice(0, 200)}`); }
  if (estado !== "is_live") throw new ErrorHttp(400, `Esa transmisión no está en vivo (estado: ${estado}). Si ya terminó, analízala como video normal.`);
  const plats = [...new Set(plataformas.filter(p => PLATAFORMAS.includes(p)))];
  const { rows: [f] } = await q("INSERT INTO fuentes(url, video_id, plataformas, estado) VALUES($1,$2,$3,'analizando') RETURNING id", [ytUrl(id), id, plats]);
  const { rows: [v] } = await q("INSERT INTO vivos(fuente_id, url, video_id, plataformas, auto_puntaje) VALUES($1,$2,$3,$4,$5) RETURNING *",
    [f.id, ytUrl(id), id, plats, entre(Math.round(Number(autoPuntaje)) || V.puntajeAuto, 1, 100)]);
  lanzar(v);
  return v;
}

export async function detenerVivo(id) {
  const ctl = capturas.get(String(id)) || capturas.get(Number(id));
  if (!ctl) throw new ErrorHttp(409, "Esa transmisión no se está capturando.");
  ctl.detener = true;
  ctl.proc?.kill("SIGINT");   // cierra el segmento en curso con limpieza
  setTimeout(() => ctl.proc?.kill("SIGKILL"), 10000).unref();
  return { ok: true };
}

export const listarVivos = async () => (await q("SELECT * FROM vivos ORDER BY id DESC LIMIT 30")).rows;

export async function detalleVivo(id) {
  const { rows: [v] } = await q("SELECT * FROM vivos WHERE id=$1", [id]);
  if (!v) throw new ErrorHttp(404, "Transmisión no encontrada.");
  const [seg, cl] = await Promise.all([
    q("SELECT estado, count(*)::int AS n FROM vivo_segmentos WHERE vivo_id=$1 GROUP BY estado", [id]),
    q(`SELECT c.id, c.titulo, c.puntaje, c.estado, c.error FROM vivo_clips vc JOIN clips c ON c.id = vc.clip_id
       WHERE vc.vivo_id=$1 ORDER BY c.id DESC LIMIT 100`, [id])
  ]);
  return { ...v, capturando: capturas.has(v.id) || capturas.has(Number(id)), segmentos_por_estado: Object.fromEntries(seg.rows.map(r => [r.estado, r.n])), clips_lista: cl.rows };
}

// ---------- Análisis de un segmento (job "vivo_segmento") ----------
const S = { type: "STRING" };
const SCHEMA = {
  type: "OBJECT",
  properties: {
    clips: { type: "ARRAY", items: { type: "OBJECT", properties: {
      titulo: S, gancho: S, descripcion: S, cta: S, hashtags: { type: "ARRAY", items: S }, inicio: S, fin: S, categoria: S,
      angulo: { type: "STRING", enum: ["Polémica", "Valor", "Emoción"] }, puntaje_viral: { type: "INTEGER" } },
      required: ["titulo", "gancho", "descripcion", "cta", "hashtags", "inicio", "fin", "categoria", "angulo", "puntaje_viral"] } },
    transcripcion: { type: "ARRAY", items: { type: "OBJECT", properties: { t: S, i: { type: "NUMBER" }, f: { type: "NUMBER" } }, required: ["t", "i", "f"] } }
  },
  required: ["clips", "transcripcion"]
};

const promptSeg = dur => `Eres director de contenido para formatos verticales (TikTok, Reels, Shorts).
Este video es un fragmento de ${Math.round(dur)} segundos de una transmisión en vivo. Devuelve un objeto JSON con dos campos:
1. "clips": hasta ${V.clipsPorSeg} momentos que valga la pena publicar, de ${cfg.clipMin} a ${Math.min(cfg.clipMax, Math.floor(dur))} segundos cada uno. Si no hay ninguno realmente bueno, devuelve un arreglo vacío.
   Cada clip es una idea completa, empieza en su gancho y no se solapa con otro. Tiempos en formato M:SS RELATIVOS al fragmento (0:00 = primer instante); nunca inventes tiempos.
   "titulo": magnético, máximo 70 caracteres, sin emojis. "gancho": la frase más fuerte. "descripcion": 1 o 2 frases (máx. 200 caracteres). "cta": llamada a la acción corta. "hashtags": de 3 a 5, cada uno con #.
   "angulo": Polémica, Valor o Emoción. "categoria": una o dos palabras. "puntaje_viral": de 1 a 100.
2. "transcripcion": lo que se habla, literal y en su idioma, en frases de máximo 6 palabras, con "t" (texto), "i" y "f" (segundos decimales relativos al fragmento). No incluyas descripciones de sonidos.`;

const duracion = async ruta => Number((await correr("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", ruta], 30000)).trim());
const MAX_PROXY = 14 * 1048576;   // base64 ≈ +33 %: deja margen bajo el límite de 20 MB por petición

export async function hVivoSegmento(job) {
  const { rows: [s] } = await q(
    `SELECT s.id, s.vivo_id, s.n, s.archivo, s.estado, v.fuente_id, v.plataformas, v.auto_puntaje
       FROM vivo_segmentos s JOIN vivos v ON v.id = s.vivo_id WHERE s.id=$1`, [job.ref_id]);
  if (!s || s.estado !== "pendiente") return;   // idempotente
  const marcar = (estado, error = null) => q("UPDATE vivo_segmentos SET estado=$2, error=$3 WHERE id=$1", [s.id, estado, error]);
  const ruta = `${dirVivo(s.vivo_id)}/${s.archivo}`;
  if (!existsSync(ruta)) return marcar("purgado");
  const proxy = `${dirVivo(s.vivo_id)}/proxy-${s.n}.mp4`;
  try {
    const dur = await duracion(ruta);
    const { rows: [p] } = await q(
      "SELECT COALESCE(SUM(dur_seg),0)::float AS suma, count(*) FILTER (WHERE dur_seg IS NULL)::int AS faltan FROM vivo_segmentos WHERE vivo_id=$1 AND n<$2", [s.vivo_id, s.n]);
    const offset = p.suma + p.faltan * V.segSeg;   // posición del segmento en la línea de tiempo de la captura
    await q("UPDATE vivo_segmentos SET dur_seg=$2, offset_seg=$3 WHERE id=$1", [s.id, Number.isFinite(dur) ? dur : null, offset]);
    if (!(dur >= V.minSeg)) return marcar("omitido", "Segmento demasiado corto");

    await correr("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", ruta, "-vf", "scale=-2:360,fps=8",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-maxrate", "350k", "-bufsize", "700k", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "32k", "-ac", "1", "-ar", "16000", "-threads", String(cfg.ffmpegThreads), "-movflags", "+faststart", proxy]);
    const bytes = await fs.readFile(proxy);
    if (bytes.length > MAX_PROXY) throw new Error(`El proxy pesa ${Math.round(bytes.length / 1048576)} MB: baja VIVO_SEG_SEG.`);

    const { data } = await generar(ROL.ANALISIS, {
      contents: [{ parts: [{ inlineData: { mimeType: "video/mp4", data: bytes.toString("base64") } }, { text: promptSeg(dur) }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.4 }
    }, { timeoutMs: 240000 });
    const txt = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!txt) throw new Error("Gemini no devolvió contenido para el segmento.");
    const raw = JSON.parse(txt);

    const palSeg = cfg.subtitulos
      ? normalizar(aPalabras((raw.transcripcion || []).filter(x => x && Number(x.i) >= 0 && Number(x.f) > Number(x.i)).map(x => ({ t: x.t, i: Number(x.i), f: Math.min(Number(x.f), dur) }))))
      : [];
    const clips = validar(raw.clips)   // ya viene ordenado por puntaje y sin solapes
      .filter(c => c.inicio_seg < dur).map(c => ({ ...c, fin_seg: Math.min(c.fin_seg, dur) }))
      .filter(c => c.fin_seg - c.inicio_seg >= cfg.clipMin - 3).slice(0, V.clipsPorSeg);

    await tx(async c => {
      for (const [i, k] of clips.entries()) {
        const pal = recortarPalabras(palSeg, k.inicio_seg, k.fin_seg);
        const auto = i === 0 && s.plataformas?.length && k.puntaje >= s.auto_puntaje ? s.plataformas : [];   // solo el mejor del segmento y si supera el puntaje
        const { rows: [r] } = await c.query(
          `INSERT INTO clips(fuente_id, titulo, gancho, descripcion, cta, hashtags, inicio_seg, fin_seg, categoria, angulo, puntaje, auto_plataformas, palabras)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING id`,
          [s.fuente_id, k.titulo, k.gancho, k.descripcion, k.cta, k.hashtags, Math.round(offset + k.inicio_seg), Math.round(offset + k.fin_seg),
           k.categoria, k.angulo, k.puntaje, auto, pal.length >= 3 ? JSON.stringify(pal) : null]);
        await c.query("INSERT INTO vivo_clips(clip_id, vivo_id, segmento_id, ini_rel, fin_rel) VALUES($1,$2,$3,$4,$5)", [r.id, s.vivo_id, s.id, k.inicio_seg, k.fin_seg]);
        await c.query(JOB, ["cortar", r.id, 2]);
      }
      await c.query("UPDATE vivo_segmentos SET estado='analizado', error=NULL WHERE id=$1", [s.id]);
      await c.query("UPDATE vivos SET clips = clips + $2 WHERE id=$1", [s.vivo_id, clips.length]);
    });
  } catch (e) {
    if (job.intentos >= job.max_intentos) await marcar("error", String(e.message).slice(0, 400));
    throw e;
  } finally {
    await fs.unlink(proxy).catch(() => {});
  }
}

// ---------- Corte local (lo usa procesarClip de pipeline.js) ----------
export async function origenVivo(clipId) {
  const { rows: [r] } = await q(
    "SELECT vc.vivo_id, vc.ini_rel, vc.fin_rel, s.archivo FROM vivo_clips vc JOIN vivo_segmentos s ON s.id = vc.segmento_id WHERE vc.clip_id=$1", [clipId]);
  return r ? { ruta: `${dirVivo(r.vivo_id)}/${r.archivo}`, ini: Number(r.ini_rel), fin: Number(r.fin_rel) } : null;
}

// Mismo resultado que cortarClip() (reencuadre 9:16 + marca + subtítulos), pero leyendo el segmento grabado.
export async function cortarDesdeSegmento(c, o, { palabras = [] } = {}) {
  if (!existsSync(o.ruta)) throw new Error("El segmento de la transmisión ya no está en disco (se superó la retención): no se puede regenerar este clip.");
  const t0 = Date.now();
  await fs.mkdir(cfg.clipsDir, { recursive: true });
  const out = `${cfg.clipsDir}/clip-${c.token}.mp4`;
  const assRuta = `${cfg.clipsDir}/sub-${c.token}.ass`;
  const dur = o.fin - o.ini;
  if (!(dur > 0)) throw new Error("Rango de corte inválido.");
  const marca = await prepararMarca();
  let ass = null;
  if (palabras.length) {
    await fs.writeFile(assRuta, construirAss(palabras, { fuente: "DejaVu Sans", tamano: cfg.subTamano, margenV: cfg.subMargenV, max: cfg.subMaxPalabras }), "utf8");
    ass = { archivo: assRuta, fontsDir: existsSync(cfg.fontsDir) ? cfg.fontsDir : null };
  }
  const cortar = extra => correr("ffmpeg", construirArgs({ urls: [o.ruta], inicio: o.ini, dur, out, ...extra }));
  let conSubtitulos = false;
  try {
    try { await cortar({ marca, ass }); conSubtitulos = !!ass; }
    catch (e) {
      if (!ass || !/\bass\b|subtit|filter|font/i.test(e.message)) throw e;
      await fs.unlink(out).catch(() => {});
      await cortar({ marca, ass: null });
    }
    const st = await fs.stat(out);
    if (st.size < 50000) throw new Error("El clip resultó vacío.");
    return { archivo: out, bytes: st.size, ms: Date.now() - t0, conSubtitulos, conMarca: !!marca };
  } catch (e) {
    await fs.unlink(out).catch(() => {});
    throw e;
  } finally {
    await fs.unlink(assRuta).catch(() => {});
  }
}

// ---------- Purga de segmentos (propia: no usa janitor.js) ----------
const SIN_CORTE_PENDIENTE = `NOT EXISTS (SELECT 1 FROM vivo_clips vc JOIN clips c ON c.id = vc.clip_id
   WHERE vc.segmento_id = s.id AND c.estado IN ('pendiente','cortando','publicando'))`;

export async function purgar() {
  const { rows } = await q(
    `SELECT v.id FROM vivos v WHERE v.estado <> 'capturando' AND NOT v.purgado AND v.fin < now() - ($1::numeric * interval '1 hour')
       AND NOT EXISTS (SELECT 1 FROM vivo_segmentos s WHERE s.vivo_id = v.id AND s.estado = 'pendiente')
       AND NOT EXISTS (SELECT 1 FROM vivo_clips vc JOIN clips c ON c.id = vc.clip_id WHERE vc.vivo_id = v.id AND c.estado IN ('pendiente','cortando','publicando'))`, [V.retencionH]);
  for (const { id } of rows) {
    await fs.rm(dirVivo(id), { recursive: true, force: true }).catch(() => {});
    await q("UPDATE vivos SET purgado = true WHERE id=$1", [id]);
    await q("UPDATE vivo_segmentos SET estado='purgado' WHERE vivo_id=$1 AND estado IN ('analizado','omitido')", [id]);
  }
  let total = await usoVivoBytes();
  const tope = V.maxMb * 1048576;
  if (total <= tope) return;
  const { rows: segs } = await q(
    `SELECT s.id, s.vivo_id, s.archivo FROM vivo_segmentos s WHERE s.estado IN ('analizado','omitido') AND ${SIN_CORTE_PENDIENTE} ORDER BY s.id`);
  for (const s of segs) {
    const ruta = `${dirVivo(s.vivo_id)}/${s.archivo}`;
    const st = await fs.stat(ruta).catch(() => null);
    await fs.unlink(ruta).catch(() => {});
    await q("UPDATE vivo_segmentos SET estado='purgado' WHERE id=$1", [s.id]);
    total -= st?.size || 0;
    if (total <= tope) break;
  }
}
