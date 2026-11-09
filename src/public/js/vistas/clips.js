// Fuentes y clips: analizar un video, ver, publicar, recortar, reciclar y resolver publicaciones inciertas.
import { h, toast, confirmar, conBoton, badge, hace, medidorDuracion } from "../ui.js";
import { api } from "../api.js";
import { suscribir, refrescar } from "../tiempo.js";
import { pintar, vacio, checksPlataformas } from "../componentes.js";
import { modalVideo, modalPublicar, modalReciclar, modalResolverClip } from "../acciones.js";
import { duracionDe, evaluarDuracion, nombrePlat } from "../esquema.js";

let bajas = [];

function tarjetaClip(c) {
  const dur = duracionDe(c);
  const ocupado = ["cortando", "publicando"].includes(c.estado);
  const pubs = c.pubs || [];
  const recortar = ev => conBoton(ev, async () => {
    if (!(await confirmar("Se volverá a cortar este clip y se reemplazará el archivo actual.", { texto: "Recortar de nuevo" }))) return;
    await api.post(`/clips/${c.id}/recortar`);
    toast("Recorte encolado."); refrescar("clips", "monitor");
  });
  const borrarArchivo = ev => conBoton(ev, async () => {
    if (!(await confirmar("Se borrará el archivo de video para liberar disco. Podrás recortarlo otra vez.", { peligro: true, texto: "Borrar archivo" }))) return;
    await api.del(`/clips/${c.id}/archivo`);
    toast("Archivo borrado."); refrescar("clips", "estado");
  });

  return h("article", { class: "card clip" },
    h("div", { class: "card-h" },
      h("div", null, h("strong", null, c.titulo || `Clip #${c.id}`), h("div", { class: "muted sm" }, `#${c.id}${c.creado_en ? " · " + hace(c.creado_en) : ""}`)),
      badge(c.estado)),
    c.gancho ? h("p", { class: "muted gancho" }, c.gancho) : null,
    medidorDuracion(dur),
    h("div", { class: "fila sm muted" },
      c.categoria ? h("span", { class: "chip" }, c.categoria) : null,
      c.angulo ? h("span", { class: "chip" }, c.angulo) : null,
      c.puntaje != null ? h("span", { class: "chip" }, `★ ${c.puntaje}`) : null),
    pubs.length ? h("div", { class: "fila" }, pubs.map(p => h("span", { class: "pub" },
      h("span", { class: "chip" }, nombrePlat(p.p)), badge(p.e),
      p.e === "incierto" ? h("button", { type: "button", class: "btn sm primary", onClick: () => modalResolverClip(c, p.p) }, "Resolver") : null))) : null,
    c.error ? h("div", { class: "aviso sm bad" }, c.error) : null,
    h("div", { class: "acciones" },
      c.tiene_archivo ? h("button", { type: "button", class: "btn sm", onClick: () => modalVideo(c) }, "Ver") : null,
      c.tiene_archivo ? h("button", { type: "button", class: "btn sm primary", disabled: ocupado, onClick: () => modalPublicar(c) }, "Publicar") : null,
      c.tiene_archivo ? h("button", { type: "button", class: "btn sm", disabled: ocupado, onClick: () => modalReciclar(c) }, "Reciclar") : null,
      h("a", { class: "btn sm", href: `#/variantes?clip=${c.id}` }, "Variantes"),
      h("button", { type: "button", class: "btn sm", disabled: ocupado, onClick: recortar }, "Recortar"),
      c.tiene_archivo ? h("button", { type: "button", class: "btn sm danger", disabled: ocupado, onClick: borrarArchivo }, "Borrar archivo") : null));
}

export const clips = {
  id: "clips", titulo: "Fuentes y clips", icono: "▤",
  montar(el) {
    const filtros = { estado: "", q: "", dur: false };
    let datos = [];

    // --- Nueva fuente ---
    const url = h("input", { type: "url", placeholder: "https://www.youtube.com/watch?v=…", required: true });
    const platsBox = h("div");
    let checks = null;
    const fuentes = h("div");
    const form = h("form", { class: "card form-fuente", onSubmit: async ev => {
      ev.preventDefault();
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await api.post("/fuentes", { url: url.value.trim(), plataformas: checks ? checks.valores() : [] });
        toast("Video enviado a análisis."); url.value = ""; refrescar("estado", "clips");
      } catch (e) { toast(e.message, "error"); } finally { btn.disabled = false; }
    } },
      h("div", { class: "card-h" }, h("h2", null, "Analizar un video de YouTube"), h("span", { class: "muted sm" }, "la IA propone clips de 30–60 s")),
      h("div", { class: "campo" }, h("label", null, "Enlace"), url),
      h("div", { class: "campo" }, h("label", null, "Plataformas destino"), platsBox),
      h("div", { class: "acciones" }, h("button", { type: "submit", class: "btn primary" }, "Analizar")),
      fuentes);

    // --- Filtros + lista ---
    const selEstado = h("select", { onChange: () => { filtros.estado = selEstado.value; pintarLista(); } }, h("option", { value: "" }, "Todos los estados"));
    const busca = h("input", { type: "search", placeholder: "Buscar título o gancho…", onInput: () => { filtros.q = busca.value.toLowerCase(); pintarLista(); } });
    const soloDur = h("input", { type: "checkbox", onChange: () => { filtros.dur = soloDur.checked; pintarLista(); } });
    const lista = h("div", { class: "grid cols" });
    const contador = h("span", { class: "muted sm" });

    function pintarLista() {
      const vis = datos.filter(c =>
        (!filtros.estado || c.estado === filtros.estado) &&
        (!filtros.q || `${c.titulo || ""} ${c.gancho || ""}`.toLowerCase().includes(filtros.q)) &&
        (!filtros.dur || ["largo", "corto"].includes(evaluarDuracion(duracionDe(c)).nivel)));
      contador.textContent = `${vis.length} de ${datos.length} clips`;
      pintar(lista, { vis, filtros }, () => (vis.length ? h("div", { class: "contents" }, vis.map(tarjetaClip)) : vacio("No hay clips con esos filtros.")));
    }

    el.append(form,
      h("div", { class: "barra-filtros" }, selEstado, busca, h("label", { class: "check" }, soloDur, h("span", null, "Solo fuera del ideal 30–60 s")), contador),
      lista);

    bajas.push(suscribir("estado", d => {
      if (!checks) { checks = checksPlataformas(d.plataformas || []); platsBox.replaceChildren(checks.el); }
      pintar(fuentes, d.fuentes, () => (d.fuentes?.length ? h("ul", { class: "lista-fuentes" }, d.fuentes.map(f => h("li", null,
        badge(f.estado), h("a", { href: f.url, target: "_blank", rel: "noopener noreferrer" }, f.video_id), h("span", { class: "muted sm" }, hace(f.creado_en)), f.error ? h("span", { class: "t-bad-txt sm" }, f.error) : null))) : h("span")));
    }));
    bajas.push(suscribir("clips", d => {
      datos = Array.isArray(d) ? d : [];
      const estados = [...new Set(datos.map(c => c.estado))].sort();
      if (selEstado.options.length - 1 !== estados.length) {
        selEstado.replaceChildren(h("option", { value: "" }, "Todos los estados"), ...estados.map(e => h("option", { value: e }, e)));
        selEstado.value = filtros.estado;
      }
      pintarLista();
    }));
  },
  desmontar() { bajas.forEach(f => f()); bajas = []; }
};
