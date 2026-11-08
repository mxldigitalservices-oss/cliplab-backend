// Contexto de navegador con la sesión persistente (cookies) guardada y cifrada en Postgres.
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { cfg } from "../config.js";
import { cargarSesion, guardarSesion } from "../sesiones.js";
import { PERFIL } from "./perfil.js";

let ocupado = false;
export const agenteOcupado = () => ocupado;

function proxy() {
  if (!cfg.proxy) return {};
  const u = new URL(cfg.proxy);
  return { proxy: { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } };
}

async function podarEvidencias(dir) {
  const l = (await fs.readdir(dir).catch(() => [])).sort();
  for (const n of l.slice(0, Math.max(0, l.length - 40))) await fs.unlink(`${dir}/${n}`).catch(() => {});
}

export async function conSesion(plataforma, etiqueta, fn, { guardar = true } = {}) {
  if (ocupado) throw new Error("El agente está ocupado con otra tarea.");
  ocupado = true;
  let browser;
  try {
    const estado = await cargarSesion(plataforma);
    if (!estado) { const e = new Error(`No hay sesión de ${plataforma}. Súbela desde el panel.`); e.sesion = true; throw e; }
    browser = await chromium.launch({
      headless: cfg.headless,
      args: ["--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
      ...proxy()
    });
    const ctx = await browser.newContext({ storageState: estado, ...PERFIL });
    ctx.setDefaultTimeout(30000);
    ctx.setDefaultNavigationTimeout(60000);
    const page = await ctx.newPage();
    const dir = `${cfg.dataDir}/evidencias`;
    const ev = async nombre => {
      await fs.mkdir(dir, { recursive: true });
      const f = `${dir}/${Date.now()}-${plataforma}-${etiqueta}-${nombre}.png`;
      await page.screenshot({ path: f }).catch(() => {});
      await podarEvidencias(dir);
      return f;
    };
    try {
      const r = await fn(page, ev);
      if (guardar) await guardarSesion(plataforma, await ctx.storageState()).catch(() => {});
      return r;
    } catch (e) {
      await ev("error").catch(() => {});
      throw e;
    }
  } finally {
    await browser?.close().catch(() => {});
    ocupado = false;
  }
}
