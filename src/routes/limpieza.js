import { Router } from 'express';
import { requireMasterKey } from '../middleware/auth.js';
import { store } from '../storage/store.js';
import { seleccionarParaLimpiar, ErrorLimpieza } from '../limpieza.js';

// Limpieza de la bandeja: archivar (no borrar) clips ya descargados o procesados, y deshacerlo.
export function crearRouterLimpieza({ almacen = store } = {}) {
  const router = Router();
  router.use(requireMasterKey);

  const responder = (res, next, error) => {
    if (error instanceof ErrorLimpieza) return res.status(error.status).json({ ok: false, error: error.message });
    return next(error);
  };

  router.get('/resumen', (req, res) => {
    const todos = almacen.clipsDonde(() => true);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      descargados: seleccionarParaLimpiar(todos, 'descargados').length,
      procesados: seleccionarParaLimpiar(todos, 'procesados').length,
      archivados: todos.filter((c) => c.archivadoEn).length,
    });
  });

  router.post('/', (req, res, next) => {
    try {
      const ids = seleccionarParaLimpiar(almacen.clipsDonde(() => true), req.body && req.body.modo);
      res.status(200).json({ ok: true, archivados: almacen.archivar(ids) });
    } catch (error) {
      responder(res, next, error);
    }
  });

  // El panel avisa cuando el usuario pulsa "Exportar/Descargar". Con archivar:true el clip sale de la bandeja de inmediato
  // (el archivo sigue en disco, asi que la descarga en curso no se afecta).
  router.post('/descargado/:id', (req, res) => {
    const clip = almacen.buscar(String(req.params.id));
    if (!clip) return res.status(404).json({ ok: false, error: 'Clip no encontrado' });
    almacen.actualizar(clip.id, { descargadoEn: new Date().toISOString() });
    const archivados = req.body && req.body.archivar === true && (clip.estado === 'listo' || clip.estado === 'publicado')
      ? almacen.archivar([clip.id]) : 0;
    return res.status(200).json({ ok: true, archivados });
  });

  router.post('/restaurar', (req, res) => {
    res.status(200).json({ ok: true, restaurados: almacen.desarchivar() });
  });

  return router;
}

export default crearRouterLimpieza();
