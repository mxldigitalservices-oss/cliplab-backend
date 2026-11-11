import { Router } from 'express';
import { requireMasterKey } from '../middleware/auth.js';
import { store } from '../storage/store.js';
import { parsearUrlYoutube } from '../utils/youtube.js';

const router = Router();

router.use(requireMasterKey);

router.get('/estado', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, ...store.snapshot() });
});

router.post('/encolar', (req, res) => {
  const parsed = parsearUrlYoutube(req.body && req.body.url);

  if (!parsed) {
    res.status(400).json({ ok: false, error: 'Solo se aceptan enlaces validos de YouTube' });
    return;
  }

  const clip = store.encolar(parsed.toString());
  res.status(201).json({ ok: true, clip });
});

export default router;
