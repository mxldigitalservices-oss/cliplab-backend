// Instagram web: Crear → Publicación (video = Reel) → Siguiente ×2 → descripción → Compartir.
import { moverYClic, escribirHumano, pausa, pensar, esperarHasta, visible } from "./humano.js";

const vencida = () => { const e = new Error("Sesión de Instagram vencida: súbela de nuevo."); e.sesion = true; return e; };
const BTN = {
  siguiente: /^(Siguiente|Next)$/i,
  compartir: /^(Compartir|Share)$/i,
  ok: /^(OK|Aceptar)$/i,
  ahoraNo: /^(Ahora no|Not now)$/i
};

export async function probar(page) {
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
  await pausa(2500, 4500);
  const login = await visible(page.locator('input[name="username"]'), 3000);
  return { ok: !login && !/accounts\/login/.test(page.url()), detalle: page.url() };
}

export async function publicar(page, { archivo, caption, real, ev, ctl }) {
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
  await pensar();
  if (await visible(page.locator('input[name="username"]'), 4000)) throw vencida();

  const ahoraNo = page.getByRole("button", { name: BTN.ahoraNo }).first();
  if (await visible(ahoraNo, 3000)) { await moverYClic(page, ahoraNo); await pensar(); }

  await moverYClic(page, page.locator('svg[aria-label="Nueva publicación"], svg[aria-label="New post"]'));
  await pensar();
  const opcion = page.getByText(/^(Publicación|Post)$/).first();
  if (await visible(opcion, 4000)) { await moverYClic(page, opcion); await pensar(); }

  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 30000 });
  await input.setInputFiles(archivo);

  const ok = page.getByRole("button", { name: BTN.ok }).first();
  if (await visible(ok, 10000)) { await moverYClic(page, ok); await pensar(); }

  const sig = page.getByRole("button", { name: BTN.siguiente }).first();
  for (let i = 1; i <= 2; i++) {
    await esperarHasta(async () => await sig.isVisible(), { etiqueta: `botón Siguiente ${i} en Instagram` });
    await pensar();
    await moverYClic(page, sig);
    await pensar();
  }

  const caja = page.getByRole("textbox", { name: /(Escribe una descripción|Write a caption)/i })
    .or(page.locator('div[contenteditable="true"][role="textbox"]')).first();
  await caja.waitFor({ state: "visible", timeout: 60000 });
  await escribirHumano(page, caja, caption, { limpiar: true });

  const compartir = page.getByRole("button", { name: BTN.compartir }).first();
  await esperarHasta(async () => await compartir.isVisible(), { etiqueta: "botón Compartir en Instagram", timeoutMs: 120000 });
  await pensar();
  await ev("listo-para-publicar");
  if (!real) return { simulado: true, detalle: "Modo prueba: se llegó hasta Compartir sin pulsarlo." };

  ctl?.clic();
  await moverYClic(page, compartir);
  const exito = page.getByText(/(Se compartió tu reel|Tu reel se ha compartido|Reel compartido|Your reel has been shared|Reel shared)/i).first();
  await esperarHasta(async () => await exito.isVisible(), { etiqueta: "confirmación de que el reel se compartió" });
  await ev("publicado");
  return { detalle: "Reel compartido en Instagram" };
}
