import { Router } from 'express';
import { requireMasterKey } from '../middleware/auth.js';
import { errorHttp } from '../sesion/cookies.js';
import { listar, importar, verificar, quitar } from '../sesion/redes.js';

const router = Router();
router.use(requireMasterKey);

const envolver = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const sinCache = (res) => res.set('Cache-Control', 'no-store');

router.get('/', envolver(async (req, res) => {
  sinCache(res);
  res.status(200).json({ ok: true, ...(await listar()) });
}));

router.post('/:plataforma', envolver(async (req, res) => {
  const bruto = req.body && req.body.cookies;
  const texto = typeof bruto === 'string' ? bruto : bruto ? JSON.stringify(bruto) : '';
  if (!texto.trim()) throw errorHttp(400, 'Envia las cookies en el campo "cookies".');
  sinCache(res);
  res.status(201).json({ ok: true, ...(await importar(req.params.plataforma, texto)) });
}));

router.post('/:plataforma/verificar', envolver(async (req, res) => {
  sinCache(res);
  res.status(200).json({ ok: true, ...(await verificar(req.params.plataforma)) });
}));

router.delete('/:plataforma', envolver(async (req, res) => {
  sinCache(res);
  res.status(200).json({ ok: true, ...(await quitar(req.params.plataforma)) });
}));

export default router;
