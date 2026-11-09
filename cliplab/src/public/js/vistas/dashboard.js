// Dashboard: monitor en tiempo real (GET /api/lotes/monitor), lotes activos, ciclos de 10–20 y cumplimiento de la regla de 60 s.
import { h } from "../ui.js";
import { suscribir } from "../tiempo.js";
import { generico, tarjetaLote, tablaCiclos, tile, pintar, vacio } from "../componentes.js";
import { loteTerminal, duracionDe, evaluarDuracion, DURACION } from "../esquema.js";
import { hace } from "../ui.js";

let bajas = [];

export const dashboard = {
  id: "dashboard", titulo: "Dashboard", icono: "◉",
  montar(el) {
    const kpis = h("div", { class: "grid kpis" });
    const activos = h("div", { class: "grid cols" });
    const ciclos = h("div");
    const monitor = h("div");
    const duracion = h("div");
    const hora = h("span", { class: "muted sm" }, "—");

    el.append(
      kpis,
      h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", null, "Lotes activos"), h("span", { class: "muted sm" }, "se actualiza solo")), activos),
      h("div", { class: "grid dos" },
        h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", null, "Ciclos"), h("span", { class: "muted sm" }, "bloques de 10–20 elementos")), ciclos),
        h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", null, "Regla de duración"), h("span", { class: "muted sm" }, `≤ ${DURACION.MAX} s · ideal ${DURACION.IDEAL_MIN}–${DURACION.MAX} s`)), duracion)),
      h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", null, "Monitor del sistema"), hora), monitor));

    let est = null, lotes = [];
    const pintarKpis = () => {
      if (!est) return;
      const activosN = lotes.filter(l => !loteTerminal(l.estado)).length;
      const ses = est.sesiones?.length || 0, tot = est.plataformas?.length || 0;
      const analizando = (est.fuentes || []).filter(f => /(pend|analiz)/.test(f.estado)).length;
      pintar(kpis, { m: est.publicarReal, a: est.agenteOcupado, d: est.discoMb, ses, tot, activosN, analizando }, () => h("div", { class: "contents" },
        tile("Modo", est.publicarReal ? "REAL" : "PRUEBA", est.publicarReal ? "t-bad-txt" : "t-ok-txt"),
        tile("Agente (navegador)", est.agenteOcupado ? "Ocupado" : "Libre"),
        tile("Sesiones conectadas", `${ses}/${tot}`),
        tile("Lotes activos", activosN),
        tile("Fuentes en análisis", analizando),
        tile("Disco usado", est.discoMb != null ? `${est.discoMb} MB` : "—")));
    };

    bajas.push(suscribir("estado", d => { est = d; pintarKpis(); }));
    bajas.push(suscribir("lotes", d => {
      lotes = Array.isArray(d) ? d : [];
      pintarKpis();
      const act = lotes.filter(l => !loteTerminal(l.estado));
      pintar(activos, act, () => (act.length ? h("div", { class: "contents" }, act.map(l => tarjetaLote(l, { onAbrir: () => { location.hash = "#/lotes?abrir=" + l.id; } }))) : vacio("No hay lotes activos.")));
    }));
    bajas.push(suscribir("ciclos", d => pintar(ciclos, d, () => tablaCiclos(d))));
    bajas.push(suscribir("monitor", d => {
      hora.textContent = "actualizado " + hace(new Date());
      pintar(monitor, d, () => generico(d ?? {}));
    }));
    bajas.push(suscribir("clips", d => {
      const lista = Array.isArray(d) ? d : [];
      const n = { ok: 0, corto: 0, largo: 0, nd: 0 };
      for (const c of lista) n[evaluarDuracion(duracionDe(c)).nivel]++;
      pintar(duracion, n, () => {
        const total = lista.length || 1;
        const seg = (k, cls) => { const s = h("span", { class: `seg ${cls}` }); s.style.width = `${(n[k] / total) * 100}%`; return s; };
        return h("div", null,
          h("div", { class: "apilada" }, seg("ok", "n-ok"), seg("corto", "n-corto"), seg("largo", "n-largo"), seg("nd", "n-nd")),
          h("ul", { class: "leyenda" },
            h("li", null, h("i", { class: "pto n-ok" }), `${n.ok} en rango ideal`),
            h("li", null, h("i", { class: "pto n-corto" }), `${n.corto} bajo el ideal`),
            h("li", null, h("i", { class: "pto n-largo" }), `${n.largo} exceden ${DURACION.MAX} s (bloqueados)`),
            h("li", null, h("i", { class: "pto n-nd" }), `${n.nd} sin duración`)));
      });
    }));
  },
  desmontar() { bajas.forEach(f => f()); bajas = []; }
};
