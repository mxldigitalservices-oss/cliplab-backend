// TikTok Studio (web). Los selectores se calibran con las capturas de evidencia.
import { moverYClic, escribirHumano, pausa, pensar, esperarHasta, encontrarFrame } from "./humano.js";

const STUDIO = "https://www.tiktok.com/tiktokstudio/upload?from=upload";
const vencida = () => { const e = new Error("Sesión de TikTok vencida: súbela de nuevo."); e.sesion = true; return e; };

export async function probar(page) {
  await page.goto("https://www.tiktok.com/tiktokstudio", { waitUntil: "domcontentloaded" });
  await pausa(2500, 4500);
  const u = page.url();
  return { ok: /tiktokstudio/.test(u) && !/login|passport/.test(u), detalle: u };
}

export async function publicar(page, { archivo, caption, real, ev, ctl }) {
  await page.goto(STUDIO, { waitUntil: "domcontentloaded" });
  await pensar();
  if (/login|passport/.test(page.url())) throw vencida();

  const frame = await encontrarFrame(page, 'input[type="file"]', 60000);
  await frame.locator('input[type="file"]').first().setInputFiles(archivo);
  await pensar();

  // TikTok rellena la descripción con el nombre del archivo: se borra y se escribe a mano.
  const editor = frame.locator('div[contenteditable="true"]').first();
  await editor.waitFor({ state: "visible", timeout: 90000 });
  await escribirHumano(page, editor, caption, { limpiar: true });

  const post = frame.locator('[data-e2e="post_video_button"]').or(frame.getByRole("button", { name: /^(Publicar|Post)$/i })).first();
  const subiendo = frame.getByText(/\b(Subiendo|Uploading)\b/i).first();
  await esperarHasta(
    async () => (await post.isEnabled()) && !(await subiendo.isVisible().catch(() => false)),
    { etiqueta: "fin de la subida del video en TikTok" }
  );
  await pensar();
  await ev("listo-para-publicar");
  if (!real) return { simulado: true, detalle: "Modo prueba: se llegó hasta el botón Publicar sin pulsarlo." };

  ctl?.clic();   // desde aquí, un fallo ya no se puede reintentar a ciegas
  await moverYClic(page, post);
  const confirmar = frame.getByRole("button", { name: /(Publicar ahora|Post now)/i }).first();
  await esperarHasta(async () => {
    if (await confirmar.isVisible().catch(() => false)) await moverYClic(page, confirmar);
    return /tiktokstudio\/content/.test(page.url());
  }, { timeoutMs: 120000, etiqueta: "confirmación de publicación en TikTok", cadaMs: [1500, 3000] });
  await ev("publicado");
  return { detalle: page.url() };
}
