import path from "node:path";
import { Router } from "express";
import { normalizarRedes, ErrorRed, REDES, etiquetaRed } from "../utils/plataformas.js";
import { programador } from "../engine/programador.js";
import { publicarClip, REDES_SOPORTADAS } from "../engine/publicador.js";
import { adaptarCopyPorRed } from "../engine/marketing.js";
import { almacenRedis } from "../storage/redis-programador.js";
import { store } from "../storage/store.js";
import { config } from "../config/index.js";
import { requireMasterKey } from "../middleware/auth.js";
import { diagnosticar } from "../engine/diagnostico.js";

const TOPE_POR_HORA = Number(process.env.PUBLICADOR_TOPE_HORA) || 2;

class ErrorServicio extends Error {
  constructor(mensaje, status = 500) {
    super(mensaje);
    this.name = "ErrorServicio";
    this.status = status;
  }
}

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const aviso = (...a) => console.warn("[programador]", ...a);

// Estas rutas publican en redes reales: exigen la misma llave maestra que /api/panel.
// Se aplica por prefijo (no a todo el router) para no intervenir en rutas ajenas, p. ej. el 404 de /api/*.
const router = Router();
router.use(["/api/programador", "/api/clips"], requireMasterKey);

function idDe(valor, etiqueta = "id") {
  const s = String(valor ?? "").trim();
  if (!s || s.length > 120) throw new ErrorServicio(`${etiqueta} inválido.`, 400);
  return s;
}

// Exige red explícita (plataformas.js). Sin red -> ErrorRed 400; nunca hay valor por defecto.
function redesDeBody(body) {
  return normalizarRedes(body?.redes ?? body?.red ?? body?.plataformas, { requerida: true });
}

function fechaDeBody(body) {
  const v = body?.fecha ?? body?.programarPara ?? body?.scheduledAt ?? null;
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new ErrorServicio("Fecha inválida. Usa formato ISO, por ejemplo 2026-11-20T15:30:00-04:00.", 400);
  }
  if (d.getTime() < Date.now() - 30_000) throw new ErrorServicio("La fecha ya pasó.", 400);
  return d.toISOString();
}

function mensajeError(e) {
  return String(e?.message || e || "Error desconocido").slice(0, 500);
}

// 200 todo bien · 207 éxito parcial (detalle por red) · 502 todas fallaron.
function codigoLote(resultados) {
  const ok = resultados.filter((r) => r.ok).length;
  if (ok === resultados.length) return 200;
  return ok === 0 ? 502 : 207;
}

// El clip SIEMPRE se lee del store (ficha, transcripción y copy persistidos); el body solo puede retocar texto.
// Nunca se acepta rutaVideo desde el cliente.
function clipDelStore(clipId, body = {}) {
  const guardado = store.buscar(clipId);
  if (!guardado) throw new ErrorServicio(`Clip ${clipId} no encontrado.`, 404);
  if (!["listo", "publicado"].includes(guardado.estado) || !guardado.url) {
    throw new ErrorServicio(`El clip ${clipId} aún no está listo para publicar.`, 409);
  }
  const retoques = body && typeof body.clip === "object" && body.clip ? body.clip : {};
  const f = guardado.ficha || {};
  const m = guardado.marketing || {};
  return {
    ...guardado,
    // Contexto para marketing.js: título/gancho/descripcion reales de la ficha (clip.titulo del store es la URL de origen).
    titulo: retoques.titulo ?? f.titulo ?? m.titulo ?? guardado.titulo ?? "",
    descripcion: retoques.descripcion ?? f.descripcion ?? guardado.copy ?? m.descripcion ?? "",
    gancho: retoques.gancho ?? f.gancho?.frase ?? undefined,
    rutaVideo: path.join(config.clipsDir, path.basename(guardado.url)),
  };
}

async function invalidarCache(clipId) {
  try {
    if (typeof almacenRedis?.invalidarCache === "function") {
      await almacenRedis.invalidarCache("cola*");
      if (clipId) await almacenRedis.invalidarCache(`*${clipId}*`);
    }
  } catch (e) {
    aviso("no se pudo invalidar caché:", e.message);
  }
}

