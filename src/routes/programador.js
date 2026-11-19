// Rutas del Publicador/Programador. Se monta SIN prefijo (las rutas ya llevan /api/...):
//   import programadorRouter from "./routes/programador.js";   app.use(programadorRouter);
// NUNCA adivina la red: toda publicación/programación exige `redes` (o `red`) explícita vía plataformas.js.
import { Router } from "express";
import { normalizarRedes, ErrorRed, REDES, etiquetaRed } from "../utils/plataformas.js";

const TOPE_POR_HORA = Number(process.env.PUBLICADOR_TOPE_HORA) || 2;

// ───────────────────────── ADAPTADORES ─────────────────────────
// Único punto a ajustar si los módulos existentes usan otros nombres. Se prueba cada nombre en orden
// (como export nombrado o dentro de `default`). Si falta algo requerido → 501 con mensaje claro, sin tumbar el servidor.
// Convenciones de llamada asumidas:
//   marketing.copy({clip, red}) | copy(clip, red) → string u objeto   (se prueba objeto primero)
//   publicador.publicar({clip, clipId, red, copy}) → resultado
//   programador.programar({clip, clipId, red, copy, fecha}) → item de cola;  cancelar(id);  activar();  pausar();  estado();  cola()
//   redis.invalidar({clipId, accion}) ;  redis.estado() ;  publicador.cookies() → { tiktok: ..., ... }
const ADAPTADORES = {
  programador: {
    ruta: "../engine/programador.js",
    estado: ["estado", "obtenerEstado", "getEstado", "estadoProgramador"],
    activar: ["activar", "iniciar", "encender", "start"],
    pausar: ["pausar", "detener", "apagar", "stop"],
    cola: ["listarCola", "obtenerCola", "cola", "listar", "getCola"],
    programar: ["programar", "encolar", "agendar"],
    cancelar: ["cancelar", "cancelarPublicacion", "quitar"],
    clip: ["obtenerClip", "getClip", "buscarClip", "clipPorId"],
  },
  publicador: {
    ruta: "../engine/publicador.js",
    publicar: ["publicar", "publicarClip", "publicarAhora"],
    cookies: ["estadoCookies", "cookiesRedes", "estadoSesiones", "sesiones"],
    clip: ["obtenerClip", "getClip", "buscarClip", "clipPorId"],
  },
  marketing: {
    ruta: "../engine/marketing.js",
    copy: ["generarCopy", "adaptarCopy", "copyPorRed", "adaptarPorRed", "generarMarketing"],
  },
  redis: {
    ruta: "../storage/redis-programador.js",
    invalidar: ["invalidarCache", "invalidar", "limpiarCache", "invalidateCache"],
    estado: ["estado", "ping", "estadoRedis", "status"],
  },
};

class ErrorServicio extends Error {
  constructor(mensaje, status = 500) { super(mensaje); this.name = "ErrorServicio"; this.status = status; }
}

const cargas = new Map();
function cargar(ruta) {
  if (!cargas.has(ruta)) cargas.set(ruta, import(ruta).catch(() => { cargas.delete(ruta); return null; }));
  return cargas.get(ruta);
}
function buscar(mod, nombres) {
  for (const o of [mod, mod?.default]) {
    for (const n of nombres) if (typeof o?.[n] === "function") return o[n].bind(o);
  }
  return null;
}
async function resolver(grupo, clave, { requerido = true } = {}) {
  const a = ADAPTADORES[grupo];
  const mod = await cargar(a.ruta);
  const fn = mod ? buscar(mod, a[clave]) : null;
  if (!fn && requerido) {
    const donde = a.ruta.replace("../", "src/");
    throw new ErrorServicio(`No se encontró la función ${grupo}.${clave} (${a[clave].join(" | ")}) en ${donde}. Ajusta ADAPTADORES en src/routes/programador.js.`, 501);
  }
  return fn;
}

const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const aviso = (...a) => console.warn("[programador]", ...a);

// ───────────────────────── Utilidades ─────────────────────────
function idDe(valor, etiqueta = "id") {
  const s = String(valor ?? "").trim();
  if (!s || s.length > 120) throw new ErrorServicio(`${etiqueta} inválido.`, 400);
  return s;
}

function redesDeBody(body) {
  // Exige marca explícita; sin red → ErrorRed 400. Nunca usa un valor por defecto.
  return normalizarRedes(body?.redes ?? body?.red ?? body?.plataformas, { requerida: true });
}

