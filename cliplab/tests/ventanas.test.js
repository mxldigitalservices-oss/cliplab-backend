import test from "node:test";
import assert from "node:assert/strict";
const { parseVentana, zonaAUtc, planificarVentanas, zonaValida } = await import("../src/ventanas.js");

const DR = "America/Santo_Domingo";
const horaLocal = (d, zona = DR) => new Intl.DateTimeFormat("en-GB", { timeZone: zona, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
const min = d => { const [h, m] = horaLocal(d).split(":").map(Number); return h * 60 + m; };

test("parseVentana: formatos válidos e inválidos", () => {
  assert.deepEqual(parseVentana("09:00-11:30"), { ini: 540, fin: 690 });
  assert.deepEqual(parseVentana(" 9:05 - 24:00 "), { ini: 545, fin: 1440 });
  for (const malo of ["", "9-11", "25:00-26:00", "10:00-09:00", "10:00-10:03", "10:60-11:00", null])
    assert.throws(() => parseVentana(malo), /Ventana inválida/, String(malo));
});

test("zonaValida", () => { assert.ok(zonaValida(DR)); assert.ok(!zonaValida("Mars/Olympus")); });

test("zonaAUtc: Santo Domingo (UTC-4 fijo) y Nueva York con cambio de horario", () => {
  assert.equal(new Date(zonaAUtc(2026, 11, 9, 540, DR)).toISOString(), "2026-11-09T13:00:00.000Z");
  assert.equal(new Date(zonaAUtc(2026, 1, 15, 540, "America/New_York")).toISOString(), "2026-01-15T14:00:00.000Z");   // EST
  assert.equal(new Date(zonaAUtc(2026, 7, 1, 540, "America/New_York")).toISOString(), "2026-07-01T13:00:00.000Z");    // EDT
  assert.equal(new Date(zonaAUtc(2026, 3, 8, 600, "America/New_York")).toISOString(), "2026-03-08T14:00:00.000Z");    // día del cambio, ya EDT
  assert.equal(new Date(zonaAUtc(2026, 11, 9, 1440, DR)).toISOString(), "2026-11-10T04:00:00.000Z");                  // 24:00 = medianoche siguiente
});

test("planificarVentanas: una variante por ventana, en orden, rodando al día siguiente", () => {
  const desde = Date.parse("2026-11-09T11:00:00Z");   // 07:00 en Santo Domingo
  const r = planificarVentanas({ cantidad: 4, desde, zona: DR, rnd: () => 0 });
  assert.deepEqual(r.map(d => d.toISOString()), ["2026-11-09T13:00:00.000Z", "2026-11-09T17:00:00.000Z", "2026-11-09T23:00:00.000Z", "2026-11-10T13:00:00.000Z"]);
});

test("planificarVentanas: siempre dentro de la ventana, separadas y nunca en el pasado", () => {
  const desde = Date.parse("2026-11-09T14:30:00Z");   // 10:30 local: ya dentro de la primera ventana
  const ventanas = ["09:00-11:00", "13:00-15:00", "19:00-22:00"];
  for (let corrida = 0; corrida < 50; corrida++) {
    const r = planificarVentanas({ cantidad: 9, ventanas, desde, zona: DR, separacionMin: 90 });
    assert.equal(r.length, 9);
    r.forEach((d, i) => {
      assert.ok(d.getTime() >= desde, "no puede estar en el pasado");
      const m = min(d);
      assert.ok(ventanas.map(v => { const { ini, fin } = parseVentana(v); return m >= ini && m < fin; }).some(Boolean), `${horaLocal(d)} fuera de ventanas`);
      if (i) assert.ok(d - r[i - 1] >= 90 * 60e3, "separación mínima");
    });
  }
});

test("planificarVentanas: errores claros", () => {
  assert.throws(() => planificarVentanas({ cantidad: 0 }), /entero positivo/);
  assert.throws(() => planificarVentanas({ cantidad: 1, zona: "Mars/Olympus" }), /Zona horaria inválida/);
  assert.throws(() => planificarVentanas({ cantidad: 1, ventanas: [] }), /al menos una ventana/);
  assert.throws(() => planificarVentanas({ cantidad: 1, ventanas: ["xx"] }), /Ventana inválida/);
  assert.throws(() => planificarVentanas({ cantidad: 100, ventanas: ["09:00-09:10"], separacionMin: 0, maxDias: 5 }), /no alcanzan/);
});
