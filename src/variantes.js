// Reciclaje multi-ángulo: mismo video base, nuevos metadatos (título, gancho, descripción, CTA, hashtags)
// y una ventana horaria distinta por variante. Cada variante se publica como elemento de un lote.
import { q, tx } from "./db.js";
import { cfg } from "./config.js";
import { ErrorHttp } from "./errores.js";
import { evento } from "./trazas.js";
import { generarTexto, ROL, tags } from "./gemini.js";
import { planificarVentanas, VENTANAS_DEFECTO } from "./ventanas.js";
import { PLATAFORMAS } from "./sesiones.js";
import { asegurarArchivoClip } from "./pipeline.js";
import { publicarEn } from "./agent/index.js";
import { dormir, rnd } from "./agent/humano.js";

export const ANGULOS = Object.freeze(["Polémica", "Valor", "Emoción", "Curiosidad", "Urgencia", "Historia"]);
export const MAX_APLAZOS = 24;

const limpio = s => String(s ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
const norm = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const corto = (s, n) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, "") + "…");

// ---------- Validación (pura) ----------

// Limpia, recorta y descarta variantes sin título o con título repetido (frente al base, a las ya usadas y entre sí).
export function validarVariantes(raw, base, { max = cfg.variantesMax, usados = [], origen = "ia" } = {}) {
  const vistos = new Set([norm(base?.titulo), ...usados.map(norm)]);
  const out = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    const titulo = limpio(v?.titulo).slice(0, 100);
    const k = norm(titulo);
    if (!k || vistos.has(k)) continue;
    vistos.add(k);
    out.push({
      titulo,
      gancho: limpio(v.gancho).slice(0, 300),
      descripcion: limpio(v.descripcion).slice(0, 400),
      cta: limpio(v.cta).slice(0, 150),
      hashtags: tags(v.hashtags),
      angulo: limpio(v.angulo).slice(0, 40),
      origen
    });
    if (out.length >= max) break;
  }
  return out;
}

// ---------- Generación: IA (rol COPY, con relevo a la llave de respaldo) y plantillas de reserva ----------

const PLANTILLAS = [
  ["Polémica", "Lo que nadie te dice:", "Pocos se atreven a decirlo:", "Dime en los comentarios si estás de acuerdo"],
  ["Valor", "Aprende esto en 60 segundos:", "Guarda este video:", "Guárdalo para verlo después"],
  ["Emoción", "Esto me dejó sin palabras:", "Escucha hasta el final:", "Compártelo con alguien que lo necesite"],
  ["Curiosidad", "¿Sabías esto?", "Casi nadie lo sabe:", "Sígueme para más datos como este"],
  ["Urgencia", "Míralo antes de que se pierda:", "Esto importa ahora mismo:", "Compártelo hoy"],
  ["Historia", "La historia detrás de:", "Te cuento cómo pasó:", "Cuéntame tu historia en los comentarios"],
  ["Polémica", "Esto va a incomodar a muchos:", "Opinión impopular:", "¿Estás de acuerdo? Responde abajo"],
  ["Valor", "El consejo que ojalá hubiera escuchado antes:", "Toma nota:", "Sígueme para más consejos"],
  ["Emoción", "No esperaba esta reacción:", "Mira lo que pasó:", "Etiqueta a quien tenga que verlo"],
  ["Curiosidad", "El detalle que casi todos pasan por alto:", "Fíjate bien en esto:", "Comenta si ya lo habías notado"],
  ["Urgencia", "No te lo pierdas:", "Pausa lo que estás haciendo:", "Envíaselo a un amigo hoy"],
  ["Historia", "Así empezó todo:", "Todo comenzó cuando:", "Sígueme para la segunda parte"]
];

// Reserva sin red: hasta 12 variantes distintas. Se usa si la IA falla o devuelve menos de las pedidas.
export function variantesPlantilla(base, n) {
  const gancho = limpio(base.gancho) || limpio(base.titulo);
  return PLANTILLAS.slice(0, n).map(([angulo, pt, pg, cta]) => ({
    titulo: `${pt} ${corto(limpio(base.titulo), 50)}`,
    gancho: `${pg} ${corto(gancho, 120)}`,
    descripcion: limpio(base.descripcion),
    cta, hashtags: base.hashtags || [], angulo
  }));
}

const S = { type: "STRING" };
const SCHEMA_VARIANTES = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: { titulo: S, gancho: S, descripcion: S, cta: S, hashtags: { type: "ARRAY", items: S }, angulo: S },
    required: ["titulo", "gancho", "descripcion", "cta", "hashtags", "angulo"]
  }
};

