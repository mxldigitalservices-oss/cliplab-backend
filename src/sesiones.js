// Sesiones persistentes: el estado autenticado (cookies + localStorage) se guarda cifrado en PostgreSQL.
import { q } from "./db.js";
import { cifrar, descifrar } from "./crypto.js";

export const PLATAFORMAS = ["tiktok", "instagram", "facebook"];

// Cookies que prueban que la sesión está abierta en cada plataforma.
const AUTH = {
  tiktok: { dominio: /(^|\.)tiktok\.com$/, cookies: ["sessionid"] },
  instagram: { dominio: /(^|\.)instagram\.com$/, cookies: ["sessionid"] },
  facebook: { dominio: /(^|\.)facebook\.com$/, cookies: ["c_user", "xs"] }
};

const SAMESITE = { strict: "Strict", lax: "Lax", none: "None", no_restriction: "None", unspecified: "Lax" };

function normCookie(c) {
  if (!c || typeof c.name !== "string" || typeof c.value !== "string" || !c.name || typeof c.domain !== "string" || !c.domain) return null;
  const exp = c.session ? -1 : Number(c.expires ?? c.expirationDate ?? -1);
  const sameSite = SAMESITE[String(c.sameSite ?? "unspecified").toLowerCase()] || "Lax";
  return {
    name: c.name, value: c.value, domain: c.domain, path: c.path || "/",
    expires: Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : -1,
    httpOnly: !!c.httpOnly, secure: !!c.secure || sameSite === "None", sameSite
  };
}

// Acepta el estado de Playwright ({cookies, origins}), un arreglo de cookies (exportado con la extensión
// Cookie-Editor / EditThisCookie) o { estado: ... }. Devuelve siempre un storageState válido de Playwright.
export function normalizarSesion(crudo) {
  const base = crudo?.estado ?? crudo;
  const lista = Array.isArray(base) ? base : base?.cookies;
  if (!Array.isArray(lista)) throw new Error("El archivo no parece una sesión: debe ser el JSON de cookies exportado.");
  const cookies = lista.map(normCookie).filter(Boolean);
  if (!cookies.length) throw new Error("El archivo no trae cookies utilizables.");
  const origins = Array.isArray(base?.origins) ? base.origins.filter(o => o && typeof o.origin === "string" && Array.isArray(o.localStorage)) : [];
  return { cookies, origins };
}

// { ok, errores, avisos, expira } — comprueba que existan y no estén vencidas las cookies de autenticación.
export function validarSesion(plataforma, estado, ahora = Date.now() / 1000) {
  const regla = AUTH[plataforma];
  const errores = [], avisos = [];
  if (!regla) return { ok: false, errores: [`Plataforma desconocida: ${plataforma}`], avisos, expira: null };
  const propias = (estado?.cookies || []).filter(c => regla.dominio.test(String(c.domain).replace(/^\./, "")));
  if (!propias.length) errores.push(`No hay cookies de ${plataforma}: exporta la sesión estando dentro de tu cuenta.`);
  let minExp = Infinity;
  for (const nombre of regla.cookies) {
    const c = propias.find(x => x.name === nombre);
    if (!c) { if (propias.length) errores.push(`Falta la cookie "${nombre}": la sesión no está iniciada.`); continue; }
    if (c.expires > 0 && c.expires <= ahora) errores.push(`La cookie "${nombre}" ya venció: inicia sesión de nuevo.`);
    else if (c.expires > 0) minExp = Math.min(minExp, c.expires);
  }
  const expira = Number.isFinite(minExp) ? new Date(minExp * 1000) : null;
  if (expira && !errores.length && expira.getTime() - ahora * 1000 < 3 * 86400e3) avisos.push("La sesión vence en menos de 3 días.");
  return { ok: !errores.length, errores, avisos, expira };
}

// nueva=true (subida manual): borra el resultado de pruebas anteriores. nueva=false (renovación automática
// tras publicar): solo actualiza datos y caducidad.
export async function guardarSesion(plataforma, estado, { nueva = true } = {}) {
  const { expira } = validarSesion(plataforma, estado);
  await q(
    `INSERT INTO sesiones(plataforma, datos, actualizado_en, expira_en) VALUES($1, $2, now(), $3)
     ON CONFLICT (plataforma) DO UPDATE SET datos = EXCLUDED.datos, actualizado_en = now(), expira_en = EXCLUDED.expira_en,
       ultimo_test = CASE WHEN $4 THEN NULL ELSE sesiones.ultimo_test END,
       test_ok = CASE WHEN $4 THEN NULL ELSE sesiones.test_ok END,
       test_detalle = CASE WHEN $4 THEN NULL ELSE sesiones.test_detalle END`,
    [plataforma, cifrar(JSON.stringify(estado)), expira, nueva]
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
export const listarSesiones = () => q("SELECT plataforma, actualizado_en, expira_en, ultimo_test, test_ok, test_detalle FROM sesiones");
export const marcarTest = (plataforma, ok, detalle) =>
  q("UPDATE sesiones SET ultimo_test=now(), test_ok=$2, test_detalle=$3 WHERE plataforma=$1", [plataforma, ok, String(detalle || "").slice(0, 300)]);
// La plataforma pidió iniciar sesión otra vez: el panel lo muestra en rojo hasta que se suba una nueva.
export const marcarVencida = (plataforma, detalle) => marcarTest(plataforma, false, detalle);
