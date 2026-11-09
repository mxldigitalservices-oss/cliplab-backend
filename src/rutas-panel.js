// API de la Fase 5 (se monta en /api, ya detrás de requireAuth): datos del panel de administración.
import express from "express";
import { q } from "./db.js";
import { listarSesiones } from "./sesiones.js";
import { listarConexiones, activarSesion } from "./sesiones-env.js";
import { rateLimit } from "./security.js";
import { estadoLlaves } from "./gemini.js";
import { agenteOcupado } from "./agent/index.js";
import { usoDiscoMb } from "./janitor.js";
import { monitor, listarLotes } from "./lotes.js";
import { instantanea, estadoListo, incidencias, variantesPanel, eventosRecientes, crearCentro } from "./panel.js";

export const rutasPanel = express.Router();

const h = fn => (req, res, next) => fn(req, res).catch(next);
const deps = { consulta: q, monitor, listarLotes, listarSesiones, estadoLlaves, agenteOcupado, discoMb: usoDiscoMb };

const centro = crearCentro({ construir: () => instantanea(deps) });
export const cerrarPanel = () => centro.cerrar();

// Paquete completo (el mismo que viaja por el canal en vivo): útil como respaldo cuando no hay SSE.
rutasPanel.get("/panel/instantanea", h(async (req, res) => res.json(await instantanea(deps))));

// ¿Está el asistente listo para operar? (sesiones, límites diarios, llaves de IA, modo y agente).
rutasPanel.get("/panel/listo", h(async (req, res) => res.json(await estadoListo(deps))));

// Estado de conexión de TikTok, Instagram, Facebook y YouTube según las variables Base64 de Railway.
rutasPanel.get("/panel/conexiones", h(async (req, res) => res.json(listarConexiones({ filas: (await listarSesiones()).rows }))));

// "Activar sesión": valida la variable Base64 de la plataforma y la deja lista (agente / yt-dlp).
rutasPanel.post("/panel/conexiones/:p/activar", rateLimit({ windowMs: 60e3, max: 20 }), h(async (req, res) => {
  const r = await activarSesion(req.params.p);
  const filas = (await listarSesiones()).rows;
  res.json({ ...r, conexion: listarConexiones({ filas }).find(c => c.plataforma === r.plataforma) });
}));

rutasPanel.get("/panel/incidencias", h(async (req, res) => res.json(await incidencias(q))));

// ?estado=activas|historial|todas|<estado>  &limite=1..300
rutasPanel.get("/panel/variantes", h(async (req, res) => res.json(await variantesPanel(q, { estado: req.query.estado, limite: req.query.limite }))));

rutasPanel.get("/panel/eventos", h(async (req, res) => res.json(await eventosRecientes(q, req.query.limite))));

// Canal en vivo (SSE): el navegador usa EventSource con la cookie de sesión.
rutasPanel.get("/panel/stream", (req, res) => {
  if (!centro.suscribir(req, res)) res.status(503).json({ error: "Demasiadas conexiones en vivo abiertas." });
});