async function leerEstado() {
  await programador.cargar().catch(() => {});
  const e = typeof programador.estado === "function" ? programador.estado() : {};
  const hist = typeof programador.historial === "function" ? programador.historial(1) : [];
  const ultimo = hist[0] || null;
  return {
    activo: Boolean(e.activo),
    ejecutando: Boolean(e.ocupado),
    ultimaEjecucion: ultimo?.fin ?? ultimo?.inicio ?? null,
    ultimoError: ultimo?.error ?? null,
    proximaEjecucion: e.proximaEjecucionMin ?? null,
    tope: e.cupoHorario
      ? {
          porHora: e.cupoHorario.maximo ?? TOPE_POR_HORA,
          usadosUltimaHora: e.cupoHorario.usados ?? 0,
          disponibles: Math.max(0, (e.cupoHorario.maximo ?? TOPE_POR_HORA) - (e.cupoHorario.usados ?? 0)),
        }
      : null,
    enCola: e.enCola ?? 0,
    backend: e.backend ?? null,
  };
}

async function leerCola() {
  await programador.cargar().catch(() => {});
  const items = programador.listar();
  return Array.isArray(items) ? items : [];
}

// { tiktok: { estado: 'activa'|'expirada'|'sin_sesion', ... }, ... }
async function leerCookies() {
  const salida = Object.fromEntries(REDES.map((r) => [r, { estado: "desconocido" }]));
  try {
    const { listarCookiesRedes } = await import("../sesion/cookiesRedes.js");
    for (const x of await listarCookiesRedes()) {
      if (!REDES.includes(x.red)) continue;
      const vencida = x.vence && new Date(x.vence).getTime() < Date.now();
      salida[x.red] = {
        estado: !x.guardada ? "sin_sesion" : vencida ? "expirada" : "activa",
        vence: x.vence ?? null,
        ...(x.error ? { error: x.error } : {}),
      };
    }
  } catch (e) {
    aviso("cookies:", e.message);
  }
  return salida;
}

async function leerRedis() {
  try {
    return typeof almacenRedis?.estado === "function" ? await almacenRedis.estado() : { conectado: false, detalle: "sin estado" };
  } catch (e) {
    return { conectado: false, detalle: mensajeError(e) };
  }
}

async function leerMongo() {
  // Lo que cuenta es el almacen REAL del programador (mongo | json), no una variable suelta: ver config/mongo.js
  try {
    await programador.cargar();
    const e = programador.estado?.() ?? {};
    const m = e.mongo ?? { configurado: false, conectado: false };
    const detalle = m.conectado
      ? "conectado"
      : !m.configurado
        ? "sin URI (define MONGODB_URI o MONGO_URL); respaldo JSON activo"
        : "respaldo JSON activo" + (m.error ? " — " + m.error : "");
    return { ...m, backend: e.backend ?? null, detalle };
  } catch (e) {
    return { configurado: false, conectado: false, detalle: mensajeError(e) };
  }
}

function resultadoDeRed(red, r) {
  const rr = r?.resultados?.[red];
  const ok = Boolean(rr?.ok);
  return { ok, resultado: rr ?? null, error: ok ? null : mensajeError(rr?.error || rr?.detalle || r?.error || "Falló la publicación") };
}

router.get(
  "/api/programador/diagnostico",
  ah(async (req, res) => {
    const quiere = (v) => /^(1|true|si|sí)$/i.test(String(v ?? ""));
    const informe = await diagnosticar({ programador, chromium: quiere(req.query.chromium), almacen: quiere(req.query.almacen) });
    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: informe.ok, data: informe, error: informe.ok ? null : "Hay bloques con problemas: revisa chromium, cola y mongo" });
  })
);

router.post(
  "/api/programador/mongo/reconectar",
  ah(async (req, res) => {
    try {
      const r = await programador.reconectarMongo();
      res.json({ ok: true, ...r, mongo: programador.estado().mongo });
    } catch (e) {
      const status = e?.codigo === "MONGO_NO_CONFIGURADO" ? 400 : 502;
      res.status(status).json({ ok: false, error: mensajeError(e), mongo: programador.estado().mongo });
    }
  })
);

router.get(
  "/api/programador/cola",
  ah(async (req, res) => {
    const [estado, cola, cookiesRedes, redis, mongo] = await Promise.all([leerEstado(), leerCola(), leerCookies(), leerRedis(), leerMongo()]);
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, ...estado, cookiesRedes, redis, mongo, cola, totalCola: cola.length, redesDisponibles: REDES_SOPORTADAS || REDES });
  })
);

