import { Router } from 'express';
import { config } from '../config/index.js';
import { checkFfmpeg } from '../engine/ffmpegCheck.js';

const router = Router();

router.get('/status', async (req, res, next) => {
  try {
    const ffmpeg = await checkFfmpeg();
    const memory = process.memoryUsage();

    res.status(200).json({
      ok: true,
      service: 'cliplab-pro',
      env: config.env,
      node: process.version,
      uptime: Math.round(process.uptime()),
      memoryMB: {
        rss: Math.round(memory.rss / 1024 / 1024),
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
      },
      ffmpeg,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
