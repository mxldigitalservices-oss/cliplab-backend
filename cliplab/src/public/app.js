// Núcleo del panel (Fase 5): utilidades compartidas, pestañas y canal en vivo (SSE con respaldo por sondeo).
// Cada vista se registra con CL.registrar(nombre, { alActivar(params), alSnapshot(s) }).
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const NOMBRE = { tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook" };
  const PLATS = Object.keys(NOMBRE);
  const NOMBRE_CX = { ...NOMBRE, youtube: "YouTube" };   // conexiones: las 3 redes de publicación + YouTube (descarga)
  const TXT_CX = { valida: "válida", invalida: "inválida", sin_variable: "sin variable" };
  const MARCA_CX = { valida: "✓", invalida: "✗", sin_variable: "–" };
  const TABS = ["resumen", "conexiones", "lotes", "incidencias", "clips"];
  const VISTAS = new Map();

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }

  async function api(ruta, opts = {}) {
    const r = await fetch("/api" + ruta, {
      credentials: "same-origin", ...opts,
      headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) }
    });
    if (r.status === 401) { location.reload(); throw new Error("Sesión vencida"); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Error " + r.status);
    return d;
  }

  // ---------- Formato ----------
  const fecha = t => t ? new Date(t).toLocaleString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const hora = t => t ? new Date(t).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  const fmt = s => { s = Math.round(Number(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };
  function relativo(t) {
    const d = new Date(t).getTime() - Date.now();
    const min = Math.round(Math.abs(d) / 60e3);
    if (min < 1) return "ahora";
    const txt = min < 60 ? min + " min" : min < 2880 ? Math.floor(min / 60) + " h" + (min % 60 ? " " + (min % 60) + " min" : "") : Math.floor(min / 1440) + " d";
    return d >= 0 ? "en " + txt : "hace " + txt;
  }
  const tiempo = t => t ? el("time", { datetime: new Date(t).toISOString(), title: fecha(t), "data-rel": "" }, relativo(t)) : el("span", { class: "muted" }, "—");
  const quitarGuion = s => String(s).replace(/_/g, " ");

  const CLASES = {
    ok: ["ok", "publicado", "publicada", "hecho", "completado", "listo", "lista", "simulada", "simulado", "real"],
    err: ["error", "con_errores", "bloqueada", "bloqueado", "incierta", "incierto", "fallo"],
    warn: ["pausado", "parcial", "aplazado", "atencion"],
    info: ["corriendo", "encolado", "en_cola", "publicando", "cortando", "programada", "pendiente", "analizando"],
    mute: ["cancelado", "cancelada", "expirado", "descartado"]
  };
  const claseEstado = e => { for (const [c, l] of Object.entries(CLASES)) if (l.includes(e)) return c; return ""; };
  const chip = (txt, clase = "") => el("span", { class: ("chip " + clase).trim() }, txt);
  const barra = (valor, max, clase = "") => el("progress", { class: clase, max: Math.max(1, max), value: Math.min(Number(valor) || 0, Math.max(1, max)) });
  const conteos = (obj = {}, orden = []) => {
    const claves = [...orden.filter(k => obj[k]), ...Object.keys(obj).filter(k => !orden.includes(k) && obj[k])];
    return el("div", { class: "chips" }, claves.length ? claves.map(k => chip(quitarGuion(k) + " " + obj[k], claseEstado(k))) : el("span", { class: "muted" }, "—"));
  };

  let tAviso = null;
  function aviso(texto, error = false) {
    const t = $("toast");
    t.textContent = texto || "";
    t.className = texto ? (error ? "error" : "ok") : "";
    t.hidden = !texto;
    clearTimeout(tAviso);
    if (texto) tAviso = setTimeout(() => { t.hidden = true; }, error ? 9000 : 5000);
  }

  // Redibuja una caja solo si cambió su firma y nadie está escribiendo dentro (no se pierde lo tecleado).
  function pintar(caja, firma, construir, forzar = false) {
    if (!forzar && caja._firma === firma) return;
    const a = document.activeElement;
    if (!forzar && a && caja.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) {
      caja._pend = () => pintar(caja, firma, construir);
      if (!caja._vigila) {
        caja._vigila = true;
        caja.addEventListener("focusin", () => clearTimeout(caja._t));
        caja.addEventListener("focusout", () => {
          clearTimeout(caja._t);
          caja._t = setTimeout(() => {
            const b = document.activeElement;
            if (b && caja.contains(b) && /^(INPUT|SELECT|TEXTAREA)$/.test(b.tagName)) return;
            const p = caja._pend; caja._pend = null; p?.();
          }, 400);
        });
      }
      return;
    }
    caja._firma = firma;
    caja._pend = null;
    caja.replaceChildren(...construir());
  }

  const accion = (fn, okMsg) => async ev => {
    const b = ev?.currentTarget;
    if (b) b.disabled = true;
    try {
      const r = await fn();
      if (r === false) return;
      if (okMsg) aviso(typeof okMsg === "function" ? okMsg(r) : okMsg);
      await refrescarYa();
    } catch (e) { aviso(e.message, true); }
    finally { if (b) b.disabled = false; }
  };

  const bannerListo = listo => el("div", { class: "listo nivel-" + listo.nivel, role: "status" },
    el("b", {}, { listo: "Listo para operar", atencion: "Puede operar, con avisos", bloqueado: "No está listo para operar" }[listo.nivel]),
    el("span", { class: "muted" }, `${listo.plataformasListas} de ${PLATS.length} redes listas para publicar`),
    listo.problemas.length || listo.avisos.length
      ? el("ul", { class: "lista-av" }, listo.problemas.map(t => el("li", { class: "mal" }, t)), listo.avisos.map(t => el("li", { class: "aviso" }, t)))
      : null);

  // ---------- Pestañas ----------
  function ir(nombre, params = {}) {
    if (!TABS.includes(nombre)) nombre = "resumen";
    CL.activa = nombre;
    for (const t of TABS) {
      $("t-" + t).hidden = t !== nombre;
      const b = $("tb-" + t);
      b.setAttribute("aria-selected", String(t === nombre));
      b.tabIndex = t === nombre ? 0 : -1;
    }
    if (location.hash !== "#" + nombre) history.replaceState(null, "", "#" + nombre);
    try { VISTAS.get(nombre)?.alActivar?.(params); } catch (e) { console.error(e); }
    if (CL.ultima) try { VISTAS.get(nombre)?.alSnapshot?.(CL.ultima); } catch (e) { console.error(e); }
  }

  // ---------- Canal en vivo ----------
  let es = null, ultimoSse = 0, sondeando = false, reconectar = null;
  const TEXTO_VIVO = { vivo: "en vivo", sondeo: "actualizando cada 5 s", reconectando: "reconectando…", caido: "sin conexión", error: "base de datos no responde", conectando: "conectando…" };
  const marcar = estado => { $("vivo").dataset.estado = estado; $("vivo-txt").textContent = TEXTO_VIVO[estado]; };

  function pintarCabecera(s) {
    const modo = $("modo");
    modo.textContent = s.sistema.modo === "real" ? "MODO REAL" : "MODO PRUEBA";
    modo.className = "tag" + (s.sistema.modo === "real" ? " real" : "");
    const c = s.monitor.cicloAbierto;
    $("info").textContent = [s.sistema.discoMb + " MB en disco", s.sistema.agenteOcupado ? "agente trabajando" : null, c ? `ciclo ${c.hechos + c.fallidos}/${c.total}` : null].filter(Boolean).join(" · ");
    const n = s.incidencias.conteos.accionables, b = $("bd-incidencias");
    b.textContent = n; b.hidden = n === 0;
  }

  // Semáforo de conexiones en la cabecera: verde = válida, rojo = inválida, gris = sin variable (siempre con texto y marca).
  function pintarConexiones(s) {
    const cx = s.listo.conexiones || [];
    pintar($("conex"), JSON.stringify(cx.map(c => [c.plataforma, c.estado, c.motivo])), () => cx.map(c => el("button", {
      type: "button", class: "semaforo " + c.estado,
      title: `${c.nombre}: ${TXT_CX[c.estado]}${c.motivo ? " — " + c.motivo : ""}`,
      "aria-label": `${c.nombre}: sesión ${TXT_CX[c.estado]}`,
      onclick: () => ir("conexiones")
    }, el("i", { "aria-hidden": "true" }), c.nombre + " " + MARCA_CX[c.estado])));
  }

  function recibir(s, via) {
    CL.ultima = s;
    if (via === "sse") { ultimoSse = Date.now(); marcar("vivo"); }
    else if (via === "sondeo") marcar("sondeo");
    pintarCabecera(s);
    pintarConexiones(s);
    for (const v of VISTAS.values()) { try { v.alSnapshot?.(s); } catch (e) { console.error(e); } }
  }

  async function refrescarYa() {
    try { recibir(await api("/panel/instantanea"), "manual"); } catch { /* el canal en vivo reintenta */ }
  }

  function conectar() {
    clearTimeout(reconectar);
    if (typeof EventSource === "undefined") { marcar("sondeo"); return; }
    es?.close();
    es = new EventSource("/api/panel/stream");
    es.addEventListener("estado", ev => recibir(JSON.parse(ev.data), "sse"));
    es.addEventListener("latido", () => { ultimoSse = Date.now(); marcar("vivo"); });
    es.addEventListener("fallo", ev => { ultimoSse = Date.now(); marcar("error"); aviso("No se pudo leer el estado: " + JSON.parse(ev.data).error, true); });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) { marcar("caido"); reconectar = setTimeout(conectar, 15000); }
      else marcar("reconectando");
    };
  }

  async function vigilar() {   // si el canal en vivo calla más de 30 s, se consulta cada 5 s
    if (Date.now() - ultimoSse < 30000 || sondeando) return;
    sondeando = true;
    try { recibir(await api("/panel/instantanea"), "sondeo"); } catch { marcar("caido"); }
    finally { sondeando = false; }
  }

  const CL = window.CL = {
    $, el, api, NOMBRE, NOMBRE_CX, TXT_CX, PLATS, fecha, hora, fmt, relativo, tiempo, quitarGuion, claseEstado, chip, barra, conteos,
    aviso, pintar, accion, bannerListo, ir, refrescarYa, ultima: null, activa: null,
    registrar: (nombre, vista) => VISTAS.set(nombre, vista)
  };

  function arrancar() {
    const botones = [...document.querySelectorAll(".tab-btn")];
    botones.forEach((b, i) => {
      b.addEventListener("click", () => ir(b.dataset.tab));
      b.addEventListener("keydown", ev => {
        const d = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        const sig = botones[(i + d + botones.length) % botones.length];
        sig.focus(); ir(sig.dataset.tab); ev.preventDefault();
      });
    });
    window.addEventListener("hashchange", () => { const n = location.hash.slice(1); if (TABS.includes(n) && n !== CL.activa) ir(n); });
    ir(location.hash.slice(1) || "resumen");
    refrescarYa();
    conectar();
    setInterval(vigilar, 5000);
    setInterval(() => document.querySelectorAll("time[data-rel]").forEach(n => { n.textContent = relativo(n.getAttribute("datetime")); }), 30000);
  }
  document.addEventListener("DOMContentLoaded", arrancar);
})();
