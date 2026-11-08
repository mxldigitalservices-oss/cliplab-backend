// Facebook Reels (web). Usa FB_REELS_URL (para Páginas, la URL de Meta Business Suite).
import { cfg } from "../config.js";
import { moverYClic, escribirHumano, pausa, pensar, esperarHasta, visible } from "./humano.js";

const vencida = () => { const e = new Error("Sesión de Facebook vencida: súbela de nuevo."); e.sesion = true; return e; };

export async function probar(page) {
  await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded" });
  await pausa(2500, 4500);
  const login = await visible(page.locator('input[name="email"]'), 3000);
  return { ok: !login && !/login|checkpoint/.test(page.url()), detalle: page.url() };
}

export async function publicar(page, { archivo, caption, real, ev, ctl }) {
  await page.goto(cfg.fbReelsUrl, { waitUntil: "domcontentloaded" });
  await pensar();
  if (/login|checkpoint/.test(page.url())) throw vencida();

  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 60000 });
  await input.setInputFiles(archivo);
  await pensar();

  const caja = page.locator('div[role="textbox"][contenteditable="true"]').first();
  const sig = page.getByRole("button", { name: /^(Siguiente|Next)$/i }).first();
  for (let i = 0; i < 4 && !(await visible(caja, 4000)); i++) {
    await esperarHasta(async () => (await sig.isVisible()) && (await sig.isEnabled()), { etiqueta: `botón Siguiente ${i + 1} en Facebook` });
    await pensar();
    await moverYClic(page, sig);
    await pensar();
  }
  await caja.waitFor({ state: "visible", timeout: 60000 });
  await escribirHumano(page, caja, caption, { limpiar: true });

  const publicarBtn = page.getByRole("button", { name: /^(Publicar|Publish)$/i }).first();
  await esperarHasta(async () => (await publicarBtn.isVisible()) && (await publicarBtn.isEnabled()), { etiqueta: "fin de la subida y botón Publicar en Facebook" });
  await pensar();
  await ev("listo-para-publicar");
  if (!real) return { simulado: true, detalle: "Modo prueba: se llegó hasta Publicar sin pulsarlo." };

  ctl?.clic();
  await moverYClic(page, publicarBtn);
  const exito = page.getByText(/(Tu reel (se publicó|está publicado)|se está publicando|is being published|Your reel (is|has been) (published|shared))/i).first();
  await esperarHasta(
    async () => (await exito.isVisible().catch(() => false)) || !page.url().includes("/reels/create"),
    { timeoutMs: 180000, etiqueta: "confirmación de publicación en Facebook" }
  );
  await ev("publicado");
  return { detalle: page.url() };
}
