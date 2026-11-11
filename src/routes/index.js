import { Router } from 'express';
import healthRoutes from './health.js';
import statusRoutes from './status.js';

const router = Router();

router.get('/', (req, res) => {
  res.status(200).json({
    ok: true,
    name: 'ClipLab Pro API',
    version: '0.1.0',
    endpoints: ['/health', '/api/status'],
  });
});

router.use(healthRoutes);
router.use('/api', statusRoutes);

export default router;
