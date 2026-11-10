import assert from 'node:assert/strict';
import { buildSentences } from '../src/engine/segmenter.mjs';
import { selectClips } from '../src/engine/selector.mjs';

const frases = [
  '¿Sabes cuál es el error número 1 al editar video?',
  'La edición rápida mejora la retención del video.',
  'Muchos creadores ignoran la retención y pierden audiencia.',
  'El secreto está en cortar las pausas largas.',
  'Un buen subtítulo mantiene la atención del espectador.',
  'Por eso la edición y la retención van de la mano.',
];

const words = [];
let t = 0;
for (let r = 0; r < 14; r++) {
  for (const f of frases) {
    for (const tok of f.split(' ')) {
      words.push({ text: tok, start: +t.toFixed(3), end: +(t + 0.3).toFixed(3) });
      t += 0.33;
    }
    t += 0.5;
  }
}

const sents = buildSentences(words);
const a = selectClips(sents, words);
const b = selectClips(sents, words);

assert.deepEqual(a, b, 'Resultado no determinista');
assert.ok(a.length > 0, 'No se seleccionaron clips');
for (let i = 1; i < a.length; i++) assert.ok(a[i].start >= a[i - 1].end - 0.7, 'Solape detectado');
for (const c of a) assert.ok(c.duration >= 20 && c.duration <= 55, `Duración fuera de rango: ${c.duration}`);

console.log(`OK: ${a.length} clips, determinista, sin solapes.`);
console.log(a.map((c) => `#${c.id} ${c.start}-${c.end}s score=${c.score}`).join('\n'));
