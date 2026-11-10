// API de cookies (se monta en /api, ya detrás de requireAuth). Nunca devuelve valores de cookies.
import express from "express";
import { rateLimit } from "./security.js";
import { ErrorHttp } from "./errores.js";
import { PLATAFORMAS } from "./sesiones.js";
import { estadoCookies, importar, importarTodas, sincronizar } from "./cookies-repo.js";

export const rutasCookies = express.Router();
const h = fn => (req, res, next) => fn(req, res).catch(next);

// Qué archivos hay en cookies/, si son válidos y si ya están importados.
rutasCookies.get("/cookies/estado", h(async (req, res) => res.json(await estadoCookies())));

// { plataforma?: "tiktok", forzar?: true }. Sin plataforma importa las tres. Solo importa si el archivo cambió (salvo forzar).
rutasCookies.post("/cookies/importar", rateLimit({ windowMs: 60e3, max: 10 }), h(async (req, res) => {
  const b = req.body || {};
  const opts = { forzar: b.forzar === true };
  if (b.plataforma !== undefined) {
    if (!PLATAFORMAS.includes(b.plataforma)) throw new ErrorHttp(400, "Plataforma inválida.");
    return res.json([await importar(b.plataforma, opts)]);
  }
  res.json(await importarTodas(opts));
}));

// git fetch de la carpeta cookies/ desde GitHub + importación. Solo funciona si la carpeta está en un clon git autenticado.
rutasCookies.post("/cookies/sincronizar", rateLimit({ windowMs: 60e3, max: 3 }), h(async (req, res) => res.json(await sincronizar())));