function fechaDeBody(body) {
  const v = body?.fecha ?? body?.programarPara ?? null;
  if (v === null || v === undefined || v === "") return null;   // sin fecha → el programador elige el siguiente hueco
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new ErrorServicio("Fecha inválida. Usa formato ISO, por ejemplo 2026-11-20T15:30:00-04:00.", 400);
  if (d.getTime() < Date.now() - 30_000) throw new ErrorServicio("La fecha ya pasó.", 400);
  return d.toISOString();
}

async function cargarClip(req, id) {
  const local = req.app?.locals?.obtenerClip;
  let fn = typeof local === "function" ? local : null;
  fn ||= await resolver("programador", "clip", { requerido: false });
  fn ||= await resolver("publicador", "clip", { requerido: false });
  if (!fn) throw new ErrorServicio("No hay función para cargar clips (obtenerClip). Defínela en ADAPTADORES o en app.locals.obtenerClip.", 501);
  const clip = await fn(id);
  if (!clip) throw new ErrorServicio(`Clip ${id} no encontrado.`, 404);
  return clip;
}

async function copyParaRed(clip, red) {
  const fn = await resolver("marketing", "copy");
  let r = await fn({ clip, red });
  if (r === undefined || r === null) r = await fn(clip, red);
  return r;
}

async function invalidarCache(clipId, accion) {
  try {
    const fn = await resolver("redis", "invalidar", { requerido: false });
    if (fn) await fn({ clipId, accion });
  } catch (e) { aviso("no se pudo invalidar caché:", e.message); }
}

function mensajeError(e) { return String(e?.message || e || "Error desconocido").slice(0, 500); }

function codigoLote(resultados) {
  const ok = resultados.filter(r => r.ok).length;
  if (ok === resultados.length) return 200;
  return ok === 0 ? 502 : 207;
}

async function leerCola() {
  const fn = await resolver("programador", "cola", { requerido: false });
  if (!fn) return [];
  const r = await fn();
  return Array.isArray(r) ? r : Array.isArray(r?.items) ? r.items : Array.isArray(r?.cola) ? r.cola : [];
}

async function leerEstado() {
  const fn = await resolver("programador", "estado", { requerido: false });
  const crudo = fn ? await fn() : null;
  const e = crudo && typeof crudo === "object" ? crudo : {};
  return {
    activo: Boolean(e.activo ?? e.encendido ?? e.running ?? false),
    ejecutando: Boolean(e.ejecutando ?? e.enEjecucion ?? e.busy ?? false),
    ultimaEjecucion: e.ultimaEjecucion ?? e.ultimoRun ?? e.lastRun ?? null,
    ultimoError: e.ultimoError ?? e.lastError ?? null,
    proximaEjecucion: e.proximaEjecucion ?? e.siguiente ?? null,
    tope: e.tope ?? null,
    disponible: Boolean(fn),
  };
}

async function leerCookies() {
  const fn = await resolver("publicador", "cookies", { requerido: false });
  const salida = Object.fromEntries(REDES.map(r => [r, "desconocido"]));
  if (!fn) return salida;
  try {
    const r = await fn();
    if (Array.isArray(r)) { for (const x of r) if (x?.red && REDES.includes(x.red)) salida[x.red] = x.estado ?? x.ok ?? "desconocido"; }
    else if (r && typeof r === "object") { for (const red of REDES) if (red in r) salida[red] = r[red]; }
  } catch (e) { aviso("cookies:", e.message); }
  return salida;
}

async function leerRedis() {
  try {
    const fn = await resolver("redis", "estado", { requerido: false });
    if (!fn) return { conectado: false, detalle: "sin función de estado" };
    const r = await fn();
    if (typeof r === "boolean") return { conectado: r };
    if (typeof r === "string") return { conectado: /^(ok|pong|ready|conectado|connected)$/i.test(r), detalle: r };
    return { conectado: Boolean(r?.conectado ?? r?.ok ?? r?.connected ?? r?.ready), ...(r && typeof r === "object" ? r : {}) };
  } catch (e) { return { conectado: false, detalle: mensajeError(e) }; }
}

