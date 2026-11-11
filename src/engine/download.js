import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { run, ComandoError } from '../utils/run.js';
import { parsearUrlYoutube } from '../utils/youtube.js';

const FORMATO = 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b';
const TIMEOUT_MS = 20 * 60 * 1000;
const PREFIJO_PROGRESO = 'PROGRESO';

function explicarError(error) {
  if (!(error instanceof ComandoError)) return error;

  const stderr = String(error.stderr || '');
  if (/confirm you.re not a bot|Sign in to confirm/i.test(stderr)) {
    return new Error('YouTube pidio verificacion anti-bot. Configura YTDLP_COOKIES con un archivo de cookies de una sesion valida.');
  }

  const detalle = stderr.trim().split('\n').filter(Boolean).pop() || error.message;
  return new Error('Fallo la descarga: ' + detalle);
}

export async function descargarVideo(url, directorio, opciones = {}) {
  const parsed = parsearUrlYoutube(url);
  if (!parsed) {
    throw new Error('URL de YouTube invalida');
  }

  await fs.mkdir(directorio, { recursive: true });

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-colors',
    '--restrict-filenames',
    '--js-runtimes', 'node',
    '--concurrent-fragments', '4',
    '--retries', '3',
    '--socket-timeout', '20',
    '--match-filter', 'duration<=' + config.maxVideoSeconds,
    '-f', FORMATO,
    '--merge-output-format', 'mp4',
    '--progress',
    '--newline',
    '--progress-template', 'download:' + PREFIJO_PROGRESO + ' %(progress._percent_str)s',
    '-o', path.join(directorio, '%(id)s.%(ext)s'),
    '--print', 'after_move:%(id)s|%(duration)s|%(filepath)s|%(title)s',
  ];

  if (path.isAbsolute(config.ffmpegPath)) {
    args.push('--ffmpeg-location', config.ffmpegPath);
  }
  if (config.ytdlpCookies) {
    args.push('--cookies', config.ytdlpCookies);
  }
  args.push('--', parsed.toString());

  let maximo = 0;
  const alLinea = (linea) => {
    if (!opciones.onProgreso) return;
    const coincidencia = new RegExp(PREFIJO_PROGRESO + '\\s+([\\d.]+)%').exec(linea);
    if (!coincidencia) return;
    const fraccion = Math.min(1, Number(coincidencia[1]) / 100);
    if (fraccion > maximo) {
      maximo = fraccion;
      opciones.onProgreso(fraccion);
    }
  };

  let resultado;
  try {
    resultado = await run(config.ytdlpPath, args, {
      timeoutMs: TIMEOUT_MS,
      signal: opciones.signal,
      onStdoutLine: alLinea,
    });
  } catch (error) {
    throw explicarError(error);
  }

  const linea = resultado.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(PREFIJO_PROGRESO))
    .pop();

  if (!linea) {
    throw new Error('El video no se descargo: supera la duracion maxima permitida o no esta disponible');
  }

  const [id, duracionTexto, archivo, ...resto] = linea.split('|');
  await fs.access(archivo);

  return {
    id,
    duracion: Number(duracionTexto) || null,
    archivo,
    titulo: resto.join('|').trim() || id,
  };
}
