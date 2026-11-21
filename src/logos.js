// ---------------------------------------------------------------------------
// Logos / fotos propias para superponer en los clips. Todo local, sin servicios externos.
//   - Se valida el CONTENIDO (bytes magicos PNG/JPEG/WebP), no la extension ni el Content-Type.
//   - Se normaliza a PNG RGBA (max. 1024 px de ancho, sin metadatos) con FFmpeg y se guarda en DATA_DIR/logos.
//   - "Quitar fondo": sin IA. Si las 4 esquinas tienen el mismo color (fondo liso) se genera una copia con ese color
//     transparente (colorkey). Si la imagen ya trae transparencia no hace falta, y si el fondo no es uniforme no se ofrece.
// ---------------------------------------------------------------------------
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { ErrorAjustes, ID_LOGO } from './ajustes.js';

export const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const MAX_LOGOS = 30;
const ANCHO_MAX = 1024;
const TOLERANCIA_FONDO = 36;   // diferencia maxima por canal entre esquinas para considerarlas "el mismo fondo"

export const dirLogos = () => path.join(config.dataDir, 'logos');

const ff = (args, { buffer = false } = {}) => new Promise((ok, no) => {
  execFile(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args],
    { timeout: 30000, maxBuffer: 8 * 1048576, encoding: buffer ? 'buffer' : 'utf8' },
    (error, stdout, stderr) => (error ? no(new Error(String(stderr || error.message).trim().split('\n').pop())) : ok(stdout)));
});

function formatoPorMagia(b) {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

async function pixel(ruta, x, y) {
  const salida = await ff(['-i', ruta, '-vf', 'crop=2:2:' + x + ':' + y, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { buffer: true });
  return { r: salida[0], g: salida[1], b: salida[2], a: salida[3] };
}

async function dimensiones(ruta) {
  const salida = await new Promise((ok, no) => execFile(config.ffprobePath,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', ruta],
    { timeout: 15000 }, (e, out) => (e ? no(e) : ok(String(out).trim()))));
  const [ancho, alto] = salida.split('x').map(Number);
  if (!(ancho > 0 && alto > 0)) throw new Error('sin dimensiones');
  return { ancho, alto };
}

/** Mira las 4 esquinas: transparentes (conAlfa), de un mismo color liso (fondoDetectado) o ninguna de las dos. */
async function analizarFondo(ruta, ancho, alto) {
  const esquinas = await Promise.all([[0, 0], [ancho - 1, 0], [0, alto - 1], [ancho - 1, alto - 1]].map(([x, y]) => pixel(ruta, x, y)));
  if (esquinas.every((p) => p.a < 16)) return { conAlfa: true, fondoDetectado: false, fondoColor: null };
  if (esquinas.some((p) => p.a < 200)) return { conAlfa: false, fondoDetectado: false, fondoColor: null };
  const media = ['r', 'g', 'b'].map((c) => Math.round(esquinas.reduce((s, p) => s + p[c], 0) / 4));
  const uniforme = esquinas.every((p) => Math.abs(p.r - media[0]) <= TOLERANCIA_FONDO && Math.abs(p.g - media[1]) <= TOLERANCIA_FONDO && Math.abs(p.b - media[2]) <= TOLERANCIA_FONDO);
  return {
    conAlfa: false,
    fondoDetectado: uniforme,
    fondoColor: uniforme ? '#' + media.map((v) => v.toString(16).padStart(2, '0')).join('') : null,
  };
}

async function podarLogos() {
  try {
    const nombres = (await fs.readdir(dirLogos())).filter((n) => /^logo_[0-9a-f]{16}\.png$/.test(n));
    const info = [];
    for (const nombre of nombres) info.push({ nombre, t: (await fs.stat(path.join(dirLogos(), nombre))).mtimeMs });
    info.sort((a, b) => b.t - a.t);
    for (const viejo of info.slice(MAX_LOGOS)) await borrarLogo(viejo.nombre.replace('.png', ''));
  } catch { /* sin carpeta aun */ }
}

/** Guarda una imagen subida. Devuelve { id, ancho, alto, conAlfa, fondoDetectado, fondoColor }. Lanza ErrorAjustes (400) si no es valida. */
export async function guardarLogo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ErrorAjustes('Falta la imagen');
  if (buffer.length > MAX_LOGO_BYTES) throw new ErrorAjustes('La imagen supera los ' + MAX_LOGO_BYTES / 1048576 + ' MB');
  const formato = formatoPorMagia(buffer);
  if (!formato) throw new ErrorAjustes('El archivo no es una imagen PNG, JPG o WebP valida');

  await fs.mkdir(dirLogos(), { recursive: true });
  const id = 'logo_' + crypto.randomBytes(8).toString('hex');
  const entrada = path.join(dirLogos(), id + '.entrada.' + (formato === 'jpeg' ? 'jpg' : formato));
  const salida = path.join(dirLogos(), id + '.png');
  try {
    await fs.writeFile(entrada, buffer);
    await ff(['-i', entrada, '-frames:v', '1', '-vf', "scale='min(" + ANCHO_MAX + ",iw)':-2,format=rgba", '-map_metadata', '-1', salida]);
    const { ancho, alto } = await dimensiones(salida);
    const fondo = await analizarFondo(salida, ancho, alto);
    if (fondo.fondoDetectado) {
      const clave = '0x' + fondo.fondoColor.slice(1);
      await ff(['-i', salida, '-vf', 'colorkey=' + clave + ':0.24:0.12,format=rgba', '-map_metadata', '-1', path.join(dirLogos(), id + '.sinfondo.png')]);
    }
    podarLogos().catch(() => {});
    return { id, ancho, alto, ...fondo };
  } catch (error) {
    logger.warn('No se pudo procesar el logo subido', { mensaje: error.message });
    await borrarLogo(id);
    throw new ErrorAjustes('No pude leer la imagen: esta danada o su formato no es compatible');
  } finally {
    await fs.rm(entrada, { force: true });
  }
}

/** Ruta del PNG del logo (con o sin fondo) o null si no existe. El id se valida: nunca arma rutas con texto libre. */
export async function rutaLogo(id, sinFondo = false) {
  if (!ID_LOGO.test(String(id))) return null;
  const ruta = path.join(dirLogos(), id + (sinFondo ? '.sinfondo.png' : '.png'));
  try {
    await fs.access(ruta);
    return ruta;
  } catch {
    return null;
  }
}

export async function borrarLogo(id) {
  if (!ID_LOGO.test(String(id))) return;
  await fs.rm(path.join(dirLogos(), id + '.png'), { force: true });
  await fs.rm(path.join(dirLogos(), id + '.sinfondo.png'), { force: true });
}
