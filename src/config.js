const path = require('path');
const env = process.env;

const dataDir = env.DATA_DIR || path.join(process.cwd(), 'data');

const config = {
  port: Number(env.PORT) || 3000,
  databaseUrl: env.DATABASE_URL,
  pgSsl: env.PGSSL === 'true',
  pgPoolMax: Number(env.PG_POOL_MAX) || 10,
  masterKey: env.MASTER_KEY || '',
  dataDir,
  tmpDir: path.join(dataDir, 'tmp'),
  exportDir: path.join(dataDir, 'cortes'),
  ytdlpBin: env.YTDLP_BIN || 'yt-dlp',
  ytdlpCookies: env.YTDLP_COOKIES || '',
  subLangs: env.SUB_LANGS || 'es.*,es,en.*,en',
  ffmpegBin: env.FFMPEG_BIN || 'ffmpeg',
  workerConcurrency: Math.max(1, Number(env.WORKER_CONCURRENCY) || 1),
  workerPollMs: Number(env.WORKER_POLL_MS) || 2000,
  maxIntentos: Math.max(1, Number(env.MAX_INTENTOS) || 2),
  staleMinutos: Number(env.STALE_MINUTOS) || 30,
  clipsPorVideo: Math.max(1, Number(env.CLIPS_POR_VIDEO) || 3),
  duracionClip: Math.max(5, Number(env.DURACION_CLIP_SEG) || 30),
};

if (!config.databaseUrl) {
  throw new Error('Falta la variable de entorno DATABASE_URL');
}

module.exports = config;
