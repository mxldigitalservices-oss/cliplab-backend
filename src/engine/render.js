import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { run, stderrCompleto } from '../utils/run.js';
import { analizarCortes, filtroSplit, xRostro } from './sujeto.js';

const MODOS = new Set(['recorte', 'blur']);
const RUTA_SEGURA = /^[A-Za-z0-9_\/.\-]+$/;
const ANCHO = 1080;
const ALTO = 1920;

// Solo presets ligeros de x264: la instancia de Railway no tiene GPU y comparte CPU con whisper y el seguimiento de rostros.
const PRESETS_LIGEROS = ['ultrafast', 'superfast', 'veryfast', 'faster'];
let avisoPreset = false;

/** Devuelve el preset pedido si es ligero; cualquier otro (medium, slow...) se baja a veryfast. */
export function presetLigero(valor) {
  const preset = String(valor || '').trim().toLowerCase();
  if (PRESETS_LIGEROS.includes(preset)) return preset;
  if (!avisoPreset) {
    avisoPreset = true;
    logger.warn('VIDEO_PRESET demasiado pesado para CPU compartida: se usa veryfast', { pedido: valor });
  }
  return 'veryfast';
}

let avisoLogoEmitido = false;

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

/** Devuelve la ruta del logo a estampar, o null si no hay logo (desactivado o archivo ausente). */
async function resolverLogo(opcion) {
  if (opcion === false) return null;
  if (opcion === undefined && !config.logoEnabled) return null;

  const ruta = typeof opcion === 'string' ? opcion : config.logoPath;
  if (await existe(ruta)) return ruta;

  if (!avisoLogoEmitido) {
    avisoLogoEmitido = true;
    logger.warn('Logo no encontrado: los clips se generan sin marca de agua', { ruta });
  }
  return null;
}

function posicionLogo(posicion, margen) {
  const m = String(margen);
  const x = posicion.endsWith('left') ? m : 'W-w-' + m;
  const y = posicion.startsWith('top') ? m : 'H-h-' + m;
  return x + ':' + y;
}

// Cadena de etapas: base (9:16) -> logo (opcional) -> subtitulos (opcional). La ultima etapa se llama [v].
function construirFiltro({ modo, subtitulos, fontsDir, logo, cortes }) {
  const salidas = ['base'];
  if (logo) salidas.push('marca');
  if (subtitulos) salidas.push('subs');
  salidas[salidas.length - 1] = 'v';

  let n = 0;
  const salida = () => '[' + salidas[n] + ']';
  const entrada = () => '[' + salidas[n - 1] + ']';
  const partes = [];

  if (cortes && cortes.length > 0) {
    // Edicion con ritmo: cada tramo se recorta, se encuadra (medio o cerrado) y todo se concatena.
    const etiquetas = [];
    cortes.forEach((c, i) => {
      const t = 'start=' + c.desde.toFixed(3) + ':end=' + c.hasta.toFixed(3);
      const zoom = modo === 'recorte' && c.plano === 'cerrado' ? config.punchZoom : 1;
      const w = Math.round((ANCHO * zoom) / 2) * 2;
      const h = Math.round((ALTO * zoom) / 2) * 2;
      let video = '[0:v]trim=' + t + ',setpts=PTS-STARTPTS,';
      if (c.sujeto && c.sujeto.split) {
        video += filtroSplit(i, c.sujeto, ANCHO, ALTO);
      } else if (modo === 'blur') {
        video += 'split=2[a' + i + '][b' + i + '];' +
          '[a' + i + ']scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=6:2,scale=' + ANCHO + ':' + ALTO + '[f' + i + '];' +
          '[b' + i + ']scale=w=' + ANCHO + ':h=' + ALTO + ':force_original_aspect_ratio=decrease:force_divisible_by=2[g' + i + '];' +
          '[f' + i + '][g' + i + ']overlay=(W-w)/2:(H-h)/2,setsar=1[v' + i + ']';
      } else {
        video += 'scale=' + w + ':' + h + ':force_original_aspect_ratio=increase,' +
          'crop=' + ANCHO + ':' + ALTO + ':' + xRostro(c.sujeto) + ':(in_h-out_h)/2,setsar=1[v' + i + ']';
      }
      partes.push(video);
      partes.push('[0:a]atrim=' + t + ',asetpts=PTS-STARTPTS,afade=t=in:d=0.02,afade=t=out:st=' + Math.max(0, c.hasta - c.desde - 0.02).toFixed(3) + ':d=0.02[a' + i + 'x]');
      etiquetas.push('[v' + i + '][a' + i + 'x]');
    });
    partes.push(etiquetas.join('') + 'concat=n=' + cortes.length + ':v=1:a=1' + salida() + '[audio]');
  } else if (modo === 'blur') {
    partes.push('[0:v]split=2[a][b]');
    partes.push('[a]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=6:2,scale=' + ANCHO + ':' + ALTO + '[fondo]');
    partes.push('[b]scale=w=' + ANCHO + ':h=' + ALTO + ':force_original_aspect_ratio=decrease:force_divisible_by=2[frente]');
    partes.push('[fondo][frente]overlay=(W-w)/2:(H-h)/2,setsar=1' + salida());
  } else {
    // Filtro 9:16 centrado EXACTO del plan maestro (escala hasta cubrir el lienzo y recorta al centro).
    partes.push(
      '[0:v]scale=' + ANCHO + ':' + ALTO + ':force_original_aspect_ratio=increase,' +
      'crop=' + ANCHO + ':' + ALTO + ':(in_w-out_w)/2:(in_h-out_h)/2,setsar=1' + salida()
    );
  }

  if (logo) {
    n++;
    let marca = '[1:v]scale=' + config.logoWidth + ':-2,format=rgba';
    if (config.logoOpacity < 1) marca += ',colorchannelmixer=aa=' + config.logoOpacity;
    partes.push(marca + '[logo]');
    partes.push(entrada() + '[logo]overlay=' + posicionLogo(config.logoPosition, config.logoMargin) + ':format=auto' + salida());
  }

  if (subtitulos) {
    n++;
    let filtro = entrada() + 'ass=filename=' + rutaParaFiltro(subtitulos);
    if (fontsDir) filtro += ':fontsdir=' + rutaParaFiltro(fontsDir);
    partes.push(filtro + salida());
  }

  return partes.join(';');
}

