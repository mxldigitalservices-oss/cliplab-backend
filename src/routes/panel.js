import { Router } from 'express';
import { requireMasterKey } from '../middleware/auth.js';
import { store } from '../storage/store.js';

const router = Router();

const HOSTS_YOUTUBE = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];

router.use(requireMasterKey);

router.get('/estado', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, ...store.snapshot() });
});

router.post('/encolar', (req, res) => {
  const entrada = typeof req.body?.url === 'string' ? req.body.url.trim() : '';

  let parsed;
  try {
    parsed = new URL(entrada);
  } catch {
    res.status(400).json({ ok: false, error: 'El enlace no es una URL valida' });
    return;
  }

  const protocoloValido = parsed.protocol === 'https:' || parsed.protocol === 'http:';
  const hostValido = HOSTS_YOUTUBE.includes(parsed.hostname.toLowerCase());

  if (!protocoloValido || !hostValido) {
    res.status(400).json({ ok: false, error: 'Solo se aceptan enlaces de YouTube' });
    return;
  }

  const clip = store.encolar(parsed.toString());
  res.status(201).json({ ok: true, clip });
});

export default router;
