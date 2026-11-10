import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DIR = 'src/public/js';
const METODOS = 'forEach|map|filter|some|every|find|reduce|flatMap';
const RE = new RegExp(
  `(?<![\\w$)\\]])([A-Za-z_$][\\w$]*(?:\\?\\.[A-Za-z_$][\\w$]*|\\.[A-Za-z_$][\\w$]*|\\[[^\\]\\n]*\\])*)\\.(${METODOS})\\(`,
  'g',
);

let total = 0;
const cambios = [];
for (const nombre of readdirSync(DIR).filter((n) => n.endsWith('.js'))) {
  const f = path.join(DIR, nombre);
  const lineas = readFileSync(f, 'utf8').split('\n');
  let n = 0;
  const nuevas = lineas.map((l, i) => {
    const t = l.replace(RE, (m, expr, metodo) => `(${expr} ?? []).${metodo}(`);
    if (t !== l) { n++; cambios.push(`${nombre}:${i + 1}: ${t.trim().slice(0, 130)}`); }
    return t;
  });
  if (n) writeFileSync(f, nuevas.join('\n'));
  console.log(`${nombre}: ${n} líneas blindadas`);
  total += n;
}
console.log(`\nTotal: ${total}`);
console.log(cambios.slice(0, 80).join('\n'));
