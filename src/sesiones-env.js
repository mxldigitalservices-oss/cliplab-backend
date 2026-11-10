// Fase 5 (ajuste): sesiones desde variables de entorno en Base64 (Railway), sin subir archivos.
// Cada plataforma tiene una variable con el JSON de cookies (o un cookies.txt Netscape) codificado en Base64.
// "Activar sesión" valida la variable y la deja cifrada en PostgreSQL (la misma ruta que usa el agente);
// para YouTube deja un cookies.txt que yt-dlp usa al descargar. Nunca se devuelve el valor de las cookies.
import fs from "node:fs/promises";
import { cfg } from "./config.js";
import { ErrorHttp } from "./errores.js";
import { PLATAFORMAS, normalizarSesion, validarSesion, guardarSesion } from "./sesiones.js";

export const CONEXIONES = Object.freeze([...PLATAFORMAS, "youtube"]);
export const NOMBRE_CONEXION = Object.freeze({ tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", youtube: "YouTube" });
const MAX_B64 = 9 * 1024 * 1024;
const YT = { dominio: /(^|\.)(youtube|google)\.com$/, cookies: ["SID", "__Secure-3PSID", "LOGIN_INFO"] };

// Nombres aceptados (el primero es el recomendado).
export const variablesDe = plataforma => {
  const P = String(plataforma).toUpperCase();
  return [`SESION_${P}_B64`, `${P}_SESSION_B64`, `${P}_COOKIES_B64`];
};

function buscarVariable(plataforma, env) {
  for (const nombre of variablesDe(plataforma)) {
    const valor = String(env[nombre] ?? "").trim();
    if (valor) return { nombre, valor };
  }
  return null;
}

// cookies.txt de Netscape (formato de yt-dlp): dominio, subdominios, ruta, seguro, expira, nombre, valor.
export function parsearNetscape(texto) {
  const cookies = [];
  for (const crudo of String(texto).split(/\r?\n/)) {
    let linea = crudo.trim();
    if (!linea) continue;
    let httpOnly = false;
    if (linea.startsWith("#HttpOnly_")) { httpOnly = true; linea = linea.slice(10); }
    else if (linea.startsWith("#")) continue;
    const c = linea.split("\t");
    if (c.length < 7) continue;
    cookies.push({ name: c[5], value: c.slice(6).join("\t"), domain: c[0], path: c[2] || "/", expires: Number(c[4]) || -1, httpOnly, secure: c[3].toUpperCase() === "TRUE", sameSite: "Lax" });
  }
  return cookies;
}

export function aNetscape(cookies) {
  const l = ["# Netscape HTTP Cookie File", "# Generado por ClipLab desde la variable Base64 de Railway", ""];
  for (const c of cookies) {
    const dominio = (c.httpOnly ? "#HttpOnly_" : "") + c.domain;
    l.push([dominio, c.domain.startsWith(".") ? "TRUE" : "FALSE", c.path || "/", c.secure ? "TRUE" : "FALSE", c.expires > 0 ? c.expires : 0, c.name, c.value].join("\t"));
  }
  return l.join("\n") + "\n";
}

// Base64 (o base64url) -> estado de Playwright { cookies, origins }. Lanza Error con mensaje claro y sin datos secretos.
export function decodificarSesion(bruto) {
  let s = String(bruto).trim().replace(/^["']|["']$/g, "").replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  if (!s) throw new Error("La variable está vacía.");
  if (s.length > MAX_B64) throw new Error("La variable es demasiado grande (máximo ~9 MB).");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) throw new Error("El valor no es Base64 válido (revisa que no se haya cortado al pegarlo en Railway).");
  const texto = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").replace(/^\uFEFF/, "").trim();
  if (!texto) throw new Error("El Base64 no contiene datos.");
  let crudo;
  if (texto.startsWith("{") || texto.startsWith("[")) {
    try { crudo = JSON.parse(texto); } catch { throw new Error("El contenido decodificado parece JSON pero está dañado."); }
  } else {
    const cookies = parsearNetscape(texto);
    if (!cookies.length) throw new Error("El contenido decodificado no es JSON de cookies ni un cookies.txt.");
    crudo = cookies;
  }
  return normalizarSesion(crudo);
}

function validarYoutube(estado, ahora) {
  const propias = (estado.cookies || []).filter(c => YT.dominio.test(String(c.domain).replace(/^\./, "")));
  const errores = [], avisos = [];
  if (!propias.length) errores.push("No hay cookies de YouTube/Google en la variable.");
  else {
    const vivas = propias.filter(c => YT.cookies.includes(c.name) && !(c.expires > 0 && c.expires <= ahora));
    if (!vivas.length) errores.push("Faltan las cookies de inicio de sesión de Google (SID / __Secure-3PSID) o ya vencieron.");
    const exp = Math.min(...vivas.filter(c => c.expires > 0).map(c => c.expires));
    if (Number.isFinite(exp) && exp * 1000 - ahora * 1000 < 3 * 86400e3 && !errores.length) avisos.push("La sesión vence en menos de 3 días.");
    return { ok: !errores.length, errores, avisos, expira: Number.isFinite(exp) ? new Date(exp * 1000) : null };
  }
  return { ok: false, errores, avisos, expira: null };
}

const memo = new Map();   // plataforma -> { bruto, estado | error }: no se vuelve a decodificar cada 4 s

// { info, estado } — info nunca incluye valores de cookies.
export function analizarVariable(plataforma, env = process.env, ahora = Date.now() / 1000) {
  const variables = variablesDe(plataforma);
  const base = { plataforma, variable: variables[0], variables, presente: false, valida: false, motivo: null, avisos: [], cookies: 0, expira: null };
  const v = buscarVariable(plataforma, env);
  if (!v) return { info: { ...base, motivo: `No hay variable ${variables[0]} en Railway.` }, estado: null };
  let m = memo.get(plataforma);
  if (!m || m.bruto !== v.valor) {
    m = { bruto: v.valor };
    try { m.estado = decodificarSesion(v.valor); } catch (e) { m.error = e.message; }
    memo.set(plataforma, m);
  }
  const presente = { ...base, variable: v.nombre, presente: true };
  if (m.error) return { info: { ...presente, motivo: m.error }, estado: null };
  const r = plataforma === "youtube" ? validarYoutube(m.estado, ahora) : validarSesion(plataforma, m.estado, ahora);
  return {
    info: { ...presente, valida: r.ok, motivo: r.ok ? null : r.errores.join(" "), avisos: r.avisos, cookies: m.estado.cookies.length, expira: r.expira },
    estado: r.ok ? m.estado : null
  };
}

// Estado de conexión de una plataforma para el panel: "valida" | "invalida" | "sin_variable".
export function conexion({ plataforma, env = process.env, sesionDb = null, ahora = Date.now() }) {
  const { info } = analizarVariable(plataforma, env, ahora / 1000);
  const dbVencida = sesionDb?.expira_en && new Date(sesionDb.expira_en).getTime() <= ahora;
  const pruebaFallo = sesionDb?.test_ok === false;
  let estado, fuente = null, motivo = info.motivo;
  const avisos = [...info.avisos];
  if (info.presente) {
    fuente = "variable";
    estado = info.valida ? "valida" : "invalida";
    if (estado === "valida" && pruebaFallo) { estado = "invalida"; motivo = `La última prueba en el navegador falló${sesionDb.test_detalle ? ": " + sesionDb.test_detalle : "."}`; }
  } else if (sesionDb) {
    fuente = "guardada";
    if (dbVencida) { estado = "invalida"; motivo = "La sesión guardada ya venció."; }
    else if (pruebaFallo) { estado = "invalida"; motivo = `La última prueba falló${sesionDb.test_detalle ? ": " + sesionDb.test_detalle : "."}`; }
    else { estado = "valida"; motivo = null; avisos.push(`No hay variable ${info.variables[0]} en Railway: se usa la sesión guardada.`); }
  } else estado = "sin_variable";
  return {
    plataforma, nombre: NOMBRE_CONEXION[plataforma], variable: info.variable, variables: info.variables, presente: info.presente,
    estado, fuente, motivo, avisos, cookies: info.cookies, expira: info.expira, publicable: plataforma !== "youtube",
    activa: plataforma === "youtube" ? !!cfg.ytCookies : !!sesionDb,
    activadaEn: sesionDb?.actualizado_en ?? null, ultimoTest: sesionDb?.ultimo_test ?? null, testOk: sesionDb?.test_ok ?? null, testDetalle: sesionDb?.test_detalle ?? null
  };
}

export const listarConexiones = ({ filas = [], env = process.env, ahora = Date.now() } = {}) =>
  CONEXIONES.map(p => conexion({ plataforma: p, env, sesionDb: filas.find(f => f.plataforma === p) || null, ahora }));

// "Activar sesión": valida la variable y la deja lista para el agente (o para yt-dlp en YouTube).
export async function activarSesion(plataforma, { env = process.env, ahora = Date.now(), guardar = guardarSesion } = {}) {
  if (!CONEXIONES.includes(plataforma)) throw new ErrorHttp(404, "Plataforma desconocida.");
  const { info, estado } = analizarVariable(plataforma, env, ahora / 1000);
  if (!info.presente) throw new ErrorHttp(400, `No hay variable ${info.variable} en Railway (también acepto ${info.variables.slice(1).join(" y ")}). Defínela con el Base64 de tus cookies y vuelve a intentar.`);
  if (!info.valida) throw new ErrorHttp(400, `La variable ${info.variable} no es válida: ${info.motivo}`);
  if (plataforma === "youtube") {
    const destino = `${cfg.dataDir}/youtube-cookies.txt`;
    await fs.mkdir(cfg.dataDir, { recursive: true });
    await fs.writeFile(destino, aNetscape(estado.cookies), { mode: 0o600 });
    if (!cfg.ytCookies || cfg.ytCookies === destino) cfg.ytCookies = destino;   // yt-dlp lo lee en cada descarga
    return { ok: true, plataforma, cookies: info.cookies, expira: info.expira, avisos: info.avisos, destino: "yt-dlp" };
  }
  await guardar(plataforma, estado, { nueva: true });
  return { ok: true, plataforma, cookies: info.cookies, expira: info.expira, avisos: info.avisos, destino: "agente" };
}
