import { cfg } from "../config.js";

const limpio = s => String(s || "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/[ \t]+/g, " ").trim();

// Título + descripción + CTA + hashtags (al final, sin salto de línea tras el último).
export function armarCaption(c) {
  const titulo = limpio(c.titulo), cta = limpio(c.cta);
  const tags = (c.hashtags || []).slice(0, 5).join(" ");
  const fijo = [titulo, cta, tags].filter(Boolean).join("\n\n").length + 6;
  let desc = limpio(c.descripcion);
  const presupuesto = Math.max(0, cfg.captionMax - fijo);
  if (desc.length > presupuesto) desc = desc.slice(0, presupuesto).replace(/\s+\S*$/, "");
  return [titulo, desc, cta, tags].filter(Boolean).join("\n\n").slice(0, cfg.captionMax);
}
