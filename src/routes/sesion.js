import { Router } from 'express';
import { requireMasterKey } from '../middleware/auth.js';
import { obtenerEstado, importar, verificarEnSegundoPlano, borrar } from '../sesion/gestor.js';
import { errorHttp } from '../sesion/cookies.js';

const router = Router();
router.use(requireMasterKey);

const envolver = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

router.get('/', envolver(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, ...(await obtenerEstado()) });
}));

router.post('/', envolver(async (req, res) => {
  const bruto = req.body && req.body.cookies;
  const texto = typeof bruto === 'string' ? bruto : bruto ? JSON.stringify(bruto) : '';
  if (!texto.trim()) throw errorHttp(400, 'Envia las cookies en el campo "cookies".');
  const resultado = await importar(texto);
  res.status(201).json({ ok: true, ...resultado });
}));

router.post('/verificar', envolver(async (req, res) => {
  verificarEnSegundoPlano('manual');
  res.status(202).json({ ok: true, verificando: true });
}));

router.delete('/', envolver(async (req, res) => {
  await borrar();
  res.status(200).json({ ok: true });
}));

export default router;