const promptVariantes = (b, n) => `Eres copywriter de formatos verticales (TikTok, Reels, Shorts). Reciclarás UN video ya cortado publicándolo varias veces con enfoques distintos.
Video base:
- Título: ${limpio(b.titulo)}
- Gancho: ${limpio(b.gancho)}
- Descripción: ${limpio(b.descripcion)}
- CTA: ${limpio(b.cta)}
- Categoría: ${limpio(b.categoria)} · Ángulo original: ${limpio(b.angulo)}
Crea ${n} variantes. Reglas:
1. Cada variante usa un ángulo distinto entre: ${ANGULOS.join(", ")} (repite solo si pides más de ${ANGULOS.length}).
2. "titulo": máximo 70 caracteres, sin emojis, distinto al original y entre sí. "gancho": primera frase que engancha. "descripcion": 1 o 2 frases (máx. 200 caracteres). "cta": una llamada a la acción corta y diferente en cada una. "hashtags": de 3 a 5, cada uno con #.
3. No inventes hechos que el video base no sugiera. Mismo idioma que el video base.
Responde solo con el arreglo JSON.`;

export async function generarVariantesIA(base, n, { generar = generarTexto } = {}) {
  try {
    const { texto } = await generar(ROL.COPY, promptVariantes(base, n), { json: true, schema: SCHEMA_VARIANTES, temperature: 0.9 });
    const j = JSON.parse(texto);
    return Array.isArray(j) ? j : (Array.isArray(j?.variantes) ? j.variantes : []);
  } catch (e) {
    console.warn("Variantes con IA no disponibles:", String(e.message).split("\n")[0]);
    return [];
  }
}

// IA primero; si faltan, se completan con plantillas. Devuelve { lista, avisos }.
export async function construirVariantes(base, n, { usados = [], generar } = {}) {
  const avisos = [];
  const ia = validarVariantes(await generarVariantesIA(base, n, { generar }), base, { max: n, usados, origen: "ia" });
  let lista = ia;
  if (lista.length < n) {
    const reserva = validarVariantes(variantesPlantilla(base, PLANTILLAS.length), base, {
      max: n - lista.length, usados: [...usados, ...lista.map(v => v.titulo)], origen: "plantilla"
    });
    if (reserva.length) avisos.push(`${reserva.length} variante(s) salieron de plantillas porque la IA no entregó suficientes.`);
    lista = [...lista, ...reserva];
  }
  if (lista.length < n) avisos.push(`Solo se pudieron generar ${lista.length} de ${n} variantes únicas.`);
  return { lista, avisos };
}

// ---------- Creación del reciclaje (lote + variantes + elementos, todo en una transacción) ----------

