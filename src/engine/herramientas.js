import fs from 'node:fs/promises';
import { config } from '../config/index.js';
import { run } from '../utils/run.js';

async function probar(funcion) {
  try {
    return await funcion();
  } catch (error) {
    return { available: false, error: error.message };
  }
}

async function verificarFfmpeg() {
  const version = await run(config.ffmpegPath, ['-version'], { timeoutMs: 8000 });
  const filtros = await run(config.ffmpegPath, ['-hide_banner', '-filters'], { timeoutMs: 8000 });
  const libass = /\sass\s/.test(filtros.stdout);

  return {
    available: libass,
    version: version.stdout.split('\n')[0].trim(),
    libass,
    error: libass ? null : 'FFmpeg sin filtro ass (libass): no se podran quemar subtitulos',
  };
}

async function verificarYtdlp() {
  const resultado = await run(config.ytdlpPath, ['--version'], { timeoutMs: 20000 });
  return { available: true, version: resultado.stdout.trim(), error: null };
}

async function verificarWhisper() {
  await run(config.whisperPath, ['-h'], { timeoutMs: 8000 });
  await fs.access(config.whisperModel);
  return { available: true, modelo: config.whisperModel, error: null };
}

export async function verificarHerramientas() {
  const [ffmpeg, ytdlp, whisper] = await Promise.all([
    probar(verificarFfmpeg),
    probar(verificarYtdlp),
    probar(verificarWhisper),
  ]);
  return { ffmpeg, ytdlp, whisper };
}
