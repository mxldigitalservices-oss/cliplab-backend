import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(__dirname, '..', '..');

function toInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const tmpDir = process.env.TMP_DIR || path.join(os.tmpdir(), 'cliplab');
const volumen = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';

export const config = Object.freeze({
  env: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 8080),
  host: '0.0.0.0',
  logLevel: process.env.LOG_LEVEL || 'info',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  masterKey: process.env.MASTER_KEY || '',
  tmpDir,
  clipsDir: process.env.CLIPS_DIR || path.join(tmpDir, 'clips'),

  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ytdlpCookies: process.env.YTDLP_COOKIES || '',
  whisperPath: process.env.WHISPER_PATH || 'whisper-cli',
  whisperModel: process.env.WHISPER_MODEL || '/opt/whisper/modelo.bin',
  whisperLang: process.env.WHISPER_LANG || 'auto',

  fontsDir: process.env.FONTS_DIR || path.join(raiz, 'fonts'),
  subtitleFont: process.env.SUBTITLE_FONT || 'Anton',

  cpuThreads: Math.max(1, toInt(process.env.CPU_THREADS, 2)),
  videoCrf: toInt(process.env.VIDEO_CRF, 24),
  videoPreset: process.env.VIDEO_PRESET || 'veryfast',
  maxVideoSeconds: toInt(process.env.MAX_VIDEO_SECONDS, 10800),
  maxClipSeconds: toInt(process.env.MAX_CLIP_SECONDS, 90),

  defaultClipSeconds: toInt(process.env.DEFAULT_CLIP_SECONDS, 45),
  defaultRenderMode: process.env.DEFAULT_RENDER_MODE === 'blur' ? 'blur' : 'recorte',
  maxQueue: Math.max(1, toInt(process.env.MAX_QUEUE, 20)),
  maxClipsStored: Math.max(1, toInt(process.env.MAX_CLIPS_STORED, 25)),

  sessionDir: process.env.SESSION_DIR || (volumen ? path.join(volumen, 'sesion') : path.join(tmpDir, 'sesion-datos')),
  sessionKey: String(process.env.SESSION_KEY || process.env.MASTER_KEY || '').trim(),
  sessionCheckMinutes: Math.max(0, toInt(process.env.SESSION_CHECK_MIN, 360)),
  sessionProbeUrl: process.env.SESSION_PROBE_URL || 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
});
