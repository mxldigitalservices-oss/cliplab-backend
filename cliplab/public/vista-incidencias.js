// Pestaña "Incidencias": publicaciones inciertas, variantes con problemas, clips y elementos de lote con error.
(() => {
  "use strict";
  const { $, el, api, chip, tiempo, pintar, accion, claseEstado, quitarGuion, NOMBRE, ir } = CL;

  let ultimo = null;
  const repintar = () => { if (ultimo) dibujar(ultimo, true); };
  const vacio = txt => [el("p", { class: "vacio" }, txt)];

  // Resolver una publicación incierta: "publicado" (ya salió) o "reintentar" (no salió).
  function resolver(i, plataforma, accionPedida) {
    const esVariante = !!i.variante_id;
    const nombre = NOMBRE[plataforma] || plataforma;
    const pregunta = accionPedida === "publicado"
      ? `¿Confirmas que el video ya está publicado en ${nombre}? Se contará como hecho.`
      : `Se descartará el resultado incierto. Confirma primero en ${nombre} que NO se publicó, o saldrá duplicado.`;
    const ok = accionPedida === "publicado" ? "Marcado como publicado."
      : esVariante ? "Descartado: reprograma la variante para reintentarla." : "Descartado: ya puedes volver a publicar el clip desde Clips.";
    return accion(async () => {
      if (!confirm(pregunta)) return false;
      const ruta = esVariante ? "/variantes/" + i.variante_id + "/resolver" : "/clips/" + i.clip_id + "/resolver";
      return api(ruta, { method: "POST", body: JSON.stringify({ plataforma, accion: accionPedida }) });
    }, ok);
  }

  const inciertas = lista => lista.length ? lista.map(i => el("div", { class: "incidencia" },
    el("div", { class: "t" }, i.variante_id ? `Variante #${i.variante_id} · ${i.variante_titulo}` : `Clip #${i.clip_id} · ${i.clip_titulo}`, " ", chip(NOMBRE[i.plataforma] || i.plataforma, "warn")),
    i.variante_id ? el("div", { class: "muted" }, "Clip base: " + i.clip_titulo) : null,
    el("div", { class: "muted" }, i.detalle || "Resultado sin confirmar", " · ", tiempo(i.creado_en)),
    el("div", { class: "acts" },
      el("button", { type: "button", class: "run chico", onclick: resolver(i, i.plataforma, "publicado") }, "Ya se publicó en " + (NOMBRE[i.plataforma] || i.plataforma)),
      el("button", { type: "button", class: "ghost chico", onclick: resolver(i, i.plataforma, "reintentar") }, "No se publicó: reintentar")))) : vacio("Sin publicaciones inciertas.");

  const variantes = lista => lista.length ? lista.map(v => el("div", { class: "incidencia" },
    el("div", { class: "t" }, `#${v.id} · ${v.titulo} `, chip(quitarGuion(v.estado), claseEstado(v.estado))),
    el("div", { class: "muted" }, "Clip: " + v.clip_titulo + " · lote «" + v.lote + "»" + (v.lote_estado === "cancelado" ? " (cancelado)" : "") + " · programada ", tiempo(v.programada_para)),
    CL.variantes.plataformas(v),
    v.error ? el("div", { class: "err-txt" }, v.error) : null,
    el("div", { class: "acts" }, CL.variantes.botones(v, repintar)),
    CL.variantes.formulario(v, repintar))) : vacio("Sin variantes con problemas.");

  const clips = lista => lista.length ? lista.map(c => el("div", { class: "incidencia" },
    el("div", { class: "t" }, `Clip #${c.id} · ${c.titulo}`),
    el("div", { class: "err-txt" }, c.error || "Error sin detalle"),
    el("div", { class: "acts" },
      el("button", { type: "button", class: "ghost chico", onclick: accion(async () => {
        if (!confirm("¿Volver a cortar el clip #" + c.id + "?")) return false;
        return api("/clips/" + c.id + "/recortar", { method: "POST" });
      }, "Clip en cola para recortar de nuevo.") }, "Recortar de nuevo"),
      el("button", { type: "button", class: "ghost chico", onclick: () => ir("clips") }, "Ver en Clips")))) : vacio("Sin clips con error.");

  const items = lista => lista.length ? lista.map(i => el("div", { class: "incidencia" },
    el("div", { class: "t" }, `Elemento #${i.id} · ${quitarGuion(i.tipo)} · lote «${i.lote}»`),
    el("div", { class: "err-txt" }, i.detalle || "Error sin detalle"),
    el("div", { class: "muted" }, `${i.intentos} intentos · `, tiempo(i.cuando)),
    el("div", { class: "acts" }, el("button", { type: "button", class: "ghost chico", onclick: () => ir("lotes", { lote: i.lote_id }) }, "Ver lote")))) : vacio("Sin elementos con error.");

  function dibujar(s, forzar = false) {
    const inc = s.incidencias, n = inc.conteos;
    $("in-n-inciertas").textContent = "(" + n.inciertas + ")";
    $("in-n-variantes").textContent = "(" + n.variantes + ")";
    $("in-n-clips").textContent = "(" + n.clips + ")";
    $("in-n-items").textContent = "(" + n.items + ")";
    pintar($("in-resumen"), JSON.stringify(n), () => [el("div", { class: "listo " + (n.accionables ? "nivel-atencion" : "nivel-listo"), role: "status" },
      el("b", {}, n.accionables ? n.accionables + (n.accionables === 1 ? " incidencia por resolver" : " incidencias por resolver") : "Sin incidencias pendientes"),
      el("span", { class: "muted" }, `${n.inciertas} inciertas · ${n.variantes} variantes · ${n.clips} clips · ${n.items} elementos de lote con error`))], forzar);
    pintar($("in-inciertas"), JSON.stringify(inc.inciertas), () => inciertas(inc.inciertas), forzar);
    pintar($("in-variantes"), JSON.stringify(inc.variantes), () => variantes(inc.variantes), forzar);
    pintar($("in-clips"), JSON.stringify(inc.clips), () => clips(inc.clips), forzar);
    pintar($("in-items"), JSON.stringify(inc.items), () => items(inc.items), forzar);
  }

  CL.registrar("incidencias", { alSnapshot(s) { ultimo = s; dibujar(s); } });
})();
