// Punto de entrada: navegación por hash, cabecera con estado y registro de vistas.
// Fase 6: basta con `window.ClipLab.registrarVista({ id, titulo, icono, montar(el,{params}), desmontar() })`.
import { h, vaciar, $ } from "./ui.js";
import { api } from "./api.js";
import * as tiempo from "./tiempo.js";
import { dashboard } from "./vistas/dashboard.js";
import { clips } from "./vistas/clips.js";
import { lotes } from "./vistas/lotes.js";
import { variantes } from "./vistas/variantes.js";
import { sesiones } from "./vistas/sesiones.js";
import { vivo } from "./vistas/vivo.js";

const vistas = new Map();
let actual = null;

export function registrarVista(v) {
  vistas.set(v.id, v);
  pintarNav();
}

function pintarNav() {
  const nav = $("#nav");
  const id = rutaActual().id;
  nav.replaceChildren(...[...vistas.values()].map(v =>
    h("a", { href: `#/${v.id}`, class: v.id === id ? "activo" : "" }, h("span", { class: "ico", "aria-hidden": "true" }, v.icono || "•"), h("span", null, v.titulo))));
}

function rutaActual() {
  const [p, q = ""] = location.hash.replace(/^#\/?/, "").split("?");
  return { id: p || "dashboard", params: new URLSearchParams(q) };
}

async function navegar() {
  const { id, params } = rutaActual();
  const v = vistas.get(id) || vistas.get("dashboard");
  try { actual?.desmontar?.(); } catch (e) { console.error(e); }
  const cont = $("#vista");
  vaciar(cont);
  $("#titulo-vista").textContent = v.titulo;
  document.title = `ClipLab · ${v.titulo}`;
  actual = v;
  pintarNav();
  try { await v.montar(cont, { params }); }
  catch (e) { console.error(e); cont.replaceChildren(h("div", { class: "aviso bad" }, `No se pudo cargar la vista: ${e.message}`)); }
}

// Cabecera: modo y agente, indicador de conexión
tiempo.suscribir("estado", d => {
  const modo = $("#chip-modo"), ag = $("#chip-agente");
  modo.textContent = d.publicarReal ? "MODO REAL" : "MODO PRUEBA";
  modo.className = `chip ${d.publicarReal ? "t-bad" : "t-ok"}`;
  ag.textContent = d.agenteOcupado ? "Agente ocupado" : "Agente libre";
  ag.className = `chip ${d.agenteOcupado ? "t-run" : ""}`;
});
tiempo.alEstado((ok, msg) => {
  const c = $("#conexion");
  c.className = `conexion ${ok ? "ok" : "mal"}`;
  c.querySelector(".txt").textContent = ok ? "En línea" : `Sin conexión${msg ? ": " + msg : ""}`;
});

$("#btn-salir").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  location.href = "/";
});

// Vistas (el orden es el del menú)
[dashboard, clips, lotes, variantes, sesiones, vivo].forEach(registrarVista);
window.ClipLab = { registrarVista, api, tiempo, h };   // punto de extensión para la Fase 6
window.addEventListener("hashchange", navegar);
navegar();
