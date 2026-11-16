import test from "node:test";
import assert from "node:assert/strict";
import { suavizar, exprCentro, parteFiltro } from "../src/encuadre.js";
import { construirFiltro, construirArgs } from "../src/video.js";

const serie = (n, f) => Array.from({ length: n }, (_, i) => ({ t: i / 4, x: f(i) }));

test("suavizar: sin rostros suficientes devuelve null (se usa el encuadre estático)", () => {
  assert.equal(suavizar(serie(20, i => (i < 5 ? 0.5 : null)), { dur: 5 }), null);
  assert.equal(suavizar([], { dur: 5 }), null);
});

test("suavizar: el temblor pequeño no mueve la cámara", () => {
  const c = suavizar(serie(40, i => 0.5 + (i % 2 ? 0.01 : -0.01)), { dur: 10, mitad: 0.28 });
  assert.ok(c.length <= 2);
  assert.ok(c.every(k => Math.abs(k.cx - 0.5) < 0.02));
});

test("suavizar: un salto brusco se recorre con velocidad limitada y dentro del cuadro", () => {
  const c = suavizar(serie(40, i => (i < 20 ? 0.3 : 0.95)), { dur: 10, mitad: 0.28, velMax: 0.3 });
  for (let i = 1; i < c.length; i++) assert.ok(Math.abs(c[i].cx - c[i - 1].cx) <= 0.3 * (c[i].t - c[i - 1].t) + 1e-3);
  assert.ok(c.every(k => k.cx >= 0.28 - 1e-9 && k.cx <= 0.72 + 1e-9));
  assert.ok(c.at(-1).cx > 0.6);
});

test("suavizar: los huecos de detección mantienen la última posición", () => {
  const c = suavizar(serie(40, i => (i > 10 && i < 30 ? null : 0.4)), { dur: 10, mitad: 0.28 });
  assert.ok(c.every(k => Number.isFinite(k.cx) && Math.abs(k.cx - 0.4) < 0.02));
});

test("suavizar: dos rostros que caben se centran juntos; si no caben, se sigue al principal", () => {
  const cerca = suavizar(serie(40, () => 0.35).map(s => ({ ...s, l: 0.30, r: 0.60 })), { dur: 10, mitad: 0.28 });
  assert.ok(Math.abs(cerca[0].cx - 0.45) < 0.01);                       // centro del grupo
  const lejos = suavizar(serie(40, () => 0.35).map(s => ({ ...s, l: 0.10, r: 0.90 })), { dur: 10, mitad: 0.28 });
  assert.ok(Math.abs(lejos[0].cx - 0.35) < 0.01);                       // sigue al principal
});

test("exprCentro: una clave y varias", () => {
  assert.equal(exprCentro([{ t: 0, cx: 0.5 }]), "0.5");
  const e = exprCentro([{ t: 0, cx: 0.3 }, { t: 2, cx: 0.7 }, { t: 4, cx: 0.7 }]);
  assert.match(e, /^if\(lt\(t,2\),0\.3\+\(0\.4\)\*\(t-0\)\/2,/);
  assert.throws(() => exprCentro([]));
});

test("parteFiltro: sujeto (9:16 completo) y blur_sujeto (fondo difuminado + primer plano)", () => {
  const s = parteFiltro({ modo: "sujeto", expr: "0.5", ratio: 9 / 16 });
  assert.match(s, /crop=w='trunc\(ih\*9\/16\/2\)\*2'/);
  assert.match(s, /scale=720:1280/);
  assert.match(s, /\[v0\]$/);
  const b = parteFiltro({ modo: "blur_sujeto", expr: "0.5", ratio: 1 });
  assert.match(b, /boxblur/);
  assert.match(b, /overlay=\(W-w\)\/2:\(H-h\)\/2/);
  assert.match(b, /scale=720:720/);
  assert.match(b, /\[v0\]$/);
});

test("construirFiltro: sin sujeto se comporta como siempre (blur y crop)", () => {
  assert.match(construirFiltro({ modo: "blur" }), /boxblur=8:2/);
  assert.match(construirFiltro({ modo: "crop" }), /crop=720:1280/);
});

test("construirFiltro: con sujeto conserva marca de agua y subtítulos", () => {
  const sujeto = { modo: "blur_sujeto", expr: "0.5", ratio: 1 };
  const f = construirFiltro({ modo: "blur", sujeto, marca: { idx: 1, x: 36, y: 150, w: 130, opacidad: 0.9 }, ass: { archivo: "/tmp/a.ass" } });
  assert.match(f, /clip\(\(0\.5\)\*iw-out_w\/2,0,iw-out_w\)/);
  assert.match(f, /overlay=36:150/);
  assert.match(f, /ass=filename=/);
  assert.match(f, /\[v\]$/);
});

test("construirArgs: el sujeto llega al filter_complex", () => {
  const a = construirArgs({ urls: ["/tmp/x.mp4"], inicio: 0, dur: 5, out: "/tmp/o.mp4", sujeto: { modo: "sujeto", expr: "0.5", ratio: 9 / 16 } });
  assert.match(a[a.indexOf("-filter_complex") + 1], /clip\(/);
});
