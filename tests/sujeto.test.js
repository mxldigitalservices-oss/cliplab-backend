import test from 'node:test';
import assert from 'node:assert/strict';
import { resumirMuestras, marcarSplit, xRostro, filtroSplit } from '../src/engine/sujeto.js';

const dos = { n: 2, x: 0.5, l: 0.2, r: 0.8 };
const uno = { n: 1, x: 0.3, l: 0.3, r: 0.3 };

test('dos rostros estables activan split en video horizontal', () => {
  const r = resumirMuestras([dos, dos, dos]);
  assert.equal(r.estable2, true);
  assert.equal(marcarSplit([r], true)[0].split, true);
});

test('en video vertical nunca hay split', () => {
  const r = resumirMuestras([dos, dos, dos]);
  assert.equal(marcarSplit([r], false)[0].split, false);
});

test('un rostro: el encuadre sigue a la cara y no hay split', () => {
  const r = resumirMuestras([uno, uno, uno]);
  assert.equal(r.estable2, false);
  assert.ok(Math.abs(r.cx - 0.3) < 1e-9);
  assert.equal(marcarSplit([r], true)[0].split, false);
});

test('conteo inestable (1,2,3) no cuenta como estable', () => {
  const r = resumirMuestras([uno, dos, { ...dos, n: 3 }]);
  assert.equal(r.estable2, false);
});

test('un beat flojo entre dos split se queda en split', () => {
  const a = resumirMuestras([dos, dos, dos]);
  const b = resumirMuestras([uno, uno, uno]);
  const out = marcarSplit([a, b, a], true);
  assert.deepEqual(out.map((s) => s.split), [true, true, true]);
});

test('sin rostro: crop centrado; con rostro: expresion con clip', () => {
  assert.equal(xRostro(null), '(in_w-out_w)/2');
  assert.match(xRostro({ cx: 0.3 }), /clip\(0\.3000\*in_w-out_w\/2,0,in_w-out_w\)/);
});

test('filtroSplit termina en la etiqueta [v<i>] y apila dos mitades', () => {
  const f = filtroSplit(2, { l: 0.2, r: 0.8 }, 1080, 1920);
  assert.ok(f.endsWith('vstack=inputs=2,setsar=1[v2]'));
  assert.ok(f.includes('scale=1080:960'));
});
