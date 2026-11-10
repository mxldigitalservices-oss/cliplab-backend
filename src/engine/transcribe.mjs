import { readFile, rm } from 'node:fs/promises';
import { run } from './audio.mjs';

const PUNCT_ONLY = /^[\s.,;:!?¿¡…"'()\-–—]+$/;
const SPECIAL = /^\s*[\[(<].*[\])>]\s*$/;

export function mergeTokens(segments) {
  const words = [];
  for (const seg of segments) {
    const raw = seg.text ?? '';
    const t = raw.trim();
    if (!t || SPECIAL.test(raw)) continue;
    const start = seg.offsets.from / 1000;
    const end = seg.offsets.to / 1000;
    const last = words[words.length - 1];
    if (PUNCT_ONLY.test(raw) && last) {
      last.text += t;
      last.end = Math.max(last.end, end);
    } else if (/^\s/.test(raw) || !last) {
      words.push({ text: t, start, end });
    } else {
      last.text += t;
      last.end = end;
    }
  }
  return words;
}

export async function transcribe(wavPath, outPrefix, opts = {}) {
  const bin = process.env.WHISPER_BIN || 'whisper-cli';
  const model = process.env.WHISPER_MODEL || '/models/ggml-base.bin';
  const lang = opts.lang || process.env.WHISPER_LANG || 'es';
  const threads = String(opts.threads || process.env.WHISPER_THREADS || 4);

  await run(bin, [
    '-m', model, '-f', wavPath, '-l', lang,
    '-oj', '-of', outPrefix, '-ml', '1', '-sow', '-t', threads,
  ]);

  const jsonPath = `${outPrefix}.json`;
  const data = JSON.parse(await readFile(jsonPath, 'utf8'));
  await rm(jsonPath, { force: true });
  return mergeTokens(data.transcription || []);
}