async function leerMongo() {
  try {
    const m = (await import("mongoose").catch(() => null))?.default;
    if (!m) return { conectado: false, detalle: "mongoose no disponible" };
    const nombres = ["desconectado", "conectado", "conectando", "desconectando"];
    const n = m.connection?.readyState ?? 0;
    return { conectado: n === 1, detalle: nombres[n] ?? String(n) };
  } catch (e) { return { conectado: false, detalle: mensajeError(e) }; }
}

function calcularTope(estadoTope, cola) {
  if (estadoTope && typeof estadoTope === "object") return estadoTope;
  const haceUnaHora = Date.now() - 3_600_000;
  const usados = cola.filter(i => /^(publicad|ok|exito)/i.test(String(i?.estado ?? "")) &&
    new Date(i?.publicadoEn ?? i?.fecha ?? 0).getTime() >= haceUnaHora).length;
  return { porHora: TOPE_POR_HORA, usadosUltimaHora: usados, disponibles: Math.max(0, TOPE_POR_HORA - usados) };
}

// ───────────────────────── Rutas ─────────────────────────
const router = Router();

router.get("/api/programador/cola", ah(async (req, res) => {
  const [estado, cola, cookiesRedes, redis, mongo] = await Promise.all([leerEstado(), leerCola(), leerCookies(), leerRedis(), leerMongo()]);
  res.json({
    ok: true,
    ...estado,
    tope: calcularTope(estado.tope, cola),
    cookiesRedes,
    redis,
    mongo,
    cola,
    totalCola: cola.length,
    redesDisponibles: REDES,
  });
}));

router.post("/api/programador/activar", ah(async (req, res) => {
  const fn = await resolver("programador", "activar");
  await fn();
  res.json({ ok: true, ...(await leerEstado()) });
}));

router.post("/api/programador/pausar", ah(async (req, res) => {
  const fn = await resolver("programador", "pausar");
  await fn();
  res.json({ ok: true, ...(await leerEstado()) });
}));

router.post("/api/clips/:id/publicar-ahora", ah(async (req, res) => {
  const clipId = idDe(req.params.id, "id de clip");
  const redes = redesDeBody(req.body);            // lanza ErrorRed (400) si falta o es inválida
  const clip = await cargarClip(req, clipId);
  const publicar = await resolver("publicador", "publicar");
  const resultados = [];
  for (const red of redes) {
    try {
      const copy = await copyParaRed(clip, red);
      const resultado = await publicar({ clip, clipId, red, copy });
      resultados.push({ red, etiqueta: etiquetaRed(red), ok: true, resultado: resultado ?? null });
    } catch (e) {
      aviso(`publicar-ahora ${clipId}/${red}:`, e.message);
      resultados.push({ red, etiqueta: etiquetaRed(red), ok: false, error: mensajeError(e) });
    }
  }
  await invalidarCache(clipId, "publicar-ahora");
  res.status(codigoLote(resultados)).json({ ok: resultados.every(r => r.ok), clipId, resultados });
}));

router.post("/api/clips/:id/programar", ah(async (req, res) => {
  const clipId = idDe(req.params.id, "id de clip");
  const redes = redesDeBody(req.body);
  const fecha = fechaDeBody(req.body);
  const clip = await cargarClip(req, clipId);
  const programar = await resolver("programador", "programar");
  const resultados = [];
  for (const red of redes) {
    try {
      const copy = await copyParaRed(clip, red);
      const item = await programar({ clip, clipId, red, copy, fecha });
      resultados.push({ red, etiqueta: etiquetaRed(red), ok: true, item: item ?? null });
    } catch (e) {
      aviso(`programar ${clipId}/${red}:`, e.message);
      resultados.push({ red, etiqueta: etiquetaRed(red), ok: false, error: mensajeError(e) });
    }
  }
  await invalidarCache(clipId, "programar");
  res.status(codigoLote(resultados)).json({ ok: resultados.every(r => r.ok), clipId, fecha, resultados });
}));

router.post("/api/programador/:id/cancelar", ah(async (req, res) => {
  const id = idDe(req.params.id, "id de la cola");
  const cancelar = await resolver("programador", "cancelar");
  const r = await cancelar(id);
  if (r === false || r === null) throw new ErrorServicio(`No se encontró el elemento ${id} en la cola.`, 404);
  await invalidarCache(r?.clipId ?? id, "cancelar");
  res.json({ ok: true, id, resultado: r ?? null });
}));

export { ErrorRed };   // re-export para pruebas
export default router;
