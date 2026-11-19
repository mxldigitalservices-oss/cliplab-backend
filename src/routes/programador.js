import { Router } from "express";
import { normalizarRedes, ErrorRed, REDES, etiquetaRed } from "../utils/plataformas.js";
import { programador } from "../engine/programador.js";
import { publicarClip, REDES_SOPORTADAS } from "../engine/publicador.js";
import { adaptarCopyPorRed } from "../engine/marketing.js";
import { almacenRedis } from "../storage/redis-programador.js";

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

function idDe(valor, etiqueta = "id") {
  const s = String(valor ?? "").trim();
  if (!s || s.length > 120) throw new ErrorServicio(`${etiqueta} inválido.`, 400);
  return s;
}

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
  if (d.getTime() < Date.now() - 30_000) {
    throw new ErrorServicio("La fecha ya pasó.", 400);
  }
  return d.toISOString();
}

function mensajeError(e) {
  return String(e?.message || e || "Error desconocido").slice(0, 500);
}

function codigoLote(resultados) {
  const ok = resultados.filter((r) => r.ok).length;
  if (ok === resultados.length) return 200;
  return ok === 0 ? 502 : 207;
}

async function invalidarCache(clipId, accion) {
  try {
    if (typeof almacenRedis?.cacheInvalidar === "function") {
      await almacenRedis.cacheInvalidar(`cola*`);
      if (clipId) await almacenRedis.cacheInvalidar(`*${clipId}*`);
    }
  } catch (e) {
    aviso("no se pudo invalidar caché:", e.message);
  }
}

async function leerEstado() {
  if (typeof programador?.cargar === "function") {
    await programador.cargar().catch(() => {});
  }
  const e = typeof programador?.estado === "function" ? programador.estado() : {};
  const hist = typeof programador?.historial === "function" ? programador.historial(1) : [];
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
    disponible: Boolean(programador),
    raw: e,
  };
}

async function leerCola() {
  if (typeof programador?.cargar === "function") {
    await programador.cargar().catch(() => {});
  }
  const items = typeof programador?.listar === "function" ? programador.listar() : [];
  return Array.isArray(items) ? items : [];
}

async function leerCookies() {
  const salida = Object.fromEntries(REDES.map((r) => [r, "desconocido"]));
  try {
    const mod = await import("../sesion/cookiesRedes.js").catch(() => null);
    const fn = mod?.estadoCookies || mod?.leerEstadoCookies || mod?.cookiesRedes || null;
    if (typeof fn === "function") {
      const r = await fn();
      if (r && typeof r === "object") {
        for (const red of REDES) {
          if (red in r) salida[red] = r[red];
        }
      }
    }
  } catch (e) {
    aviso("cookies:", e.message);
  }
  return salida;
}

async function leerRedis() {
  try {
    if (typeof almacenRedis?.estado === "function") {
      return await almacenRedis.estado();
    }
    return { conectado: false, detalle: "sin estado" };
  } catch (e) {
    return { conectado: false, detalle: mensajeError(e) };
  }
}

async function leerMongo() {
  try {
    const m = (await import("mongoose").catch(() => null))?.default;
    if (!m) return { conectado: false, detalle: "mongoose no disponible" };
    const nombres = ["desconectado", "conectado", "conectando", "desconectando"];
    const n = m.connection?.readyState ?? 0;
    return { conectado: n === 1, detalle: nombres[n] ?? String(n) };
  } catch (e) {
    return { conectado: false, detalle: mensajeError(e) };
  }
}

async function cargarClip(req, clipId) {
  if (typeof req.app?.locals?.obtenerClip === "function") {
    const c = await req.app.locals.obtenerClip(clipId);
    if (c) return c;
  }
  if (typeof programador?.obtener === "function") {
    const job = programador.obtener(clipId);
    if (job?.clip) return job.clip;
  }
  return { id: clipId, titulo: `Clip ${clipId}` };
}

const router = Router();

router.get(
  "/api/programador/cola",
  ah(async (req, res) => {
    const [estado, cola, cookiesRedes, redis, mongo] = await Promise.all([
      leerEstado(),
      leerCola(),
      leerCookies(),
      leerRedis(),
      leerMongo(),
    ]);
    res.json({
      ok: true,
      ...estado,
      cookiesRedes,
      redis,
      mongo,
      cola,
      totalCola: cola.length,
      redesDisponibles: REDES_SOPORTADAS || REDES,
    });
  })
);

