import { store } from '../storage/store.js';
import { logger } from '../utils/logger.js';
import { detalleDeError } from '../utils/run.js';
import { PERFIL } from '../agent/perfil.js';
import { PLATAFORMAS_RED, esPlataformaRed, esperarLogin } from './plataformas.js';
import { guardarSesionRed } from './redes.js';
import { errorHttp } from './cookies.js';

// Login manual con un navegador controlado (Playwright) que se abre EN EL SERVIDOR. Solo tiene sentido cuando el
// servidor tiene pantalla (ejecucion local, o DISPLAY / LOGIN_HEADFUL=true). En Railway no hay pantalla ni
// Chromium: ahi la ruta responde con el modo "local" (scripts/login-local.js desde el equipo del usuario).

let enCurso = null;
export const loginEnCurso = () => enCurso;

export function puedeAbrirVentana(env = process.env, so = process.platform) {
  if (env.LOGIN_HEADFUL === 'true') return true;
  if (env.LOGIN_HEADFUL === 'false') return false;
  if (env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID) return false;
  return so === 'darwin' || so === 'win32' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

async function cargarChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    throw errorHttp(501, 'Playwright no esta instalado en el servidor. Ejecuta: npm i --no-save playwright && npx playwright install chromium');
  }
}

/**
 * Abre la ventana de login y devuelve enseguida; la captura de cookies sigue en segundo plano.
 * deps (solo pruebas): { launch, opciones }
 */
export async function iniciarLoginEnServidor(plataforma, deps = {}) {
  if (!esPlataformaRed(plataforma)) throw errorHttp(404, 'Plataforma no soportada: ' + plataforma);
  if (enCurso) throw errorHttp(409, 'Ya hay un inicio de sesion en curso (' + enCurso.plataforma + '). Termina esa ventana primero.');

  let launch = deps.launch;
  if (!launch) {
    const chromium = await cargarChromium();
    launch = chromium.launch.bind(chromium);
  }
  const def = PLATAFORMAS_RED[plataforma];
  enCurso = { plataforma, desde: new Date().toISOString() };
  store.actualizarConexion(plataforma, { conectando: true });

  const tarea = (async () => {
    let browser;
    try {
      browser = await launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
      const contexto = await browser.newContext(PERFIL);
      const pagina = await contexto.newPage();
      await pagina.goto(def.urlLogin, { waitUntil: 'domcontentloaded' });
      const estado = await esperarLogin(contexto, plataforma, deps.opciones);
      await guardarSesionRed(plataforma, estado);
    } catch (error) {
      logger.warn('Login manual no completado', { plataforma, mensaje: error.message });
      store.actualizarConexion(plataforma, { conectando: false });
      store.registrarIncidencia('warn', 'Inicio de sesion en ' + def.nombre + ' no completado: ' + error.message, 'conexiones', detalleDeError(error));
    } finally {
      await browser?.close().catch(() => {});
      enCurso = null;
    }
  })();

  return { modo: 'servidor', plataforma, tarea };
}
