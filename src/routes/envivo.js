import { Router } from 'express';
import { requireMasterKey } from '../middleware/auth.js';
import { store } from '../storage/store.js';
import { gestorEnVivo, ErrorEnVivo, momentoPublico } from '../engine/envivo.js';

const MAX_LISTA = 60;
const MAX_TANDA = 10;

// Panel En Vivo: iniciar/detener la captura, marcar momentos y entregarlos por tandas a "Todos los clips" (#clips).
export function crearRouterEnVivo({ gestor = gestorEnVivo, almacen = store } = {}) {
  const router = Router();
  router.use(requireMasterKey);

  const manejar = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof ErrorEnVivo) return res.status(error.status).json({ ok: false, error: error.message });
      return next(error);
    }
    return undefined;
  };

  const vivos = () => almacen.clipsDonde((c) => c.envivo && !c.archivadoEn);

  router.get('/estado', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, sesion: gestor.estado(), momentos: vivos().slice(0, MAX_LISTA).map(momentoPublico) });
  });

  router.post('/iniciar', manejar(async (req, res) => {
    const cuerpo = req.body || {};
    const opciones = { auto: cuerpo.auto === true };
    if (cuerpo.bloques !== undefined) opciones.bloques = cuerpo.bloques === true;   // modo bloques de 6 min (ENVIVO_BLOQUES=on lo activa por defecto)
    if (cuerpo.cantidad !== undefined) opciones.cantidad = cuerpo.cantidad;   // tope de cortes automaticos de la sesion
    res.status(202).json({ ok: true, sesion: await gestor.iniciar(cuerpo.url, opciones) });
  }));

  router.post('/detener', manejar(async (req, res) => {
    res.status(200).json({ ok: true, sesion: await gestor.detener() });
  }));

  router.post('/marcar', manejar(async (req, res) => {
    const momento = await gestor.marcar({ segundosAtras: req.body && req.body.segundos, origen: 'manual' });
    res.status(201).json({ ok: true, momento });
  }));

  router.post('/auto', manejar(async (req, res) => {
    const cuerpo = req.body || {};
    const sesion = cuerpo.cantidad !== undefined
      ? gestor.configurarAuto(Boolean(cuerpo.activo), { cantidad: cuerpo.cantidad })
      : gestor.configurarAuto(Boolean(cuerpo.activo));
    res.status(200).json({ ok: true, sesion });
  }));

  // Entrega una tanda (por defecto 5) de momentos ya listos a "Todos los clips": quedan marcados como enviados.
  router.post('/tanda', manejar(async (req, res) => {
    const cuerpo = req.body || {};
    const n = Math.min(MAX_TANDA, Math.max(1, Math.floor(Number(cuerpo.cantidad)) || 5));
    const permitidos = Array.isArray(cuerpo.ids) ? new Set(cuerpo.ids.map(String)) : null;
    const elegidos = vivos().filter((c) => c.estado === 'listo' && !c.enviadoEn && (!permitidos || permitidos.has(c.id))).reverse().slice(0, n);
    const marca = new Date().toISOString();
    for (const c of elegidos) almacen.actualizar(c.id, { enviadoEn: marca });
    res.status(200).json({ ok: true, enviados: elegidos.map((c) => c.id) });
  }));

  return router;
}

export default crearRouterEnVivo();
