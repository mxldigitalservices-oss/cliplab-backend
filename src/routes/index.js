import { Router } from 'express';
import healthRoutes from './health.js';
import statusRoutes from './status.js';
import panelRoutes from './panel.js';
import programadorRouter from './programador.js';
import sesionRoutes from './sesion.js';
import cookiesRedesRoutes from './cookies-redes.js';
import loteRoutes from './lote.js';
import envivoRoutes from './envivo.js';
import limpiezaRoutes from './limpieza.js';
import { routerConexiones, routerPublicar } from './instagram.js';
import seriesRoutes from './series.js';

const router = Router();

router.get('/api', (req, res) => {
  res.status(200).json({
    ok: true,
    name: 'ClipLab Pro API',
    version: '0.3.0',
    endpoints: ['/health', '/api/status', '/api/panel/estado', '/api/panel/encolar', '/api/panel/sesion', '/api/panel/cookies-redes', '/api/panel/logo', '/api/panel/lote/aplicar', '/api/panel/envivo/estado', '/api/connections/status', '/api/publish/instagram', '/api/series', '/api/series/cola', '/api/programador/cola'],
  });
});

router.use(healthRoutes);
router.use('/api', statusRoutes);
router.use('/api/panel/sesion', sesionRoutes);
router.use('/api/panel/cookies-redes', cookiesRedesRoutes);
router.use('/api/panel/envivo', envivoRoutes);
router.use('/api/panel/limpieza', limpiezaRoutes);
router.use('/api/connections', routerConexiones);
router.use('/api/publish', routerPublicar);
router.use('/api/series', seriesRoutes);
router.use('/api/panel', loteRoutes);
router.use('/api/panel', panelRoutes);
router.use(programadorRouter);

export default router;
