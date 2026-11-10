// Cookies de sesión desde la carpeta cookies/ (facebook.json, instagram.json, tiktok.json):
//   lectura segura → validación de llaves críticas → importación a las sesiones cifradas de PostgreSQL (sesiones.js),
//   que es lo que ya usa el agente de Playwright. Los valores de las cookies nunca se registran ni se devuelven.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { q } from "./db.js";
import { correr } from "./proc.js";
import { ErrorHttp } from "./errores.js";
import { PLATAFORMAS, normalizarSesion, validarSesion, guardarSesion, cargarSesion, tieneSesion } from "./sesiones.js";

process.env.GIT_TERMINAL_PROMPT ??= "0";   // un git sin credenciales falla rápido en vez de quedarse esperando una contraseña
const MAX_BYTES = 6 * 1048576;

const DOMINIO = {
  facebook: /(^|\.)facebook\.com$/,
  instagram: /(^|\.)instagram\.com$/,
  tiktok: /(^|\.)tiktok\.com$/
};
// Obligatorias: sin ellas la sesión no está iniciada. Opcionales: solo generan aviso.
const CRITICAS = { facebook: ["c_user", "xs"], instagram: ["ds_user_id", "sessionid"], tiktok: ["sessionid"] };
const OPCIONALES = { tiktok: ["msToken"] };   // token anti-bot que rota solo: no prueba que haya sesión, por eso no bloquea

// ---------- Lectura segura ----------

// COOKIES_DIR (acepta "~/") o, por defecto, <proyecto>/cookies junto a src/.
export function dirCookies() {
  const e = process.env.COOKIES_DIR;
  if (e) return path.resolve(e.startsWith("~/") ? path.join(os.homedir(), e.slice(2)) : e);
  return path.resolve(fileURLToPath(new URL("../cookies/", import.meta.url)));
}

// Solo nombres de la lista blanca; el archivo real (tras resolver enlaces) debe quedar dentro de la carpeta.
// Devuelve null si no existe. Los mensajes de error nunca incluyen fragmentos del contenido.
export async function leerArchivo(plataforma) {
  if (!PLATAFORMAS.includes(plataforma)) throw new ErrorHttp(404, "Plataforma desconocida.");
  const dir = dirCookies();
  let base, real;
  try { base = await fs.realpath(dir); real = await fs.realpath(path.join(dir, `${plataforma}.json`)); }
  catch { return null; }
  if (path.dirname(real) !== base) throw new Error(`${plataforma}.json apunta fuera de la carpeta de cookies.`);
  const st = await fs.stat(real);
  if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) throw new Error(`${plataforma}.json: tipo o tamaño no válido.`);
  const texto = await fs.readFile(real, "utf8");
  let json;
  try { json = JSON.parse(texto); } catch { throw new Error(`${plataforma}.json no es un JSON válido.`); }   // el mensaje nativo cita trozos del texto
  return { json, sha: createHash("sha256").update(texto).digest("hex"), mtime: st.mtime };
}

// ---------- Validación ----------

// Suma a validarSesion (vencimiento, dominio) las llaves críticas de cada plataforma.
export function validarCriticas(plataforma, estado, ahora = Date.now() / 1000) {
  const base = validarSesion(plataforma, estado, ahora);
  const errores = [...base.errores], avisos = [...base.avisos];
  const ya = n => errores.some(e => e.includes(`"${n}"`));
  const propias = estado.cookies.filter(c => DOMINIO[plataforma].test(String(c.domain).replace(/^\./, "")));
  for (const n of CRITICAS[plataforma]) {
    const c = propias.find(x => x.name === n);
    if (!c) { if (propias.length && !ya(n)) errores.push(`Falta la cookie crítica "${n}".`); }
    else if (!c.value) errores.push(`La cookie "${n}" está vacía.`);
    else if (c.expires > 0 && c.expires <= ahora && !ya(n)) errores.push(`La cookie "${n}" ya venció.`);
  }
  for (const n of OPCIONALES[plataforma] || [])
    if (!propias.some(x => x.name === n && x.value)) avisos.push(`No hay "${n}": no autentica y se regenera sola, pero ayuda contra bloqueos anti-bot.`);
  return { ok: !errores.length, errores, avisos, expira: base.expira, presentes: [...new Set(propias.map(c => c.name))].sort() };
}

// ---------- Importación a las sesiones cifradas ----------

