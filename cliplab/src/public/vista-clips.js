// Pestaña "Clips": nuevo video, inventario de clips (publicar, recortar, reciclar), fuentes y capturas de evidencia.
(() => {
  "use strict";
  const { $, el, api, chip, tiempo, pintar, aviso, accion, fmt, ir, NOMBRE, PLATS } = CL;

  const ESTADOS = { pendiente: "en cola", cortando: "cortando…", listo: "listo", publicando: "publicando…", publicado: "publicado", error: "error", expirado: "archivo purgado" };
  let datos = null, cargando = false, pendiente = false;
  const recAbierto = new Set();   // clips con el formulario de reciclaje abierto
  const recVars = new Map();      // variables de programación tecleadas por clip
  const recPlats = new Map();

  const repintar = () => dibujar(true);
  const act = (fn, ok) => accion(async () => {
    const r = await fn();
    if (r === false) return false;
    await cargar(true);
    return r;
  }, ok);

  // Formulario de reciclaje multi-ángulo con sus variables de programación (POST /api/clips/:id/reciclar).
  function formReciclar(c) {
    const elegidas = recPlats.get(c.id) || new Set();
    recPlats.set(c.id, elegidas);
    const v = recVars.get(c.id) || { cantidad: "5", desde: "", separacion: "", ventanas: "" };
    recVars.set(c.id, v);
    const campo = (clave, props) => {
      const i = el("input", { ...props, value: v[clave] });
      i.addEventListener("input", () => { v[clave] = i.value; });
      return i;
    };
    const zona = CL.ultima?.monitor?.config?.zona || "";
    const cant = campo("cantidad", { type: "number", min: "1", max: "20", "aria-label": "Cantidad de variantes" });
    const desde = campo("desde", { type: "datetime-local", "aria-label": "Empezar desde" });
    const sep = campo("separacion", { type: "number", min: "1", placeholder: "90", "aria-label": "Separación mínima en minutos" });
    const vent = campo("ventanas", { type: "text", placeholder: "09:00-11:00, 18:00-20:00", "aria-label": "Ventanas horarias" });
    return el("fieldset", { class: "rep" },
      el("legend", {}, "Variables de programación"),
      el("label", {}, "Variantes", cant),
      PLATS.map(p => {
        const cb = el("input", { type: "checkbox", value: p, checked: elegidas.has(p) });
        cb.addEventListener("change", () => { cb.checked ? elegidas.add(p) : elegidas.delete(p); });
        return el("label", {}, cb, NOMBRE[p]);
      }),
      el("label", {}, "Empezar desde (opcional)", desde),
      el("label", {}, "Separación mínima, min (opcional)", sep),
      el("label", {}, "Ventanas horarias" + (zona ? " en " + zona : "") + " (opcional)", vent),
      el("button", { type: "button", class: "run chico", onclick: accion(async () => {
        if (!elegidas.size) throw new Error("Elige al menos una plataforma.");
        const n = Number(cant.value);
        if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("La cantidad debe estar entre 1 y 20.");
        const cuerpo = { plataformas: [...elegidas], cantidad: n };
        if (desde.value) {
          const d = new Date(desde.value);
          if (Number.isNaN(d.getTime())) throw new Error("La fecha de inicio no es válida.");
          cuerpo.desde = d.toISOString();
        }
        if (sep.value) {
          const m = Number(sep.value);
          if (!Number.isFinite(m) || m < 1) throw new Error("La separación debe ser un número de minutos mayor que 0.");
          cuerpo.separacion_min = m;
        }
        const ventanas = vent.value.split(",").map(x => x.trim()).filter(Boolean);
        if (ventanas.length) cuerpo.ventanas = ventanas;
        const r = await api("/clips/" + c.id + "/reciclar", { method: "POST", body: JSON.stringify(cuerpo) });
        recAbierto.delete(c.id); recVars.delete(c.id); recPlats.delete(c.id);
        ir("lotes");
        return r;
      }, r => `Se programaron ${r.variantes?.length ?? 0} variantes en el lote «${r.lote?.nombre ?? ""}».` + (r.avisos?.length ? " " + r.avisos.join(" ") : "")) }, "Crear variantes"),
      el("button", { type: "button", class: "ghost chico", onclick: () => { recAbierto.delete(c.id); repintar(); } }, "Cerrar"));
  }

  function tarjeta(c) {
    const pubs = (c.pubs || []).map(p => chip(NOMBRE[p.p] + ": " + (p.e === "simulado" ? "prueba" : p.e), p.e === "ok" ? "ok" : p.e === "error" ? "err" : "warn"));
    const publicar = lista => act(() => api("/clips/" + c.id + "/publicar", { method: "POST", body: JSON.stringify({ plataformas: lista }) }), "Publicación en cola.");
    const ocupado = ["pendiente", "cortando", "publicando"].includes(c.estado);
    const resolver = (p, a, ok) => act(() => api("/clips/" + c.id + "/resolver", { method: "POST", body: JSON.stringify({ plataforma: p, accion: a }) }), ok);
    return el("div", { class: "clip" },
      c.tiene_archivo ? el("video", { controls: true, preload: "none", playsinline: true, src: "/media/" + c.token + ".mp4" }) : el("div", { class: "ph" }, ESTADOS[c.estado] || c.estado),
      el("div", { class: "body" },
        el("h3", {}, c.titulo),
        c.gancho ? el("small", { class: "muted" }, "“" + c.gancho + "”") : null,
        el("div", { class: "chips" },
          chip(fmt(c.inicio_seg) + " → " + fmt(c.fin_seg)),
          c.puntaje != null ? chip(c.puntaje + "/100") : null,
          c.angulo ? chip(c.angulo) : null,
          chip(ESTADOS[c.estado] || c.estado, c.estado === "error" ? "err" : c.estado === "publicado" ? "ok" : ""), pubs),
        c.error ? el("small", { class: "err-txt" }, c.error) : null,
        el("div", { class: "acts" },
          ...PLATS.map(p => el("button", { class: "ghost", disabled: ocupado, onclick: publicar([p]) }, "→ " + NOMBRE[p])),
          el("button", { class: "ghost", disabled: ocupado, onclick: act(async () => { if (!confirm("¿Publicar en todas las plataformas?")) return false; return api("/clips/" + c.id + "/publicar", { method: "POST", body: JSON.stringify({ plataformas: PLATS }) }); }, "Publicación en cola.") }, "→ Todas"),
          el("button", { class: "ghost", disabled: ocupado, onclick: act(() => api("/clips/" + c.id + "/recortar", { method: "POST" })) }, "Recortar de nuevo"),
          c.tiene_archivo ? el("button", { class: "ghost", disabled: ocupado, onclick: act(() => api("/clips/" + c.id + "/archivo", { method: "DELETE" })) }, "Borrar archivo") : null,
          el("button", { class: "ghost", disabled: ocupado, onclick: () => { recAbierto.has(c.id) ? recAbierto.delete(c.id) : recAbierto.add(c.id); repintar(); } }, recAbierto.has(c.id) ? "Cerrar reciclaje" : "Reciclar…"),
          ...(c.pubs || []).filter(p => p.e === "incierto").flatMap(p => [
            el("button", { class: "ghost", onclick: resolver(p.p, "publicado", "Marcado como publicado.") }, "Ya se publicó en " + NOMBRE[p.p]),
            el("button", { class: "ghost", onclick: resolver(p.p, "reintentar", "Listo para reintentar.") }, "Reintentar " + NOMBRE[p.p])
          ])),
        recAbierto.has(c.id) ? formReciclar(c) : null));
  }

  function dibujar(forzar = false) {
    if (!datos) return;
    const { e, clips } = datos;
    $("fuentes").replaceChildren(...e.fuentes.map(f => el("div", {}, f.video_id + ": " + f.estado + (f.error ? " — " + f.error : ""))));
    const reproduciendo = [...document.querySelectorAll("#clips video")].some(v => !v.paused);
    if (!(reproduciendo && !forzar)) {   // no cortar la reproducción en curso
      pintar($("clips"), JSON.stringify(clips), () => clips.length ? clips.map(tarjeta) : [el("div", { class: "card muted" }, "Aún no hay clips.")], forzar);
    }
    pintar($("evid"), JSON.stringify(e.evidencias), () => e.evidencias.length
      ? e.evidencias.map(n => el("div", {}, el("a", { href: "/evidencia/" + n, target: "_blank", rel: "noopener" }, n)))
      : ["Sin capturas todavía."], forzar);
  }

  async function cargar(forzar = false) {
    if (cargando) { pendiente = true; return; }
    cargando = true;
    try {
      const [e, clips] = await Promise.all([api("/estado"), api("/clips")]);
      datos = { e, clips };
      dibujar(forzar);
    } catch (err) { if (forzar) aviso(err.message, true); }
    finally { cargando = false; if (pendiente) { pendiente = false; cargar(); } }
  }

  $("auto").replaceChildren(...PLATS.map(p => el("label", {}, el("input", { type: "checkbox", value: p }), NOMBRE[p])));
  $("f").addEventListener("submit", async ev => {
    ev.preventDefault();
    $("go").disabled = true;
    try {
      const plataformas = [...document.querySelectorAll("#auto input:checked")].map(i => i.value);
      await api("/fuentes", { method: "POST", body: JSON.stringify({ url: $("url").value.trim(), plataformas }) });
      $("url").value = "";
      aviso("Video en cola: se analiza y se cortan los clips.");
      await cargar(true);
    } catch (e) { aviso(e.message, true); }
    $("go").disabled = false;
  });

  CL.registrar("clips", {
    alActivar() { cargar(true); },
    alSnapshot() { if (CL.activa === "clips") cargar(); }
  });
})();
