import { Router } from 'express';
import { requireMasterKey } from '../middleware/auth.js';
import { errorHttp } from '../sesion/cookies.js';
import { PLATAFORMAS_RED, esPlataformaRed } from '../sesion/plataformas.js';
import { guardarSesionRed } from '../sesion/redes.js';
import { iniciarLoginEnServidor, puedeAbrirVentana } from '../sesion/login-servidor.js';

const router = Router();
router.use(requireMasterKey);

const envolver = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function validarPlataforma(req) {
  if (!esPlataformaRed(req.params.plataforma)) {
    throw errorHttp(404, 'Plataforma no soportada: ' + req.params.plataforma);
  }
  return req.params.plataforma;
}

function baseUrl(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return proto + '://' + req.get('host');
}

// Boton "Iniciar sesion" de la tarjeta.
router.post('/:plataforma/login', envolver(async (req, res) => {
  const plataforma = validarPlataforma(req);
  const def = PLATAFORMAS_RED[plataforma];

  if (puedeAbrirVentana()) {
    await iniciarLoginEnServidor(plataforma);
    res.status(202).json({
      ok: true,
      modo: 'servidor',
      plataforma,
      mensaje: 'Se abrio la ventana de ' + def.nombre + ' en el servidor. Inicia sesion ahi; el panel se actualiza solo.',
    });
    return;
  }

  // Servidor remoto sin pantalla (Railway): la ventana se abre en el equipo de la persona y sube la sesion cifrada.
  res.status(200).json({
    ok: true,
    modo: 'local',
    plataforma,
    mensaje: 'El servidor no tiene pantalla. Ejecuta este comando en tu computadora: abrira ' + def.nombre + ' para que inicies sesion a mano.',
    comando: 'CLIPLAB_URL=' + baseUrl(req) + ' MASTER_KEY=<tu llave> npm run login -- ' + plataforma,
  });
}));

// Recibe el storageState capturado por scripts/login-local.js (o cualquier cliente con la llave).
router.put('/:plataforma', envolver(async (req, res) => {
  const plataforma = validarPlataforma(req);
  const cuerpo = req.body && typeof req.body === 'object' ? req.body : {};
  const resultado = await guardarSesionRed(plataforma, cuerpo.estado || cuerpo);
  res.status(200).json({ ok: true, ...resultado });
}));

export default router;
