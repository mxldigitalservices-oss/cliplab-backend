// Flujo: analizar (Gemini) → cortar (FFmpeg) → publicar (agente Playwright).
import { existsSync } from "node:fs";
import { q } from "./db.js";
import { cfg } from "./config.js";
import { encolar } from "./queue.js";
import { analizar } from "./gemini.js";
import { cortarClip } from "./video.js";
import { palabrasDelClip } from "./transcripcion.js";
import { publicarEn } from "./agent/index.js";
import { dormir, rnd } from "./agent/humano.js";
import { PLATAFORMAS } from "./sesiones.js";
import { borrarArchivoClip, limpiar } from "./janitor.js";

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

// Corta (reencuadre + marca + subtítulos) y guarda en PostgreSQL solo metadatos ligeros.
export async function procesarClip(c) {
  const url = ytUrl(c.video_id);
  const palabras = await palabrasDelClip(c, url);
  const r = await cortarClip(c, url, { palabras });
  const dur = Number(c.fin_seg) - Number(c.inicio_seg);
  await q(
    `UPDATE clips SET estado = CASE WHEN estado = 'publicado' THEN estado ELSE 'listo' END, error = NULL, archivo = $2,
       tam_bytes = $3, duracion_seg = $4, procesado_ms = $5, con_subtitulos = $6, con_marca = $7,
       palabras = COALESCE($8::jsonb, palabras), archivo_borrado_en = NULL WHERE id = $1`,
    [c.id, r.archivo, r.bytes, dur, r.ms, r.conSubtitulos, r.conMarca, palabras.length ? JSON.stringify(palabras) : null]
  );
  return r.archivo;
}

// Garantiza que el video base exista en disco (lo regenera con los tiempos guardados si fue purgado).
// No pisa el estado "publicado" del clip: las variantes reciclan clips que ya salieron.
export async function asegurarArchivoClip(c) {
  if (c.archivo && existsSync(c.archivo)) return c.archivo;
  await q("UPDATE clips SET estado = CASE WHEN estado = 'publicado' THEN estado ELSE 'cortando' END, error = NULL WHERE id=$1", [c.id]);
  try { return await procesarClip(c); }
  catch (e) {
    await q("UPDATE clips SET estado = CASE WHEN estado = 'publicado' THEN estado ELSE 'error' END, error=$2 WHERE id=$1", [c.id, String(e.message).slice(0, 400)]);
    throw e;
  }
}

export async function hCortar(job) {
  const { rows: [c] } = await cargarClip(job.ref_id);
  if (!c) return;
  await limpiar().catch(() => {});   // libera disco antes de empezar a generar otro archivo
  await q("UPDATE clips SET estado='cortando', error=NULL WHERE id=$1 AND estado <> 'publicado'", [c.id]);
  try {
    await procesarClip(c);
    if (c.auto_plataformas?.length) await encolar("publicar", c.id, { plataformas: c.auto_plataformas }, 0, 1);
  } catch (e) {
    if (ultimo(job)) await q("UPDATE clips SET estado='error', error=$2 WHERE id=$1 AND estado <> 'publicado'", [c.id, e.message.slice(0, 400)]);
    throw e;
  }
}

export async function hPublicar(job) {
  const plats = (job.payload?.plataformas || []).filter(p => PLATAFORMAS.includes(p));
  const { rows: [c] } = await cargarClip(job.ref_id);
  if (!c || !plats.length) return;

  const { rows: previas } = await q("SELECT plataforma, estado FROM publicaciones WHERE clip_id=$1 AND variante_id IS NULL AND estado IN ('ok','incierto')", [c.id]);
  const yaHechas = new Set(previas.filter(r => r.estado === "ok").map(r => r.plataforma));
  // Un "incierto" (se pulsó Publicar pero no se confirmó) bloquea el reintento hasta que la persona lo resuelva en el panel.
  const inciertas = new Set(previas.filter(r => r.estado === "incierto").map(r => r.plataforma));
  const pendientes = plats.filter(x => !yaHechas.has(x) && !inciertas.has(x));
  const fallos = plats.filter(x => inciertas.has(x) && !yaHechas.has(x)).map(x => `${x}: resultado incierto, verifica en la plataforma y confírmalo en el panel`);
  if (!pendientes.length) {   // idempotente: nada que publicar, no se vuelve a cortar
    if (fallos.length) await q("UPDATE clips SET estado='listo', error=$2 WHERE id=$1 AND estado <> 'publicado'", [c.id, fallos.join(" | ").slice(0, 500)]);
    return;
  }

  if (!c.archivo || !existsSync(c.archivo)) {   // el archivo fue purgado: se regenera con los timestamps guardados
    await q("UPDATE clips SET estado='cortando', error=NULL WHERE id=$1", [c.id]);
    try { c.archivo = await procesarClip(c); }
    catch (e) {   // sin esto el clip se quedaba "cortando" para siempre
      await q("UPDATE clips SET estado='error', error=$2 WHERE id=$1", [c.id, String(e.message).slice(0, 400)]);
      throw e;
    }
  }
  await q("UPDATE clips SET estado='publicando', error=NULL WHERE id=$1", [c.id]);

  let primera = true;
  for (const p of pendientes) {
    const { rows: [dia] } = await q("SELECT count(*)::int AS n FROM publicaciones WHERE plataforma=$1 AND estado IN ('ok','incierto') AND creado_en > now() - interval '24 hours'", [p]);
    if (dia.n >= cfg.maxPubDia) { fallos.push(`${p}: límite diario (${cfg.maxPubDia}) alcanzado`); continue; }
    if (!primera) await dormir(rnd(cfg.pausaPlataformasS[0], cfg.pausaPlataformasS[1]) * 1000);
    primera = false;
    try {
      const r = await publicarEn(p, c);
      await q("INSERT INTO publicaciones(clip_id, plataforma, estado, detalle) VALUES($1,$2,$3,$4)", [c.id, p, r.simulado ? "simulado" : "ok", r.detalle || ""]);
      if (r.simulado) fallos.push(`${p}: modo prueba (no se publicó)`);
    } catch (e) {
      const msg = String(e.message).split("\n")[0].slice(0, 300);   // sin los banners multilínea de Playwright
      const estado = e.incierto ? "incierto" : "error";
      await q("INSERT INTO publicaciones(clip_id, plataforma, estado, detalle) VALUES($1,$2,$3,$4)", [c.id, p, estado, e.incierto ? `Se pulsó Publicar pero no se confirmó: ${msg}` : msg]);
      fallos.push(e.incierto ? `${p}: resultado incierto, verifica en la plataforma y confírmalo en el panel` : `${p}: ${msg}`);
    }
  }

  const { rows: oks } = await q("SELECT plataforma FROM publicaciones WHERE clip_id=$1 AND variante_id IS NULL AND estado='ok'", [c.id]);
  const hechas = new Set(oks.map(r => r.plataforma));
  if (plats.every(p => hechas.has(p))) {
    await q("UPDATE clips SET estado='publicado', error=NULL WHERE id=$1", [c.id]);
    if (cfg.borrarAlPublicar) await borrarArchivoClip(c.id);   // salida completa: el video pesado se borra YA; quedan los metadatos
  } else {
    await q("UPDATE clips SET estado='listo', error=$2 WHERE id=$1", [c.id, fallos.join(" | ").slice(0, 500) || null]);
  }
}