export async function prepararCookies() {
  await q(`CREATE TABLE IF NOT EXISTS cookies_importadas(
    plataforma text PRIMARY KEY, sha256 text NOT NULL, importado_en timestamptz NOT NULL DEFAULT now())`);
  if (process.env.COOKIES_AUTOIMPORT !== "0") {
    const r = await importarTodas();
    console.log("Cookies:", r.map(x => `${x.plataforma}=${x.estado}`).join(" "));
  }
  if (process.env.COOKIES_GITHUB_TOKEN) {   // GitHub como fuente: se trae al arrancar y luego cada COOKIES_SYNC_MIN minutos
    const log = tag => r => console.log(`Cookies (GitHub${tag}):`, (r.importadas || []).map(x => `${x.plataforma}=${x.estado}`).join(" "));
    await sincronizar().then(log("")).catch(e => console.error("Cookies (GitHub):", e.message));
    const min = Number(process.env.COOKIES_SYNC_MIN ?? 15);
    if (min > 0) setInterval(() => sincronizar().then(log(" auto")).catch(e => console.error("Cookies (GitHub auto):", e.message)), min * 60e3).unref();
  }
}

// Solo importa si el archivo cambió desde la última importación: así un reinicio no pisa cookies más frescas
// que el agente renovó en la base tras publicar (guardarSesion con nueva=false). forzar=true ignora esa guarda.
export async function importar(plataforma, { forzar = false, archivo } = {}) {
  const a = archivo ?? await leerArchivo(plataforma).catch(e => ({ error: e.message }));
  if (!a) return { plataforma, estado: "sin_archivo" };
  if (a.error) return { plataforma, estado: "invalida", errores: [a.error] };
  let estado;
  try { estado = normalizarSesion(a.json); } catch (e) { return { plataforma, estado: "invalida", errores: [e.message] }; }
  const v = validarCriticas(plataforma, estado);
  if (!v.ok) return { plataforma, estado: "invalida", errores: v.errores, avisos: v.avisos };
  const { rows: [prev] } = await q("SELECT sha256 FROM cookies_importadas WHERE plataforma=$1", [plataforma]);
  if (prev?.sha256 === a.sha && !forzar) return { plataforma, estado: "sin_cambios", expira: v.expira, avisos: v.avisos };
  await guardarSesion(plataforma, estado);
  await q(`INSERT INTO cookies_importadas(plataforma, sha256) VALUES($1,$2)
           ON CONFLICT (plataforma) DO UPDATE SET sha256 = EXCLUDED.sha256, importado_en = now()`, [plataforma, a.sha]);
  return { plataforma, estado: "importada", cookies: estado.cookies.length, expira: v.expira, avisos: v.avisos, presentes: v.presentes };
}

export async function importarTodas(opts) {
  const out = [];
  for (const p of PLATAFORMAS) out.push(await importar(p, opts));
  return out;
}

// Diagnóstico sin valores: qué archivos hay, si son válidos y si ya están importados.
export async function estadoCookies() {
  const plataformas = [];
  for (const p of PLATAFORMAS) {
    const a = await leerArchivo(p).catch(e => ({ error: e.message }));
    const f = { plataforma: p, archivo: !!a && !a.error, en_base: await tieneSesion(p) };
    if (a?.error) f.error = a.error;
    else if (a) {
      f.modificado = a.mtime;
      f.sha = a.sha.slice(0, 8);
      try { const v = validarCriticas(p, normalizarSesion(a.json)); Object.assign(f, { valida: v.ok, errores: v.errores, avisos: v.avisos, expira: v.expira, presentes: v.presentes }); }
      catch (e) { f.valida = false; f.errores = [e.message]; }
      const { rows: [prev] } = await q("SELECT sha256 FROM cookies_importadas WHERE plataforma=$1", [p]);
      f.importada = prev?.sha256 === a.sha;
    }
    plataformas.push(f);
  }
  return { carpeta: "cookies/", plataformas };
}

// ---------- Uso en clientes de automatización / peticiones ----------

// storageState listo para browser.newContext({ storageState }) de Playwright (descifrado en memoria).
export async function estadoPlaywright(plataforma) {
  const s = await cargarSesion(plataforma);
  if (!s) throw new ErrorHttp(400, `Falta la sesión de ${plataforma}.`);
  return s;
}

// Cabecera Cookie para peticiones HTTP directas a un host de la plataforma. No la registres en logs.
export async function cookieHeader(plataforma, urlDestino) {
  const s = await estadoPlaywright(plataforma);
  const host = new URL(urlDestino).hostname, ahora = Date.now() / 1000;
  return s.cookies
    .filter(c => { const d = c.domain.replace(/^\./, ""); return !(c.expires > 0 && c.expires <= ahora) && (host === d || host.endsWith("." + d)); })
    .map(c => `${c.name}=${c.value}`).join("; ");
}

// ---------- Sincronización opcional con GitHub ----------

