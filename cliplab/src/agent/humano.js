// Ritmo humano: pausas con distribución natural, ratón con trayectoria curva y tecleo con ráfagas.
// Todo se escala con HUMANO_FACTOR (1 = normal). La descripción se teclea dentro de un tope de tiempo
// (TYPE_BUDGET_S) para que un texto largo no haga el proceso eterno.
import { cfg } from "../config.js";

export const rnd = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
export const dormir = ms => new Promise(r => setTimeout(r, ms));
// Promedio de tres aleatorios: los valores centrales son más probables que los extremos (como las personas).
export const natural = (a, b) => a + ((Math.random() + Math.random() + Math.random()) / 3) * (b - a);
export const pausa = (a, b) => dormir(Math.round(natural(a, b) * cfg.humanoFactor));
export const pensar = () => pausa(900, 2600);
export const leer = () => pausa(1500, 4200);   // "mirar la pantalla" antes de decidir
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

// ---------- Ratón ----------

const bezier = (p0, p1, p2, p3, t) => {
  const u = 1 - t;
  return { x: u ** 3 * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t ** 3 * p3.x, y: u ** 3 * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t ** 3 * p3.y };
};
const suave = t => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);   // arranca y frena despacio

// Puntos de una curva de Bézier con aceleración/frenado y temblor leve; el último punto es exactamente `b`.
export function trayectoria(a, b, pasos) {
  const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist, ny = dx / dist;   // perpendicular
  const curva = () => (Math.random() * 2 - 1) * dist * 0.15;
  const c1 = { x: a.x + dx * 0.3 + nx * curva(), y: a.y + dy * 0.3 + ny * curva() };
  const c2 = { x: a.x + dx * 0.7 + nx * curva(), y: a.y + dy * 0.7 + ny * curva() };
  const pts = [];
  for (let i = 1; i <= pasos; i++) {
    const p = bezier(a, c1, c2, b, suave(i / pasos));
    pts.push(i === pasos ? { x: b.x, y: b.y } : { x: p.x + (Math.random() - 0.5) * 1.2, y: p.y + (Math.random() - 0.5) * 1.2 });
  }
  return pts;
}

const ultimaPos = new WeakMap();
const dentro = (page, p) => {
  const v = page.viewportSize() || { width: 1366, height: 850 };
  return { x: Math.min(v.width - 2, Math.max(2, p.x)), y: Math.min(v.height - 2, Math.max(2, p.y)) };
};

async function irA(page, destino) {
  const v = page.viewportSize() || { width: 1366, height: 850 };
  const origen = ultimaPos.get(page) || { x: rnd(40, v.width / 2), y: rnd(40, v.height / 2) };
  const dist = Math.hypot(destino.x - origen.x, destino.y - origen.y);
  const pasos = Math.min(45, Math.max(12, Math.round(dist / 14)));
  const rumbo = Math.random() < 0.2 && dist > 200   // a veces se pasa un poco y corrige, como una mano real
    ? [{ x: destino.x + rnd(-18, 18), y: destino.y + rnd(8, 20) }, destino] : [destino];
  let desde = origen;
  for (const meta of rumbo) {
    for (const p of trayectoria(desde, dentro(page, meta), meta === destino ? pasos : Math.ceil(pasos * 0.8))) {
      await page.mouse.move(p.x, p.y);
      await dormir(Math.round(rnd(3, 9) * cfg.humanoFactor));
    }
    desde = meta;
  }
  ultimaPos.set(page, destino);
}

export async function moverYClic(page, loc) {
  const el = loc.first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const box = await el.boundingBox();
  if (!box) { await el.click(); return; }
  await irA(page, { x: box.x + box.width * (0.25 + Math.random() * 0.5), y: box.y + box.height * (0.3 + Math.random() * 0.4) });
  await pausa(80, 260);
  await page.mouse.down();
  await pausa(40, 120);
  await page.mouse.up();
}

// Mirada breve a la página: un par de movimientos y un desplazamiento corto, sin hacer clic en nada.
export async function ojear(page) {
  const v = page.viewportSize() || { width: 1366, height: 850 };
  await irA(page, { x: rnd(v.width * 0.25, v.width * 0.75), y: rnd(v.height * 0.25, v.height * 0.75) });
  if (Math.random() < 0.5) { await page.mouse.wheel(0, rnd(60, 220)); await pausa(300, 900); await page.mouse.wheel(0, -rnd(40, 180)); }
  await pausa(400, 1200);
}

// ---------- Teclado ----------

// Retardo medio por tecla (ms): el configurado, pero nunca tanto como para pasarse del tope de tiempo.
export function retardoMedio(totalChars) {
  const configurado = (cfg.typeMin + cfg.typeMax) / 2;
  const tope = (cfg.typeBudgetS * 1000 * 0.8) / Math.max(1, totalChars);   // 80 %: el resto son pausas de respiro
  return Math.min(configurado, Math.max(8, tope));
}

// Escribe como una persona: una tecla a la vez, en ráfagas rápidas y lentas, con respiros tras signos y espacios.
export async function escribirHumano(page, loc, texto, { limpiar = true } = {}) {
  await moverYClic(page, loc);
  await pausa(300, 800);
  if (limpiar) {
    await page.keyboard.press("Control+A");
    await pausa(80, 200);
    await page.keyboard.press("Backspace");
    await pausa(200, 500);
  }
  const chars = [...texto];
  const media = retardoMedio(chars.length);
  let rafaga = rnd(4, 11), ritmo = natural(0.6, 1.4);
  for (const ch of chars) {
    if (ch === "\n") await page.keyboard.press("Enter");
    else await page.keyboard.type(ch);
    if (--rafaga <= 0) { rafaga = rnd(4, 11); ritmo = natural(0.6, 1.4); }
    await dormir(Math.round(natural(media * 0.5, media * 1.5) * ritmo * cfg.humanoFactor));
    if (/[\s,.;:!?]/.test(ch) && Math.random() < 0.12) await pausa(150, 450);
    if (Math.random() < 0.012) await pausa(500, 1200);
  }
}
