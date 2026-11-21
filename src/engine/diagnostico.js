// ---------------------------------------------------------------------------
// Diagnostico del publicador: una sola respuesta con todo lo que hace falta para saber si "Programar y Publicar"
// esta operativo en produccion (despliegue, Chromium, MongoDB/cola y sesiones de cada red).
// Nunca lanza: cada bloque trae su propio { ok, error }. Sin secretos: las URIs salen enmascaradas.
// ---------------------------------------------------------------------------
import { diagnosticarChromium } from './chromium.js';

let chromiumEnCurso = null; // una sola prueba de Chromium a la vez: lanzar varios navegadores a la vez agota la RAM

const comoError = (e) => String(e && e.message ? e.message : e).slice(0, 300);

/** Estado de la sesion de cada red (sin mostrar cookies). */
export async function estadoSesiones({ importar = () => import('../sesion/cookiesRedes.js') } = {}) {
  const salida = {};
  try {
    const { listarCookiesRedes } = await importar();
    for (const x of await listarCookiesRedes()) {
      const vencida = Boolean(x.vence) && new Date(x.vence).getTime() < Date.now();
      salida[x.red] = { estado: !x.guardada ? 'sin_sesion' : vencida ? 'expirada' : 'activa', vence: x.vence ?? null, ...(x.error ? { error: comoError(x.error) } : {}) };
    }
  } catch (error) {
    return { error: comoError(error) };
  }
  return salida;
}

/**
 * @param {{ programador: object, chromium?: boolean, almacen?: boolean, env?: object, probarChromium?: Function }} o
 *   chromium: lanza Chromium de verdad (tarda unos segundos); almacen: prueba de escritura/lectura en Mongo o JSON.
 */
export async function diagnosticar({ programador, chromium = false, almacen = false, env = process.env, probarChromium = diagnosticarChromium } = {}) {
  const informe = {
    despliegue: {
      commit: env.RAILWAY_GIT_COMMIT_SHA ? String(env.RAILWAY_GIT_COMMIT_SHA).slice(0, 7) : null,
      rama: env.RAILWAY_GIT_BRANCH || null,
      entorno: env.RAILWAY_ENVIRONMENT_NAME || null,
      node: process.version,
      uptimeSeg: Math.round(process.uptime()),
      publicadorModo: env.PUBLICADOR_MODO || 'real',
    },
    chromium: null,
    cola: null,
    mongo: null,
    sesiones: null,
    ok: false,
  };

  // Chromium
  try {
    if (chromium) {
      chromiumEnCurso ||= probarChromium({ lanzar: true }).finally(() => { chromiumEnCurso = null; });
      informe.chromium = await chromiumEnCurso;
    } else {
      informe.chromium = await probarChromium({ lanzar: false });
      informe.chromium.nota = 'Solo se comprobo el paquete y el ejecutable. Anade ?chromium=1 para lanzarlo de verdad.';
    }
  } catch (error) {
    informe.chromium = { ok: false, error: comoError(error) };
  }

  // Cola y MongoDB
  try {
    await programador.cargar();
    const e = programador.estado();
    informe.mongo = { ...e.mongo, backend: e.backend };
    informe.cola = { backend: e.backend, enCola: e.enCola, activo: e.activo, rutaJson: e.rutaJson };
    if (almacen) {
      try {
        informe.cola.sonda = await programador.sonda();
      } catch (error) {
        informe.cola.sonda = { ok: false, error: comoError(error) };
      }
    }
  } catch (error) {
    informe.cola = { ok: false, error: comoError(error) };
    informe.mongo = { conectado: false, error: comoError(error) };
  }

  informe.sesiones = await estadoSesiones();

  const chromiumOk = Boolean(informe.chromium && informe.chromium.ok);
  const colaOk = Boolean(informe.cola && !informe.cola.error && (!informe.cola.sonda || informe.cola.sonda.ok !== false));
  informe.ok = chromiumOk && colaOk;
  return informe;
}
