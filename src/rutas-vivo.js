// API de la Fase 6 (se monta en /api, ya detrás de requireAuth): transmisiones en vivo.
import express from "express";
import { rateLimit } from "./security.js";
import { ErrorHttp } from "./errores.js";
import { PLATAFORMAS } from "./sesiones.js";
import { crearVivo, listarVivos, detalleVivo, detenerVivo } from "./vivo.js";

export const rutasVivo = express.Router();

const ID = /^\d{1,18}$/;
const h = fn => (req, res, next) => fn(req, res).catch(next);
const id = req => { if (!ID.test(req.params.id)) throw new ErrorHttp(404, "No encontrado."); return req.params.id; };

rutasVivo.get("/vivos", h(async (req, res) => res.json(await listarVivos())));

// Cuerpo: { url, plataformas?: ["tiktok",...], auto_puntaje?: 1-100 }
// Sin plataformas, los clips quedan "listos" para revisión manual; con ellas, el mejor clip de cada segmento
// que alcance auto_puntaje se publica solo (con los mismos límites diarios y bloqueos de siempre).
rutasVivo.post("/vivos", rateLimit({ windowMs: 60e3, max: 5 }), h(async (req, res) => {
  const b = req.body || {};
  const plataformas = [...new Set((Array.isArray(b.plataformas) ? b.plataformas : []).filter(p => PLATAFORMAS.includes(p)))];
  res.status(201).json(await crearVivo({ url: b.url, plataformas, autoPuntaje: b.auto_puntaje }));
}));

rutasVivo.get("/vivos/:id", h(async (req, res) => res.json(await detalleVivo(id(req)))));
rutasVivo.post("/vivos/:id/detener", h(async (req, res) => res.json(await detenerVivo(id(req)))));
