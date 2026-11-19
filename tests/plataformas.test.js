import test from "node:test";
import assert from "node:assert/strict";
import { REDES, ETIQUETAS, etiquetaRed, ErrorRed, normalizarRedes, redesDeClip, tieneRed, formatearRedes } from "../src/utils/plataformas.js";

test("constantes y etiquetas", () => {
  assert.deepEqual([...REDES], ["tiktok", "instagram", "facebook"]);
  assert.equal(etiquetaRed("tiktok"), "TikTok");
  assert.equal(etiquetaRed("x"), "x");
  assert.ok(Object.isFrozen(REDES) && Object.isFrozen(ETIQUETAS));
});

test("normalizarRedes acepta arreglo, texto y mapa; orden estable y sin duplicados", () => {
  assert.deepEqual(normalizarRedes(["Facebook", "tiktok", "TIKTOK"]), ["tiktok", "facebook"]);
  assert.deepEqual(normalizarRedes("instagram, tiktok;facebook"), ["tiktok", "instagram", "facebook"]);
  assert.deepEqual(normalizarRedes({ tiktok: true, instagram: false, facebook: "on" }), ["tiktok", "facebook"]);
});

test("sin red → ErrorRed 400, nunca default", () => {
  for (const v of [undefined, null, "", [], {}, { tiktok: false }]) {
    assert.throws(() => normalizarRedes(v), e => e instanceof ErrorRed && e.status === 400);
  }
  assert.deepEqual(normalizarRedes(undefined, { requerida: false }), []);
});

test("red inválida → ErrorRed 400", () => {
  assert.throws(() => normalizarRedes(["youtube"]), e => e.status === 400 && /no válida/.test(e.message));
});

test("redesDeClip nunca infiere", () => {
  assert.deepEqual(redesDeClip({}), []);
  assert.deepEqual(redesDeClip(null), []);
  assert.deepEqual(redesDeClip({ redes: ["tiktok"] }), ["tiktok"]);
  assert.deepEqual(redesDeClip({ platforms: "facebook" }), ["facebook"]);
  assert.deepEqual(redesDeClip({ redes: ["youtube"] }), []);
});

test("tieneRed", () => {
  const clip = { redes: ["tiktok", "facebook"] };
  assert.equal(tieneRed(clip, "TikTok"), true);
  assert.equal(tieneRed(clip, "instagram"), false);
  assert.equal(tieneRed(clip, "youtube"), false);
  assert.equal(tieneRed({}, "tiktok"), false);
});

test("formatearRedes", () => {
  assert.equal(formatearRedes([]), "ninguna");
  assert.equal(formatearRedes(["tiktok"]), "TikTok");
  assert.equal(formatearRedes("tiktok facebook"), "TikTok y Facebook");
  assert.equal(formatearRedes(["facebook", "instagram", "tiktok"]), "TikTok, Instagram y Facebook");
  assert.equal(formatearRedes(["youtube"]), "ninguna");
});
