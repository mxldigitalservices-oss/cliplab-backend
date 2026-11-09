// Pestaña "Resumen": estado del sistema en tiempo real, ciclo activo, lotes, inventario de clips y actividad.
(() => {
  "use strict";
  const { $, el, chip, barra, conteos, tiempo, pintar, bannerListo, NOMBRE, PLATS, claseEstado, quitarGuion, hora } = CL;

  const fila = (k, ...v) => el("div", { class: "kv" }, el("span", { class: "muted" }, k), el("span", { class: "v" }, ...v));
  const tarjeta = (titulo, ...hijos) => el("div", { class: "card stat" }, el("h3", {}, titulo), ...hijos);

  const ORD = {
    lotes: ["pendiente", "corriendo", "pausado", "completado", "con_errores", "cancelado"],
    items: ["pendiente", "encolado", "corriendo", "aplazado", "hecho", "error", "cancelado"],
    variantes: ["programada", "en_cola", "publicando", "publicada", "simulada", "parcial", "incierta", "error", "cancelada"],
    clips: ["pendiente", "cortando", "listo", "publicando", "publicado", "error", "expirado"]
  };

  function tarjetas(s) {
    const { sistema: si, listo, inventario: inv, monitor: m } = s;
    const c = m.cicloAbierto;
    const disco = si.maxDiscoMb > 0 ? si.discoMb / si.maxDiscoMb : 0;
    return [
      tarjeta("Sistema",
        fila("Modo", chip(si.modo === "real" ? "REAL: publica de verdad" : "PRUEBA: no pulsa Publicar", si.modo === "real" ? "warn" : "info")),
        fila("Agente de navegador", chip(si.agenteOcupado ? "trabajando" : "libre", si.agenteOcupado ? "info" : "ok")),
        fila("Disco de clips", `${si.discoMb} / ${si.maxDiscoMb} MB`),
        barra(si.discoMb, si.maxDiscoMb, disco > 0.9 ? "mal" : disco > 0.7 ? "" : "ok"),
        fila("Servidor activo desde", tiempo(si.arranque)),
        fila("Zona de publicación", si.zona)),
      tarjeta("Ciclo de lotes",
        c ? [
          fila("Ciclo abierto", "#" + c.id),
          barra(c.hechos + c.fallidos, c.total),
          fila("Avance", `${c.hechos + c.fallidos} de ${c.total} · ${c.hechos} hechos · ${c.fallidos} con error`),
          fila("Inició", tiempo(c.iniciado_en))
        ] : [
          el("p", { class: "vacio" }, "Sin ciclo abierto."),
          fila("Tamaño de ciclo", m.config.tamanoCiclo + " elementos"),
          fila("Pausa entre ciclos", m.config.pausaCicloS + " s")
        ]),
      tarjeta("Lotes", conteos(m.lotes, ORD.lotes)),
      tarjeta("Elementos de lote", conteos(m.items, ORD.items)),
      tarjeta("Variantes", conteos(m.variantes, ORD.variantes)),
      tarjeta("Inventario de clips",
        fila("Total", el("span", { class: "num" }, String(inv.total))),
        fila("Con archivo en disco", `${inv.conArchivo} · ${inv.mb} MB`),
        conteos(inv.clips, ORD.clips),
        fila("Videos fuente", conteos(inv.fuentes))),
      tarjeta("Cola de trabajos",
        fila("Pendientes", String(inv.jobs.pendientes)),
        fila("Corriendo", String(inv.jobs.corriendo)),
        fila("Con error (24 h)", chip(String(inv.jobs.errores24h), inv.jobs.errores24h ? "err" : "ok"))),
      tarjeta("Publicaciones en 24 h",
        listo.plataformas.map(p => el("div", {},
          fila(NOMBRE[p.plataforma], `${p.usoDia} / ${p.maxPubDia}`),
          barra(p.usoDia, p.maxPubDia, p.usoDia >= p.maxPubDia ? "mal" : p.usoDia >= p.maxPubDia * 0.8 ? "" : "ok"))))
    ];
  }

  const proximas = m => m.proximasVariantes.length
    ? m.proximasVariantes.map(v => el("div", { class: "kv" },
        el("span", {}, el("b", {}, "#" + v.id + " "), v.titulo, " ", (v.plataformas || []).map(p => chip(NOMBRE[p] || p))),
        tiempo(v.programada_para)))
    : [el("p", { class: "vacio" }, "No hay variantes programadas.")];

  const actividad = lista => lista.length
    ? [el("div", { class: "feed" }, lista.map(e => el("div", {},
        tiempo(e.creado_en), chip(quitarGuion(e.evento), claseEstado(e.estado)),
        e.lote ? el("span", { class: "muted" }, "«" + e.lote + "»") : null,
        e.detalle ? el("span", {}, e.detalle) : null)))]
    : [el("p", { class: "vacio" }, "Sin actividad registrada todavía.")];

  CL.registrar("resumen", {
    alSnapshot(s) {
      pintar($("rs-listo"), JSON.stringify(s.listo), () => [bannerListo(s.listo)]);
      pintar($("rs-tarjetas"), JSON.stringify([s.sistema, s.listo.plataformas.map(p => [p.usoDia, p.maxPubDia]), s.inventario, s.monitor.cicloAbierto, s.monitor.lotes, s.monitor.items, s.monitor.variantes, s.monitor.config]), () => tarjetas(s));
      pintar($("rs-proximas"), JSON.stringify(s.monitor.proximasVariantes), () => proximas(s.monitor));
      pintar($("rs-actividad"), JSON.stringify(s.actividad), () => actividad(s.actividad));
    }
  });
})();
