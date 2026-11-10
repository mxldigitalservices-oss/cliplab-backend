import test from "node:test";
import assert from "node:assert/strict";
import { parseJson3, aPalabras, recortarPalabras, agrupar, construirAss, fmtT } from "../src/subtitulos.js";

const json3 = { events: [
  { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "hola", tOffsetMs: 0 }, { utf8: " mundo", tOffsetMs: 500 }, { utf8: " feliz", tOffsetMs: 1100 }] },
  { tStartMs: 3000, dDurationMs: 500, segs: [{ utf8: "[Música]" }] },
  { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: "frase completa sin offsets" }] },
  { tStartMs: 9000, dDurationMs: 100 }
] };

test("json3: palabras con tiempo, sin ruido y sin solapes", () => {
  const p = parseJson3(json3);
  assert.deepEqual(p.slice(0, 3).map(w => w.t), ["hola", "mundo", "feliz"]);
  assert.equal(p[0].i, 1); assert.equal(p[0].f, 1.5);
  assert.ok(!p.some(w => w.t.startsWith("[")));
  for (let k = 1; k < p.length; k++) assert.ok(p[k - 1].f <= p[k].i + 1e-9, "sin solapes");
  assert.ok(p.every(w => w.f - w.i <= 1.2 + 1e-9));
});

test("frases de varias palabras se reparten el tiempo", () => {
  const p = aPalabras([{ t: "uno dos tres", i: 0, f: 3 }]);
  assert.equal(p.length, 3);
  assert.ok(Math.abs(p.at(-1).f - 3) < 1e-9);
});

test("recortarPalabras da tiempos relativos al clip y respeta los bordes", () => {
  const p = [{ t: "a", i: 9, f: 10.5 }, { t: "b", i: 11, f: 12 }, { t: "c", i: 19.9, f: 21 }, { t: "d", i: 30, f: 31 }];
  const r = recortarPalabras(p, 10, 20);
  assert.deepEqual(r.map(w => w.t), ["a", "b", "c"]);
  assert.equal(r[0].i, 0); assert.equal(r[0].f, 0.5); assert.equal(r[1].i, 1);
  assert.ok(Math.abs(r[2].f - 10) < 1e-9);
});

test("agrupar: máximo de palabras, pausas largas y caracteres", () => {
  const w = (t, i) => ({ t, i, f: i + 0.3 });
  assert.equal(agrupar([w("a", 0), w("b", 0.4), w("c", 0.8), w("d", 1.2)], { max: 3 }).length, 2);
  assert.equal(agrupar([w("a", 0), w("b", 3)], { max: 3 }).length, 2);
});

test("ASS: cabecera 720x1280, karaoke con suma de duraciones y texto saneado", () => {
  const ass = construirAss([{ t: "hola", i: 0.5, f: 0.9 }, { t: "{x}\\mundo", i: 1.0, f: 1.6 }], { margenV: 360 });
  assert.match(ass, /PlayResX: 720/); assert.match(ass, /PlayResY: 1280/);
  assert.match(ass, /Style: Sub,DejaVu Sans,64,&H0000E6FF,&H00FFFFFF/);
  const d = ass.split("\n").filter(l => l.startsWith("Dialogue"));
  assert.equal(d.length, 1);
  assert.match(d[0], /0:00:00\.50,0:00:01\.75/);
  assert.match(d[0], /\{\\k50\}HOLA \{\\k75\}XMUNDO$/);
  assert.ok(!/\{x\}/.test(d[0]));
});

test("fmtT", () => { assert.equal(fmtT(3661.257), "1:01:01.26"); assert.equal(fmtT(0), "0:00:00.00"); });