router.post(
  "/api/programador/activar",
  ah(async (req, res) => {
    if (typeof programador?.iniciar !== "function") {
      throw new ErrorServicio("programador.iniciar no disponible", 501);
    }
    await programador.iniciar();
    await invalidarCache("", "activar");
    res.json({ ok: true, ...(await leerEstado()) });
  })
);

router.post(
  "/api/programador/pausar",
  ah(async (req, res) => {
    if (typeof programador?.detener !== "function") {
      throw new ErrorServicio("programador.detener no disponible", 501);
    }
    await programador.detener();
    await invalidarCache("", "pausar");
    res.json({ ok: true, ...(await leerEstado()) });
  })
);

router.post(
  "/api/clips/:id/publicar-ahora",
  ah(async (req, res) => {
    const clipId = idDe(req.params.id, "id de clip");
    const redes = redesDeBody(req.body);
    const clipBase = await cargarClip(req, clipId);
    const resultados = [];

    for (const red of redes) {
      try {
        const copy = adaptarCopyPorRed({ clip: clipBase, red });
        const clipParaPublicar = {
          ...clipBase,
          id: clipId,
          plataformas: [red],
          titulo: copy.titulo,
          descripcion: copy.descripcion,
          etiquetas: copy.hashtags,
        };
        const r = await publicarClip(clipParaPublicar, { modo: req.body?.modo });
        const okRed = Boolean(r?.resultados?.[red]?.ok ?? r?.ok);
        const errRed = r?.resultados?.[red]?.error ?? r?.error ?? null;
        resultados.push({
          red,
          etiqueta: etiquetaRed(red),
          ok: okRed,
          copy,
          resultado: r?.resultados?.[red] ?? r ?? null,
          ...(okRed ? {} : { error: mensajeError(errRed || "Falló publicación") }),
        });
      } catch (e) {
        aviso(`publicar-ahora ${clipId}/${red}:`, e.message);
        resultados.push({
          red,
          etiqueta: etiquetaRed(red),
          ok: false,
          error: mensajeError(e),
        });
      }
    }

    await invalidarCache(clipId, "publicar-ahora");
    res.status(codigoLote(resultados)).json({
      ok: resultados.every((r) => r.ok),
      clipId,
      resultados,
    });
  })
);

router.post(
  "/api/clips/:id/programar",
  ah(async (req, res) => {
    const clipId = idDe(req.params.id, "id de clip");
    const redes = redesDeBody(req.body);
    const fecha = fechaDeBody(req.body);
    const clipBase = await cargarClip(req, clipId);

    if (typeof programador?.encolar !== "function") {
      throw new ErrorServicio("programador.encolar no disponible", 501);
    }

    const resultados = [];
    for (const red of redes) {
      try {
        const copy = adaptarCopyPorRed({ clip: clipBase, red });
        const item = await programador.encolar({
          clipId,
          clip: {
            ...clipBase,
            id: clipId,
            titulo: copy.titulo,
            descripcion: copy.descripcion,
            etiquetas: copy.hashtags,
          },
          platforms: [red],
          ...(fecha ? { scheduledAt: fecha } : {}),
        });
        resultados.push({
          red,
          etiqueta: etiquetaRed(red),
          ok: true,
          copy,
          item: item ?? null,
        });
      } catch (e) {
        aviso(`programar ${clipId}/${red}:`, e.message);
        resultados.push({
          red,
          etiqueta: etiquetaRed(red),
          ok: false,
          error: mensajeError(e),
        });
      }
    }

    await invalidarCache(clipId, "programar");
    res.status(codigoLote(resultados)).json({
      ok: resultados.every((r) => r.ok),
      clipId,
      fecha,
      resultados,
    });
  })
);

router.post(
  "/api/programador/:id/cancelar",
  ah(async (req, res) => {
    const id = idDe(req.params.id, "id de la cola");
    if (typeof programador?.cancelar !== "function") {
      throw new ErrorServicio("programador.cancelar no disponible", 501);
    }
    const r = await programador.cancelar(id);
    if (!r) {
      throw new ErrorServicio(`No se encontró el elemento ${id} en la cola.`, 404);
    }
    await invalidarCache(r?.clipId ?? id, "cancelar");
    res.json({ ok: true, id, resultado: r });
  })
);

export { ErrorRed };
export default router;