export async function crearReciclaje(p, { consulta = q, transaccion = tx, ahora = Date.now(), generar, rnd: aleatorio = Math.random } = {}) {
  const { rows: [clip] } = await consulta("SELECT id, titulo, gancho, descripcion, cta, hashtags, categoria, angulo FROM clips WHERE id=$1", [p.clipId]);
  if (!clip) throw new ErrorHttp(404, "Clip no encontrado.");

  const plataformas = [...new Set((Array.isArray(p.plataformas) ? p.plataformas : []).filter(x => PLATAFORMAS.includes(x)))];
  if (!plataformas.length) throw new ErrorHttp(400, "Elige al menos una plataforma.");

  const manuales = Array.isArray(p.manuales) && p.manuales.length ? p.manuales : null;
  const cantidad = manuales ? Math.min(manuales.length, cfg.variantesMax) : Number(p.cantidad);
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > cfg.variantesMax) throw new ErrorHttp(400, `cantidad debe ser un entero entre 1 y ${cfg.variantesMax}.`);

  const desde = p.desde ? Date.parse(p.desde) : ahora + 60e3;
  if (!Number.isFinite(desde)) throw new ErrorHttp(400, "desde no es una fecha válida (usa ISO 8601).");
  const sep = p.separacionMin == null ? 90 : Number(p.separacionMin);
  if (!Number.isFinite(sep) || sep < 0 || sep > 1440) throw new ErrorHttp(400, "separacion_min debe estar entre 0 y 1440.");

  const { rows: previos } = await consulta("SELECT titulo FROM variantes WHERE clip_id=$1", [clip.id]);
  const usados = previos.map(r => r.titulo);
  let lista, avisos = [];
  if (manuales) {
    lista = validarVariantes(manuales, clip, { max: cantidad, usados, origen: "manual" });
    if (lista.length < manuales.length) avisos.push("Se descartaron variantes manuales sin título o con título repetido.");
  } else ({ lista, avisos } = await construirVariantes(clip, cantidad, { usados, generar }));
  if (!lista.length) throw new ErrorHttp(422, "No se pudo generar ninguna variante única.");

  let horarios;
  try {
    horarios = planificarVentanas({ cantidad: lista.length, ventanas: p.ventanas?.length ? p.ventanas : VENTANAS_DEFECTO, desde, separacionMin: sep, rnd: aleatorio });
  } catch (e) { throw new ErrorHttp(400, e.message); }

  const nombre = limpio(p.nombre).slice(0, 120) || `Reciclaje clip #${clip.id} · ${new Date(ahora).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return transaccion(async c => {
    const cq = (sql, params) => c.query(sql, params);
    const { rows: [lote] } = await cq("INSERT INTO lotes(nombre, tipo, clip_id, total) VALUES($1,'reciclaje',$2,$3) RETURNING *", [nombre, clip.id, lista.length]);
    const variantes = [];
    for (const [i, v] of lista.entries()) {
      const { rows: [row] } = await cq(
        `INSERT INTO variantes(clip_id, lote_id, titulo, gancho, descripcion, cta, hashtags, angulo, origen, plataformas, programada_para)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [clip.id, lote.id, v.titulo, v.gancho, v.descripcion, v.cta, v.hashtags, v.angulo, v.origen, plataformas, horarios[i]]);
      const { rows: [it] } = await cq("INSERT INTO lote_items(lote_id, tipo, clip_id, variante_id) VALUES($1,'publicar_variante',$2,$3) RETURNING id", [lote.id, clip.id, row.id]);
      await evento({ lote: lote.id, item: it.id, variante: row.id, tipo: "variante_programada", estado: "programada", detalle: `${row.angulo || "sin ángulo"} · ${horarios[i].toISOString()}` }, cq);
      variantes.push(row);
    }
    await evento({ lote: lote.id, tipo: "lote_creado", estado: "pendiente", detalle: `${lista.length} variantes del clip ${clip.id}` }, cq);
    return { lote, variantes, avisos, solicitadas: manuales ? manuales.length : cantidad };
  });
}

// ---------- Estado de una variante a partir de sus publicaciones (puro) ----------

export function resumenVariante(plataformas, ultimas) {
  const est = plataformas.map(p => ultimas[p] || null);
  if (est.includes("incierto")) return "incierta";
  const buenos = est.filter(e => e === "ok" || e === "simulado").length;
  if (buenos === est.length) return est.includes("simulado") ? "simulada" : "publicada";
  return est.includes("ok") ? "parcial" : "error";
}

const ultimasPublicaciones = async (id, consulta = q) => {
  const { rows } = await consulta("SELECT DISTINCT ON (plataforma) plataforma, estado FROM publicaciones WHERE variante_id=$1 AND estado <> 'descartado' ORDER BY plataforma, id DESC", [id]);
  return Object.fromEntries(rows.map(r => [r.plataforma, r.estado]));
};

const MENSAJE = {
  incierta: "Se pulsó Publicar pero no se confirmó: verifica en la plataforma y resuélvelo en el panel.",
  parcial: "Se publicó solo en algunas plataformas.",
  error: "No se publicó en ninguna plataforma."
};

export async function finalizarVariante(id, { consulta = q, detalle = "" } = {}) {
  const { rows: [v] } = await consulta("SELECT plataformas FROM variantes WHERE id=$1", [id]);
  if (!v) return null;
  const estado = resumenVariante(v.plataformas, await ultimasPublicaciones(id, consulta));
  const msg = estado === "publicada" || estado === "simulada" ? (estado === "simulada" ? "Modo prueba: no se publicó." : null) : [MENSAJE[estado], detalle].filter(Boolean).join(" ").slice(0, 500);
  await consulta(
    `UPDATE variantes SET estado=$2, error=$3, publicado_en = CASE WHEN $2 = 'publicada' THEN now() ELSE publicado_en END, actualizado_en=now()
     WHERE id=$1 AND estado NOT IN ('cancelada')`, [id, estado, msg]);
  await evento({ variante: id, tipo: "variante_resultado", estado, detalle: msg }, consulta);
  return estado;
}

