import { Router } from 'express';

const router = Router();

router.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'cliplab-pro',
    uptime: Math.round(process.uptime()),
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ? String(process.env.RAILWAY_GIT_COMMIT_SHA).slice(0, 7) : null,
    timestamp: new Date().toISOString(),
  });
});

export default router;