// Lee <plataforma>.json del repo con la API de GitHub (token fine-grained de solo lectura: Contents → Read-only).
// Funciona en Railway porque no necesita .git. El token nunca se registra ni aparece en mensajes de error.
async function bajarDeGithub(plataforma) {
  const repo = process.env.COOKIES_GITHUB_REPO || "mxldigitalservices-oss/cliplab-backend";
  const ruta = (process.env.COOKIES_GITHUB_RUTA || "cliplab/cookies").replace(/^\/+|\/+$/g, "");
  const rama = process.env.COOKIES_GITHUB_RAMA || "main";
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${ruta}/${plataforma}.json?ref=${encodeURIComponent(rama)}`, {
    headers: { Authorization: `Bearer ${process.env.COOKIES_GITHUB_TOKEN}`, Accept: "application/vnd.github.raw+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cliplab" },
    signal: AbortSignal.timeout(20000)
  });
  if (r.status === 404) return null;
  if (r.status === 401 || r.status === 403) throw new Error(`GitHub rechazó el token (${r.status}): revisa que sea válido y tenga Contents: Read-only sobre el repo.`);
  if (!r.ok) throw new Error(`GitHub respondió ${r.status}.`);
  const texto = await r.text();
  if (!texto || texto.length > MAX_BYTES) throw new Error(`${plataforma}.json: tamaño no válido.`);
  let json;
  try { json = JSON.parse(texto); } catch { throw new Error(`${plataforma}.json no es un JSON válido.`); }
  return { json, sha: createHash("sha256").update(texto).digest("hex"), mtime: new Date() };
}

async function sincronizarGithub(importarDespues) {
  const importadas = [];
  for (const p of PLATAFORMAS) {
    try {
      const a = await bajarDeGithub(p);
      importadas.push(a ? (importarDespues ? await importar(p, { archivo: a }) : { plataforma: p, estado: "descargada" }) : { plataforma: p, estado: "sin_archivo" });
    } catch (e) { importadas.push({ plataforma: p, estado: "error", errores: [limpiarMsg(e.message)] }); }
  }
  return { origen: "github", rama: process.env.COOKIES_GITHUB_RAMA || "main", importadas };
}

const limpiarMsg = s => String(s).replace(/(https?:\/\/)[^@\s/]+@/g, "$1***@").split("\n")[0].slice(0, 200);   // sin tokens incrustados en la URL
let enCurso = false;

// Con COOKIES_GITHUB_TOKEN usa la API de GitHub; sin él, git local. Trae de origin SOLO la carpeta cookies/ (fetch + restore de esa ruta): el código desplegado no se toca.
// Requiere que la carpeta esté dentro de un clon git con el remoto ya autenticado (SSH o token). Se niega a
// pisar cambios locales sin subir.
export async function sincronizar({ importarDespues = true } = {}) {
  if (enCurso) throw new ErrorHttp(409, "Ya hay una sincronización en curso.");
  enCurso = true;
  try {
    if (process.env.COOKIES_GITHUB_TOKEN) return await sincronizarGithub(importarDespues);   // modo Railway: API de GitHub
    const dir = dirCookies();
    let top, rama, rel;
    try {
      top = (await correr("git", ["-C", dir, "rev-parse", "--show-toplevel"], 15000)).trim();
      rama = (await correr("git", ["-C", top, "rev-parse", "--abbrev-ref", "HEAD"], 15000)).trim();
      rel = path.relative(top, await fs.realpath(dir));
    } catch {
      throw new ErrorHttp(409, "La carpeta de cookies no está en un repositorio git (o git no está instalado). En Railway el contenedor suele desplegarse sin .git: sube las cookies con PUT /api/sesiones/:plataforma o vuelve a desplegar.");
    }
    if (!rama || rama === "HEAD") throw new ErrorHttp(409, "El repositorio está en HEAD desacoplado: cambia a una rama.");
    if (!rel || rel.startsWith("..")) throw new ErrorHttp(409, "La carpeta de cookies queda fuera del repositorio.");
    try {
      if ((await correr("git", ["-C", top, "status", "--porcelain", "--", rel], 15000)).trim())
        throw new ErrorHttp(409, "Hay cambios locales sin subir en cookies/: súbelos o descártalos antes de sincronizar.");
      await correr("git", ["-C", top, "fetch", "--quiet", "origin", rama], 60000);
      await correr("git", ["-C", top, "restore", "--source=FETCH_HEAD", "--worktree", "--", rel], 30000);
    } catch (e) {
      if (e instanceof ErrorHttp) throw e;
      throw new ErrorHttp(502, `No pude sincronizar con GitHub: ${limpiarMsg(e.message)}`);
    }
    return { rama, importadas: importarDespues ? await importarTodas() : null };
  } finally { enCurso = false; }
}
