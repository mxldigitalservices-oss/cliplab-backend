// Lotes controlados: los elementos se procesan en CICLOS de 10 a 20 (LOTE_TAMANO). Solo hay un ciclo abierto a la
// vez en todo el servidor; el siguiente no arranca hasta que el anterior termina y pasa la pausa (LOTE_PAUSA_S).
// Así solo hay ≤20 jobs vivos de lotes en la cola, la memoria/CPU de Railway no se dispara y el janitor libera
// disco al cerrar cada ciclo. Todo queda en Postgres (lotes, lote_ciclos, lote_items, lote_eventos).
import { q, tx } from "./db.js";
import { cfg } from "./config.js";
import { ErrorHttp } from "./errores.js";
import { evento } from "./trazas.js";
import { limpiar } from "./janitor.js";
import { hCortar } from "./pipeline.js";
import { hPublicarVariante, MAX_APLAZOS } from "./variantes.js";

const dormir = ms => new Promise(r => setTimeout(r, ms));
const LOCK_DESPACHO = 4004;   // advisory lock: un solo despachador a la vez, aunque haya varias instancias

// tipo de elemento → cola de jobs. Las colas comparten worker con "analizar/cortar" (medios) y "publicar" (agente),
// de modo que el navegador y FFmpeg nunca corren dos tareas a la vez.
export const TIPOS_ITEM = Object.freeze({
  cortar: { cola: "lote_medios", intentos: 2 },
  publicar_variante: { cola: "lote_agente", intentos: 1 }
});
export const COLAS_LOTE = Object.freeze(["lote_medios", "lote_agente"]);

// ---------- Estado del lote (puro) ----------
// vivos = pendiente+encolado+corriendo; iniciados = elementos que ya salieron de "pendiente".
export function estadoLote({ estado, vivos, errores, iniciados }) {
  if (!["pendiente", "corriendo"].includes(estado)) return estado;   // pausado / cancelado / terminados no se tocan
  if (vivos === 0) return errores > 0 ? "con_errores" : "completado";
  return iniciados > 0 ? "corriendo" : estado;
}

export async function refrescarLotes(consulta = q) {
  const { rows } = await consulta(`
    SELECT l.id, l.estado,
           count(*) FILTER (WHERE i.estado IN ('pendiente','encolado','corriendo'))::int AS vivos,
           count(*) FILTER (WHERE i.estado = 'error')::int AS errores,
           count(*) FILTER (WHERE i.estado <> 'pendiente')::int AS iniciados
    FROM lotes l JOIN lote_items i ON i.lote_id = l.id
    WHERE l.estado IN ('pendiente','corriendo') GROUP BY l.id, l.estado`);
  let cambios = 0;
  for (const r of rows) {
    const nuevo = estadoLote(r);
    if (nuevo === r.estado) continue;
    await consulta(
      `UPDATE lotes SET estado=$2, actualizado_en=now(),
         iniciado_en = CASE WHEN iniciado_en IS NULL THEN now() ELSE iniciado_en END,
         terminado_en = CASE WHEN $2 IN ('completado','con_errores') THEN now() ELSE NULL END
       WHERE id=$1 AND estado=$3`, [r.id, nuevo, r.estado]);
    await evento({ lote: r.id, tipo: "lote_estado", estado: nuevo, detalle: `${r.vivos} vivos · ${r.errores} con error` }, consulta);
    cambios++;
  }
  return cambios;
}

// ---------- Crear lotes de cortes ----------

