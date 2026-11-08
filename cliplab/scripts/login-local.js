// Se ejecuta en TU equipo: abre un navegador visible, inicias sesión a mano (captcha/2FA incluidos)
// y la sesión se sube cifrada al servidor.
import { chromium } from "playwright";
import fs from "node:fs";
import readline from "node:readline/promises";
import { PERFIL } from "../src/agent/perfil.js";

const URLS = {
  tiktok: "https://www.tiktok.com/login",
  instagram: "https://www.instagram.com/accounts/login/",
  facebook: "https://www.facebook.com/login"
};
const plat = process.argv[2];
if (!URLS[plat]) {
  console.log("Uso: CLIPLAB_URL=https://tu-app.up.railway.app MASTER_KEY=... npm run login -- tiktok|instagram|facebook");
  process.exit(1);
}
const base = (process.env.CLIPLAB_URL || "").replace(/\/$/, "");
const key = process.env.MASTER_KEY || "";

const browser = await chromium.launch({ headless: false, args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await browser.newContext(PERFIL);
const page = await ctx.newPage();
await page.goto(URLS[plat]);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question(`Inicia sesión en ${plat} en la ventana abierta. Cuando veas tu cuenta, vuelve aquí y presiona Enter... `);
rl.close();
const estado = await ctx.storageState();
await browser.close();

if (base && key) {
  const r = await fetch(`${base}/api/sesiones/${plat}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify(estado)
  });
  if (r.ok) { console.log("Sesión subida al servidor."); process.exit(0); }
  console.log("El servidor respondió", r.status, await r.text());
}
const f = `sesion-${plat}.json`;
fs.writeFileSync(f, JSON.stringify(estado), { mode: 0o600 });
console.log(`Guardada en ${f}. Súbela desde el panel (Sesiones) y luego bórrala. No la subas a GitHub.`);
