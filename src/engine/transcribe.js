import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { run } from '../utils/run.js';

const ABRE_SIGNO = /^[¿¡"'“‘(\[]+$/u;
const SOLO_PUNTUACION = /^[\p{P}\p{S}]+$/u;
const MARCA_ESPECIAL = /^[\[(].*[\])]$/;

export function parsearPalabras(json) {
  const segmentos = Array.isArray(json && json.transcription) ? json.transcription : [];
  const palabras = [];
  let prefijo = '';

  for (const segmento of segmentos) {
    const texto = String((segmento && segmento.text) || '').trim();
    if (!texto || MARCA_ESPECIAL.test(texto)) continue;

    const offsets = (segmento && segmento.offsets) || {};
    const inicio = Number(offsets.from) / 1000;
    const fin = Number(offsets.to) / 1000;
    if (!Number.isFinite(inicio) || !Number.isFinite(fin)) continue;

    if (ABRE_SIGNO.test(texto)) {
      prefijo += texto;
      continue;
    }

    if (SOLO_PUNTUACION.test(texto) && palabras.length > 0) {
      const anterior = palabras[palabras.length - 1];
      anterior.texto += texto;
      anterior.fin = Math.max(anterior.fin, fin);
      continue;
    }

    palabras.push({
      texto: prefijo + texto,
      inicio,
      fin: Math.max(fin, inicio + 0.05),
    });
    prefijo = '';
  }

  return palabras;
}

export async function transcribirAudio(video, directorio, opciones = {}) {
  const { inicio = 0, duracion = 0, idioma = config.whisperLang, signal, onProgreso } = opciones;

  await fs.mkdir(directorio, { recursive: true });
  const wav = path.join(directorio, 'audio.wav');
  const base = path.join(directorio, 'transcripcion');
  const rutaJson = base + '.json';

  try {
    const argsAudio = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(inicio), '-i', video];
    if (duracion > 0) {
      argsAudio.push('-t', String(duracion));
    }
    argsAudio.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav);
    await run(config.ffmpegPath, argsAudio, { timeoutMs: 5 * 60 * 1000, signal });

    const alLineaError = (linea) => {
      if (!onProgreso) return;
      const coincidencia = /progress\s*=\s*(\d+)%/.exec(linea);
      if (coincidencia) {
        onProgreso(Math.min(1, Number(coincidencia[1]) / 100));
      }
    };

    await run(config.whisperPath, [
      '-m', config.whisperModel,
      '-f', wav,
      '-l', idioma,
      '-t', String(config.cpuThreads),
      '-bs', '1',
      '-ml', '1',
      '-sow',
      '-oj',
      '-np',
      '-pp',
      '-of', base,
    ], { timeoutMs: 20 * 60 * 1000, signal, onStderrLine: alLineaError });

    const json = JSON.parse(await fs.readFile(rutaJson, 'utf8'));
    return parsearPalabras(json);
  } finally {
    await fs.rm(wav, { force: true });
    await fs.rm(rutaJson, { force: true });
  }
}
