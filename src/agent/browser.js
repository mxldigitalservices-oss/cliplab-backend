// Contexto de navegador con la sesión persistente (cookies) guardada y cifrada en Postgres.
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { cfg } from "../config.js";
import { cargarSesion, guardarSesion, marcarVencida } from "../sesiones.js";
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

// fn(page, ev, ctl): ctl.clic() se llama justo antes de pulsar el botón final de publicar. Si algo falla
// después, el error sale marcado con `incierto` (el post pudo haberse publicado) y NO debe reintentarse a ciegas.
// deps (solo pruebas): { cargar, guardar, vencida, launch, dirEvidencias }
export async function conSesion(plataforma, etiqueta, fn, { guardar = true, deps = {} } = {}) {
  if (ocupado) throw new Error("El agente está ocupado con otra tarea.");
  ocupado = true;
  let browser, clicHecho = false;
  try {
    const estado = await (deps.cargar || cargarSesion)(plataforma);
    if (!estado) { const e = new Error(`No hay sesión de ${plataforma}. Súbela desde el panel.`); e.sesion = true; throw e; }
    browser = await (deps.launch || (o => chromium.launch(o)))({
      headless: cfg.headless,
      args: ["--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
      ...proxy()
    });
    const ctx = await browser.newContext({ storageState: estado, ...PERFIL });
    ctx.setDefaultTimeout(30000);
    ctx.setDefaultNavigationTimeout(60000);
    const page = await ctx.newPage();
    const dir = deps.dirEvidencias || `${cfg.dataDir}/evidencias`;
    const ev = async nombre => {
      await fs.mkdir(dir, { recursive: true });
      const f = `${dir}/${Date.now()}-${plataforma}-${etiqueta}-${nombre}.png`;
      await page.screenshot({ path: f }).catch(() => {});
      await podarEvidencias(dir);
      return f;
    };
    try {
      const r = await fn(page, ev, { clic: () => { clicHecho = true; } });
      if (guardar) await (deps.guardar || guardarSesion)(plataforma, await ctx.storageState(), { nueva: false }).catch(() => {});   // renueva cookies
      return r;
    } catch (e) {
      await ev("error").catch(() => {});
      if (clicHecho) e.incierto = true;
      throw e;
    }
  } catch (e) {
    if (e.sesion) await (deps.vencida || marcarVencida)(plataforma, e.message).catch(() => {});
    throw e;
  } finally {
    await browser?.close().catch(() => {});
    ocupado = false;
  }
}
