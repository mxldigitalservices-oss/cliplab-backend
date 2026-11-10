import assert from 'node:assert/strict';
import { buildAss, clipWords, fmtTime } from '../src/engine/ass.mjs';

assert.equal(fmtTime(3661.5), '1:01:01.50');
assert.equal(fmtTime(0), '0:00:00.00');

const words = [];
let t = 10;
for (let i = 0; i < 40; i++) {
  words.push({ text: i % 9 === 8 ? `palabra${i}.` : `palabra${i}`, start: +t.toFixed(2), end: +(t + 0.3).toFixed(2) });
  t += 0.35;
}
const clip = { id: 1, start: 10, end: 24 };
const cw = clipWords(words, clip);
assert.ok(cw.length > 0 && cw[0].start >= 0, 'sin palabras en el clip');

const ass = buildAss(cw, clip);
assert.ok(ass.includes('[Events]') && ass.includes('\\kf'), 'estructura ASS inválida');
const d = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
assert.ok(d.length >= 3, 'muy pocas líneas');
for (const l of d) assert.match(l, /^Dialogue: 0,\d:\d\d:\d\d\.\d\d,\d:\d\d:\d\d\.\d\d,Karaoke,/);
console.log(`OK: ${d.length} líneas de subtítulos karaoke generadas.`);
