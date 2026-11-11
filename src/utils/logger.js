import { config } from '../config/index.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

function write(level, message, meta) {
  if (LEVELS[level] > currentLevel) return;

  const entry = {
    time: new Date().toISOString(),
    level,
    message,
  };

  if (meta !== undefined) {
    entry.meta = meta instanceof Error ? { name: meta.name, message: meta.message, stack: meta.stack } : meta;
  }

  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  error: (message, meta) => write('error', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  info: (message, meta) => write('info', message, meta),
  debug: (message, meta) => write('debug', message, meta),
};
