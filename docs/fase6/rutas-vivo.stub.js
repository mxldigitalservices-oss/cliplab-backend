// FASE 6 · esqueleto OPCIONAL de endpoints para transmisiones en vivo y captura en tiempo real.
// NO está montado: la Fase 5 no toca server.js. En la Fase 6 se copia a src/rutas-vivo.js y se monta con:
//     import { rutasVivo } from "./rutas-vivo.js";
//     api.use(rutasVivo);        // junto a api.use(rutasLotes), ya detrás de requireAuth
// El panel (public/js/vistas/vivo.js) ya consume estos contratos y trata el 404 como "Fase 6 no instalada".
import express from "express";

export const rutasVivo = express.Router();

// Regla de oro: todo segmento capturado dura como máximo 60 s (ideal 30–60 s).
export const REGLA_DURACION = { max_seg: 60, ideal_min_seg: 30 };

const snapshot = () => ({ disponible: true, regla: REGLA_DURACION, transmisiones: [], capturas: [] });

rutasVivo.get("/vivo/estado", (req, res) => res.json(snapshot()));

// Flujo SSE (el panel lo usa si en vivo.js se activa `sse: "/api/vivo/eventos"`).
rutasVivo.get("/vivo/eventos", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const enviar = () => res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  enviar();
  const t = setInterval(enviar, 5000);
  req.on("close", () => clearInterval(t));
});
