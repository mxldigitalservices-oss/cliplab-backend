import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { run, ComandoError, stderrCompleto } from '../utils/run.js';
import { parsearUrlYoutube } from '../utils/youtube.js';
import { conSesion, renovar, esBloqueoAntiBot } from '../sesion/gestor.js';

const FORMATO = 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b/best/bv*/ba';
const FORMATO_RESPALDO = 'bv*+ba/b/best/bv*/ba';
const TIMEOUT_MS = 20 * 60 * 1000;
const PREFIJO_PROGRESO = 'PROGRESO';

// "Requested format is not available" casi nunca significa que el selector -f este mal: YouTube entrego pocos o ningun
// formato descargable para ese cliente (SABR, PO Token, desafio de JavaScript, IP de centro de datos). Ademas, al enviar
// cookies yt-dlp DESCARTA los clientes que no las soportan, que son justo los que hoy resuelven formatos sin resolvedor
// de JS. Por eso en vez de forzar un unico juego de clientes se prueba una escalera, de lo mas simple a lo mas especifico:
//   1. clientes por defecto de yt-dlp (los mantiene el proyecto y cambian con cada version), con sesion;
//   2. igual, con selector de formato mas libre;
//   3. se suman web_safari (HLS, sin PO Token) y tv;
//   4. sin cookies (se habilitan clientes que no las admiten);
//   5. sin cookies + android_vr.
// Si todas fallan, el error trae `--list-formats` y las estrategias probadas para diagnosticar en Incidencias.
const ESTRATEGIAS = [
  { id: 'predeterminada', formato: FORMATO, clientes: null, cookies: true },
  { id: 'formato-libre', formato: FORMATO_RESPALDO, clientes: null, cookies: true },
  { id: 'hls-seguro', formato: FORMATO_RESPALDO, clientes: 'default,web_safari,tv', cookies: true },
  { id: 'sin-cookies', formato: FORMATO_RESPALDO, clientes: null, cookies: false },
  { id: 'sin-cookies-android-vr', formato: FORMATO_RESPALDO, clientes: 'default,android_vr', cookies: false },
];

/** Plan de intentos. Sin sesion guardada las estrategias "con cookies" se vuelven iguales a las demas y se eliminan duplicados. */
export function planDeEstrategias(hayCookies) {
  const vistos = new Set();
  const plan = [];
  for (const estrategia of ESTRATEGIAS) {
    const e = { ...estrategia, cookies: estrategia.cookies && hayCookies };
    const clave = [e.formato, e.clientes, e.cookies].join('|');
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    plan.push(e);
  }
  return plan;
}

/** El error pide probar otra estrategia (formatos ausentes o mediaciones rechazadas), no es un fallo definitivo del video. */
export function pideOtraEstrategia(stderr) {
  return /requested format is not available|no video formats found|only images are available|http error 403|forbidden/i.test(String(stderr || ''));
}

function conDetalle(mensaje, stderr) {
  const err = new Error(mensaje);
  err.detalle = stderrCompleto(stderr);
  return err;
}

function explicarError(error, trasRenovar) {
  if (!(error instanceof ComandoError)) return error;
  const stderr = String(error.stderr || '');
  if (esBloqueoAntiBot(stderr)) {
    if (trasRenovar && trasRenovar.estado === 'sin_sesion') {
      return conDetalle('YouTube pidio verificacion anti-bot y no hay sesion guardada. Importa cookies en /sesion.html.', stderr);
    }
    if (trasRenovar) {
      return conDetalle('YouTube siguio pidiendo verificacion anti-bot tras renovar la sesion. Importa cookies frescas en /sesion.html.', stderr);
    }
    return conDetalle('YouTube pidio verificacion anti-bot. Importa cookies en /sesion.html.', stderr);
  }
  const detalle = stderr.trim().split('\n').filter(Boolean).pop() || error.message;
  return conDetalle('Fallo la descarga: ' + detalle, stderr);
}

