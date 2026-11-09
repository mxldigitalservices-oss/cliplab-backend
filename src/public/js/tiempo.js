// Tiempo real por "canales". Hoy: sondeo adaptativo (pausa si la pestaña está oculta, retroceso si hay errores).
// Fase 6: un canal puede declarar `sse: "/api/vivo/eventos"` y se usa EventSource sin tocar las vistas.
import { api } from "./api.js";

const BASE = {
  estado:  { url: "/estado",        ms: 5000 },
  clips:   { url: "/clips",         ms: 6000 },
  monitor: { url: "/lotes/monitor", ms: 3000 },
  lotes:   { url: "/lotes",         ms: 4000 },
  ciclos:  { url: "/ciclos",        ms: 5000 }
};

const canales = new Map();
const oyentesEstado = new Set();
let conectado = null;

function emitir(ok, msg = "") {
  if (conectado === ok && ok) return;
  conectado = ok;
  oyentesEstado.forEach(f => f(ok, msg));
}

export function alEstado(fn) { oyentesEstado.add(fn); return () => oyentesEstado.delete(fn); }

/** def: { url } | { fetcher: async()=>datos } y opcional { ms, sse } */
export function definirCanal(nombre, def) {
  const c = canales.get(nombre);
  if (c) { c.def = def; return; }
  canales.set(nombre, { def, subs: new Set(), timer: null, fallos: 0, ultimo: undefined, enCurso: false, es: null });
}

export function quitarCanal(nombre) {
  const c = canales.get(nombre);
  if (!c) return;
  detener(c);
  canales.delete(nombre);
}

for (const [n, d] of Object.entries(BASE)) definirCanal(n, d);

function detener(c) {
  clearTimeout(c.timer); c.timer = null;
  if (c.es) { c.es.close(); c.es = null; }
}

function entregar(c, data) {
  c.ultimo = data;
  c.subs.forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
}

async function tick(nombre) {
  const c = canales.get(nombre);
  if (!c || !c.subs.size || c.enCurso) return;
  c.enCurso = true;
  try {
    const d = await (c.def.fetcher ? c.def.fetcher() : api.get(c.def.url));
    c.fallos = 0; emitir(true); entregar(c, d);
  } catch (e) {
    c.fallos++; emitir(false, e.message);
  } finally {
    c.enCurso = false;
    programar(nombre);
  }
}

function programar(nombre) {
  const c = canales.get(nombre);
  if (!c) return;
  clearTimeout(c.timer); c.timer = null;
  if (!c.subs.size || document.hidden || c.es) return;
  const espera = Math.min(30000, (c.def.ms || 5000) * 2 ** Math.min(c.fallos, 3));
  c.timer = setTimeout(() => tick(nombre), espera);
}

function abrirSse(nombre, c) {
  if (!c.def.sse || typeof EventSource === "undefined" || c.es) return !!c.es;
  const es = new EventSource(c.def.sse, { withCredentials: true });
  es.onmessage = ev => { try { emitir(true); entregar(c, JSON.parse(ev.data)); } catch { /* mensaje inválido */ } };
  es.onerror = () => { es.close(); c.es = null; emitir(false, "Flujo en vivo interrumpido"); if (c.def.url || c.def.fetcher) tick(nombre); };
  c.es = es;
  return true;
}

export function suscribir(nombre, fn) {
  const c = canales.get(nombre);
  if (!c) throw new Error("Canal desconocido: " + nombre);
  c.subs.add(fn);
  if (c.ultimo !== undefined) queueMicrotask(() => c.subs.has(fn) && fn(c.ultimo));
  if (!abrirSse(nombre, c) && !c.timer && !c.enCurso) tick(nombre);
  return () => { c.subs.delete(fn); if (!c.subs.size) detener(c); };
}

export function refrescar(...nombres) {
  for (const n of nombres) {
    const c = canales.get(n);
    if (c && c.subs.size && !c.es) { clearTimeout(c.timer); c.timer = null; tick(n); }
  }
}

export const ultimo = nombre => canales.get(nombre)?.ultimo;

document.addEventListener("visibilitychange", () => {
  for (const [n, c] of canales) {
    if (!c.subs.size) continue;
    if (document.hidden) { clearTimeout(c.timer); c.timer = null; }
    else if (!c.es) tick(n);
  }
});