// ---------- Manejador del elemento "publicar_variante" ----------
// Devuelve { ok, detalle } (terminado) o { aplazar: { minutos, motivo } } (se reprograma sin gastar un intento).
export async function hPublicarVariante(item, job = {}, deps = {}) {
  const { consulta = q, publicar = publicarEn, asegurarArchivo = asegurarArchivoClip, pausar = dormir } = deps;
  const { rows: [v] } = await consulta("SELECT * FROM variantes WHERE id=$1", [item.variante_id]);
  if (!v) return { ok: false, detalle: "La variante ya no existe." };
  if (["cancelada", "publicada"].includes(v.estado)) return { ok: true, detalle: `Variante ${v.estado}: nada que hacer.` };
  const { rows: [c] } = await consulta("SELECT c.*, f.video_id FROM clips c JOIN fuentes f ON f.id = c.fuente_id WHERE c.id=$1", [v.clip_id]);
  if (!c) return { ok: false, detalle: "El clip base ya no existe." };
  if (["cortando", "publicando"].includes(c.estado)) return { aplazar: { minutos: 5, motivo: `El clip base está ${c.estado}.` } };

  const ultimas = await ultimasPublicaciones(v.id, consulta);
  const pendientes = v.plataformas.filter(p => !["ok", "incierto"].includes(ultimas[p]));
  if (!pendientes.length) return { ok: true, detalle: `Variante ${await finalizarVariante(v.id, { consulta })}.` };

  await consulta("UPDATE variantes SET estado='publicando', intentos=intentos+1, iniciado_en=COALESCE(iniciado_en, now()), error=NULL, actualizado_en=now() WHERE id=$1", [v.id]);
  await evento({ lote: v.lote_id, item: item.id, variante: v.id, tipo: "variante_publicando", estado: "publicando", detalle: pendientes.join(", ") });

  let archivo;
  try { archivo = await asegurarArchivo(c); }
  catch (e) {
    const msg = `No se pudo preparar el video base: ${String(e.message).split("\n")[0]}`.slice(0, 400);
    await consulta("UPDATE variantes SET estado='error', error=$2, actualizado_en=now() WHERE id=$1", [v.id, msg]);
    await evento({ lote: v.lote_id, item: item.id, variante: v.id, tipo: "variante_resultado", estado: "error", detalle: msg });
    return { ok: false, detalle: msg };
  }

  const pieza = { ...c, id: `${c.id}v${v.id}`, archivo, titulo: v.titulo, gancho: v.gancho, descripcion: v.descripcion, cta: v.cta, hashtags: v.hashtags };
  let aplazar = null, primera = true;
  const notas = [];
  for (const p of pendientes) {
    const { rows: [dia] } = await consulta("SELECT count(*)::int AS n FROM publicaciones WHERE plataforma=$1 AND estado IN ('ok','incierto') AND creado_en > now() - interval '24 hours'", [p]);
    if (dia.n >= cfg.maxPubDia) { aplazar = { minutos: cfg.aplazoMin, motivo: `${p}: límite diario (${cfg.maxPubDia}) alcanzado.` }; break; }
    if (!primera) await pausar(rnd(cfg.pausaPlataformasS[0], cfg.pausaPlataformasS[1]) * 1000);
    primera = false;
    try {
      const r = await publicar(p, pieza);
      await consulta("INSERT INTO publicaciones(clip_id, plataforma, estado, detalle, variante_id) VALUES($1,$2,$3,$4,$5)", [c.id, p, r.simulado ? "simulado" : "ok", r.detalle || "", v.id]);
    } catch (e) {
      const msg = String(e.message).split("\n")[0].slice(0, 300);
      if (/est[aá] ocupado/i.test(msg)) { aplazar = { minutos: 2, motivo: "El agente de navegador está ocupado." }; break; }
      const estado = e.incierto ? "incierto" : "error";
      await consulta("INSERT INTO publicaciones(clip_id, plataforma, estado, detalle, variante_id) VALUES($1,$2,$3,$4,$5)", [c.id, p, estado, e.incierto ? `Se pulsó Publicar pero no se confirmó: ${msg}` : msg, v.id]);
      notas.push(`${p}: ${msg}`);
    }
  }
  if (aplazar) return { aplazar };
  const estado = await finalizarVariante(v.id, { consulta, detalle: notas.join(" | ") });
  return { ok: estado === "publicada" || estado === "simulada", detalle: `Variante ${estado}.` };
}

// ---------- Operaciones del panel ----------

export const listarVariantes = async clipId =>
  (await q(`SELECT v.*, (SELECT json_agg(json_build_object('p', plataforma, 'e', estado, 'd', detalle, 't', creado_en) ORDER BY id)
                           FROM publicaciones WHERE variante_id = v.id) AS pubs
            FROM variantes v WHERE v.clip_id=$1 ORDER BY v.programada_para, v.id`, [clipId])).rows;

