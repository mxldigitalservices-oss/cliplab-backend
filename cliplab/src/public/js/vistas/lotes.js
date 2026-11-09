// Control de lotes: crear lote de cortes, pausar / reanudar / cancelar, detalle con eventos en vivo y ciclos de 10–20.
import { h, toast, badge, hace, fechaHora, medidorDuracion, chipDuracion } from "../ui.js";
import { api } from "../api.js";
import { suscribir, refrescar, definirCanal, quitarCanal } from "../tiempo.js";
import { pintar, vacio, tarjetaLote, tablaCiclos, generico } from "../componentes.js";
import { loteTerminal, duracionDe, evaluarDuracion, DURACION, pick } from "../esquema.js";

let bajas = [];
let detalleBajas = [];
let detalleCanales = [];

function cerrarDetalle(box) {
  detalleBajas.forEach(f => f()); detalleBajas = [];
  detalleCanales.forEach(quitarCanal); detalleCanales = [];
  box.replaceChildren();
}

function abrirDetalle(box, lote) {
  cerrarDetalle(box);
  const cDet = `lote:${lote.id}`, cEv = `lote-ev:${lote.id}`;
  definirCanal(cDet, { fetcher: () => api.get(`/lotes/${lote.id}`), ms: 3000 });
  definirCanal(cEv, { fetcher: () => api.get(`/lotes/${lote.id}/eventos?limite=60`), ms: 3000 });
  detalleCanales = [cDet, cEv];
  const cuerpo = h("div"), eventos = h("div", { class: "eventos" });
  box.append(h("div", { class: "card" },
    h("div", { class: "card-h" }, h("h2", null, `Detalle del lote #${lote.id}`), h("button", { type: "button", class: "btn sm ghost", onClick: () => cerrarDetalle(box) }, "Cerrar")),
    cuerpo, h("h3", null, "Eventos recientes"), eventos));
  box.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  detalleBajas.push(suscribir(cDet, d => pintar(cuerpo, d, () => generico(d ?? {}))));
  detalleBajas.push(suscribir(cEv, d => pintar(eventos, d, () => {
    const lista = Array.isArray(d) ? d : (d?.eventos || []);
    if (!lista.length) return vacio("Sin eventos todavía.");
    return h("ul", { class: "lista-eventos" }, lista.map(e => h("li", null,
      h("span", { class: "muted sm" }, e.creado_en ? fechaHora(e.creado_en) : ""),
      e.nivel ? badge(e.nivel) : null,
      h("span", null, String(pick(e, ["mensaje", "texto", "detalle", "evento", "tipo"], JSON.stringify(e)))))));
  })));
}

