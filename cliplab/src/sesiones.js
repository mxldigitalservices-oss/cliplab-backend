import { q } from "./db.js";
import { cifrar, descifrar } from "./crypto.js";

export const PLATAFORMAS = ["tiktok", "instagram", "facebook"];

export async function guardarSesion(plataforma, estado) {
  await q(
    `INSERT INTO sesiones(plataforma, datos, actualizado_en) VALUES($1, $2, now())
     ON CONFLICT (plataforma) DO UPDATE SET datos = EXCLUDED.datos, actualizado_en = now()`,
    [plataforma, cifrar(JSON.stringify(estado))]
  );
}

export async function cargarSesion(plataforma) {
  const { rows: [r] } = await q("SELECT datos FROM sesiones WHERE plataforma=$1", [plataforma]);
  if (!r) return null;
  try { return JSON.parse(descifrar(r.datos)); }
  catch { throw new Error(`No pude descifrar la sesión de ${plataforma} (¿cambió MASTER_KEY o SESSION_KEY?). Vuelve a subirla.`); }
}

export async function tieneSesion(plataforma) {
  const { rows } = await q("SELECT 1 FROM sesiones WHERE plataforma=$1", [plataforma]);
  return rows.length > 0;
}

export const borrarSesion = plataforma => q("DELETE FROM sesiones WHERE plataforma=$1", [plataforma]);
export const listarSesiones = () => q("SELECT plataforma, actualizado_en, ultimo_test, test_ok, test_detalle FROM sesiones");
export const marcarTest = (plataforma, ok, detalle) =>
  q("UPDATE sesiones SET ultimo_test=now(), test_ok=$2, test_detalle=$3 WHERE plataforma=$1", [plataforma, ok, String(detalle || "").slice(0, 300)]);
