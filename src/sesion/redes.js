import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { store } from '../storage/store.js';
import { cifrar, descifrar, infoAlmacen } from './almacen.js';
import { PLATAFORMAS_RED, esPlataformaRed, validarEstado } from './plataformas.js';
import { errorHttp } from './cookies.js';

// Sesiones de Facebook / Instagram / TikTok: se guardan cifradas (AES-256-GCM, la misma clave y el mismo
// SESSION_DIR que la sesion de YouTube) en red-<plataforma>.enc. Nunca viajan al panel: solo su estado.

const archivo = async (plataforma) => path.join((await infoAlmacen()).dir, 'red-' + plataforma + '.enc');

async function escribirAtomico(ruta, contenido) {
  const temporal = ruta + '.' + process.pid + '.tmp';
  await fs.writeFile(temporal, contenido, { mode: 0o600 });
  await fs.rename(temporal, ruta);
}

function marcarActiva(plataforma, { cuenta, expira, guardadoEn }) {
  store.actualizarConexion(plataforma, {
    estado: 'activa',
    conectando: false,
    cuenta: cuenta || null,
    ultimaVerificacion: guardadoEn,
    expiraEn: expira ? new Date(expira * 1000).toISOString() : null,
  });
}

/** Valida y guarda (cifrado) el storageState capturado tras el login manual. Actualiza el panel al instante. */
export async function guardarSesionRed(plataforma, estadoCrudo) {
  if (!esPlataformaRed(plataforma)) throw errorHttp(404, 'Plataforma no soportada: ' + plataforma);
  if (!config.sessionKey) {
    throw errorHttp(503, 'Define SESSION_KEY (o MASTER_KEY) en el servidor para poder cifrar la sesion.');
  }

  const resultado = validarEstado(plataforma, estadoCrudo);
  if (!resultado.ok) throw errorHttp(400, resultado.error);

  const guardadoEn = new Date().toISOString();
  await escribirAtomico(
    await archivo(plataforma),
    cifrar({ plataforma, estado: resultado.estado, cuenta: resultado.cuenta, expira: resultado.expira, guardadoEn })
  );
  marcarActiva(plataforma, { cuenta: resultado.cuenta, expira: resultado.expira, guardadoEn });
  logger.info('Sesion de red social guardada', { plataforma, cookies: resultado.estado.cookies.length });
  return { plataforma, cuenta: resultado.cuenta, guardadoEn, cookies: resultado.estado.cookies.length };
}

/** Sesion descifrada lista para Playwright (storageState); null si no hay. Uso interno del publicador. */
export async function leerSesionRed(plataforma) {
  if (!esPlataformaRed(plataforma)) return null;
  let texto;
  try {
    texto = await fs.readFile(await archivo(plataforma), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return descifrar(texto).estado;
}

/** Al arrancar: las tarjetas reflejan las sesiones ya guardadas (el store es en memoria y empieza en "Sin sesion"). */
export async function restaurarEstadosRedes() {
  if (!config.sessionKey) return;
  for (const plataforma of Object.keys(PLATAFORMAS_RED)) {
    try {
      const texto = await fs.readFile(await archivo(plataforma), 'utf8');
      const sesion = descifrar(texto);
      const vencida = sesion.expira && sesion.expira * 1000 < Date.now();
      if (vencida) {
        store.actualizarConexion(plataforma, { estado: 'expirada', cuenta: sesion.cuenta || null, ultimaVerificacion: sesion.guardadoEn });
      } else {
        marcarActiva(plataforma, sesion);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('No se pudo restaurar la sesion guardada', { plataforma, mensaje: error.message });
      }
    }
  }
}
