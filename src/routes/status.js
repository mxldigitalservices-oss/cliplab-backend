import { Router } from 'express';
import { config } from '../config/index.js';
import { verificarHerramientas } from '../engine/herramientas.js';

const router = Router();

router.get('/status', async (req, res, next) => {
  try {
    const herramientas = await verificarHerramientas();
    const memory = process.memoryUsage();

    res.status(200).json({
      ok: true,
      service: 'cliplab-pro',
      env: config.env,
      node: process.version,
      uptime: Math.round(process.uptime()),
      cpuThreads: config.cpuThreads,
      memoryMB: {
        rss: Math.round(memory.rss / 1024 / 1024),
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
      },
      herramientas,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
