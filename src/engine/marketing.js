import { normalizarRedes, REDES, etiquetaRed, ErrorRed } from "../utils/plataformas.js";

function limpiarTexto(valor = "") {
  return String(valor ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function dividirOraciones(texto = "") {
  return limpiarTexto(texto)
    .split(/(?<=[.!?])\s+|\s*[|•·]+\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function extraerPuntosClave(texto = "", maximo = 3) {
  const limpio = limpiarTexto(texto);
  if (!limpio) return [];

  const oraciones = dividirOraciones(limpio);
  if (oraciones.length >= 2) {
    return oraciones.slice(0, maximo).map((o) => (o.length > 130 ? `${o.slice(0, 127).trim()}...` : o));
  }

  const palabras = limpio.split(/\s+/).filter(Boolean);
  if (palabras.length <= 12) return [limpio];

  const puntos = [];
  const tamanoTrozo = Math.max(8, Math.ceil(palabras.length / maximo));
  for (let i = 0; i < palabras.length && puntos.length < maximo; i += tamanoTrozo) {
    const trozo = palabras.slice(i, i + tamanoTrozo).join(" ").trim();
    if (trozo) puntos.push(trozo);
  }
  return puntos;
}

export function construirContextoClip(clip = {}) {
  const tituloBase = limpiarTexto(
    clip.titulo ?? clip.title ?? clip.nombre ?? clip.tema ?? "Clip sin título"
  );
  const instruccion = limpiarTexto(
    clip.instruccion ?? clip.busqueda ?? clip.query ?? clip.prompt ?? ""
  );
  const transcripcion = limpiarTexto(
    clip.transcripcion ?? clip.transcript ?? clip.texto ?? clip.guion ?? clip.resumen ?? ""
  );
  const descripcionBase = limpiarTexto(clip.descripcion ?? clip.description ?? "");
  const duracionSeg = Number(clip.duracion ?? clip.duration ?? clip.segundos ?? 0) || null;

  const fuentePrincipal = transcripcion || descripcionBase || tituloBase;
  const puntosClave = extraerPuntosClave(fuentePrincipal, 3);
  const gancho = limpiarTexto(
    clip.gancho ?? clip.hook ?? puntosClave[0] ?? tituloBase
  );

  return {
    tituloBase,
    instruccion,
    gancho: gancho.length > 110 ? `${gancho.slice(0, 107).trim()}...` : gancho,
    puntosClave,
    resumenLargo: fuentePrincipal.length > 260,
    duracionSeg,
    fuenteTexto: fuentePrincipal,
  };
}

function construirHashtags(red, ctx, extraTags = []) {
  const baseTags = ["clips", "contenido", "aprende"];
  const porRed = {
    tiktok: ["tiktok", "parati", "fyp", "viraltips"],
    instagram: ["instagram", "reels", "guardar", "compartir"],
    facebook: ["facebook", "comunidad", "debate", "hablemos"],
  };

  const palabrasTema = `${ctx.tituloBase} ${ctx.instruccion}`
    .toLowerCase()
    .replace(/[^a-záéíóúñ0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && w.length <= 16)
    .slice(0, 2);

  const combinados = [
    ...palabrasTema,
    ...(porRed[red] ?? []),
    ...baseTags,
    ...(Array.isArray(extraTags) ? extraTags : []),
  ]
    .map((t) => String(t).replace(/^#+/, "").replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ_]/g, "").toLowerCase())
    .filter(Boolean);

  return [...new Set(combinados)].slice(0, 7).map((t) => `#${t}`);
}

export function adaptarCopyPorRed({ clip = {}, red, hashtagsExtra = [] } = {}) {
  const [redNormalizada] = normalizarRedes(red, { requerida: true });
  const ctx = construirContextoClip(clip);
  const hashtags = construirHashtags(redNormalizada, ctx, hashtagsExtra);

  if (redNormalizada === "tiktok") {
    const titulo = `${ctx.gancho}${ctx.duracionSeg ? ` (${ctx.duracionSeg}s)` : ""}`.slice(0, 100);
    const bullets = ctx.puntosClave.map((p) => `• ${p}`).join("\n");
    const cta = "¿Te pasó o qué opinas? Déjalo en comentarios.";
    const descripcion = [
      ctx.resumenLargo ? "Lo clave en corto:" : ctx.gancho,
      bullets,
      cta,
      hashtags.join(" "),
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      red: "tiktok",
      etiqueta: etiquetaRed("tiktok"),
      titulo,
      descripcion,
      cta,
      hashtags,
      contexto: ctx,
    };
  }

  if (redNormalizada === "instagram") {
    const titulo = ctx.tituloBase.slice(0, 100);
    const puntosFormateados = ctx.puntosClave.map((p, idx) => `${idx + 1}. ${p}`).join("\n");
    const cta = "Guarda este clip y compártelo con alguien que necesite verlo.";
    const descripcion = [
      titulo,
      puntosFormateados || ctx.fuenteTexto.slice(0, 220),
      cta,
      hashtags.join(" "),
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      red: "instagram",
      etiqueta: etiquetaRed("instagram"),
      titulo,
      descripcion,
      cta,
      hashtags,
      contexto: ctx,
    };
  }

  const titulo = `${ctx.tituloBase}${ctx.instruccion ? ` — ${ctx.instruccion}` : ""}`.slice(0, 120);
  const contextoDetallado = ctx.resumenLargo
    ? `${ctx.fuenteTexto.slice(0, 360)}${ctx.fuenteTexto.length > 360 ? "..." : ""}`
    : ctx.fuenteTexto || ctx.gancho;
  const puntosExtra = ctx.puntosClave.length > 1
    ? `Puntos principales:\n${ctx.puntosClave.map((p) => `- ${p}`).join("\n")}`
    : "";
  const cta = "¿Qué te parece este tema? Cuéntanos tu experiencia en los comentarios.";
  const descripcion = [
    contextoDetallado,
    puntosExtra,
    cta,
    hashtags.join(" "),
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    red: "facebook",
    etiqueta: etiquetaRed("facebook"),
    titulo,
    descripcion,
    cta,
    hashtags,
    contexto: ctx,
  };
}

export function generarCopy({ clip = {}, red, redes, hashtagsExtra = [] } = {}) {
  if (red) {
    return adaptarCopyPorRed({ clip, red, hashtagsExtra });
  }
  const listaRedes = normalizarRedes(redes, { requerida: true });
  const porRed = {};
  for (const r of listaRedes) {
    porRed[r] = adaptarCopyPorRed({ clip, red: r, hashtagsExtra });
  }
  return {
    redes: listaRedes,
    porRed,
  };
}

// ---------------------------------------------------------------------------
// Paquete base (sin red): titulo, descripcion, CTA, hashtags y nicho a partir del titulo del video + transcripcion.
// Lo usan el curador (fichas), el planificador y el pipeline. Es local y determinista (misma semilla -> mismo texto).
// NO exige red: la red solo se pide en adaptarCopyPorRed / generarCopy (publicacion).
// ---------------------------------------------------------------------------
const NICHOS = {
  negocios: ["negocio", "emprend", "cliente", "venta", "dinero", "empresa", "pesos", "inversi", "ganancia", "marca", "marketing", "precio"],
  tecnologia: ["tecnolog", "inteligencia artificial", "software", "app", "program", "codigo", "celular", "computador", "internet", "robot"],
  debate: ["opini", "debate", "pol[ií]tic", "gobierno", "polemic", "verdad", "mentira", "culpa", "discusi"],
  entretenimiento: ["pel[ií]cula", "serie", "m[uú]sica", "cancion", "famos", "chiste", "risa", "humor", "juego", "show"],
};
const HASHTAGS_NICHO = {
  negocios: ["negocios", "emprendimiento", "dinero", "ventas", "exito"],
  tecnologia: ["tecnologia", "innovacion", "digital", "futuro", "tips"],
  debate: ["debate", "opinion", "hablemos", "actualidad", "reflexion"],
  entretenimiento: ["entretenimiento", "divertido", "momentos", "viral", "humor"],
  general: ["aprende", "tips", "consejos", "contenido", "motivacion"],
};
const CTAS = [
  "Sígueme para más contenido como este.",
  "Guarda este clip y compártelo con quien lo necesite.",
  "Cuéntame en los comentarios qué opinas.",
  "Si te sirvió, deja tu like y comparte.",
  "¿Te pasó algo parecido? Escríbelo abajo.",
  "Activa las notificaciones para no perderte la siguiente parte.",
];
const PLANTILLAS_TITULO = [
  (t) => t,
  (t) => `${t}: lo que casi nadie te cuenta`,
  (t) => `Lo esencial de ${t}`,
  (t) => `Esto cambia cómo ves ${t}`,
  (t) => `${t}: la idea clave`,
];
const MULETILLAS = /^(mira|oye|bueno|pues|entonces|ok|okay|so|look|y|pero|o sea|eh+|mm+|um+)[,\s]+/i;

function hashSemilla(semilla = "") {
  let h = 2166136261;
  for (const c of String(semilla)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
const elegir = (lista, n) => lista[n % lista.length];
const mayus = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const sinAcentosMk = (t) => String(t ?? "").toLowerCase().replace(/ñ/g, "n").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

function cortarPalabra(texto, max) {
  const t = limpiarTexto(texto);
  if (t.length <= max) return t;
  const corte = t.slice(0, max - 1);
  const sp = corte.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? corte.slice(0, sp) : corte).replace(/[\s.,;:]+$/, "")}…`;
}

function detectarNicho(texto) {
  const t = sinAcentosMk(texto);
  let mejor = "general";
  let max = 0;
  for (const [nicho, claves] of Object.entries(NICHOS)) {
    const n = claves.filter((k) => new RegExp(sinAcentosMk(k).replace(/\[i\]/g, "i")).test(t)).length;
    if (n > max) { max = n; mejor = nicho; }
  }
  return mejor;
}

function ganchoDeTexto(transcripcion) {
  const frases = dividirOraciones(transcripcion)
    .map((f) => limpiarTexto(f).replace(MULETILLAS, "").replace(/[.,;:]+$/, ""))
    .filter((f) => f.split(/\s+/).length >= 4);
  if (!frases.length) return "";
  const puntuar = (f) => (/\d/.test(f) ? 2 : 0) + (/\?/.test(f) ? 1 : 0) + (/(error|secreto|nunca|siempre|clave|cuidado|truco|verdad)/i.test(f) ? 2 : 0);
  const ventana = frases.slice(0, 3);
  return mayus(ventana.reduce((m, f) => (puntuar(f) > puntuar(m) ? f : m), ventana[0]));
}

export function generarMarketingBase({ tituloVideo = "", transcripcion = "", semilla = "", indice = 1, total = 1 } = {}) {
  const tema = limpiarTexto(tituloVideo) || "Clip";
  const h = hashSemilla(semilla || `${tema}|${indice}`);
  const gancho = ganchoDeTexto(transcripcion);
  let titulo = gancho ? cortarPalabra(gancho, 88) : cortarPalabra(elegir(PLANTILLAS_TITULO, h)(tema), 88);
  if (titulo.length < 11) titulo = cortarPalabra(`${titulo}: lo esencial`, 88);
  const cta = elegir(CTAS, hashSemilla(`cta|${semilla}|${indice}`));
  const nicho = detectarNicho(`${tema} ${transcripcion}`);
  const palabrasTema = sinAcentosMk(tema).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && w.length <= 16).slice(0, 2);
  const etiquetas = [...new Set([...HASHTAGS_NICHO[nicho], ...palabrasTema, "clips", "parati"].map((x) => x.replace(/[^a-z0-9]/g, "")).filter(Boolean))].slice(0, 8);
  const hashtags = etiquetas.map((x) => `#${x}`);
  const parte = total > 1 ? ` (parte ${indice} de ${total})` : "";
  const descripcion = [titulo, `Mira hasta el final${parte}.`].join("\n\n");
  return { titulo, descripcion, cta, hashtags, nicho, version: 2, generadoEn: new Date().toISOString() };
}

export function generarMarketing(entrada = {}) {
  // Con { clip, red|redes } -> copy adaptado por red (exige red explicita). Sin clip -> paquete base del curador/pipeline.
  if (entrada && typeof entrada === "object" && "clip" in entrada) {
    return generarCopy(entrada);
  }
  return generarMarketingBase(entrada);
}

export default {
  REDES,
  generarMarketingBase,
  construirContextoClip,
  adaptarCopyPorRed,
  generarCopy,
  generarMarketing,
};
