// Selección explícita de red (TikTok / Instagram / Facebook). El sistema NUNCA adivina para qué red es un clip:
// si no se marca ninguna red, es un error claro (400), no un valor por defecto.

export const REDES = Object.freeze(["tiktok", "instagram", "facebook"]);
export const ETIQUETAS = Object.freeze({ tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook" });
export const etiquetaRed = r => ETIQUETAS[r] ?? String(r);

export class ErrorRed extends Error {
  constructor(mensaje) { super(mensaje); this.name = "ErrorRed"; this.status = 400; }   // el manejador de errores de Express ya respeta e.status
}

const verdadero = v => v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true" || String(v).toLowerCase() === "on";

// Acepta arreglo (["tiktok","facebook"]), texto ("tiktok, facebook" | "tiktok facebook"), o mapa ({ tiktok: true, instagram: false }).
// Devuelve las redes válidas, sin duplicados y en orden estable. Con requerida=false, "ninguna" es válido ([]).
export function normalizarRedes(valor, { requerida = true } = {}) {
  let lista;
  if (Array.isArray(valor)) lista = valor;
  else if (typeof valor === "string") lista = valor.split(/[,\s;|]+/);
  else if (valor && typeof valor === "object") lista = Object.entries(valor).filter(([, v]) => verdadero(v)).map(([k]) => k);
  else lista = [];
  const limpias = [...new Set(lista.map(x => String(x ?? "").trim().toLowerCase()).filter(Boolean))];
  const invalidas = limpias.filter(r => !REDES.includes(r));
  if (invalidas.length) throw new ErrorRed(`Red no válida: ${invalidas.map(r => r.slice(0, 20)).join(", ")}. Usa: ${REDES.join(", ")}.`);
  if (!limpias.length && requerida) throw new ErrorRed("Marca explícitamente para qué red es: tiktok, instagram y/o facebook.");
  return REDES.filter(r => limpias.includes(r));
}

// Redes que el usuario marcó en un clip/proyecto (campo `redes`, `platforms` o `plataformas`). Nunca infiere: sin marca → [].
export function redesDeClip(clip) {
  try { return normalizarRedes(clip?.redes ?? clip?.platforms ?? clip?.plataformas, { requerida: false }); }
  catch { return []; }
}

// ¿El clip tiene marcada esa red? Red inválida o clip sin marca → false (nunca lanza, nunca infiere).
export function tieneRed(clip, red) {
  const r = String(red ?? "").trim().toLowerCase();
  return REDES.includes(r) && redesDeClip(clip).includes(r);
}

// Texto legible: ["tiktok"] → "TikTok"; ["tiktok","facebook"] → "TikTok y Facebook"; 3 → "TikTok, Instagram y Facebook"; [] → "ninguna".
export function formatearRedes(valor) {
  let redes;
  try { redes = normalizarRedes(valor, { requerida: false }); } catch { redes = []; }
  const nombres = redes.map(etiquetaRed);
  if (!nombres.length) return "ninguna";
  if (nombres.length === 1) return nombres[0];
  return `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;
}
