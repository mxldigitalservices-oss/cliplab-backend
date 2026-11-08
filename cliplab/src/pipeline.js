// Flujo: analizar (Gemini) → cortar (FFmpeg) → publicar (agente Playwright).
import { existsSync } from "node:fs";
import { q } from "./db.js";
import { cfg } from "./config.js";
import { encolar } from "./queue.js";
import { analizar } from "./gemini.js";
import { cortarClip } from "./video.js";
import { publicarEn } from "./agent/index.js";
import { dormir, rnd } from "./agent/humano.js";
import { PLATAFORMAS } from "./sesiones.js";
import { borrarArchivoClip } from "./janitor.js";

export const ytUrl = id => `https://www.youtube.com/watch?v=${id}`;
const ultimo = job => job.intentos >= job.max_intentos;

export async function hAnalizar(job) {
  const { rows: [f] } = await q("SELECT * FROM fuentes WHERE id=$1", [job.ref_id]);
  if (!f) return;
  await q("UPDATE fuentes SET estado='analizando', error=NULL WHERE id=$1", [f.id]);
  try {
    const clips = await analizar(ytUrl(f.video_id));
    for (const [i, c] of clips.entries()) {
      const { rows: [r] } = await q(
        `INSERT INTO clips(fuente_id, titulo, gancho, descripcion, cta, hashtags, inicio_seg, fin_seg, categoria, angulo, puntaje, auto_plataformas)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [f.id, c.titulo, c.gancho, c.descripcion, c.cta, c.hashtags, c.inicio_seg, c.fin_seg, c.categoria, c.angulo, c.puntaje, i === 0 ? f.plataformas : []]
      );
      await encolar("cortar", r.id, {}, 0, 2);
    }
    await q("UPDATE fuentes SET estado='listo' WHERE id=$1", [f.id]);
  } catch (e) {
    if (ultimo(job)) await q("UPDATE fuentes SET estado='error', error=$2 WHERE id=$1", [f.id, e.message.slice(0, 400)]);
    throw e;
  }
}

const cargarClip = id => q("SELECT c.*, f.video_id FROM clips c JOIN fuentes f ON f.id = c.fuente_id WHERE c.id = $1", [id]);

export async function hCortar(job) {
  const { rows: [c] } = await cargarClip(job.ref_id);
  if (!c) return;
  await q("UPDATE clips SET estado='cortando', error=NULL WHERE id=$1", [c.id]);
  try {
    const archivo = await cortarClip(c, ytUrl(c.video_id));
    await q("UPDATE clips SET estado='listo', archivo=$2 WHERE id=$1", [c.id, archivo]);
    if (c.auto_plataformas?.length) await encolar("publicar", c.id, { plataformas: c.auto_plataformas }, 0, 1);
  } catch (e) {
    if (ultimo(job)) await q("UPDATE clips SET estado='error', error=$2 WHERE id=$1", [c.id, e.message.slice(0, 400)]);
    throw e;
  }
}

export async function hPublicar(job) {
  const plats = (job.payload?.plataformas || []).filter(p => PLATAFORMAS.includes(p));
  const { rows: [c] } = await cargarClip(job.ref_id);
  if (!c || !plats.length) return;

  const { rows: previas } = await q("SELECT plataforma FROM publicaciones WHERE clip_id=$1 AND estado='ok'", [c.id]);
  const yaHechas = new Set(previas.map(r => r.plataforma));
  const pendientes = plats.filter(x => !yaHechas.has(x));
  if (!pendientes.length) return;   // idempotente: nada que publicar, no se vuelve a cortar

  if (!c.archivo || !existsSync(c.archivo)) {   // el archivo fue purgado: se regenera con los timestamps guardados
    await q("UPDATE clips SET estado='cortando', error=NULL WHERE id=$1", [c.id]);
    c.archivo = await cortarClip(c, ytUrl(c.video_id));
    await q("UPDATE clips SET archivo=$2 WHERE id=$1", [c.id, c.archivo]);
  }
  await q("UPDATE clips SET estado='publicando', error=NULL WHERE id=$1", [c.id]);

  const fallos = [];
  let primera = true;
  for (const p of pendientes) {
    const { rows: [dia] } = await q("SELECT count(*)::int AS n FROM publicaciones WHERE plataforma=$1 AND estado='ok' AND creado_en > now() - interval '24 hours'", [p]);
    if (dia.n >= cfg.maxPubDia) { fallos.push(`${p}: límite diario (${cfg.maxPubDia}) alcanzado`); continue; }
    if (!primera) await dormir(rnd(cfg.pausaPlataformasS[0], cfg.pausaPlataformasS[1]) * 1000);
    primera = false;
    try {
      const r = await publicarEn(p, c);
      await q("INSERT INTO publicaciones(clip_id, plataforma, estado, detalle) VALUES($1,$2,$3,$4)", [c.id, p, r.simulado ? "simulado" : "ok", r.detalle || ""]);
      if (r.simulado) fallos.push(`${p}: modo prueba (no se publicó)`);
    } catch (e) {
      const msg = String(e.message).split("\n")[0].slice(0, 300);   // sin los banners multilínea de Playwright
      await q("INSERT INTO publicaciones(clip_id, plataforma, estado, detalle) VALUES($1,$2,'error',$3)", [c.id, p, msg]);
      fallos.push(`${p}: ${msg}`);
    }
  }

  const { rows: oks } = await q("SELECT plataforma FROM publicaciones WHERE clip_id=$1 AND estado='ok'", [c.id]);
  const hechas = new Set(oks.map(r => r.plataforma));
  if (plats.every(p => hechas.has(p))) {
    await q("UPDATE clips SET estado='publicado', error=NULL WHERE id=$1", [c.id]);
    await borrarArchivoClip(c.id);   // auto-purga: ya está publicado en todas las plataformas pedidas
  } else {
    await q("UPDATE clips SET estado='listo', error=$2 WHERE id=$1", [c.id, fallos.join(" | ").slice(0, 500) || null]);
  }
}
