// Esquema del frontend: reglas de negocio visibles (duración) y mapa TOLERANTE de nombres de campos.
// Si el backend nombra un campo distinto, se corrige aquí y en ningún otro sitio.

// REGLA DE ORO: clips y variantes duran como máximo 60 s (ideal 30–60 s).
export const DURACION = Object.freeze({ MAX: 60, IDEAL_MIN: 30 });

export const PLAT_NOMBRE = { tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", youtube: "YouTube" };
export const nombrePlat = p => PLAT_NOMBRE[p] || (String(p).charAt(0).toUpperCase() + String(p).slice(1));

export const pick = (o, claves, def) => {
  for (const k of claves) if (o && o[k] !== undefined && o[k] !== null) return o[k];
  return def;
};

export const CAMPOS = {
  lote: {
    nombre: ["nombre", "titulo"],
    total: ["total", "total_items", "items_total", "n_items", "cantidad"],
    hechos: ["completados", "hechos", "ok", "items_ok", "procesados", "listos"],
    fallidos: ["fallidos", "errores", "items_error", "fallos", "con_error"],
    creado: ["creado_en", "creado"]
  },
  ciclo: {
    numero: ["numero", "n", "indice", "ciclo", "id"],
    lote: ["lote_id", "lote"],
    total: ["total", "cantidad", "n_items", "items"],
    hechos: ["completados", "hechos", "ok", "procesados"],
    inicio: ["inicio", "iniciado_en", "inicio_en", "creado_en"],
    fin: ["fin", "terminado_en", "fin_en", "finalizado_en"]
  },
  variante: {
    plataforma: ["plataforma", "p"],
    programada: ["programada_para", "programada", "programado_para"],
    titulo: ["titulo"],
    gancho: ["gancho"],
    angulo: ["angulo"],
    detalle: ["detalle", "error"]
  },
  sesion: {
    plataforma: ["plataforma", "p", "nombre"],
    expira: ["expira", "expira_en", "expires"],
    testOk: ["test_ok", "ultimo_test_ok", "probado_ok"],
    testDetalle: ["test_detalle", "detalle_test", "ultimo_test_detalle"],
    testEn: ["test_en", "probado_en", "ultimo_test", "test_fecha"],
    actualizado: ["actualizado_en", "guardado_en", "creado_en"]
  }
};

// ---------- Estados ----------
export function tono(estado) {
  const s = String(estado || "").toLowerCase();
  if (/incierto/.test(s)) return "warn";
  if (/(error|fall|cancel|expir|rechaz)/.test(s)) return "bad";
  if (/paus/.test(s)) return "warn";
  if (/(cortando|publicando|analizando|procesando|ejecutando|en[_ ]curso|activo|activa|running|generando)/.test(s)) return "run";
  if (/(publicado|complet|termin|finaliz|listo|hecho|^ok$|conectad)/.test(s)) return "ok";
  if (/(pendiente|program|cola|espera)/.test(s)) return "wait";
  return "neutro";
}
export const loteTerminal = e => /(complet|termin|finaliz|cancel|hecho|fallid)/.test(String(e || "").toLowerCase());
export const loteEnPausa = e => /paus/.test(String(e || "").toLowerCase());
export const varianteCerrada = e => /(publicad|cancel|descart|^ok$)/.test(String(e || "").toLowerCase());

export function progresoLote(l) {
  const total = Number(pick(l, CAMPOS.lote.total, 0)) || 0;
  const hechos = Number(pick(l, CAMPOS.lote.hechos, 0)) || 0;
  const fall = Number(pick(l, CAMPOS.lote.fallidos, 0)) || 0;
  const pct = total ? Math.min(100, Math.round((hechos / total) * 100)) : 0;
  const fallPct = total ? Math.min(100 - pct, Math.round((fall / total) * 100)) : 0;
  return { total, hechos, fall, pct, fallPct };
}

// ---------- Duración ----------
export function duracionDe(o) {
  if (!o) return null;
  const d = pick(o, ["duracion_seg", "duracion", "dur_seg"]);
  if (d !== undefined && d !== "" && !isNaN(d)) return Math.round(Number(d) * 10) / 10;
  const i = pick(o, ["inicio_seg"]), f = pick(o, ["fin_seg"]);
  if (i !== undefined && f !== undefined && i !== "" && f !== "" && !isNaN(i) && !isNaN(f)) return Math.round((Number(f) - Number(i)) * 10) / 10;
  return null;
}

export function evaluarDuracion(seg) {
  const { MAX, IDEAL_MIN } = DURACION;
  if (seg == null || isNaN(seg)) return { nivel: "nd", texto: "sin duración", bloquea: false, ayuda: "Aún no hay inicio/fin definidos." };
  if (seg <= 0) return { nivel: "largo", texto: "duración inválida", bloquea: true, ayuda: "El fin debe ser posterior al inicio." };
  if (seg > MAX) return { nivel: "largo", texto: `${seg} s · excede ${MAX} s`, bloquea: true, ayuda: `Regla de oro: máximo ${MAX} s.` };
  if (seg < IDEAL_MIN) return { nivel: "corto", texto: `${seg} s · bajo el ideal`, bloquea: false, ayuda: `Válido, pero el rango ideal es ${IDEAL_MIN}–${MAX} s.` };
  return { nivel: "ok", texto: `${seg} s`, bloquea: false, ayuda: `Dentro del rango ideal (${IDEAL_MIN}–${MAX} s).` };
}