export async function descargarVideo(url, directorio, opciones = {}) {
  const parsed = parsearUrlYoutube(url);
  if (!parsed) {
    throw new Error('URL de YouTube invalida');
  }

  await fs.mkdir(directorio, { recursive: true });

  const argsDe = (estrategia, { conFormato = true } = {}) => {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-colors',
      '--restrict-filenames',
      '--js-runtimes', 'node',
      '--socket-timeout', '20',
      '--retries', '3',
    ];
    if (estrategia.clientes) args.push('--extractor-args', 'youtube:player_client=' + estrategia.clientes);
    if (config.ytdlpProxy) args.push('--proxy', config.ytdlpProxy);
    if (path.isAbsolute(config.ffmpegPath)) args.push('--ffmpeg-location', config.ffmpegPath);
    if (!conFormato) return args;
    return [
      ...args,
      '--concurrent-fragments', '4',
      '--match-filter', 'duration<=' + config.maxVideoSeconds,
      '-f', estrategia.formato,
      '--merge-output-format', 'mp4',
      '--progress',
      '--newline',
      '--progress-template', 'download:' + PREFIJO_PROGRESO + ' %(progress._percent_str)s',
      '-o', path.join(directorio, '%(id)s.%(ext)s'),
      '--print', 'after_move:%(id)s|%(duration)s|%(filepath)s|%(title)s',
    ];
  };

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

  const lanzar = (estrategia) => conSesion((rutaCookies) => {
    const args = argsDe(estrategia);
    if (estrategia.cookies && rutaCookies) args.push('--cookies', rutaCookies);
    args.push('--', parsed.toString());
    return run(config.ytdlpPath, args, {
      timeoutMs: TIMEOUT_MS,
      signal: opciones.signal,
      onStdoutLine: alLinea,
    });
  });

  /** Mejor esfuerzo: lista los formatos que YouTube SI entrego, para dejarlo en el detalle del error. */
  const listarFormatos = (estrategia) => conSesion(async (rutaCookies) => {
    const args = [...argsDe(estrategia, { conFormato: false }), '--list-formats'];
    if (estrategia.cookies && rutaCookies) args.push('--cookies', rutaCookies);
    args.push('--', parsed.toString());
    try {
      const { stdout } = await run(config.ytdlpPath, args, { timeoutMs: 60 * 1000, signal: opciones.signal });
      return stdout.split('\n').filter(Boolean).slice(-40).join('\n');
    } catch (error) {
      return 'No se pudo listar formatos: ' + String(error.stderr || error.message).trim().split('\n').pop();
    }
  });

  /** Recorre la escalera. Lanza el error mas informativo si ninguna estrategia funciona. */
  const escalera = async () => {
    const hayCookies = await conSesion(async (ruta) => Boolean(ruta));
    const plan = planDeEstrategias(hayCookies);
    const intentos = [];
    let errorAntiBot = null;
    let ultimo = null;

    for (let i = 0; i < plan.length; i++) {
      const estrategia = plan[i];
      if (opciones.signal && opciones.signal.aborted) throw new Error('Trabajo cancelado');
      try {
        const resultado = await lanzar(estrategia);
        if (i > 0) logger.info('Descarga resuelta con una estrategia de respaldo', { estrategia: estrategia.id, intento: i + 1 });
        return resultado;
      } catch (error) {
        if (!(error instanceof ComandoError)) throw error;
        const stderr = String(error.stderr || '');
        const antiBot = esBloqueoAntiBot(stderr);
        // Con sesion, un anti-bot significa que las cookies ya no sirven: se corta y el flujo exterior las renueva.
        if (antiBot && estrategia.cookies) throw error;
        if (antiBot) errorAntiBot = errorAntiBot || error;
        else if (!pideOtraEstrategia(stderr)) throw error;
        ultimo = error;
        intentos.push(estrategia.id + ': ' + (stderr.trim().split('\n').filter(Boolean).pop() || error.message));
        logger.warn('Estrategia de descarga sin resultado: se prueba la siguiente', { estrategia: estrategia.id, intento: i + 1, de: plan.length });
      }
    }

    if (errorAntiBot) throw errorAntiBot;

    const formatos = await listarFormatos(plan[0]);
    const detalle = [
      'Estrategias probadas (' + plan.length + '):',
      ...intentos.map((l) => ' - ' + l),
      '',
      'Formatos que entrego YouTube (--list-formats):',
      formatos,
    ].join('\n');
    const final = new Error(
      'YouTube no entrego formatos descargables para este video desde el servidor (se probaron ' + plan.length + ' estrategias). '
      + 'Suele deberse a la IP del centro de datos o a que YouTube exige un PO Token: reimporta cookies frescas en /sesion.html '
      + 'o define YTDLP_PROXY con un proxy residencial.',
    );
    final.detalle = stderrCompleto(detalle) + (ultimo ? '\n\n' + stderrCompleto(ultimo.stderr) : '');
    throw final;
  };

  let resultado;
  try {
    resultado = await escalera();
  } catch (error) {
    const bloqueo = error instanceof ComandoError && esBloqueoAntiBot(error.stderr);
    if (!bloqueo || (opciones.signal && opciones.signal.aborted)) {
      throw explicarError(error);
    }
    logger.warn('YouTube pidio verificacion anti-bot: se renueva la sesion y se reintenta una vez');
    const sesion = await renovar('antibot');
    if (!sesion.sondeoOk) {
      throw explicarError(error, sesion);
    }
    try {
      resultado = await escalera();
    } catch (segundo) {
      throw explicarError(segundo, sesion);
    }
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
