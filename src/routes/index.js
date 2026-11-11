import { Router } from 'express';
import healthRoutes from './health.js';
import statusRoutes from './status.js';
import panelRoutes from './panel.js';

const router = Router();

router.get('/api', (req, res) => {
  res.status(200).json({
    ok: true,
    name: 'ClipLab Pro API',
    version: '0.2.0',
    endpoints: ['/health', '/api/status', '/api/panel/estado', '/api/panel/encolar'],
  });
});

router.use(healthRoutes);
router.use('/api', statusRoutes);
router.use('/api/panel', panelRoutes);

export default router;
