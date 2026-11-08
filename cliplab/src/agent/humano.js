// Comportamiento humano: teclado carácter por carácter, ratón con trayectoria y esperas reguladas.
import { cfg } from "../config.js";

export const rnd = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
export const dormir = ms => new Promise(r => setTimeout(r, ms));
export const pausa = (a, b) => dormir(rnd(a, b));
export const pensar = () => pausa(900, 2600);
export const visible = (loc, ms = 3000) => loc.first().waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);

export async function esperarHasta(cond, { timeoutMs = cfg.uploadTimeoutMs, etiqueta = "condición", cadaMs = [2000, 4000] } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await cond().catch(() => false)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Tiempo agotado (${Math.round(timeoutMs / 1000)} s) esperando: ${etiqueta}`);
    await pausa(cadaMs[0], cadaMs[1]);
  }
}

export async function encontrarFrame(page, selector, timeoutMs = 60000) {
  let hallado = null;
  await esperarHasta(async () => {
    for (const f of page.frames()) {
      if (await f.locator(selector).count().catch(() => 0)) { hallado = f; return true; }
    }
    return false;
  }, { timeoutMs, etiqueta: `elemento ${selector}`, cadaMs: [1000, 2000] });
  return hallado;
}

export async function moverYClic(page, loc) {
  const el = loc.first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const box = await el.boundingBox();
  if (!box) { await el.click(); return; }
  const x = box.x + box.width * (0.25 + Math.random() * 0.5);
  const y = box.y + box.height * (0.3 + Math.random() * 0.4);
  await page.mouse.move(x - rnd(40, 160), y - rnd(20, 90));
  await page.mouse.move(x, y, { steps: rnd(12, 28) });
  await pausa(80, 260);
  await page.mouse.down();
  await pausa(40, 120);
  await page.mouse.up();
}

// Escribe como una persona: una tecla a la vez, con retardo variable entre pulsaciones.
export async function escribirHumano(page, loc, texto, { limpiar = true } = {}) {
  await moverYClic(page, loc);
  await pausa(300, 800);
  if (limpiar) {
    await page.keyboard.press("Control+A");
    await pausa(80, 200);
    await page.keyboard.press("Backspace");
    await pausa(200, 500);
  }
  for (const ch of texto) {
    if (ch === "\n") await page.keyboard.press("Enter");
    else await page.keyboard.type(ch);
    await pausa(cfg.typeMin, cfg.typeMax);
    if (/[\s,.;:!?]/.test(ch) && Math.random() < 0.12) await pausa(200, 650);
    if (Math.random() < 0.015) await pausa(700, 1600);
  }
}
