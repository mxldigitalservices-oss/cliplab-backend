// Variantes del reciclaje multi-ángulo: programación, reprogramar, cancelar y resolver publicaciones inciertas.
import { h, badge, fechaHora, medidorDuracion } from "../ui.js";
import { api } from "../api.js";
import { suscribir, definirCanal, quitarCanal } from "../tiempo.js";
import { pintar, vacio, tarjetaVariante } from "../componentes.js";
import { modalReciclar } from "../acciones.js";
import { CAMPOS, pick, duracionDe, evaluarDuracion, tono, DURACION } from "../esquema.js";

let bajas = [];
let canalActual = null, bajaVar = null;

const lista = d => (Array.isArray(d) ? d : (d?.variantes || d?.items || []));

export const variantes = {
  id: "variantes", titulo: "Variantes programadas", icono: "⧉",
  montar(el, { params } = {}) {
    let clips = [], clipId = params?.get("clip") || "";
    const sel = h("select", { "aria-label": "Clip" });
    const btnReciclar = h("button", { type: "button", class: "btn sm primary" }, "Reciclar este clip");
    const resumen = h("div", { class: "fila" });
    const calendario = h("div");
    const nota = h("p", { class: "muted sm" }, `Las variantes reutilizan el corte del clip: deben durar como máximo ${DURACION.MAX} s (ideal ${DURACION.IDEAL_MIN}–${DURACION.MAX} s).`);
    const cuerpo = h("div");

    el.append(
      h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", null, "Clip"), btnReciclar), h("div", { class: "barra-filtros" }, sel), nota, resumen),
      cuerpo);

    const clipActual = () => clips.find(c => String(c.id) === String(clipId));

    function cambiarClip(id) {
      clipId = String(id);
      if (bajaVar) { bajaVar(); bajaVar = null; }
      if (canalActual) { quitarCanal(canalActual); canalActual = null; }
      history.replaceState(null, "", `#/variantes?clip=${clipId}`);
      if (!clipId) { cuerpo.replaceChildren(vacio("Elige un clip.")); return; }
      canalActual = `variantes:${clipId}`;
      definirCanal(canalActual, { fetcher: () => api.get(`/clips/${clipId}/variantes`), ms: 5000 });
      bajaVar = suscribir(canalActual, d => {
        const vs = lista(d), clip = clipActual();
        const cnt = {};
        for (const v of vs) cnt[v.estado] = (cnt[v.estado] || 0) + 1;
        pintar(resumen, cnt, () => h("div", { class: "contents" }, Object.entries(cnt).length ? Object.entries(cnt).map(([e, n]) => h("span", { class: "fila" }, badge(e), h("strong", null, n))) : h("span", { class: "muted" }, "Sin variantes")));
        pintar(cuerpo, { vs, clip: clip && [clip.inicio_seg, clip.fin_seg] }, () => {
          if (!vs.length) return vacio("Este clip aún no tiene variantes. Usa «Reciclar este clip».");
          const orden = [...vs].sort((a, b) => new Date(pick(a, CAMPOS.variante.programada, 0)) - new Date(pick(b, CAMPOS.variante.programada, 0)));
          const dias = new Map();
          for (const v of orden) {
            const p = pick(v, CAMPOS.variante.programada);
            const k = p && !isNaN(new Date(p)) ? new Date(p).toLocaleDateString("es-DO", { weekday: "long", day: "numeric", month: "short" }) : "Sin programar";
            (dias.get(k) || dias.set(k, []).get(k)).push(v);
          }
          return h("div", { class: "contents" }, [...dias].map(([dia, items]) => h("section", { class: "dia" },
            h("h3", null, dia, h("span", { class: "muted sm" }, ` · ${items.length}`)),
            h("div", { class: "grid cols" }, items.map(v => tarjetaVariante(v, { clip }))))));
        });
      });
    }

    btnReciclar.addEventListener("click", () => { const c = clipActual(); if (c) modalReciclar(c); });
    sel.addEventListener("change", () => cambiarClip(sel.value));

    bajas.push(suscribir("clips", d => {
      clips = Array.isArray(d) ? d : [];
      const firma = clips.map(c => c.id).join(",");
      if (sel.dataset.firma !== firma) {
        sel.dataset.firma = firma;
        sel.replaceChildren(...clips.map(c => h("option", { value: c.id }, `#${c.id} · ${c.titulo || "sin título"} · ${evaluarDuracion(duracionDe(c)).texto}`)));
        if (!clipId && clips.length) clipId = String(clips[0].id);
        sel.value = clipId;
        if (String(clipId) !== String(canalActual?.split(":")[1])) cambiarClip(clipId);
      }
      btnReciclar.disabled = !clipActual()?.tiene_archivo;
    }));
  },
  desmontar() {
    bajas.forEach(f => f()); bajas = [];
    if (bajaVar) { bajaVar(); bajaVar = null; }
    if (canalActual) { quitarCanal(canalActual); canalActual = null; }
  }
};
