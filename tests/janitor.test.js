import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cliplab-j-"));
process.env.CLIPS_DIR = dir;
const { decidir, limpiar, borrarArchivoClip } = await import("../src/janitor.js");

const T = n => `${n}`.padStart(12, "0");
const tok = n => `00000000-0000-0000-0000-${T(n)}`;
const crear = (nombre, minutos, bytes = 100) => {
  const p = path.join(dir, nombre); fs.writeFileSync(p, Buffer.alloc(bytes));
  const t = new Date(Date.now() - minutos * 60e3); fs.utimesSync(p, t, t); return p;
};

test("decidir: reglas de borrado", () => {
  const ahora = Date.now(), ttlMs = 48 * 3600e3;
  const f = (n, min) => ({ n, p: `/x/${n}`, st: { mtimeMs: ahora - min * 60e3 } });
  const ctx = (refs, ocupados = []) => ({ ahora, ttlMs, ocupados: new Set(ocupados), refs: new Map(refs), lleno: false });
  assert.equal(decidir(f(`clip-${tok(1)}.mp4`, 1), ctx([[`/x/clip-${tok(1)}.mp4`, "publicado"]])), "publicado");
  assert.equal(decidir(f(`clip-${tok(2)}.mp4`, 1), ctx([])), null, "recién nacido, en gracia");
  assert.equal(decidir(f(`clip-${tok(2)}.mp4`, 20), ctx([])), "huérfano");
  assert.equal(decidir(f(`clip-${tok(3)}.mp4`, 60 * 49), ctx([[`/x/clip-${tok(3)}.mp4`, "listo"]])), "ttl");
  assert.equal(decidir(f(`clip-${tok(4)}.mp4`, 60), ctx([[`/x/clip-${tok(4)}.mp4`, "listo"]])), null);
  assert.equal(decidir(f(`clip-${tok(5)}.mp4`, 60 * 100), ctx([[`/x/clip-${tok(5)}.mp4`, "cortando"]], [tok(5)])), null, "ocupado jamás");
  assert.equal(decidir(f(`raw-${tok(6)}.mp4`, 45), ctx([])), "temporal");
  assert.equal(decidir(f(`sub-${tok(6)}.ass`, 5), ctx([])), null);
  assert.equal(decidir({ ...f(`clip-${tok(7)}.mp4`, 60), }, { ...ctx([[`/x/clip-${tok(7)}.mp4`, "listo"]]), lleno: true }), "disco");
});

test("limpiar: borra publicados, huérfanos y temporales; conserva lo útil; marca la base", async () => {
  const pub = crear(`clip-${tok(1)}.mp4`, 5), huer = crear(`clip-${tok(2)}.mp4`, 30), listo = crear(`clip-${tok(3)}.mp4`, 30);
  const ocup = crear(`clip-${tok(4)}.mp4`, 9999), raw = crear(`raw-${tok(5)}.mp4`, 90), ass = crear(`sub-${tok(6)}.ass`, 2);
  fs.mkdirSync(path.join(dir, "tr-abc")); const t = new Date(Date.now() - 90 * 60e3); fs.utimesSync(path.join(dir, "tr-abc"), t, t);
  const updates = [];
  const consulta = async (sql, params) => {
    if (sql.startsWith("SELECT")) return { rows: [
      { token: tok(1), archivo: pub, estado: "publicado" }, { token: tok(3), archivo: listo, estado: "listo" }, { token: tok(4), archivo: ocup, estado: "publicando" }] };
    updates.push(params); return { rows: [] };
  };
  const r = await limpiar({ consulta });
  assert.deepEqual([pub, huer, raw].map(fs.existsSync), [false, false, false]);
  assert.deepEqual([listo, ocup, ass].map(fs.existsSync), [true, true, true]);
  assert.ok(!fs.existsSync(path.join(dir, "tr-abc")));
  assert.deepEqual(updates, [[pub]]);
  assert.equal(r.borrados, 4);
});

test("borrarArchivoClip: borra el archivo, deja constancia y no toca clips ocupados", async () => {
  const p = crear(`clip-${tok(9)}.mp4`, 1);
  const llamadas = [];
  const mk = estado => async (sql, params) => { llamadas.push(sql.split(" ")[0]); return sql.startsWith("SELECT") ? { rows: [{ archivo: p, estado }] } : { rows: [] }; };
  assert.equal(await borrarArchivoClip(9, "expirado", { consulta: mk("publicando") }), false);
  assert.ok(fs.existsSync(p));
  assert.equal(await borrarArchivoClip(9, "expirado", { consulta: mk("publicado") }), true);
  assert.ok(!fs.existsSync(p));
  assert.ok(llamadas.includes("UPDATE"));
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
