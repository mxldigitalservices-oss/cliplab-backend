// Reciclaje automático: cuando un clip con plataformas elegidas termina de cortarse, hCortar encola un job
// "auto_variantes" y este manejador arma el flujo completo con crearReciclaje() (el mismo motor que el botón
// "Reciclar"), sin intervención. Va en su propio job para que un fallo de la IA se reintente solo
// y nunca obligue a volver a cortar el video.
import { q } from "./db.js";
import { cfg } from "./config.js";
import { PLATAFORMAS, tieneSesion } from "./sesiones.js";
import { crearReciclaje } from "./variantes.js";

// AUTO_VARIANTES = cuántas variantes por clip (0 apaga la función). Por defecto 3, nunca más de VARIANTES_MAX.
const cantidad = () => {
  const raw = process.env.AUTO_VARIANTES;
  const n = raw === undefined || raw === "" ? 3 : Math.round(Number(raw));
  return Number.isFinite(n) ? Math.min(cfg.variantesMax, Math.max(0, n)) : 3;
};

export async function hAutoVariantes(job) {
  const n = cantidad();
  if (!n) return;
  const { rows: [c] } = await q("SELECT id, auto_plataformas FROM clips WHERE id=$1", [job.ref_id]);
  if (!c?.auto_plataformas?.length) return;

  // Idempotente: si el clip ya tiene variantes (reintento, re-corte, doble disparo) no se crean otras.
  const { rows: ya } = await q("SELECT 1 FROM variantes WHERE clip_id=$1 LIMIT 1", [c.id]);
  if (ya.length) return;

  // Solo plataformas con sesión cargada: es la misma comprobación que hace la ruta manual.
  const plataformas = [];
  for (const p of c.auto_plataformas) if (PLATAFORMAS.includes(p) && (await tieneSesion(p))) plataformas.push(p);
  if (!plataformas.length) return;

  await crearReciclaje({ clipId: c.id, plataformas, cantidad: n });
}
