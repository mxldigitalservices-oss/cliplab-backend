import test from "node:test";
import assert from "node:assert/strict";
import { ESTILOS, nombresEstilos, normalizarEstilo, construirAssEstilo, agrupar } from "../src/estilos-subtitulos.js";

const frase = "Esto cambia por completo la forma en que ahorras tu dinero cada mes".split(" ");
let t = 0.3; const pal = frase.map(w => { const p = { t: w, i: t, f: t + 0.34 }; t += 0.38; return p; });
const estiloLinea = ass => ass.split("\n").find(l => l.startsWith("Style:"));
const eventos = ass => ass.split("\n").filter(l => l.startsWith("Dialogue:"));

test("hay al menos 3 estilos y los nombres son los esperados", () => {
  assert.deepEqual(nombresEstilos().sort(), ["clasico", "dinamico", "minimal"]);
});
test("normalizarEstilo: vacío → defecto; mayúsculas ok; inválido o __proto__ → error claro", () => {
  assert.equal(normalizarEstilo(undefined), "dinamico"); assert.equal(normalizarEstilo(" Clasico "), "clasico");
  assert.throws(() => normalizarEstilo("neon"), /Usa: dinamico, clasico, minimal/);
  assert.throws(() => normalizarEstilo("__proto__"));
});
test("dinamico: karaoke \\k, mayúsculas, pop y 3 palabras por línea", () => {
  const a = construirAssEstilo(pal, { estilo: "dinamico" });
  assert.match(a, /\\k\d+/); assert.match(a, /\\t\(0,110/); assert.match(a, /ESTO/);
  assert.ok(eventos(a).every(e => (e.match(/\\k/g) || []).length <= 3));
});
test("clasico: sin karaoke ni animación, minúsculas, contorno negro y 2 líneas con \\N", () => {
  const a = construirAssEstilo(pal, { estilo: "clasico" });
  assert.doesNotMatch(a, /\\k\d/); assert.doesNotMatch(a, /\\t\(/);
  assert.match(a, /esto cambia/); assert.match(a, /\\N/);
  assert.match(estiloLinea(a), /,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,/);
});
test("minimal: caja translúcida (BorderStyle 3), tamaño menor que dinamico", () => {
  const a = construirAssEstilo(pal, { estilo: "minimal" });
  assert.match(estiloLinea(a), /,100,100,0,0,3,8,0,2,60,60,/);
  assert.ok(Number(estiloLinea(a).split(",")[2]) < Number(estiloLinea(construirAssEstilo(pal)).split(",")[2]));
});
test("las tres variantes producen ASS realmente distintos", () => {
  const set = new Set(nombresEstilos().map(e => estiloLinea(construirAssEstilo(pal, { estilo: e }))));
  assert.equal(set.size, 3);
});
test("respeta margenV (zona segura de la interfaz) y la escala de tamaño", () => {
  assert.match(estiloLinea(construirAssEstilo(pal, { estilo: "clasico", margenV: 400 })), /,400,1$/);
  assert.equal(estiloLinea(construirAssEstilo(pal, { estilo: "dinamico", tamano: 64 })).split(",")[2], "64");
  assert.equal(estiloLinea(construirAssEstilo(pal, { estilo: "dinamico", tamano: 32 })).split(",")[2], "32");
});
test("el texto no puede inyectar etiquetas ASS", () => {
  const a = construirAssEstilo([{ t: "{\\fs300}hola", i: 0, f: 1 }, { t: "x\\Ny", i: 1, f: 2 }], { estilo: "clasico" });
  assert.doesNotMatch(a, /\\fs300/); assert.doesNotMatch(a, /\{[^}]*hola/);
});
test("una línea demasiado ancha reduce su tamaño en vez de salirse de la pantalla", () => {
  const largo = [{ t: "anticonstitucionalisimamente".repeat(2), i: 0, f: 1 }];
  assert.match(construirAssEstilo(largo, { estilo: "dinamico" }), /\\fs\d+/);
});
test("los eventos están en orden y con fin > inicio", () => {
  for (const e of nombresEstilos()) {
    let prev = -1;
    for (const l of eventos(construirAssEstilo(pal, { estilo: e }))) {
      const [, ini, fin] = l.split(",");
      const s = x => { const [h, m, r] = x.split(":"); return +h * 3600 + +m * 60 + +r; };
      assert.ok(s(fin) > s(ini) && s(ini) >= prev); prev = s(ini);
    }
  }
});
test("agrupar parte por pausa larga", () => {
  assert.equal(agrupar([{ t: "a", i: 0, f: 0.3 }, { t: "b", i: 3, f: 3.3 }]).length, 2);
});
test("ESTILOS está congelado", () => { assert.throws(() => { "use strict"; ESTILOS.dinamico.tamano = 1; }); });
