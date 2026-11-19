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

export function generarMarketing(entrada = {}) {
  if (entrada && typeof entrada === "object" && "clip" in entrada) {
    return generarCopy(entrada);
  }
  throw new ErrorRed("Especifica { clip, red } o { clip, redes } con tiktok, instagram y/o facebook.");
}

export default {
  REDES,
  construirContextoClip,
  adaptarCopyPorRed,
  generarCopy,
  generarMarketing,
};
