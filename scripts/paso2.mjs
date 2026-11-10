import { processVideo } from '../src/engine/pipeline.mjs';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

if (!input) {
  console.error('Uso: node scripts/paso2.mjs <video> [--lang es] [--out out] [--max 8] [--min-dur 20] [--max-dur 55]');
  process.exit(1);
}

processVideo(input, {
  lang: opt('lang', 'es'),
  outDir: opt('out', 'out'),
  select: {
    maxClips: Number(opt('max', 8)),
    minDur: Number(opt('min-dur', 20)),
    maxDur: Number(opt('max-dur', 55)),
  },
}).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
