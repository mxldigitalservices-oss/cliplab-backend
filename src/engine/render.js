import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { run, resumirStderr } from '../utils/run.js';

const MODOS = new Set(['recorte', 'blur']);
const RUTA_SEGURA = /^[A-Za-z0-9_\/.\-]+$/;

function rutaParaFiltro(ruta) {
  if (!RUTA_SEGURA.test(ruta)) {
    throw new Error('Ruta no permitida en el filtro de subtitulos: ' + ruta);
  }
  return ruta;
}

async function existe(ruta) {
  try {
    await fs.access(ruta);
    return true;
  } catch {
    return false;
  }
}

function construirFiltro(modo, subtitulos, fontsDir) {
  const partes = [];
  const salidaVideo = subtitulos ? '[base]' : '[v]';

  if (modo === 'blur') {
    partes.push('[0:v]split=2[a][b]');
    partes.push('[a]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=6:2,scale=1080:1920[fondo]');
    partes.push('[b]scale=w=1080:h=1920:force_original_aspect_ratio=decrease:force_divisible_by=2[frente]');
    partes.push('[fondo][frente]overlay=(W-w)/2:(H-h)/2' + salidaVideo);
  } else {
    partes.push(
      "[0:v]crop=w='min(iw,trunc(ih*9/16/2)*2)':h=ih," +
      'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920' + salidaVideo
    );
  }

  if (subtitulos) {
    let filtro = '[base]ass=filename=' + rutaParaFiltro(subtitulos);
    if (fontsDir) filtro += ':fontsdir=' + rutaParaFiltro(fontsDir);
    partes.push(filtro + '[v]');
  }

  return partes.join(';');
}

export async function renderizarClip(opciones) {
  const { entrada, salida, inicio = 0, duracion, subtitulos = null, modo = 'recorte', onProgreso, signal } = opciones;

  const desde = Number(inicio);
  const largo = Math.min(Number(duracion), config.maxClipSeconds);

  if (!Number.isFinite(desde) || desde < 0) throw new Error('Inicio de clip invalido');
  if (!Number.isFinite(largo) || largo <= 0) throw new Error('Duracion de clip invalida');
  if (!MODOS.has(modo)) throw new Error('Modo de render invalido: ' + modo);
  if (!(await existe(entrada))) throw new Error('No existe el video de entrada');

  await fs.mkdir(path.dirname(salida), { recursive: true });

  const rutaAss = subtitulos ? path.resolve(subtitulos) : null;
  const fontsDir = (await existe(config.fontsDir)) ? path.resolve(config.fontsDir) : null;
  const filtro = construirFiltro(modo, rutaAss, fontsDir);
  const hilos = String(config.cpuThreads);

  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y',
    '-ss', String(desde), '-i', entrada, '-t', String(largo),
    '-filter_complex', filtro,
    '-map', '[v]', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', config.videoPreset, '-crf', String(config.videoCrf),
    '-maxrate', '5000k', '-bufsize', '10000k',
    '-pix_fmt', 'yuv420p', '-fpsmax', '30',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '44100',
    '-threads', hilos, '-filter_complex_threads', hilos,
    '-map_metadata', '-1', '-movflags', '+faststart',
    salida,
  ];

  let ultimo = -1;
  const alLinea = (linea) => {
    const coincidencia = /^out_time_(?:us|ms)=(\d+)$/.exec(linea);
    if (!coincidencia || !onProgreso) return;
    const fraccion = Math.min(1, Number(coincidencia[1]) / 1e6 / largo);
    if (fraccion - ultimo >= 0.02) {
      ultimo = fraccion;
      onProgreso(fraccion);
    }
  };

  try {
    await run(config.ffmpegPath, args, {
      timeoutMs: 15 * 60 * 1000,
      signal,
      onStdoutLine: alLinea,
    });
  } catch (error) {
    await fs.rm(salida, { force: true });
    const detalle = String(error.stderr || '').trim().split('\n').filter(Boolean).pop();
    const fallo = new Error('Fallo el render: ' + (detalle || error.message));
    fallo.detalle = resumirStderr(error.stderr);
    throw fallo;
  }

  if (onProgreso) onProgreso(1);
  const info = await fs.stat(salida);
  return { archivo: salida, bytes: info.size, duracion: largo };
}
