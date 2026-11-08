// Ayuda para pruebas: lanza Chromium (el de Playwright o, si no está, cualquiera instalado) o devuelve null para omitirlas.
import fs from "node:fs";
import { chromium } from "playwright";

function buscar() {
  if (process.env.CLIPLAB_CHROMIUM) return process.env.CLIPLAB_CHROMIUM;
  for (const raiz of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", `${process.env.HOME}/.cache/ms-playwright`].filter(Boolean)) {
    for (const d of fs.existsSync(raiz) ? fs.readdirSync(raiz).filter(n => n.startsWith("chromium-")).sort().reverse() : []) {
      for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) if (fs.existsSync(`${raiz}/${d}/${sub}`)) return `${raiz}/${d}/${sub}`;
    }
  }
  return null;
}

export async function lanzador() {
  const intentos = [o => chromium.launch(o)];
  const ruta = buscar();
  if (ruta) intentos.push(o => chromium.launch({ ...o, executablePath: ruta }));
  for (const f of intentos) {
    try { const b = await f({ headless: true }); await b.close(); return o => f(o); } catch { /* siguiente */ }
  }
  return null;
}