export async function crearLoteCortes({ nombre, clipIds }) {
  const ids = [...new Set((Array.isArray(clipIds) ? clipIds : []).map(String))];
  if (!ids.length) throw new ErrorHttp(400, "Indica al menos un clip.");
  if (ids.length > cfg.loteMaxItems) throw new ErrorHttp(400, `Un lote admite hasta ${cfg.loteMaxItems} elementos.`);
  if (!ids.every(x => /^\d{1,18}$/.test(x))) throw new ErrorHttp(400, "clip_ids inválidos.");
  const { rows } = await q("SELECT id::text AS id FROM clips WHERE id = ANY($1::bigint[])", [ids]);
  const existentes = new Set(rows.map(r => r.id));
  const faltan = ids.filter(x => !existentes.has(x));
  if (faltan.length) throw new ErrorHttp(400, `Clips inexistentes: ${faltan.slice(0, 10).join(", ")}.`);
  const nom = String(nombre || "").replace(/\s+/g, " ").trim().slice(0, 120) || `Cortes · ${ids.length} clips · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return tx(async c => {
    const cq = (s, p) => c.query(s, p);
    const { rows: [lote] } = await cq("INSERT INTO lotes(nombre, tipo, total) VALUES($1,'cortes',$2) RETURNING *", [nom, ids.length]);
    await cq("INSERT INTO lote_items(lote_id, tipo, clip_id) SELECT $1, 'cortar', x FROM unnest($2::bigint[]) AS x", [lote.id, ids]);
    await evento({ lote: lote.id, tipo: "lote_creado", estado: "pendiente", detalle: `${ids.length} cortes` }, cq);
    return lote;
  });
}

// ---------- Ciclos ----------

// Abre un ciclo si no hay otro abierto, ya pasó la pausa y hay elementos vencidos. Devuelve { cicloId, n } o null.
export async function iniciarCiclo({ tam = cfg.loteTam, pausaS = cfg.lotePausaS } = {}) {
  const t = Math.min(20, Math.max(10, tam));
  return tx(async c => {
    const cq = (s, p) => c.query(s, p);
    await cq("SELECT pg_advisory_xact_lock($1)", [LOCK_DESPACHO]);
    const { rows: abierto } = await cq("SELECT 1 FROM lote_ciclos WHERE estado='abierto' LIMIT 1");
    if (abierto.length) return null;
    const { rows: reciente } = await cq("SELECT 1 FROM lote_ciclos WHERE terminado_en > now() - ($1::numeric * interval '1 second') LIMIT 1", [pausaS]);
    if (reciente.length) return null;
    const { rows: items } = await cq(
      `SELECT i.id, i.tipo, i.lote_id, i.variante_id
       FROM lote_items i
       JOIN lotes l ON l.id = i.lote_id AND l.estado IN ('pendiente','corriendo')
       LEFT JOIN variantes v ON v.id = i.variante_id
       WHERE i.estado = 'pendiente' AND (i.variante_id IS NULL OR (v.estado = 'programada' AND v.programada_para <= now()))
       ORDER BY i.lote_id, i.id LIMIT $1 FOR UPDATE OF i SKIP LOCKED`, [t]);
    if (!items.length) return null;
    const { rows: [ciclo] } = await cq("INSERT INTO lote_ciclos(total) VALUES($1) RETURNING id", [items.length]);
    for (const it of items) {
      const def = TIPOS_ITEM[it.tipo];
      const { rows: [job] } = await cq(
        "INSERT INTO jobs(tipo, ref_id, payload, max_intentos) VALUES($1,$2,$3,$4) RETURNING id",
        [def.cola, it.id, { item_id: it.id, lote_id: it.lote_id, ciclo_id: ciclo.id }, def.intentos]);
      await cq("UPDATE lote_items SET estado='encolado', ciclo_id=$2, job_id=$3, encolado_en=now() WHERE id=$1", [it.id, ciclo.id, job.id]);
    }
    const vars = items.filter(i => i.variante_id).map(i => i.variante_id);
    if (vars.length) await cq("UPDATE variantes SET estado='en_cola', actualizado_en=now() WHERE id = ANY($1::bigint[]) AND estado='programada'", [vars]);
    const lotes = [...new Set(items.map(i => i.lote_id))];
    await cq("UPDATE lotes SET estado='corriendo', iniciado_en=COALESCE(iniciado_en, now()), actualizado_en=now() WHERE id = ANY($1::bigint[]) AND estado='pendiente'", [lotes]);
    await evento({ ciclo: ciclo.id, tipo: "ciclo_iniciado", estado: "abierto", detalle: `${items.length} elementos de ${lotes.length} lote(s)` }, cq);
    return { cicloId: ciclo.id, n: items.length };
  });
}

// Cierra un elemento (hecho/error) y, si falló, sincroniza su variante. Idempotente: solo actúa sobre elementos vivos.
export async function cerrarItem(id, estado, detalle = null, consulta = q) {
  const { rows: [it] } = await consulta(
    `UPDATE lote_items SET estado=$2, terminado_en=now(), detalle=$3
     WHERE id=$1 AND estado IN ('encolado','corriendo') RETURNING lote_id, ciclo_id, variante_id`,
    [id, estado, detalle == null ? null : String(detalle).slice(0, 500)]);
  if (!it) return false;
  if (estado === "error" && it.variante_id) {
    // Si estaba publicando, no sabemos si salió: "incierta" obliga a verificar antes de reintentar.
    await consulta(
      `UPDATE variantes SET estado = CASE WHEN estado='publicando' THEN 'incierta' ELSE 'error' END, error=$2, actualizado_en=now()
       WHERE id=$1 AND estado IN ('en_cola','publicando')`, [it.variante_id, String(detalle || "Falló el elemento del lote.").slice(0, 500)]);
  }
  await evento({ lote: it.lote_id, ciclo: it.ciclo_id, item: id, variante: it.variante_id, tipo: "item_" + estado, estado, detalle }, consulta);
  return true;
}

// Jobs que murieron (reinicio, error no atrapado) sin cerrar su elemento.
export async function reconciliar(consulta = q) {
  const { rows } = await consulta(
    `SELECT i.id, j.estado AS job_estado, j.error FROM lote_items i JOIN jobs j ON j.id = i.job_id
     WHERE i.estado IN ('encolado','corriendo') AND j.estado IN ('error','hecho') LIMIT 100`);
  let n = 0;
  for (const r of rows) {
    const ok = r.job_estado === "hecho";
    if (await cerrarItem(r.id, ok ? "hecho" : "error", ok ? null : (r.error || "El job terminó con error."), consulta)) n++;
  }
  return n;
}

// Cierra los ciclos cuyos elementos ya terminaron todos. Devuelve cuántos cerró.
export async function cerrarCiclos(consulta = q) {
  const { rows } = await consulta(
    `UPDATE lote_ciclos c SET estado='completado', terminado_en=now(),
       hechos = (SELECT count(*)::int FROM lote_items WHERE ciclo_id=c.id AND estado='hecho'),
       fallidos = (SELECT count(*)::int FROM lote_items WHERE ciclo_id=c.id AND estado='error')
     WHERE c.estado='abierto' AND NOT EXISTS (SELECT 1 FROM lote_items i WHERE i.ciclo_id=c.id AND i.estado IN ('encolado','corriendo'))
     RETURNING c.id, c.hechos, c.fallidos, c.total`);
  for (const r of rows) {
    const estado = r.fallidos > 0 ? "con_errores" : "completado";
    if (estado !== "completado") await consulta("UPDATE lote_ciclos SET estado=$2 WHERE id=$1", [r.id, estado]);
    await evento({ ciclo: r.id, tipo: "ciclo_cerrado", estado, detalle: `${r.hechos}/${r.total} hechos · ${r.fallidos} con error` }, consulta);
  }
  return rows.length;
}

// Un paso del despachador (exportado para pruebas).
export async function tick({ limpiarDisco = limpiar } = {}) {
  await reconciliar();
  const cerrados = await cerrarCiclos();
  if (cerrados) await limpiarDisco().catch(e => console.error("janitor tras ciclo:", e.message));   // libera disco entre ciclos
  await refrescarLotes();
  const ciclo = await iniciarCiclo();
  if (ciclo) await refrescarLotes();
  return { cerrados, ciclo };
}

export function iniciarDespachador(cadaMs = cfg.loteTickMs) {
  let activo = true;
  (async () => {
    while (activo) {
      try { await tick(); } catch (e) { console.error("[lotes]", e.message); }
      await dormir(cadaMs);
    }
  })();
  return () => { activo = false; };
}

// ---------- Manejador de los jobs lote_medios / lote_agente ----------

const MANEJADORES = {
  cortar: (it, job) => hCortar({ ref_id: it.clip_id, intentos: job.intentos, max_intentos: job.max_intentos }).then(() => ({ ok: true, detalle: "Clip cortado." })),
  publicar_variante: (it, job) => hPublicarVariante(it, job)
};

// Mueve la variante a una nueva hora y deja un elemento pendiente en su lote (el actual queda "aplazado").
export async function aplazarItem(it, { minutos, motivo }, consulta = null) {
  const correr = async c => {
    const cq = (s, p) => c.query(s, p);
    const { rows: [v] } = await cq("SELECT v.aplazos, l.estado AS lote_estado FROM variantes v JOIN lotes l ON l.id = v.lote_id WHERE v.id=$1 FOR UPDATE OF v", [it.variante_id]);
    await cq("UPDATE lote_items SET estado='aplazado', terminado_en=now(), detalle=$2 WHERE id=$1", [it.id, String(motivo).slice(0, 500)]);
    if (!v || v.lote_estado === "cancelado") {
      await cq("UPDATE variantes SET estado='cancelada', actualizado_en=now() WHERE id=$1 AND estado IN ('en_cola','publicando','programada')", [it.variante_id]);
      await evento({ lote: it.lote_id, item: it.id, variante: it.variante_id, tipo: "variante_cancelada", estado: "cancelada", detalle: "Lote cancelado" }, cq);
      return { aplazado: false };
    }
    if (v.aplazos >= MAX_APLAZOS) {
      const msg = `Se aplazó ${MAX_APLAZOS} veces y no se pudo publicar: ${motivo}`.slice(0, 500);
      await cq("UPDATE lote_items SET estado='error', detalle=$2 WHERE id=$1", [it.id, msg]);
      await cq("UPDATE variantes SET estado='error', error=$2, actualizado_en=now() WHERE id=$1", [it.variante_id, msg]);
      await evento({ lote: it.lote_id, item: it.id, variante: it.variante_id, tipo: "variante_resultado", estado: "error", detalle: msg }, cq);
      return { aplazado: false };
    }
    await cq("UPDATE variantes SET estado='programada', programada_para = now() + ($2::numeric * interval '1 minute'), aplazos = aplazos + 1, error=$3, actualizado_en=now() WHERE id=$1",
      [it.variante_id, minutos, String(motivo).slice(0, 500)]);
    await cq("INSERT INTO lote_items(lote_id, tipo, clip_id, variante_id) VALUES($1,$2,$3,$4)", [it.lote_id, it.tipo, it.clip_id, it.variante_id]);
    await evento({ lote: it.lote_id, item: it.id, variante: it.variante_id, tipo: "variante_aplazada", estado: "programada", detalle: `${motivo} Reintento en ${minutos} min.` }, cq);
    return { aplazado: true };
  };
  return consulta ? correr({ query: consulta }) : tx(correr);
}

export async function hLoteItem(job, { manejadores = MANEJADORES } = {}) {
  const { rows: [it] } = await q(
    `UPDATE lote_items SET estado='corriendo', intentos=intentos+1, iniciado_en=COALESCE(iniciado_en, now())
     WHERE id=$1 AND estado IN ('encolado','corriendo') RETURNING *`, [job.ref_id]);
  if (!it) return;   // cancelado o ya cerrado: nada que hacer
  await evento({ lote: it.lote_id, ciclo: it.ciclo_id, item: it.id, variante: it.variante_id, tipo: "item_corriendo", estado: "corriendo", detalle: `intento ${it.intentos}` });
  try {
    const r = await manejadores[it.tipo](it, job);
    if (r?.aplazar) { await aplazarItem(it, r.aplazar); return; }
    await cerrarItem(it.id, r?.ok === false ? "error" : "hecho", r?.detalle);
  } catch (e) {
    const msg = String(e.message).split("\n")[0].slice(0, 300);
    if (job.intentos >= job.max_intentos) await cerrarItem(it.id, "error", msg);
    else await q("UPDATE lote_items SET estado='encolado', detalle=$2 WHERE id=$1", [it.id, `Reintento tras error: ${msg}`]);
    throw e;
  }
}

// ---------- Control del lote ----------

async function cambiarEstadoLote(id, desde, hacia, tipo) {
  const { rowCount } = await q("UPDATE lotes SET estado=$3, actualizado_en=now() WHERE id=$1 AND estado = ANY($2::text[])", [id, desde, hacia]);
  if (!rowCount) {
    const { rows: [l] } = await q("SELECT estado FROM lotes WHERE id=$1", [id]);
    throw l ? new ErrorHttp(409, `El lote está ${l.estado}: no se puede ${tipo}.`) : new ErrorHttp(404, "Lote no encontrado.");
  }
  await evento({ lote: id, tipo: "lote_" + hacia, estado: hacia });
  return { ok: true, estado: hacia };
}
export const pausarLote = id => cambiarEstadoLote(id, ["pendiente", "corriendo"], "pausado", "pausar");
export const reanudarLote = id => cambiarEstadoLote(id, ["pausado"], "pendiente", "reanudar");   // refrescarLotes lo promueve a "corriendo"

// Cancela lo que aún no empezó. Los elementos ya encolados terminan su ejecución actual.
export async function cancelarLote(id) {
  return tx(async c => {
    const cq = (s, p) => c.query(s, p);
    const { rows: [l] } = await cq("SELECT estado FROM lotes WHERE id=$1 FOR UPDATE", [id]);
    if (!l) throw new ErrorHttp(404, "Lote no encontrado.");
    if (["completado", "con_errores", "cancelado"].includes(l.estado)) throw new ErrorHttp(409, `El lote ya está ${l.estado}.`);
    const { rows: its } = await cq("UPDATE lote_items SET estado='cancelado', terminado_en=now(), detalle='Lote cancelado' WHERE lote_id=$1 AND estado='pendiente' RETURNING variante_id", [id]);
    const vars = its.map(r => r.variante_id).filter(Boolean);
    if (vars.length) await cq("UPDATE variantes SET estado='cancelada', actualizado_en=now() WHERE id = ANY($1::bigint[]) AND estado='programada'", [vars]);
    await cq("UPDATE lotes SET estado='cancelado', terminado_en=now(), actualizado_en=now() WHERE id=$1", [id]);
    await evento({ lote: id, tipo: "lote_cancelado", estado: "cancelado", detalle: `${its.length} elementos cancelados` }, cq);
    return { ok: true, cancelados: its.length };
  });
}

// ---------- Consultas para el panel / asistente de monitoreo ----------

const CONTEOS = "(SELECT COALESCE(json_object_agg(estado, n), '{}'::json) FROM (SELECT estado, count(*)::int AS n FROM lote_items WHERE lote_id = l.id GROUP BY estado) t) AS items";

export const listarLotes = async (limite = 30) => (await q(`SELECT l.*, ${CONTEOS} FROM lotes l ORDER BY l.id DESC LIMIT $1`, [limite])).rows;

export async function detalleLote(id) {
  const { rows: [lote] } = await q(`SELECT l.*, ${CONTEOS} FROM lotes l WHERE l.id=$1`, [id]);
  if (!lote) throw new ErrorHttp(404, "Lote no encontrado.");
  const [items, variantes] = await Promise.all([
    q(`SELECT i.id, i.tipo, i.estado, i.ciclo_id, i.clip_id, i.variante_id, i.intentos, i.detalle, i.creado_en, i.encolado_en, i.iniciado_en, i.terminado_en
       FROM lote_items i WHERE i.lote_id=$1 ORDER BY i.id LIMIT 500`, [id]),
    q(`SELECT id, clip_id, titulo, gancho, cta, angulo, origen, plataformas, estado, programada_para, intentos, aplazos, error, iniciado_en, publicado_en, actualizado_en
       FROM variantes WHERE lote_id=$1 ORDER BY programada_para, id`, [id])
  ]);
  return { lote, items: items.rows, variantes: variantes.rows };
}

export const listarEventos = async (loteId, limite = 100) =>
  (await q("SELECT id, ciclo_id, item_id, variante_id, evento, estado, detalle, creado_en FROM lote_eventos WHERE lote_id=$1 ORDER BY id DESC LIMIT $2", [loteId, limite])).rows;

export const listarCiclos = async (limite = 20) => (await q("SELECT * FROM lote_ciclos ORDER BY id DESC LIMIT $1", [limite])).rows;

export async function monitor() {
  const [items, variantes, abierto, proximas, lotes, ciclos] = await Promise.all([
    q("SELECT estado, count(*)::int AS n FROM lote_items GROUP BY estado"),
    q("SELECT estado, count(*)::int AS n FROM variantes GROUP BY estado"),
    q("SELECT * FROM lote_ciclos WHERE estado='abierto' ORDER BY id DESC LIMIT 1"),
    q("SELECT id, lote_id, clip_id, titulo, plataformas, programada_para FROM variantes WHERE estado='programada' ORDER BY programada_para LIMIT 10"),
    q("SELECT estado, count(*)::int AS n FROM lotes GROUP BY estado"),
    q("SELECT * FROM lote_ciclos ORDER BY id DESC LIMIT 5")
  ]);
  const mapa = r => Object.fromEntries(r.rows.map(x => [x.estado, x.n]));
  return {
    config: { tamanoCiclo: cfg.loteTam, pausaCicloS: cfg.lotePausaS, variantesMax: cfg.variantesMax, protegerHoras: cfg.protegerHoras, zona: cfg.zonaHoraria },
    cicloAbierto: abierto.rows[0] || null,
    lotes: mapa(lotes), items: mapa(items), variantes: mapa(variantes),
    proximasVariantes: proximas.rows, ultimosCiclos: ciclos.rows
  };
}
