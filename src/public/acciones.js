// Acciones compartidas sobre variantes (las usan "Lotes y variantes" e "Incidencias"):
// reprogramar (formulario con fecha), cancelar y salto a la resolución de inciertas.
(() => {
  "use strict";
  const { el, api, accion, chip, ir } = CL;

  const REPROGRAMABLES = ["programada", "error", "parcial", "cancelada"];
  const CANCELABLES = ["programada", "error", "parcial"];
  const abiertas = new Set();     // variantes con el formulario de reprogramación abierto
  const valores = new Map();      // fecha tecleada por variante (sobrevive a los redibujados)

  const aLocal = d => new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);

  const puedeReprogramar = v => REPROGRAMABLES.includes(v.estado) && v.lote_estado !== "cancelado";
  const puedeCancelar = v => CANCELABLES.includes(v.estado);

  // repintar: función que redibuja la lista que contiene la variante.
  function botones(v, repintar) {
    const b = [];
    if (puedeReprogramar(v)) {
      b.push(el("button", { type: "button", class: "ghost chico", onclick: () => { abiertas.has(v.id) ? abiertas.delete(v.id) : abiertas.add(v.id); repintar(); } },
        abiertas.has(v.id) ? "Cerrar" : "Reprogramar"));
    } else if (REPROGRAMABLES.includes(v.estado)) {
      b.push(el("button", { type: "button", class: "ghost chico", disabled: true, title: "El lote está cancelado" }, "Reprogramar"));
    }
    if (puedeCancelar(v)) {
      b.push(el("button", { type: "button", class: "ghost chico", onclick: accion(async () => {
        if (!confirm("¿Cancelar la variante #" + v.id + "?")) return false;
        return api("/variantes/" + v.id + "/cancelar", { method: "POST" });
      }, "Variante cancelada.") }, "Cancelar"));
    }
    if (v.estado === "incierta") {
      b.push(el("button", { type: "button", class: "ghost chico", onclick: () => ir("incidencias") }, "Resolver incierta…"));
    }
    return b;
  }

  function formulario(v, repintar) {
    if (!abiertas.has(v.id) || !puedeReprogramar(v)) return null;
    const base = Math.max(Date.now() + 5 * 60e3, new Date(v.programada_para).getTime());
    const inp = el("input", { type: "datetime-local", value: valores.get(v.id) ?? aLocal(new Date(base)), "aria-label": "Nueva fecha y hora de la variante " + v.id });
    inp.addEventListener("input", () => valores.set(v.id, inp.value));
    return el("fieldset", { class: "rep" },
      el("legend", {}, "Variables de programación"),
      el("label", {}, "Nueva fecha y hora (tu zona horaria)", inp),
      el("button", { type: "button", class: "run chico", onclick: accion(async () => {
        const d = new Date(inp.value);
        if (!inp.value || Number.isNaN(d.getTime())) throw new Error("Elige una fecha y hora válidas.");
        const r = await api("/variantes/" + v.id + "/reprogramar", { method: "POST", body: JSON.stringify({ programada_para: d.toISOString() }) });
        abiertas.delete(v.id); valores.delete(v.id);
        repintar();
        return r;
      }, "Variante reprogramada.") }, "Reprogramar"),
      el("button", { type: "button", class: "ghost chico", onclick: () => { abiertas.delete(v.id); repintar(); } }, "Cerrar"));
  }

  const plataformas = v => el("div", { class: "chips" }, (v.plataformas || []).map(p => chip(CL.NOMBRE[p] || p)));

  CL.variantes = { botones, formulario, plataformas, puedeReprogramar, puedeCancelar };
})();