/** Mide el archivo ya renderizado para devolver metadatos reales (no los pedidos). */
async function medirSalida(ruta) {
  try {
    const { stdout } = await run(config.ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-show_entries', 'format=duration',
      '-of', 'json', ruta,
    ], { timeoutMs: 30 * 1000 });
    const datos = JSON.parse(stdout);
    const video = (datos.streams && datos.streams[0]) || {};
    const duracion = Number(datos.format && datos.format.duration);
    return {
      ancho: Number(video.width) || null,
      alto: Number(video.height) || null,
      duracion: Number.isFinite(duracion) && duracion > 0 ? Math.round(duracion * 100) / 100 : null,
    };
  } catch (error) {
    logger.warn('No se pudo medir el clip con ffprobe', { mensaje: error.message });
    return {};
  }
}

export async function renderizarClip(opciones) {
  const { entrada, salida, inicio = 0, duracion, subtitulos = null, modo = 'recorte', onProgreso, signal, logo: opcionLogo, cortes = null } = opciones;

  const desde = Number(inicio);
  const largo = Math.min(Number(duracion), config.maxClipSeconds);
  const largoSalida = cortes && cortes.length > 0 ? cortes.reduce((suma, c) => suma + (c.hasta - c.desde), 0) : largo;

  if (!Number.isFinite(desde) || desde < 0) throw new Error('Inicio de clip invalido');
  if (!Number.isFinite(largo) || largo <= 0) throw new Error('Duracion de clip invalida');
  if (!MODOS.has(modo)) throw new Error('Modo de render invalido: ' + modo);
  if (!(await existe(entrada))) throw new Error('No existe el video de entrada');

  await fs.mkdir(path.dirname(salida), { recursive: true });

  const rutaAss = subtitulos ? path.resolve(subtitulos) : null;
  const fontsDir = (await existe(config.fontsDir)) ? path.resolve(config.fontsDir) : null;
  const logo = await resolverLogo(opcionLogo);
  const logoOmitido = opcionLogo === undefined && config.logoEnabled && !logo;
  const cortesRostro = await analizarCortes(entrada, cortes, desde);
  const filtro = construirFiltro({ modo, subtitulos: rutaAss, fontsDir, logo, cortes: cortesRostro });
  const hilos = String(config.cpuThreads);
  const preset = presetLigero(config.videoPreset);

  // Orden importante: -ss/-i del video, luego -i del logo y despues las opciones de salida (-t, -map...).
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y',
    '-ss', String(desde), '-i', entrada,
    ...(logo ? ['-i', logo] : []),
    '-t', String(largo),
    '-filter_complex', filtro,
    '-map', '[v]', ...(cortes && cortes.length > 0 ? ['-map', '[audio]'] : ['-map', '0:a:0?']),
    '-c:v', 'libx264', '-preset', preset, '-crf', String(config.videoCrf),
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
    const fraccion = Math.min(1, Number(coincidencia[1]) / 1e6 / largoSalida);
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
    fallo.detalle = stderrCompleto(error.stderr) || error.message;
    throw fallo;
  }

  if (onProgreso) onProgreso(1);
  const info = await fs.stat(salida);
  const medido = await medirSalida(salida);

  if ((medido.ancho && medido.ancho !== ANCHO) || (medido.alto && medido.alto !== ALTO)) {
    logger.warn('El clip no salio en 1080x1920', { ancho: medido.ancho, alto: medido.alto });
  }

  return {
    archivo: salida,
    bytes: info.size,
    duracion: medido.duracion || largoSalida,
    ancho: medido.ancho || null,
    alto: medido.alto || null,
    conLogo: Boolean(logo),
    logoOmitido,
    // Para la revision tecnica del clip (curador.js): analisis de rostros por corte y recursos de CPU usados.
    analisis: cortesRostro,
    preset,
    hilos: Number(hilos),
  };
}
