import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lanzador } from "./_navegador.js";

process.env.MASTER_KEY = "clave-maestra-de-prueba-123";
process.env.HUMANO_FACTOR = "0.05";   // pruebas rápidas: mismas curvas y aleatoriedad, esperas casi nulas
process.env.TYPE_BUDGET_S = "20";
const { trayectoria, retardoMedio, natural, escribirHumano, moverYClic, esperarHasta, ojear } = await import("../src/agent/humano.js");
const { conSesion } = await import("../src/agent/browser.js");

const lanzar = await lanzador();
const sinNavegador = !lanzar && "no hay Chromium disponible";

test("trayectoria: curva suave que termina exactamente en el destino", () => {
  const pts = trayectoria({ x: 0, y: 0 }, { x: 500, y: 300 }, 30);
  assert.equal(pts.length, 30);
  assert.deepEqual(pts.at(-1), { x: 500, y: 300 });
  const rectaY = pts.slice(0, -1).map(p => Math.abs(p.y - p.x * 0.6));
  assert.ok(Math.max(...rectaY) > 1, "no es una línea recta perfecta");
  const paso = pts.map((p, i) => Math.hypot(p.x - (pts[i - 1]?.x ?? 0), p.y - (pts[i - 1]?.y ?? 0)));
  assert.ok(paso[15] > paso[1] && paso[15] > paso.at(-2), "más rápido en medio que al arrancar y al frenar");
});

test("retardoMedio respeta el tope de tiempo y 'natural' queda dentro del rango", () => {
  assert.ok(retardoMedio(10) <= 115);
  assert.ok(retardoMedio(600) * 600 <= 20 * 1000 * 0.8 + 1, "una descripción de 600 caracteres cabe en el tope");
  for (let i = 0; i < 500; i++) { const v = natural(10, 20); assert.ok(v >= 10 && v <= 20); }
});

test("esperarHasta: resuelve cuando se cumple y falla con mensaje claro al agotarse", async () => {
  let n = 0;
  await esperarHasta(async () => ++n >= 3, { timeoutMs: 5000, cadaMs: [5, 10] });
  assert.equal(n, 3);
  await assert.rejects(esperarHasta(async () => false, { timeoutMs: 60, etiqueta: "nada", cadaMs: [5, 10] }), /Tiempo agotado.*nada/);
});

const PAGINA = `<!doctype html><meta charset=utf-8><body style="height:2000px"><div id=ed contenteditable=true role=textbox style="border:1px solid;min-height:60px"></div>
<button id=b onclick="window.n=(window.n||0)+1;this.textContent='clic '+window.n">Publicar</button></body>`;

test("escribirHumano y moverYClic en un navegador real", { skip: sinNavegador }, async () => {
  const b = await lanzar({ headless: true });
  try {
    const page = await (await b.newContext({ viewport: { width: 1366, height: 850 } })).newPage();
    await page.setContent(PAGINA);
    const texto = "Título con acentos ñ y emoji 🎬\n\nDescripción: ¡lista! #cliplab";
    await page.evaluate(() => { document.getElementById("ed").textContent = "texto previo"; });
    await escribirHumano(page, page.locator("#ed"), texto, { limpiar: true });
    const plano = s => s.replace(/\n+/g, "\n");   // innerText de un contenteditable cuenta los saltos de línea de más
    assert.equal(plano(await page.locator("#ed").innerText()), plano(texto), "el texto sale exacto, incluido el borrado previo");
    await moverYClic(page, page.locator("#b"));
    assert.equal(await page.evaluate(() => window.n), 1);
    assert.equal(await page.locator("#b").innerText(), "clic 1");
    await ojear(page);
  } finally { await b.close(); }
});

test("conSesion: carga cookies, las renueva al terminar y marca 'incierto' tras el clic final", { skip: sinNavegador }, async () => {
  const srv = http.createServer((_, res) => { res.setHeader("Set-Cookie", "renovada=1; Path=/"); res.setHeader("Content-Type", "text/html"); res.end("<title>ok</title>"); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const estado = { cookies: [{ name: "sessionid", value: "secreta", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }], origins: [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cliplab-ev-"));
  const guardados = [], vencidas = [];
  const deps = { cargar: async () => estado, guardar: async (p, st, o) => guardados.push({ p, st, o }), vencida: async (p, m) => vencidas.push({ p, m }), launch: lanzar, dirEvidencias: dir };
  try {
    // 1) éxito: la sesión llega al navegador y se guarda renovada, sin borrar el resultado de pruebas (nueva:false)
    const visto = await conSesion("tiktok", "t1", async page => { await page.goto(url); return page.evaluate(() => document.cookie); }, { deps });
    assert.match(visto, /sessionid=secreta/);
    assert.equal(guardados.length, 1);
    assert.deepEqual(guardados[0].o, { nueva: false });
    assert.ok(guardados[0].st.cookies.some(c => c.name === "renovada"), "cookies nuevas guardadas");

    // 2) fallo antes del clic: error normal, con captura de evidencia
    await assert.rejects(conSesion("tiktok", "t2", async () => { throw new Error("no cargó"); }, { deps }), e => !e.incierto && /no cargó/.test(e.message));
    assert.ok(fs.readdirSync(dir).some(n => n.endsWith("-error.png")));

    // 3) fallo después del clic final: incierto
    await assert.rejects(conSesion("tiktok", "t3", async (page, ev, ctl) => { ctl.clic(); throw new Error("sin confirmación"); }, { deps }), e => e.incierto === true);
    assert.equal(guardados.length, 1, "no se guarda estado tras un fallo");

    // 4) sesión vencida: se marca en el panel
    await assert.rejects(conSesion("tiktok", "t4", async () => { const e = new Error("Sesión de TikTok vencida"); e.sesion = true; throw e; }, { deps }), /vencida/);
    assert.deepEqual(vencidas.map(v => v.p), ["tiktok"]);

    // 5) sin sesión guardada
    await assert.rejects(conSesion("tiktok", "t5", async () => {}, { deps: { ...deps, cargar: async () => null } }), /No hay sesión de tiktok/);
    assert.equal(vencidas.length, 2);

    // 6) el agente no se queda "ocupado" tras errores, y no admite dos tareas a la vez
    let segunda;
    const primera = conSesion("tiktok", "t6", async () => { segunda = await conSesion("tiktok", "t7", async () => {}, { deps }).then(() => "entró", e => e.message); }, { deps });
    await primera;
    assert.match(segunda, /ocupado/);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
