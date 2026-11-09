// Pestaña "Lotes y variantes": monitor del sistema (GET /api/lotes/monitor), lotes de cortes/reciclaje con su
// detalle y las variantes programadas del reciclaje multi-ángulo (reprogramar, cancelar, ver estado).
(() => {
  "use strict";
  const { $, el, api, chip, barra, conteos, tiempo, pintar, aviso, accion, claseEstado, quitarGuion, hora, fecha, NOMBRE } = CL;

  const ORD = {
    lotes: ["pendiente", "corriendo", "pausado", "completado", "con_errores", "cancelado"],
    items: ["pendiente", "encolado", "corriendo", "aplazado", "hecho", "error", "cancelado"],
    variantes: ["programada", "en_cola", "publicando", "publicada", "simulada", "parcial", "incierta", "error", "cancelada"]
  };
  const TERMINADOS = ["hecho", "error", "cancelado"];
  const MAX_FILAS = 100;

  let datos = null;                 // { mon, lotes, vars, t }
  let filtro = "activas";
  let cargando = false, pendiente = false, firmaSnap = "";
  const abiertos = new Set();       // lotes con el detalle desplegado
  const detalles = new Map();       // id de lote -> { items, variantes, eventos }

  const fila = (k, ...v) => el("div", { class: "kv" }, el("span", { class: "muted" }, k), el("span", { class: "v" }, ...v));
  const tabla = (cabeceras, filas) => el("div", { class: "tabla-wrap" }, el("table", { class: "tabla" },
    el("thead", {}, el("tr", {}, cabeceras.map(c => el("th", { scope: "col" }, c)))), el("tbody", {}, filas)));

  // ---------- Monitor ----------
  function monitor(m) {
    const c = m.cicloAbierto;
    return el("div", { class: "stats" },
      el("div", { class: "card stat" }, el("h3", {}, "Configuración"),
        fila("Elementos por ciclo", String(m.config.tamanoCiclo)), fila("Pausa entre ciclos", m.config.pausaCicloS + " s"),
        fila("Variantes por petición (máx.)", String(m.config.variantesMax)), fila("Protección del video base", m.config.protegerHoras + " h"),
        fila("Zona horaria", m.config.zona)),
      el("div", { class: "card stat" }, el("h3", {}, "Ciclo abierto"),
        c ? [fila("Ciclo", "#" + c.id), barra(c.hechos + c.fallidos, c.total),
             fila("Avance", `${c.hechos + c.fallidos} de ${c.total} · ${c.fallidos} con error`), fila("Inició", tiempo(c.iniciado_en))]
          : el("p", { class: "vacio" }, "No hay ciclo abierto.")),
      el("div", { class: "card stat" }, el("h3", {}, "Lotes"), conteos(m.lotes, ORD.lotes)),
      el("div", { class: "card stat" }, el("h3", {}, "Elementos"), conteos(m.items, ORD.items)),
      el("div", { class: "card stat" }, el("h3", {}, "Variantes"), conteos(m.variantes, ORD.variantes)),
      el("div", { class: "card stat" }, el("h3", {}, "Últimos ciclos"),
        m.ultimosCiclos.length ? m.ultimosCiclos.map(x => fila("#" + x.id, chip(quitarGuion(x.estado), claseEstado(x.estado)), ` ${x.hechos}/${x.total} · ${x.fallidos} con error · `, tiempo(x.terminado_en || x.iniciado_en)))
          : el("p", { class: "vacio" }, "Aún no hay ciclos.")),
      el("div", { class: "card stat" }, el("h3", {}, "Próximas variantes"),
        m.proximasVariantes.length ? m.proximasVariantes.map(v => fila("#" + v.id + " " + v.titulo, tiempo(v.programada_para)))
          : el("p", { class: "vacio" }, "No hay variantes programadas.")));
  }

  // ---------- Lotes ----------
  const act = (id, que, ok, pregunta) => accion(async () => {
    if (pregunta && !confirm(pregunta)) return false;
    return api("/lotes/" + id + "/" + que, { method: "POST" });
  }, ok);

  function detalleLote(l) {
    const d = detalles.get(l.id);
    if (!d) return el("div", { class: "detalle muted" }, "Cargando detalle…");
    const items = d.items.slice(0, MAX_FILAS);
    return el("div", { class: "detalle" },
      el("div", {}, el("h4", {}, `Elementos (${d.items.length}${d.items.length > MAX_FILAS ? ", mostrando " + MAX_FILAS : ""})`),
        items.length ? tabla(["#", "Tipo", "Estado", "Intentos", "Ciclo", "Detalle"], items.map(i => el("tr", {},
          el("td", {}, String(i.id)), el("td", {}, quitarGuion(i.tipo) + (i.clip_id ? " · clip " + i.clip_id : "")),
          el("td", {}, chip(quitarGuion(i.estado), claseEstado(i.estado))), el("td", {}, String(i.intentos)),
          el("td", {}, i.ciclo_id ? "#" + i.ciclo_id : "—"), el("td", { class: "ancho" }, i.detalle || ""))))
          : el("p", { class: "vacio" }, "Sin elementos.")),
      d.variantes.length ? el("div", {}, el("h4", {}, `Variantes del lote (${d.variantes.length})`),
        tabla(["#", "Título", "Plataformas", "Programada", "Estado"], d.variantes.map(v => el("tr", {},
          el("td", {}, String(v.id)), el("td", { class: "ancho" }, v.titulo + (v.angulo ? " · " + v.angulo : "")),
          el("td", {}, CL.variantes.plataformas(v)), el("td", {}, tiempo(v.programada_para)),
          el("td", {}, chip(quitarGuion(v.estado), claseEstado(v.estado)), v.error ? el("div", { class: "err-txt" }, v.error) : null))))) : null,
      el("div", {}, el("h4", {}, "Últimos eventos"),
        d.eventos.length ? el("div", { class: "feed" }, d.eventos.map(e => el("div", {}, tiempo(e.creado_en), chip(quitarGuion(e.evento), claseEstado(e.estado)), e.detalle ? el("span", {}, e.detalle) : null)))
          : el("p", { class: "vacio" }, "Sin eventos.")));
  }

  function tarjetaLote(l) {
    const it = l.items || {};
    const terminados = TERMINADOS.reduce((a, k) => a + (it[k] || 0), 0);
    const abierto = abiertos.has(l.id);
    return el("article", { class: "lote", id: "lote-" + l.id },
      el("div", { class: "cabecera" },
        el("h3", {}, "#" + l.id + " · " + l.nombre),
        chip(l.tipo), chip(quitarGuion(l.estado), claseEstado(l.estado))),
      barra(terminados, l.total, l.estado === "con_errores" ? "mal" : l.estado === "completado" ? "ok" : ""),
      el("div", { class: "kv" }, el("span", { class: "muted" }, `${terminados} de ${l.total} elementos terminados`), conteos(it, ORD.items)),
      el("div", { class: "kv" },
        el("span", { class: "muted" }, "Creado ", tiempo(l.creado_en), l.iniciado_en ? [" · inició ", tiempo(l.iniciado_en)] : "", l.terminado_en ? [" · terminó ", tiempo(l.terminado_en)] : ""),
        el("span", { class: "acts" },
          ["pendiente", "corriendo"].includes(l.estado) ? el("button", { type: "button", class: "ghost chico", onclick: act(l.id, "pausar", "Lote pausado.") }, "Pausar") : null,
          l.estado === "pausado" ? el("button", { type: "button", class: "ghost chico", onclick: act(l.id, "reanudar", "Lote reanudado.") }, "Reanudar") : null,
          ["pendiente", "corriendo", "pausado"].includes(l.estado) ? el("button", { type: "button", class: "ghost chico", onclick: act(l.id, "cancelar", "Lote cancelado.", "¿Cancelar el lote «" + l.nombre + "»? Lo que ya está en ejecución termina; lo pendiente se cancela.") }, "Cancelar") : null,
          el("button", { type: "button", class: "ghost chico", "aria-expanded": String(abierto), onclick: () => {
            if (abiertos.has(l.id)) abiertos.delete(l.id); else { abiertos.add(l.id); cargar(); }
            dibujar(true);
          } }, abierto ? "Ocultar detalle" : "Ver detalle"))),
      abierto ? detalleLote(l) : null);
  }

  // ---------- Variantes ----------
  function filaVariante(v) {
    const f = [el("tr", {},
      el("td", {}, String(v.id)),
      el("td", { class: "ancho" }, el("b", {}, v.titulo), el("div", { class: "muted" }, (v.angulo ? v.angulo + " · " : "") + "clip: " + v.clip_titulo + " · lote «" + v.lote + "»"),
        v.error ? el("div", { class: "err-txt" }, v.error) : null),
      el("td", {}, CL.variantes.plataformas(v)),
      el("td", {}, v.estado === "publicada" && v.publicado_en ? ["publicada ", tiempo(v.publicado_en)] : [tiempo(v.programada_para), el("div", { class: "muted" }, fecha(v.programada_para))]),
      el("td", {}, chip(quitarGuion(v.estado), claseEstado(v.estado)), el("div", { class: "muted" }, `${v.intentos} intentos · ${v.aplazos} aplazos`)),
      el("td", {}, el("div", { class: "acts" }, CL.variantes.botones(v, () => dibujar(true)))))];
    const form = CL.variantes.formulario(v, () => dibujar(true));
    if (form) f.push(el("tr", {}, el("td", { colspan: "6" }, form)));
    return f;
  }

  function variantes(lista) {
    if (!lista.length) return [el("p", { class: "vacio" }, "No hay variantes con este filtro.")];
    return [tabla(["#", "Variante", "Plataformas", "Salida", "Estado", "Acciones"], lista.flatMap(filaVariante))];
  }

  // ---------- Carga y dibujo ----------
  function dibujar(forzar = false) {
    if (!datos) return;
    $("lt-hora").textContent = "Consultado a las " + hora(datos.t);
    pintar($("lt-monitor"), JSON.stringify(datos.mon), () => [monitor(datos.mon)], forzar);
    pintar($("lt-lotes"), JSON.stringify([datos.lotes, [...abiertos].map(id => detalles.get(id))]), () =>
      datos.lotes.length ? datos.lotes.map(tarjetaLote) : [el("div", { class: "card vacio" }, "Aún no hay lotes.")], forzar);
    pintar($("lt-vars"), JSON.stringify(datos.vars), () => variantes(datos.vars), forzar);
  }

  async function cargar(manual = false) {
    if (cargando) { pendiente = true; return; }
    cargando = true;
    try {
      const ids = [...abiertos];
      const [mon, lotes, vars, det] = await Promise.all([
        api("/lotes/monitor"), api("/lotes"), api("/panel/variantes?estado=" + encodeURIComponent(filtro)),
        Promise.all(ids.map(id => Promise.all([api("/lotes/" + id), api("/lotes/" + id + "/eventos?limite=30")])
          .then(([d, eventos]) => [id, { items: d.items, variantes: d.variantes, eventos }]).catch(() => null)))
      ]);
      for (const x of det) if (x) detalles.set(x[0], x[1]);
      datos = { mon, lotes, vars, t: Date.now() };
      dibujar(manual);
    } catch (e) {
      if (manual) aviso(e.message, true); else $("lt-hora").textContent = "No se pudo consultar: " + e.message;
    } finally {
      cargando = false;
      if (pendiente) { pendiente = false; cargar(); }
    }
  }

  $("lt-consultar").addEventListener("click", () => cargar(true));
  $("lt-filtro").addEventListener("change", ev => { filtro = ev.target.value; cargar(true); });

  CL.registrar("lotes", {
    alActivar(params) {
      firmaSnap = "";
      if (params.lote) abiertos.add(String(params.lote));
      cargar(true);
      if (params.lote) setTimeout(() => $("lote-" + params.lote)?.scrollIntoView({ block: "start" }), 600);
    },
    alSnapshot(s) {
      if (CL.activa !== "lotes") return;
      const f = JSON.stringify([s.monitor, s.lotes]);
      if (f === firmaSnap) return;
      firmaSnap = f;
      cargar();
    }
  });
})();
