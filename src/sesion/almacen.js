import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const ARCHIVO_PERFIL = 'perfil.enc';
const ARCHIVO_ESTADO = 'estado.json';

let dirResuelto = null;
let persistente = false;

async function resolverDir() {
  if (dirResuelto) return dirResuelto;

  const candidatos = [config.sessionDir, path.join(config.tmpDir, 'sesion-datos')];
  for (const dir of candidatos) {
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.access(dir, fs.constants.W_OK);
      dirResuelto = dir;
      persistente = !dir.startsWith(config.tmpDir + path.sep);
      if (!persistente) {
        logger.warn('La sesion se guarda en almacenamiento temporal: se perdera al redesplegar. Monta un volumen en Railway o define SESSION_DIR.', { dir });
      }
      return dir;
    } catch (error) {
      logger.warn('Directorio de sesion no escribible', { dir, mensaje: error.message });
    }
  }
  throw new Error('No hay un directorio escribible para guardar la sesion');
}

export async function infoAlmacen() {
  const dir = await resolverDir();
  return { dir, persistente };
}

function derivarClave(sal) {
  if (!config.sessionKey) {
    throw new Error('Falta SESSION_KEY (o MASTER_KEY) para cifrar la sesion');
  }
  return crypto.scryptSync(config.sessionKey, sal, 32);
}

export function cifrar(objeto) {
  const sal = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cifrador = crypto.createCipheriv('aes-256-gcm', derivarClave(sal), iv);
  const datos = Buffer.concat([cifrador.update(JSON.stringify(objeto), 'utf8'), cifrador.final()]);
  return JSON.stringify({
    v: 1,
    sal: sal.toString('base64'),
    iv: iv.toString('base64'),
    tag: cifrador.getAuthTag().toString('base64'),
    datos: datos.toString('base64'),
  });
}

export function descifrar(texto) {
  const paquete = JSON.parse(texto);
  if (paquete.v !== 1) throw new Error('Version de perfil no soportada');
  const descifrador = crypto.createDecipheriv(
    'aes-256-gcm',
    derivarClave(Buffer.from(paquete.sal, 'base64')),
    Buffer.from(paquete.iv, 'base64')
  );
  descifrador.setAuthTag(Buffer.from(paquete.tag, 'base64'));
  const plano = Buffer.concat([descifrador.update(Buffer.from(paquete.datos, 'base64')), descifrador.final()]);
  return JSON.parse(plano.toString('utf8'));
}

async function escribirAtomico(ruta, contenido) {
  const temporal = ruta + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  await fs.writeFile(temporal, contenido, { mode: 0o600 });
  await fs.rename(temporal, ruta);
}

export async function guardarPerfil(perfil) {
  const dir = await resolverDir();
  await escribirAtomico(path.join(dir, ARCHIVO_PERFIL), cifrar(perfil));
}

export async function leerPerfil() {
  const dir = await resolverDir();
  let texto;
  try {
    texto = await fs.readFile(path.join(dir, ARCHIVO_PERFIL), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return descifrar(texto);
  } catch {
    throw new Error('No se pudo descifrar la sesion guardada (cambio SESSION_KEY o MASTER_KEY?). Importa las cookies de nuevo.');
  }
}

export async function leerEstado() {
  const dir = await resolverDir();
  try {
    return JSON.parse(await fs.readFile(path.join(dir, ARCHIVO_ESTADO), 'utf8'));
  } catch {
    return null;
  }
}

export async function guardarEstado(estado) {
  const dir = await resolverDir();
  await escribirAtomico(path.join(dir, ARCHIVO_ESTADO), JSON.stringify(estado, null, 2));
}

export async function borrarTodo() {
  const dir = await resolverDir();
  await fs.rm(path.join(dir, ARCHIVO_PERFIL), { force: true });
  await fs.rm(path.join(dir, ARCHIVO_ESTADO), { force: true });
}
