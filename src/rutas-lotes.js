// API de la Fase 4 (se monta en /api, ya detrás de requireAuth): lotes, ciclos, reciclaje y variantes.
import express from "express";
import { q } from "./db.js";
import { rateLimit } from "./security.js";
import { ErrorHttp } from "./errores.js";
import { PLATAFORMAS, tieneSesion } from "./sesiones.js";
import { crearLoteCortes, listarLotes, detalleLote, listarEventos, listarCiclos, monitor, pausarLote, reanudarLote, cancelarLote } from "./lotes.js";
import { crearReciclaje, listarVariantes, cancelarVariante, reprogramarVariante, resolverVariante } from "./variantes.js";

export const rutasLotes = express.Router();

const ID = /^\d{1,18}$/;
const h = fn => (req, res, next) => fn(req, res).catch(next);
const id = (req, nombre = "id") => { if (!ID.test(req.params[nombre])) throw new ErrorHttp(404, "No encontrado."); return req.params[nombre]; };
const lista = v => [...new Set((Array.isArray(v) ? v : []).filter(p => PLATAFORMAS.includes(p)))];

// ----- Monitoreo -----
rutasLotes.get("/lotes/monitor", h(async (req, res) => res.json(await monitor())));
rutasLotes.get("/ciclos", h(async (req, res) => res.json(await listarCiclos())));

// ----- Lotes -----
rutasLotes.get("/lotes", h(async (req, res) => res.json(await listarLotes())));

// Lote de cortes: { nombre?, clip_ids: [1,2,3,...] } (hasta LOTE_MAX_ITEMS). Se procesa en ciclos de 10 a 20.
rutasLotes.post("/lotes", rateLimit({ windowMs: 60e3, max: 10 }), h(async (req, res) => {
  const lote = await crearLoteCortes({ nombre: req.body?.nombre, clipIds: req.body?.clip_ids });
  res.status(201).json(lote);
}));

rutasLotes.get("/lotes/:id", h(async (req, res) => res.json(await detalleLote(id(req)))));
rutasLotes.get("/lotes/:id/eventos", h(async (req, res) => {
  const limite = Math.min(500, Math.max(1, Number(req.query.limite) || 100));
  res.json(await listarEventos(id(req), limite));
}));
rutasLotes.post("/lotes/:id/pausar", h(async (req, res) => res.json(await pausarLote(id(req)))));
rutasLotes.post("/lotes/:id/reanudar", h(async (req, res) => res.json(await reanudarLote(id(req)))));
rutasLotes.post("/lotes/:id/cancelar", h(async (req, res) => res.json(await cancelarLote(id(req)))));

// ----- Reciclaje multi-ángulo -----
// Cuerpo: { cantidad, plataformas: ["tiktok",...], ventanas?: ["09:00-11:00",...], desde?: ISO, separacion_min?: 90,
//           nombre?, variantes?: [{ titulo, gancho, descripcion, cta, hashtags, angulo }] (manuales: sustituyen a la IA) }
rutasLotes.post("/clips/:id/reciclar", rateLimit({ windowMs: 60e3, max: 5 }), h(async (req, res) => {
  const clipId = id(req);
  const b = req.body || {};
  const plataformas = lista(b.plataformas);
  if (!plataformas.length) throw new ErrorHttp(400, "Elige al menos una plataforma.");
  for (const p of plataformas) if (!(await tieneSesion(p))) throw new ErrorHttp(400, `Falta la sesión de ${p}. Súbela en la sección Sesiones.`);
  const r = await crearReciclaje({
    clipId, plataformas, cantidad: b.cantidad, ventanas: Array.isArray(b.ventanas) ? b.ventanas : undefined,
    desde: b.desde, separacionMin: b.separacion_min, nombre: b.nombre, manuales: b.variantes
  });
  res.status(201).json(r);
}));

rutasLotes.get("/clips/:id/variantes", h(async (req, res) => {
  const clipId = id(req);
  const { rows } = await q("SELECT 1 FROM clips WHERE id=$1", [clipId]);
  if (!rows.length) throw new ErrorHttp(404, "Clip no encontrado.");
  res.json(await listarVariantes(clipId));
}));

rutasLotes.post("/variantes/:id/reprogramar", h(async (req, res) => res.json(await reprogramarVariante(id(req), req.body?.programada_para))));
rutasLotes.post("/variantes/:id/cancelar", h(async (req, res) => res.json(await cancelarVariante(id(req)))));
rutasLotes.post("/variantes/:id/resolver", h(async (req, res) => res.json(await resolverVariante(id(req), req.body?.plataforma, req.body?.accion))));