router.post(
  "/api/programador/activar",
  ah(async (req, res) => {
    await programador.iniciar();
    await invalidarCache("");
    res.json({ ok: true, ...(await leerEstado()) });
  })
);

router.post(
  "/api/programador/pausar",
  ah(async (req, res) => {
    await programador.detener();
    await invalidarCache("");
    res.json({ ok: true, ...(await leerEstado()) });
  })
);

router.post(
  "/api/clips/:id/publicar-ahora",
  ah(async (req, res) => {
    const clipId = idDe(req.params.id, "id de clip");
    const redes = redesDeBody(req.body);
    const clip = clipDelStore(clipId, req.body);
    const resultados = [];

    for (const red of redes) {
      try {
        const copy = adaptarCopyPorRed({ clip, red });
        const r = await publicarClip(
          { clipId, rutaVideo: clip.rutaVideo, plataformas: [red], descripcion: copy.descripcion, etiquetas: copy.hashtags },
          { modo: req.body?.modo }
        );
        const { ok, resultado, error } = resultadoDeRed(red, r);
        resultados.push({ red, etiqueta: etiquetaRed(red), ok, copy, resultado, ...(ok ? {} : { error }) });
      } catch (e) {
        aviso(`publicar-ahora ${clipId}/${red}:`, e.message);
        resultados.push({ red, etiqueta: etiquetaRed(red), ok: false, error: mensajeError(e) });
      }
    }

    if (resultados.some((r) => r.ok)) {
      store.actualizar(clipId, { estado: "publicado", etapa: "Publicado", publicadoEn: new Date().toISOString() });
    }
    await invalidarCache(clipId);
    res.status(codigoLote(resultados)).json({ ok: resultados.every((r) => r.ok), clipId, resultados });
  })
);

router.post(
  "/api/clips/:id/programar",
  ah(async (req, res) => {
    const clipId = idDe(req.params.id, "id de clip");
    const redes = redesDeBody(req.body);
    const fecha = fechaDeBody(req.body);
    const clip = clipDelStore(clipId, req.body);
    await programador.cargar();   // sin esto, encolar corría sin almacén: "Cannot read properties of null (reading 'tipo')"

    const resultados = [];
    for (const red of redes) {
      try {
        const copy = adaptarCopyPorRed({ clip, red });
        const item = await programador.encolar({
          clipId,
          porRed: true,                       // un trabajo por red, cada uno con su propio copy
          platforms: [red],
          descripcion: copy.descripcion,      // el copy adaptado a ESTA red (antes se perdía y salía el copy genérico)
          etiquetas: copy.hashtags,
          ...(fecha ? { scheduledAt: fecha } : {}),
        });
        resultados.push({ red, etiqueta: etiquetaRed(red), ok: true, copy, item: item ?? null });
      } catch (e) {
        aviso(`programar ${clipId}/${red}:`, e.message);
        resultados.push({ red, etiqueta: etiquetaRed(red), ok: false, error: mensajeError(e) });
      }
    }

    await invalidarCache(clipId);
    res.status(codigoLote(resultados)).json({ ok: resultados.every((r) => r.ok), clipId, fecha, resultados });
  })
);

const STATUS_POR_CODIGO = { NO_ENCONTRADO: 404, EN_CURSO: 409, NO_CANCELABLE: 409, NO_REINTENTABLE: 409 };
async function accionSobreTrabajo(id, accion) {
  await programador.cargar();
  try {
    return await programador[accion](id);
  } catch (e) {
    throw new ErrorServicio(mensajeError(e), STATUS_POR_CODIGO[e?.codigo] ?? 500);
  }
}

router.post(
  "/api/programador/:id/cancelar",
  ah(async (req, res) => {
    const id = idDe(req.params.id, "id de la cola");
    const r = await accionSobreTrabajo(id, "cancelar");
    await invalidarCache(r?.clipId ?? id);
    res.json({ ok: true, id, resultado: r });
  })
);

router.post(
  "/api/programador/:id/reintentar",
  ah(async (req, res) => {
    const id = idDe(req.params.id, "id de la cola");
    const r = await accionSobreTrabajo(id, "reintentar");
    await invalidarCache(r?.clipId ?? id);
    res.json({ ok: true, id, resultado: r });
  })
);

export { ErrorRed };
export default router;
