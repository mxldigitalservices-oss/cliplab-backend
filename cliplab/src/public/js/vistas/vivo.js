// FASE 6 (preparada, aún sin backend): transmisiones en vivo y captura en tiempo real.
// Contrato que el backend de la Fase 6 debe cumplir (ver cliplab/docs/fase6/rutas-vivo.stub.js):
//   GET /api/vivo/estado   -> { disponible, transmisiones:[{id,url,estado,...}], capturas:[{id,estado,inicio_seg,fin_seg,...}] }
//   GET /api/vivo/eventos  -> flujo SSE con el mismo JSON (opcional; descomentar `sse` abajo)
// Los segmentos capturados siguen la MISMA regla de oro: máximo 60 s (ideal 30–60 s).
import { h } from "../ui.js";
import { api } from "../api.js";
import { definirCanal, suscribir } from "../tiempo.js";
import { generico, pintar, vacio } from "../componentes.js";
import { DURACION } from "../esquema.js";

let baja = null;

definirCanal("vivo", {
  fetcher: async () => {
    try { return await api.get("/vivo/estado"); }
    catch (e) { if (e.status === 404) return { disponible: false }; throw e; }   // 404 = Fase 6 aún no instalada (no es un fallo)
  },
  ms: 10000
  // sse: "/api/vivo/eventos",   // Fase 6: al activarlo, el panel pasa de sondeo a flujo en vivo sin más cambios
});

export const vivo = {
  id: "vivo", titulo: "En vivo (Fase 6)", icono: "●",
  montar(el) {
    const estado = h("div"), trans = h("div"), caps = h("div");
    el.append(
      h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", null, "Transmisiones y captura en tiempo real"), h("span", { class: "chip" }, "preparado")), estado),
      h("div", { class: "grid dos" },
        h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", null, "Transmisiones")), trans),
        h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", null, "Capturas en curso")), caps)),
      h("div", { class: "card" }, h("h2", null, "Reglas que aplicarán"), h("ul", { class: "leyenda" },
        h("li", null, `Cada segmento capturado dura como máximo ${DURACION.MAX} s (ideal ${DURACION.IDEAL_MIN}–${DURACION.MAX} s).`),
        h("li", null, "Los segmentos entran como clips normales: mismo flujo de lotes, ciclos de 10–20 y reciclaje multi-ángulo."),
        h("li", null, "El panel ya consume /api/vivo/estado y admite flujo SSE en /api/vivo/eventos."))));

    baja = suscribir("vivo", d => {
      pintar(estado, { disponible: d?.disponible }, () => (d?.disponible
        ? h("div", { class: "aviso ok" }, "Backend de la Fase 6 detectado.")
        : h("div", { class: "aviso" }, "El backend de la Fase 6 todavía no está instalado. Esta sección se activará sola cuando exista GET /api/vivo/estado.")));
      pintar(trans, d?.transmisiones, () => (d?.transmisiones?.length ? generico(d.transmisiones) : vacio("Sin transmisiones.")));
      pintar(caps, d?.capturas, () => (d?.capturas?.length ? generico(d.capturas) : vacio("Sin capturas.")));
    });
  },
  desmontar() { baja?.(); baja = null; }
};
