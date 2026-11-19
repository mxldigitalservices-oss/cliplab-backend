import test from "node:test";
import assert from "node:assert/strict";
import { parsear, sanear, puntuarTexto, bonus, priorizar } from "../src/instruccion.js";

test("parsear: quita palabras vacías y verbos de pedido; sin nada útil devuelve null", () => {
  assert.deepEqual(parsear("busca los momentos donde hablen de inversión").tokens, ["inversion"]);
  assert.equal(parsear("   "), null);
  assert.equal(parsear("busca los momentos donde"), null);
  assert.equal(parsear(null), null);
});
test("parsear: frases entre comillas se guardan enteras y sus palabras también cuentan", () => {
  const c = parsear('ahorro y "fondo de emergencia"');
  assert.deepEqual(c.frases, ["fondo de emergencia"]);
  assert.ok(c.tokens.includes("ahorro") && c.tokens.includes("emergencia"));
});
test("sanear: quita caracteres de control y acota la longitud", () => {
  assert.equal(sanear("hola\u0000\n  mundo"), "hola mundo");
  assert.equal(sanear("x".repeat(500)).length, 300);
});
test("coincidencia por raíz: invertir≈inversión y dinero≈dineros, pero política≠policía", () => {
  assert.ok(puntuarTexto("La inversión en bolsa", parsear("invertir")).coincidencias > 0);
  assert.ok(puntuarTexto("gastas dineros", parsear("dinero")).coincidencias > 0);
  assert.equal(puntuarTexto("llamó a la policía", parsear("política")).coincidencias, 0);
});
test("tildes y mayúsculas no importan", () => {
  assert.ok(puntuarTexto("MI EMPRESA FACTURÓ MÁS", parsear("facturo empresa")).cobertura === 1);
});
test("bonus: más cobertura sube más; una frase exacta suma; sin coincidencias es 0", () => {
  const c = parsear('ahorro inversion "fondo de emergencia"');
  const poco = bonus(puntuarTexto("hablemos del ahorro hoy", c));
  const mucho = bonus(puntuarTexto("el ahorro y la inversion con tu fondo de emergencia", c));
  assert.ok(mucho > poco && poco > 0);
  assert.equal(bonus(puntuarTexto("receta de pasta con tomate", c)), 0);
});
test("priorizar: sube solo a los que coinciden, conserva el resto de campos y respeta el tope", () => {
  const segs = [{ id: 1, texto: "hablamos de inversión y ahorro", puntaje: 60 }, { id: 2, texto: "receta de pasta", puntaje: 60 }, { id: 3, texto: "inversión inversión inversión ahorro", puntaje: 95 }];
  const r = priorizar(segs, "inversión y ahorro");
  assert.ok(r[0].puntaje > 60 && r[0].coincide && r[0].puntaje_base === 60);
  assert.equal(r[1].puntaje, 60); assert.equal(r[1].coincide, false);
  assert.equal(r[2].puntaje, 100);
  assert.deepEqual(r.map(s => s.id), [1, 2, 3]);
});
test("priorizar: sin instrucción devuelve copias idénticas; ordenar y escala 0-1 funcionan", () => {
  const segs = [{ texto: "algo", puntaje: 50 }];
  assert.deepEqual(priorizar(segs, ""), segs); assert.notEqual(priorizar(segs, "")[0], segs[0]);
  const r = priorizar([{ texto: "ahorro", puntaje: 0.5 }, { texto: "nada", puntaje: 0.6 }], "ahorro", { tope: 1, ordenar: true });
  assert.equal(r[0].texto, "ahorro"); assert.ok(r[0].puntaje <= 1 && r[0].puntaje > 0.5);
});
test("priorizar acepta accesores para otros formatos de segmento", () => {
  const r = priorizar([{ transcripcion: "el ahorro", score: 10 }], "ahorro", { texto: s => s.transcripcion, puntaje: s => s.score });
  assert.ok(r[0].puntaje > 10);
});
