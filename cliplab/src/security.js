// src/security.js — Búnker: acceso, anti-indexación, límites y URLs firmadas.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "cl_session";
const SESION_SEG = 12 * 3600;
const MAX_FALLOS = 10;
const VENTANA_MS = 15 * 60e3;

let MASTER = "";
let SKEY = null;

// Falla cerrada: sin llave maestra el servidor NO arranca.
export function assertConfig() {
  const k = process.env.MASTER_KEY || process.env.API_KEY || "";
  if (k.length < 16) throw new Error("MASTER_KEY ausente o menor de 16 caracteres: el búnker no arranca sin llave maestra.");
  MASTER = k;
  SKEY = createHmac("sha256", k).update("cliplab/v1").digest();
}

const sha = s => createHash("sha256").update(String(s)).digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b));
const sign = s => createHmac("sha256", SKEY).update(s).digest("base64url");

// ---------- Bloqueo por intentos fallidos (por IP) ----------
const fallos = new Map();
setInterval(() => { const t = Date.now(); for (const [ip, f] of fallos) if (f.reset <= t) fallos.delete(ip); }, 60e3).unref();
const bloqueado = ip => { const f = fallos.get(ip); return !!f && f.reset > Date.now() && f.n >= MAX_FALLOS; };
const falla = ip => {
  const t = Date.now();
  let f = fallos.get(ip);
  if (!f || f.reset <= t) f = { n: 0, reset: t + VENTANA_MS };
  f.n++; fallos.set(ip, f);
};

// ---------- Cabeceras: noindex/noarchive en TODAS las respuestas ----------
export function securityHeaders(req, res, next) {
  res.set({
    "X-Robots-Tag": "noindex, noarchive, nosnippet, noimageindex",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cache-Control": "no-store"
  });
  if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000");
  next();
}

// ---------- CORS cerrado: solo orígenes listados en ALLOWED_ORIGIN (coma). "*" se ignora. ----------
export function cors(req, res, next) {
  const permitidos = (process.env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  const o = req.get("origin");
  if (o && permitidos.includes(o)) {
    res.set({
      "Access-Control-Allow-Origin": o,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers": "Content-Type,x-api-key",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Vary": "Origin"
    });
  }
  return req.method === "OPTIONS" ? res.sendStatus(204) : next();
}

// ---------- Límite de peticiones en memoria (sin dependencias) ----------
export function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset <= t) hits.delete(k); }, Math.min(windowMs, 60e3)).unref();
  return (req, res, next) => {
    const t = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.reset <= t) { h = { n: 0, reset: t + windowMs }; hits.set(req.ip, h); }
    if (++h.n > max) {
      res.set("Retry-After", String(Math.ceil((h.reset - t) / 1000)));
      return res.status(429).json({ error: "Demasiadas solicitudes. Espera un momento." });
    }
    next();
  };
}

// ---------- Sesión (cookie firmada, sin estado en servidor) ----------
function leerCookie(req, nombre) {
  for (const p of (req.headers.cookie || "").split(";")) {
    const i = p.indexOf("=");
    if (i > 0 && p.slice(0, i).trim() === nombre) {
      try { return decodeURIComponent(p.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}
const sesionValida = v => {
  const [exp, firma] = String(v).split(".");
  return /^\d{9,12}$/.test(exp || "") && Number(exp) > Date.now() / 1000 && !!firma && same(sign("s:" + exp), firma);
};

export function isAuthed(req) {
  const k = req.get("x-api-key");
  if (k) return same(k, MASTER);
  const c = leerCookie(req, COOKIE);
  return !!c && sesionValida(c);
}

// Middleware de raíz: todo lo que no sea público pasa por aquí.
export function requireAuth(req, res, next) {
  if (bloqueado(req.ip)) return res.status(429).json({ error: "Demasiados intentos fallidos. Espera 15 minutos." });
  if (isAuthed(req)) return next();
  if (req.get("x-api-key")) falla(req.ip);
  res.status(401).json({ error: "Acceso denegado." });
}

// ---------- Login / logout ----------
const CSP_LOGIN = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export function loginPage(res, mensaje = "", status = 200) {
  res.status(status).set("Content-Security-Policy", CSP_LOGIN).type("html").send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,noarchive,nosnippet"><title>Acceso</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1420;color:#e8ecf5;font:16px system-ui,sans-serif}
form{width:min(92vw,340px);display:grid;gap:12px}
h1{margin:0 0 4px;font-size:1.4rem}
input,button{font:inherit;padding:14px;border-radius:10px;border:1px solid #2a3552}
input{background:#171e2e;color:inherit}
button{background:#f5b544;color:#1a1405;border:0;font-weight:600;cursor:pointer}
p{margin:0;color:#f27c6b;min-height:1.2em;font-size:.9rem}
</style></head><body>
<form method="post" action="/auth/login" autocomplete="off">
<h1>ClipLab</h1>
<input type="password" name="key" placeholder="Llave maestra" required autofocus autocomplete="current-password">
<button type="submit">Entrar</button>
<p>${mensaje}</p>
</form></body></html>`);
}

export function login(req, res) {
  if (bloqueado(req.ip)) return loginPage(res, "Demasiados intentos. Espera 15 minutos.", 429);
  const clave = typeof req.body?.key === "string" ? req.body.key : "";
  if (!clave || !same(clave, MASTER)) { falla(req.ip); return res.redirect(303, "/?e=1"); }
  const exp = Math.floor(Date.now() / 1000) + SESION_SEG;
  res.cookie(COOKIE, `${exp}.${sign("s:" + exp)}`, {
    httpOnly: true, sameSite: "strict", secure: req.secure, maxAge: SESION_SEG * 1000, path: "/"
  });
  res.redirect(303, "/");
}

export function logout(req, res) {
  res.clearCookie(COOKIE, { path: "/" });
  res.redirect(303, "/");
}

// ---------- CSP del panel (el HTML usa scripts/estilos en línea y Google Fonts) ----------
export function panelCsp() {
  let extra = "";
  try { if (process.env.PUBLIC_URL) extra = " " + new URL(process.env.PUBLIC_URL).origin; } catch {}
  return "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data: https://i.ytimg.com; media-src 'self'" + extra +
    "; connect-src 'self'" + extra + "; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
}

// ---------- URLs de video firmadas con expiración ----------
export function mediaUrl(base, token, ttl = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  return `${base}/media/${token}.mp4?exp=${exp}&sig=${sign(`m:${token}:${exp}`)}`;
}

export function verifyMedia(token, exp, sig) {
  if (typeof exp !== "string" || typeof sig !== "string" || !/^\d{9,12}$/.test(exp)) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  return same(sign(`m:${token}:${exp}`), sig);
}
