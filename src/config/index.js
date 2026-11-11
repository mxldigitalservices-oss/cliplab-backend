import os from 'node:os';
import path from 'node:path';

function toInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = Object.freeze({
  env: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 8080),
  host: '0.0.0.0',
  logLevel: process.env.LOG_LEVEL || 'info',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  tmpDir: process.env.TMP_DIR || path.join(os.tmpdir(), 'cliplab'),
});
