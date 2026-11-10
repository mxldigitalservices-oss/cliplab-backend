import { renderAll } from '../src/engine/render.mjs';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

if (!input) {
  console.error('Uso: node scripts/paso3.mjs <video> [--out out] [--only 1,3] [--upper] [--focus 0.5] [--crf 20] [--preset veryfast] [--font-size 68]');
  process.exit(1);
}

const only = opt('only', '') ? opt('only', '').split(',').map(Number) : [];

renderAll(input, {
  outDir: opt('out', 'out'),
  only,
  focus: opt('focus', 0.5),
  crf: opt('crf', 20),
  preset: opt('preset', 'veryfast'),
  sub: {
    upper: args.includes('--upper'),
    fontSize: Number(opt('font-size', 68)),
    marginV: Number(opt('margin-v', 520)),
  },
}).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
