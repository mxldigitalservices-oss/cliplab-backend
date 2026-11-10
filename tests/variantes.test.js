import test from "node:test";
import assert from "node:assert/strict";
const { validarVariantes, variantesPlantilla, construirVariantes, resumenVariante, generarVariantesIA } = await import("../src/variantes.js");

const base = { titulo: "Cómo ahorrar dinero rápido", gancho: "Nadie te lo explica así", descripcion: "Tres hábitos simples.", cta: "Sígueme", hashtags: ["#ahorro"], categoria: "Finanzas", angulo: "Valor" };

test("validarVariantes: limpia, recorta y descarta repetidas (incluida la del clip base)", () => {
  const raw = [
    { titulo: "  El truco\n que cambia   todo ", gancho: "g", descripcion: "d", cta: "c", hashtags: ["ahorro", "#Dinero!", "#ahorro"], angulo: "Valor" },
    { titulo: "COMO AHORRAR DINERO RAPIDO" },            // igual al base sin tildes/mayúsculas
    { titulo: "el truco que cambia todo" },               // repetida entre sí
    { titulo: "" }, null, { gancho: "sin título" },
    { titulo: "x".repeat(300) }
  ];
  const r = validarVariantes(raw, base);
  assert.equal(r.length, 2);
  assert.equal(r[0].titulo, "El truco que cambia todo");
  assert.deepEqual(r[0].hashtags, ["#ahorro", "#Dinero"]);
  assert.equal(r[1].titulo.length, 100);
});

test("validarVariantes: respeta max y títulos ya usados", () => {
  const raw = Array.from({ length: 10 }, (_, i) => ({ titulo: `Título ${i}` }));
  assert.equal(validarVariantes(raw, base, { max: 3 }).length, 3);
  assert.equal(validarVariantes(raw, base, { usados: ["Título 0", "titulo 1"] }).length, 8);
  assert.equal(validarVariantes("no es lista", base).length, 0);
});

test("variantesPlantilla: hasta 12, todas distintas, ≤100 caracteres y con el hashtag base", () => {
  const largo = { ...base, titulo: "Un título larguísimo ".repeat(10) };
  const r = validarVariantes(variantesPlantilla(largo, 12), largo, { max: 20, origen: "plantilla" });
  assert.equal(r.length, 12);
  assert.equal(new Set(r.map(v => v.titulo)).size, 12);
  assert.ok(r.every(v => v.titulo.length <= 100 && v.cta && v.hashtags.includes("#ahorro")));
  assert.equal(variantesPlantilla(base, 50).length, 12);
});

test("construirVariantes: IA primero, plantillas para completar, con avisos", async () => {
  const generar = async () => ({ texto: JSON.stringify([{ titulo: "Ángulo IA 1", gancho: "g", descripcion: "d", cta: "c", hashtags: ["#a"], angulo: "Valor" }, { titulo: "Ángulo IA 2", gancho: "g", descripcion: "d", cta: "c", hashtags: ["#a"], angulo: "Emoción" }]) });
  const { lista, avisos } = await construirVariantes(base, 5, { generar });
  assert.equal(lista.length, 5);
  assert.deepEqual(lista.map(v => v.origen), ["ia", "ia", "plantilla", "plantilla", "plantilla"]);
  assert.match(avisos[0], /3 variante/);
});

test("construirVariantes: si la IA falla, todo sale de plantillas; si piden más de las posibles, avisa", async () => {
  const cae = async () => { throw new Error("sin llaves"); };
  const a = await construirVariantes(base, 4, { generar: cae });
  assert.equal(a.lista.length, 4);
  assert.ok(a.lista.every(v => v.origen === "plantilla"));
  const b = await construirVariantes(base, 20, { generar: cae });
  assert.equal(b.lista.length, 12);
  assert.ok(b.avisos.some(x => /12 de 20/.test(x)));
});

test("generarVariantesIA: acepta {variantes:[...]} y tolera JSON roto", async () => {
  assert.equal((await generarVariantesIA(base, 2, { generar: async () => ({ texto: '{"variantes":[{"titulo":"a"}]}' }) })).length, 1);
  assert.deepEqual(await generarVariantesIA(base, 2, { generar: async () => ({ texto: "no json" }) }), []);
});

test("resumenVariante: todos los casos", () => {
  const P = ["tiktok", "instagram"];
  assert.equal(resumenVariante(P, { tiktok: "ok", instagram: "ok" }), "publicada");
  assert.equal(resumenVariante(P, { tiktok: "simulado", instagram: "simulado" }), "simulada");
  assert.equal(resumenVariante(P, { tiktok: "ok", instagram: "error" }), "parcial");
  assert.equal(resumenVariante(P, { tiktok: "ok" }), "parcial");
  assert.equal(resumenVariante(P, { tiktok: "error", instagram: "error" }), "error");
  assert.equal(resumenVariante(P, {}), "error");
  assert.equal(resumenVariante(P, { tiktok: "ok", instagram: "incierto" }), "incierta");
  assert.equal(resumenVariante(["tiktok"], { tiktok: "simulado" }), "simulada");
});
