// ---------------------------------------------------------------------------
// Chromium para el publicador: argumentos de lanzamiento y diagnostico.
//
//   --no-sandbox              el contenedor corre como root y no tiene los espacios de nombres que exige el sandbox
//   --disable-dev-shm-usage   /dev/shm en Railway es diminuto (64 MB): Chromium escribe en /tmp en vez de morir con
//                             "Target closed" / "page crashed" al subir un video o abrir varias pestanas
// Misma lista que scripts/check-chromium.mjs (la que valida el build): si cambia una, cambia la otra.
// ---------------------------------------------------------------------------
import fs from 'node:fs/promises';

export const ARGS_CHROMIUM = Object.freeze(['--no-sandbox', '--disable-dev-shm-usage']);

export function rutaChromiumEnv(env = process.env) {
  return env.CHROMIUM_PATH || env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
}

/** Opciones para chromium.launch(). */
export function opcionesLanzamiento(env = process.env) {
  return { headless: true, executablePath: rutaChromiumEnv(env), args: [...ARGS_CHROMIUM] };
}

const conTiempo = (promesa, ms, mensaje) => {
  let t;
  const limite = new Promise((_, rechazar) => { t = setTimeout(() => rechazar(new Error(mensaje)), ms); });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(t));
};

/** Espacio libre en /dev/shm en MB (null si el sistema no lo permite). */
export async function espacioShmMb() {
  try {
    const s = await fs.statfs('/dev/shm');
    return { libreMb: Math.round((s.bavail * s.bsize) / 1048576), totalMb: Math.round((s.blocks * s.bsize) / 1048576) };
  } catch {
    return null;
  }
}

/**
 * Comprueba de verdad que Chromium arranca: importa playwright-core, localiza el ejecutable, lo lanza con los mismos
 * argumentos que el publicador, abre una pagina en blanco y lo cierra. Nunca lanza: devuelve { ok, ... , error }.
 * @param {{ importar?: () => Promise<object>, lanzar?: boolean, timeoutMs?: number, env?: object }} [o]
 */
export async function diagnosticarChromium({ importar = () => import('playwright-core'), lanzar = true, timeoutMs = 25000, env = process.env } = {}) {
  const salida = { ok: false, paquete: false, ejecutable: null, ejecutableExiste: false, version: null, args: [...ARGS_CHROMIUM], browsersPath: env.PLAYWRIGHT_BROWSERS_PATH || null, shm: await espacioShmMb(), ms: null, error: null };
  const inicio = Date.now();
  let navegador = null;
  try {
    const modulo = await importar();
    const chromium = modulo.chromium || (modulo.default && modulo.default.chromium);
    if (!chromium) throw new Error('playwright-core no expone chromium');
    salida.paquete = true;
    salida.ejecutable = rutaChromiumEnv(env) || chromium.executablePath();
    await fs.access(salida.ejecutable);
    salida.ejecutableExiste = true;
    if (!lanzar) { salida.ok = true; return salida; }
    navegador = await conTiempo(chromium.launch(opcionesLanzamiento(env)), timeoutMs, 'Chromium no arranco en ' + timeoutMs + ' ms');
    salida.version = navegador.version();
    const pagina = await conTiempo(navegador.newPage(), timeoutMs, 'Chromium no abrio una pagina en ' + timeoutMs + ' ms');
    await conTiempo(pagina.goto('about:blank'), timeoutMs, 'about:blank no cargo');
    salida.ok = true;
  } catch (error) {
    salida.error = String(error && error.message ? error.message : error).split('\n')[0].slice(0, 300);
    if (salida.paquete && !salida.ejecutableExiste) salida.error += ' (no hay Chromium en esa ruta: revisa PLAYWRIGHT_BROWSERS_PATH y el paso "playwright-core install" del Dockerfile)';
  } finally {
    if (navegador) await Promise.resolve(navegador.close()).catch(() => {});
    salida.ms = Date.now() - inicio;
  }
  return salida;
}
