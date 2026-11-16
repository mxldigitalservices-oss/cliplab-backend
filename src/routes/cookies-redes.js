import { Router } from 'express';
import { requireMasterKey } from '../middleware/auth.js';
import { errorHttp } from '../sesion/cookies.js';
import { REDES, listarCookiesRedes, guardarCookies, borrarCookies } from '../sesion/cookiesRedes.js';

const router = Router();
router.use(requireMasterKey);

const envolver = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

router.get('/', envolver(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, success: true, redes: await listarCookiesRedes() });
}));

router.post('/:red', envolver(async (req, res) => {
  if (!Object.hasOwn(REDES, req.params.red)) throw errorHttp(404, 'Red no soportada: ' + req.params.red);
  const entrada = req.body ? req.body.cookies : undefined;
  if (entrada === undefined || entrada === null || entrada === '') {
    throw errorHttp(400, 'Pega el JSON de las cookies en el campo "cookies".');
  }
  res.set('Cache-Control', 'no-store');
  res.status(201).json({ ok: true, success: true, red: req.params.red, ...(await guardarCookies(req.params.red, entrada)) });
}));

router.delete('/:red', envolver(async (req, res) => {
  if (!Object.hasOwn(REDES, req.params.red)) throw errorHttp(404, 'Red no soportada: ' + req.params.red);
  await borrarCookies(req.params.red);
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, success: true, red: req.params.red });
}));

export default router;
