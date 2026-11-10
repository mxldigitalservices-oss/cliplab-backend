import test from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_KEY_1 = "k1"; process.env.GEMINI_API_KEY_2 = "k2";
process.env.GEMINI_API_KEY_3 = "k3"; process.env.GEMINI_API_KEY_4 = "k4";
const { generar, cadena, estadoLlaves, ROL, _test } = await import("../src/gemini.js");

const respuesta = (status, body = {}, headers = {}) => ({
  ok: status >= 200 && status < 300, status, headers: new Headers(headers),
  json: async () => body, text: async () => JSON.stringify(body)
});
const usadas = [];
const simular = fn => { globalThis.fetch = async (url, opts) => { usadas.push(opts.headers["x-goog-api-key"]); return fn(opts.headers["x-goog-api-key"], url); }; };
test.beforeEach(() => { usadas.length = 0; _test.reiniciar(); _test.fijarRegistro(() => {}); });

test("cada rol usa su propia llave", async () => {
  simular(() => respuesta(200, { ok: 1 }));
  for (const [rol, k] of [[ROL.COPY, "k1"], [ROL.AUDITORIA, "k2"], [ROL.ANALISIS, "k3"], [ROL.RESPALDO, "k4"]]) {
    const r = await generar(rol, {});
    assert.equal(r.rol, rol);
    assert.equal(usadas.at(-1), k);
  }
});

test("usa el modelo gemini-3.5-flash", async () => {
  let url = "";
  simular((_, u) => { url = u; return respuesta(200); });
  await generar(ROL.COPY, {});
  assert.match(url, /models\/gemini-3\.5-flash:generateContent/);
});

test("429 enfría solo esa llave y releva a la de respaldo", async () => {
  simular(k => k === "k1" ? respuesta(429, {}, { "retry-after": "30" }) : respuesta(200));
  const r = await generar(ROL.COPY, {});
  assert.deepEqual(usadas, ["k1", "k4"]);
  assert.equal(r.rol, ROL.RESPALDO);
  const e = Object.fromEntries(estadoLlaves().map(x => [x.rol, x]));
  assert.ok(e.copy.enfriamientoSeg > 20 && e.copy.enfriamientoSeg <= 30);
  assert.equal(e.auditoria.enfriamientoSeg, 0);   // las demás no se tocan
  await generar(ROL.COPY, {});
  assert.equal(usadas.at(-1), "k4");              // sigue en respaldo mientras k1 enfría
});

test("401 y 5xx también relevan", async () => {
  simular(k => k === "k2" ? respuesta(401) : respuesta(200));
  assert.equal((await generar(ROL.AUDITORIA, {})).rol, ROL.RESPALDO);
  _test.reiniciar();
  simular(k => k === "k3" ? respuesta(503) : respuesta(200));
  assert.equal((await generar(ROL.ANALISIS, {})).rol, ROL.RESPALDO);
});

test("404 falla de inmediato con mensaje claro; 400 no rota", async () => {
  simular(() => respuesta(404));
  await assert.rejects(generar(ROL.COPY, {}), /no encontrado \(404\)/);
  assert.equal(usadas.length, 1);
  usadas.length = 0; _test.reiniciar();
  simular(() => respuesta(400));
  await assert.rejects(generar(ROL.COPY, {}), /Gemini 400/);
  assert.equal(usadas.length, 1);
});

test("error de red enfría la llave y releva", async () => {
  let n = 0;
  globalThis.fetch = async (_, o) => { usadas.push(o.headers["x-goog-api-key"]); if (n++ === 0) throw new Error("ECONNRESET"); return respuesta(200); };
  assert.equal((await generar(ROL.COPY, {})).rol, ROL.RESPALDO);
});

test("la cadena nunca repite el respaldo y estadoLlaves no expone llaves", () => {
  assert.deepEqual(cadena(ROL.RESPALDO), ["respaldo"]);
  assert.deepEqual(cadena(ROL.COPY), ["copy", "respaldo"]);
  assert.ok(!JSON.stringify(estadoLlaves()).match(/k[1-4]"/));
});