export async function cancelarVariante(id) {
  return tx(async c => {
    const cq = (s, p) => c.query(s, p);
    const { rows: [v] } = await cq("SELECT id, lote_id, estado FROM variantes WHERE id=$1 FOR UPDATE", [id]);
    if (!v) throw new ErrorHttp(404, "Variante no encontrada.");
    if (["en_cola", "publicando"].includes(v.estado)) throw new ErrorHttp(409, "La variante se está procesando ahora mismo.");
    if (["publicada", "simulada", "cancelada", "incierta"].includes(v.estado)) throw new ErrorHttp(409, `Una variante ${v.estado} no se puede cancelar.`);
    await cq("UPDATE lote_items SET estado='cancelado', terminado_en=now(), detalle='Variante cancelada' WHERE variante_id=$1 AND estado='pendiente'", [id]);
    await cq("UPDATE variantes SET estado='cancelada', actualizado_en=now() WHERE id=$1", [id]);
    await evento({ lote: v.lote_id, variante: id, tipo: "variante_cancelada", estado: "cancelada" }, cq);
    return { ok: true };
  });
}

// Reprograma una variante (error, parcial, cancelada o aún programada) a una nueva hora; vuelve a entrar a su lote.
export async function reprogramarVariante(id, cuando) {
  const t = Date.parse(cuando);
  if (!Number.isFinite(t)) throw new ErrorHttp(400, "programada_para no es una fecha válida (usa ISO 8601).");
  return tx(async c => {
    const cq = (s, p) => c.query(s, p);
    const { rows: [v] } = await cq("SELECT v.id, v.lote_id, v.clip_id, v.estado, l.estado AS lote_estado FROM variantes v JOIN lotes l ON l.id = v.lote_id WHERE v.id=$1 FOR UPDATE OF v", [id]);
    if (!v) throw new ErrorHttp(404, "Variante no encontrada.");
    if (!["programada", "error", "parcial", "cancelada"].includes(v.estado)) throw new ErrorHttp(409, `No se puede reprogramar una variante ${v.estado}.`);
    if (v.lote_estado === "cancelado") throw new ErrorHttp(409, "El lote está cancelado.");
    const cuandoISO = new Date(Math.max(t, Date.now())).toISOString();
    await cq("UPDATE variantes SET estado='programada', programada_para=$2, error=NULL, aplazos=0, actualizado_en=now() WHERE id=$1", [id, cuandoISO]);
    const { rows: vivo } = await cq("SELECT 1 FROM lote_items WHERE variante_id=$1 AND estado IN ('pendiente','encolado','corriendo')", [id]);
    if (!vivo.length) {
      await cq("INSERT INTO lote_items(lote_id, tipo, clip_id, variante_id) VALUES($1,'publicar_variante',$2,$3)", [v.lote_id, v.clip_id, id]);
      await cq("UPDATE lotes SET estado = CASE WHEN estado IN ('completado','con_errores') THEN 'corriendo' ELSE estado END, terminado_en = NULL, total = total + 1, actualizado_en=now() WHERE id=$1", [v.lote_id]);
    }
    await evento({ lote: v.lote_id, variante: id, tipo: "variante_reprogramada", estado: "programada", detalle: cuandoISO }, cq);
    return { ok: true, programada_para: cuandoISO };
  });
}

// Resuelve una publicación "incierta" de una variante: ya salió (cuenta como hecha) o hay que reintentar.
export async function resolverVariante(id, plataforma, accion) {
  if (!PLATAFORMAS.includes(plataforma) || !["publicado", "reintentar"].includes(accion)) throw new ErrorHttp(400, "Datos inválidos.");
  return tx(async c => {
    const cq = (s, p) => c.query(s, p);
    const r = await cq("UPDATE publicaciones SET estado='descartado' WHERE variante_id=$1 AND plataforma=$2 AND estado='incierto'", [id, plataforma]);
    if (!r.rowCount) throw new ErrorHttp(404, "No hay publicación incierta para resolver.");
    if (accion === "publicado") {
      const { rows: [v] } = await cq("SELECT clip_id FROM variantes WHERE id=$1", [id]);
      await cq("INSERT INTO publicaciones(clip_id, plataforma, estado, detalle, variante_id) VALUES($1,$2,'ok','Confirmado manualmente',$3)", [v.clip_id, plataforma, id]);
    }
    const estado = await finalizarVariante(id, { consulta: cq });
    return { ok: true, estado };
  });
}