export const lotes = {
  id: "lotes", titulo: "Lotes y ciclos", icono: "☰",
  montar(el, { params } = {}) {
    let clipsData = [], loteData = [], solo = "activos";
    const seleccion = new Set();

    // --- Crear lote de cortes ---
    const nombre = h("input", { type: "text", placeholder: "Nombre del lote (opcional)" });
    const listaClips = h("div", { class: "lista-sel" });
    const resumen = h("span", { class: "muted sm" });
    const btnCrear = h("button", { type: "submit", class: "btn primary" }, "Crear lote");
    const form = h("form", { class: "card", onSubmit: async ev => {
      ev.preventDefault();
      if (!seleccion.size) return toast("Selecciona al menos un clip.", "error");
      btnCrear.disabled = true;
      try {
        await api.post("/lotes", { nombre: nombre.value.trim() || undefined, clip_ids: [...seleccion].map(Number) });
        toast(`Lote creado con ${seleccion.size} clips. Se procesa en ciclos de 10–20.`);
        seleccion.clear(); nombre.value = ""; pintarSel(true); refrescar("lotes", "monitor", "ciclos");
      } catch (e) { toast(e.message, "error"); } finally { btnCrear.disabled = false; }
    } },
      h("div", { class: "card-h" }, h("h2", null, "Nuevo lote de cortes"), h("span", { class: "muted sm" }, "ciclos de 10–20 elementos")),
      h("div", { class: "campo" }, h("label", null, "Nombre"), nombre),
      h("div", { class: "barra-filtros" },
        h("button", { type: "button", class: "btn sm", onClick: () => { clipsData.filter(c => c.estado === "pendiente" && !evaluarDuracion(duracionDe(c)).bloquea).forEach(c => seleccion.add(String(c.id))); pintarSel(true); } }, "Seleccionar pendientes válidos"),
        h("button", { type: "button", class: "btn sm ghost", onClick: () => { seleccion.clear(); pintarSel(true); } }, "Limpiar"), resumen),
      h("p", { class: "muted sm" }, `Los clips que superan ${DURACION.MAX} s aparecen bloqueados: la regla de oro exige ${DURACION.IDEAL_MIN}–${DURACION.MAX} s.`),
      listaClips, h("div", { class: "acciones" }, btnCrear));

    function pintarSel(forzar) {
      resumen.textContent = `${seleccion.size} seleccionados`;
      const firma = { c: clipsData.map(c => [c.id, c.estado, c.inicio_seg, c.fin_seg]), s: [...seleccion] };
      pintar(listaClips, forzar ? { ...firma, t: Math.random() } : firma, () => (clipsData.length ? h("div", { class: "contents" }, clipsData.map(c => {
        const ev = evaluarDuracion(duracionDe(c));
        const cb = h("input", { type: "checkbox", disabled: ev.bloquea, checked: seleccion.has(String(c.id)) && !ev.bloquea,
          onChange: () => { cb.checked ? seleccion.add(String(c.id)) : seleccion.delete(String(c.id)); resumen.textContent = `${seleccion.size} seleccionados`; } });
        return h("label", { class: `fila-sel ${ev.bloquea ? "off" : ""}` }, cb, h("span", { class: "titulo" }, c.titulo || `Clip #${c.id}`), badge(c.estado), chipDuracion(duracionDe(c)));
      })) : vacio("Aún no hay clips.")));
    }

    // --- Lista de lotes ---
    const tabs = h("div", { class: "tabs" },
      ["activos", "todos"].map(t => h("button", { type: "button", class: `tab ${t === solo ? "on" : ""}`, onClick: ev => { solo = t; tabs.querySelectorAll(".tab").forEach(b => b.classList.toggle("on", b === ev.currentTarget)); pintarLotes(); } }, t === "activos" ? "Activos" : "Todos")));
    const cont = h("div", { class: "grid cols" });
    const detalle = h("div");
    const ciclos = h("div");

    function pintarLotes() {
      const vis = solo === "activos" ? loteData.filter(l => !loteTerminal(l.estado)) : loteData;
      pintar(cont, { vis, solo }, () => (vis.length ? h("div", { class: "contents" }, vis.map(l => tarjetaLote(l, { onAbrir: x => abrirDetalle(detalle, x) }))) : vacio(solo === "activos" ? "No hay lotes activos." : "Aún no hay lotes.")));
    }

    el.append(
      h("div", { class: "grid dos" }, form, h("div", null, h("div", { class: "card-h" }, h("h2", null, "Lotes"), tabs), cont)),
      detalle,
      h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", null, "Ciclos")), ciclos));

    bajas.push(suscribir("clips", d => { clipsData = Array.isArray(d) ? d : []; pintarSel(false); }));
    bajas.push(suscribir("lotes", d => {
      loteData = Array.isArray(d) ? d : [];
      pintarLotes();
      const abrir = params?.get("abrir");
      if (abrir && !detalle.firstChild) { const l = loteData.find(x => String(x.id) === abrir); if (l) abrirDetalle(detalle, l); }
    }));
    bajas.push(suscribir("ciclos", d => pintar(ciclos, d, () => tablaCiclos(d, 30))));
  },
  desmontar() { bajas.forEach(f => f()); bajas = []; detalleBajas.forEach(f => f()); detalleBajas = []; detalleCanales.forEach(quitarCanal); detalleCanales = []; }
};
