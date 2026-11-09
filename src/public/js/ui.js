// Utilidades de interfaz. Sin innerHTML: todo texto entra como nodo de texto (a prueba de XSS).
import { tono, evaluarDuracion } from "./esquema.js";

export function h(tag, props, ...hijos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "for") el.htmlFor = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  agregar(el, hijos);
  return el;
}
function agregar(el, k) {
  if (k === undefined || k === null || k === false) return;
  if (Array.isArray(k)) { k.forEach(x => agregar(el, x)); return; }
  el.append(k instanceof Node ? k : document.createTextNode(String(k)));
}

export const $ = (s, r = document) => r.querySelector(s);
export const vaciar = el => { el.replaceChildren(); return el; };
export const etiqueta = k => { const s = String(k).replace(/_/g, " ").trim(); return s.charAt(0).toUpperCase() + s.slice(1); };

export function fechaHora(v) {
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleString("es-DO", { dateStyle: "short", timeStyle: "short" });
}
export function hace(v) {
  const d = new Date(v);
  if (isNaN(d)) return "";
  const s = Math.round((Date.now() - d) / 1000), a = Math.abs(s);
  const [n, u] = a < 60 ? [a, "s"] : a < 3600 ? [Math.round(a / 60), "min"] : a < 86400 ? [Math.round(a / 3600), "h"] : [Math.round(a / 86400), "d"];
  return s < 0 ? `en ${n} ${u}` : `hace ${n} ${u}`;
}
export function aInputLocal(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- Avisos ----------
export function toast(msg, tipo = "ok", ms = 4500) {
  const cont = document.getElementById("toasts");
  if (!cont) return;
  const t = h("div", { class: `toast t-${tipo}`, role: tipo === "error" ? "alert" : "status" }, String(msg));
  cont.append(t);
  setTimeout(() => t.remove(), ms);
}

// ---------- Modales (<dialog> nativo) ----------
/** botones: [{ texto, clase, valor, onClick: async (cerrar, btn) => false|void }] */
export function abrirModal({ titulo, cuerpo, botones = [], ancho }) {
  const dlg = h("dialog", { class: "modal" + (ancho ? ` ${ancho}` : "") });
  let valor, resolver;
  const cerrado = new Promise(r => { resolver = r; });
  dlg.addEventListener("close", () => { dlg.remove(); resolver(valor); });
  const cerrar = v => { valor = v; if (dlg.close) dlg.close(); else dlg.dispatchEvent(new Event("close")); };
  dlg.addEventListener("click", e => { if (e.target === dlg) cerrar(); });

  const pie = h("div", { class: "modal-pie" }, botones.map(b => h("button", {
    type: "button", class: `btn ${b.clase || ""}`,
    onClick: async ev => {
      const btn = ev.currentTarget;
      if (b.onClick) {
        btn.disabled = true;
        try { if ((await b.onClick(cerrar, btn)) === false) { btn.disabled = false; return; } }
        catch (e) { toast(e.message || "Error", "error"); btn.disabled = false; return; }
      }
      cerrar(b.valor);
    }
  }, b.texto)));

  dlg.append(h("div", { class: "modal-cab" }, h("h2", null, titulo), h("button", { class: "btn ghost sm", type: "button", "aria-label": "Cerrar", onClick: () => cerrar() }, "✕")),
    h("div", { class: "modal-cuerpo" }, cuerpo), botones.length ? pie : null);
  document.body.append(dlg);
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
  return { el: dlg, cerrar, cerrado };
}

export async function confirmar(msg, { texto = "Confirmar", peligro = false } = {}) {
  const m = abrirModal({
    titulo: "¿Seguro?", cuerpo: h("p", null, msg),
    botones: [{ texto: "Cancelar", clase: "ghost", valor: false }, { texto, clase: peligro ? "danger" : "primary", valor: true }]
  });
  return (await m.cerrado) === true;
}

/** Ejecuta fn desactivando el botón y mostrando el error como toast. */
export async function conBoton(ev, fn) {
  const b = ev?.currentTarget;
  if (b) b.disabled = true;
  try { return await fn(); }
  catch (e) { toast(e.message || "Error", "error"); }
  finally { if (b) b.disabled = false; }
}

// ---------- Piezas visuales ----------
export const badge = estado => h("span", { class: `badge t-${tono(estado)}` }, String(estado ?? "—").replace(/_/g, " "));

/** Medidor de duración: escala 0–60 s; la zona ideal (30–60 s) va sombreada. Excederse = rojo. */
export function medidorDuracion(seg) {
  const ev = evaluarDuracion(seg);
  const relleno = h("span", { class: "medidor-relleno" });
  relleno.style.width = seg == null || isNaN(seg) ? "0%" : `${Math.min(100, Math.max(0, (seg / 60) * 100))}%`;
  return h("div", { class: `medidor n-${ev.nivel}`, title: ev.ayuda },
    h("div", { class: "medidor-pista" }, h("span", { class: "zona-ideal" }), relleno),
    h("span", { class: "medidor-txt" }, ev.texto));
}

export const chipDuracion = seg => {
  const ev = evaluarDuracion(seg);
  return h("span", { class: `chip dur n-${ev.nivel}`, title: ev.ayuda }, ev.texto);
};
