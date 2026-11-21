// Módulo del dashboard: panel del Publicador (encender/pausar, cookies por red, selección explícita de red, cola).
// Uso:  import { montarPublicador } from "/js/publicador-ui.js";
//       const panel = montarPublicador(document.getElementById("publicador"), { obtenerClipId: () => clipSeleccionado?.id });
// Si no pasas obtenerClipId, el panel muestra un campo "ID del clip". Ninguna red viene marcada por defecto.

import { leerLlave } from "./api.js";

const REDES = [
  { id: "tiktok", nombre: "TikTok" },
  { id: "instagram", nombre: "Instagram" },
  { id: "facebook", nombre: "Facebook" },
];

const CSS = `
.pub{font-family:system-ui,sans-serif;color:#e8e8ee;background:#16161d;border:1px solid #2b2b38;border-radius:14px;padding:18px;max-width:980px}
.pub h2{margin:0 0 14px;font-size:18px}
.pub-barra{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-bottom:14px}
.pub-toggle{font-size:16px;font-weight:700;padding:14px 22px;border:0;border-radius:12px;cursor:pointer;color:#fff;background:#2e7d32}
.pub-toggle.on{background:#c62828}
.pub-toggle:disabled{opacity:.5;cursor:wait}
.pub-badge{font-weight:800;letter-spacing:.06em;padding:8px 14px;border-radius:999px;font-size:13px}
.pub-badge.on{background:#1b5e20;color:#b9f6ca}.pub-badge.off{background:#4a1f1f;color:#ffcdd2}
.pub-tag{font-size:12px;padding:4px 10px;border-radius:999px;background:#33334a;color:#cfd0ff}
.pub-semaforos{display:flex;gap:14px;flex-wrap:wrap}
.pub-sem{display:flex;align-items:center;gap:6px;font-size:13px}
.pub-luz{width:12px;height:12px;border-radius:50%;background:#777}
.pub-luz.ok{background:#43a047}.pub-luz.aviso{background:#fbc02d}.pub-luz.mal{background:#e53935}
.pub-info{font-size:12.5px;color:#a9a9bd;margin-bottom:14px;display:flex;gap:16px;flex-wrap:wrap}
.pub-caja{border:1px solid #2b2b38;border-radius:12px;padding:14px;margin-bottom:14px}
.pub-caja label{font-size:13px;color:#a9a9bd;display:block;margin-bottom:6px}
.pub-redes{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.pub-red{padding:10px 18px;border-radius:10px;border:2px solid #3a3a4d;background:#1f1f2b;color:#e8e8ee;cursor:pointer;font-weight:600}
.pub-red[aria-pressed="true"]{border-color:#7c4dff;background:#3a2a73}
.pub-fila{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.pub input{background:#1f1f2b;border:1px solid #3a3a4d;color:#e8e8ee;border-radius:8px;padding:9px 10px}
.pub-btn{padding:10px 18px;border-radius:10px;border:0;cursor:pointer;font-weight:700;color:#fff;background:#5e35b1}
.pub-btn.sec{background:#00695c}
.pub-btn.peq{padding:5px 10px;font-size:12px;background:#444}
.pub-btn:disabled{opacity:.4;cursor:not-allowed}
.pub-msg{margin-top:10px;font-size:13px;min-height:18px}
.pub-msg.ok{color:#81c784}.pub-msg.err{color:#ff8a80}
.pub table{width:100%;border-collapse:collapse;font-size:13px}
.pub th,.pub td{text-align:left;padding:8px;border-bottom:1px solid #2b2b38;vertical-align:top}
.pub th{color:#a9a9bd;font-weight:600}
.pub-vacio{color:#a9a9bd;padding:12px 0}
`;

function el(tag, props = {}, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v !== false && v != null) n.setAttribute(k, String(v));
  }
  for (const h of hijos.flat()) if (h != null) n.append(h.nodeType ? h : document.createTextNode(String(h)));
  return n;
}

function inyectarCSS() {
  if (document.getElementById("pub-css")) return;
  document.head.append(el("style", { id: "pub-css", text: CSS }));
}

// Habla con la API con la llave maestra y desempaqueta el envelope { success, data, error }.
// Éxito parcial (207): success:true, data.parcial:true y data.resultados con el detalle real por red.
async function api(base, ruta, { method = "GET", body } = {}) {
  const cabeceras = { Accept: "application/json" };
  const llave = leerLlave();
  if (llave) cabeceras["x-master-key"] = llave;
  if (body) cabeceras["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(base + ruta, { method, headers: cabeceras, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  } catch {
    throw new Error("Sin conexión con el servidor");
  }
  let json = null;
  try { json = await res.json(); } catch { /* sin cuerpo JSON */ }
  if (res.status === 401) throw new Error("Falta o no coincide la llave maestra: ponla en la pestaña de acceso del panel.");
  if (!res.ok || (json && json.success === false)) throw new Error((json && json.error) || `Error ${res.status}`);
  if (json && typeof json === "object" && "success" in json) return { ...(json.data || {}), ...(json.error ? { error: json.error } : {}) };
  return json ?? {};
}

function nivelCookie(v) {
  const s = String(v && typeof v === "object" ? (v.estado ?? "") : v ?? "").toLowerCase();
  if (v === true || /^(activa|activo|ok|valida|válida|conectad)/.test(s)) return "ok";
  if (v === false || /^(expirada|vencida|caducada|sin_sesion|sin sesi|error)/.test(s)) return "mal";
  return "";   // desconocido
}

const ESTADOS_COLA = { queued: "En cola", running: "Publicando", published: "Publicado", failed: "Falló", cancelled: "Cancelado" };

// Normaliza un trabajo del programador { id, clipId, platforms[], status, scheduledAt, lastError } a lo que pinta la tabla.
function itemDeCola(it) {
  const red = Array.isArray(it.platforms) ? it.platforms.join(", ") : it.red;
  return {
    id: it.id ?? it._id,
    clipId: it.clipId ?? it.clip ?? null,
    red,
    redUnica: Array.isArray(it.platforms) && it.platforms.length === 1 ? it.platforms[0] : (it.red ?? null),
    status: it.status ?? "",
    estado: ESTADOS_COLA[it.status] ?? it.estado ?? "—",
    fecha: it.scheduledAt ?? it.fecha ?? it.programadoPara ?? null,
    error: it.lastError ?? it.error ?? null,
  };
}

function formatoFecha(v) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("es-DO", { dateStyle: "short", timeStyle: "short" });
}

// Selector de red reutilizable (p. ej. en cada tarjeta de clip listo). Sin selección por defecto.
export function crearSelectorRedes(onChange = () => {}) {
  const seleccion = new Set();
  const contenedor = el("div", { class: "pub-redes", role: "group", "aria-label": "Redes" });
  for (const r of REDES) {
    const b = el("button", {
      type: "button", class: "pub-red", "aria-pressed": "false", "data-red": r.id, text: r.nombre,
      onclick: () => {
        if (seleccion.has(r.id)) seleccion.delete(r.id); else seleccion.add(r.id);
        b.setAttribute("aria-pressed", String(seleccion.has(r.id)));
        onChange([...seleccion]);
      },
    });
    contenedor.append(b);
  }
  return { contenedor, seleccion: () => REDES.map(r => r.id).filter(id => seleccion.has(id)) };
}

export function montarPublicador(raiz, opciones = {}) {
  if (!raiz) throw new Error("montarPublicador: contenedor requerido");
  const { obtenerClipId = null, intervaloMs = 5000, base = "" } = opciones;
  inyectarCSS();

  let estado = { activo: false, ejecutando: false, cola: [], cookiesRedes: {} };
  let ocupado = false;
  let temporizador = null;

  const badge = el("span", { class: "pub-badge off", text: "DETENIDO" });
  const tagEjec = el("span", { class: "pub-tag", text: "ejecutando…", hidden: true });
  const toggle = el("button", { type: "button", class: "pub-toggle", text: "Encender Publicador", onclick: alternar });
  const semaforos = el("div", { class: "pub-semaforos" });
  const info = el("div", { class: "pub-info" });
  const campoClip = obtenerClipId ? null : el("input", { type: "text", placeholder: "ID del clip", "aria-label": "ID del clip", oninput: refrescarBotones });
  const campoFecha = el("input", { type: "datetime-local", "aria-label": "Fecha y hora (opcional)", oninput: refrescarBotones });
  const selector = crearSelectorRedes(refrescarBotones);
  const btnAhora = el("button", { type: "button", class: "pub-btn", text: "Publicar ahora", onclick: () => enviar("publicar-ahora") });
  const btnProgramar = el("button", { type: "button", class: "pub-btn sec", text: "Programar", onclick: () => enviar("programar") });
  const msg = el("div", { class: "pub-msg", role: "status" });
  const cuerpoCola = el("tbody");

  raiz.replaceChildren(el("section", { class: "pub" },
    el("h2", { text: "Programar y Publicar" }),
    el("div", { class: "pub-barra" }, toggle, badge, tagEjec, semaforos),
    info,
    el("div", { class: "pub-caja" },
      campoClip ? el("div", {}, el("label", { text: "Clip" }), campoClip, el("div", { style: "height:10px" })) : null,
      el("label", { text: "¿Para qué red? (elige explícitamente; no hay selección automática)" }),
      selector.contenedor,
      el("div", { class: "pub-fila" },
        el("label", { style: "margin:0", text: "Fecha (opcional):" }), campoFecha, btnAhora, btnProgramar),
      msg),
    el("div", { class: "pub-caja" },
      el("table", {},
        el("thead", {}, el("tr", {}, ["Clip", "Red", "Estado", "Programado", "Error", ""].map(t => el("th", { text: t })))),
        cuerpoCola))));

  function clipId() { return String((obtenerClipId ? obtenerClipId() : campoClip.value) ?? "").trim(); }

  function refrescarBotones() {
    const listo = !ocupado && clipId() !== "" && selector.seleccion().length > 0;
    btnAhora.disabled = !listo;
    btnProgramar.disabled = !listo;
  }

  function mostrar(texto, tipo = "") { msg.className = `pub-msg ${tipo}`; msg.textContent = texto; }

  function pintar() {
    const on = !!estado.activo;
    badge.className = `pub-badge ${on ? "on" : "off"}`;
    badge.textContent = on ? "ACTIVO" : "DETENIDO";
    tagEjec.hidden = !estado.ejecutando;
    toggle.className = `pub-toggle ${on ? "on" : ""}`;
    toggle.textContent = on ? "Pausar Publicador" : "Encender Publicador";

    semaforos.replaceChildren(...REDES.map(r => {
      const v = estado.cookiesRedes?.[r.id];
      const nivel = nivelCookie(v);
      const txt = typeof v === "object" && v ? (v.estado ?? v.mensaje ?? "") : (typeof v === "string" ? v : "");
      return el("span", { class: "pub-sem", title: txt || "sin datos" }, el("span", { class: `pub-luz ${nivel}` }), r.nombre);
    }));

    const t = estado.tope || {};
    const partes = [];
    if (t.porHora != null) partes.push(`Tope: ${t.usadosUltimaHora ?? 0}/${t.porHora} por hora`);
    partes.push(`Redis: ${estado.redis?.conectado ? "conectado" : "sin conexión"}`);
    {
      const m = estado.mongo || {};
      const motivo = m.conectado ? "" : !m.configurado ? " (sin URI: cola en archivo local)" : " (cola en archivo local)";
      partes.push(`MongoDB: ${m.conectado ? "conectado" : "sin conexión"}${motivo}`);
    }
    partes.push(`Última ejecución: ${formatoFecha(estado.ultimaEjecucion)}`);
    if (estado.ultimoError) partes.push(`Último error: ${typeof estado.ultimoError === "string" ? estado.ultimoError : (estado.ultimoError.mensaje ?? estado.ultimoError.message ?? "ver logs")}`);
    info.replaceChildren(...partes.map(p => el("span", { text: p })));

    const cola = Array.isArray(estado.cola) ? estado.cola : [];
    if (!cola.length) {
      cuerpoCola.replaceChildren(el("tr", {}, el("td", { colspan: 6, class: "pub-vacio", text: "La cola está vacía." })));
    } else {
      cuerpoCola.replaceChildren(...cola.map(filaCola));
    }
    refrescarBotones();
  }

  function filaCola(crudo) {
    const it = itemDeCola(crudo);
    const nombres = it.red ? it.red.split(", ").map((r) => REDES.find((x) => x.id === r)?.nombre ?? r).join(", ") : "—";
    const acciones = el("td", {});
    if (it.status === "queued" && it.id != null) acciones.append(el("button", { type: "button", class: "pub-btn peq", text: "Cancelar", onclick: () => cancelar(it.id) }));
    if ((it.status === "failed" || it.status === "cancelled") && it.id != null) acciones.append(el("button", { type: "button", class: "pub-btn peq", text: "Reintentar", onclick: () => reintentar(it.id) }));
    return el("tr", {},
      el("td", { text: it.clipId ?? "—" }),
      el("td", { text: nombres }),
      el("td", { text: it.estado }),
      el("td", { text: formatoFecha(it.fecha) }),
      el("td", { text: it.error ? String(it.error.mensaje ?? it.error).slice(0, 120) : "" }),
      acciones);
  }

  async function actualizar() {
    try {
      estado = await api(base, "/api/programador/cola");
      pintar();
    } catch (e) { mostrar(`No se pudo leer el estado: ${e.message}`, "err"); }
    refrescarBotones();   // el clip elegido fuera del módulo (select del panel) también habilita/deshabilita los botones
  }

  async function conBloqueo(fn) {
    if (ocupado) return;
    ocupado = true; toggle.disabled = true; refrescarBotones();
    try { await fn(); } catch (e) { mostrar(e.message, "err"); }
    finally { ocupado = false; toggle.disabled = false; await actualizar(); }
  }

  function alternar() {
    return conBloqueo(async () => {
      const r = await api(base, `/api/programador/${estado.activo ? "pausar" : "activar"}`, { method: "POST" });
      estado = { ...estado, ...r };
      mostrar(r.activo ? "Publicador encendido." : "Publicador pausado.", "ok");
      pintar();
    });
  }

  function enviar(accion) {
    const redes = selector.seleccion();
    const id = clipId();
    if (!redes.length) return mostrar("Marca explícitamente para qué red es: TikTok, Instagram y/o Facebook.", "err");
    if (!id) return mostrar("Indica el clip.", "err");
    const cuerpo = { redes };
    if (accion === "programar" && campoFecha.value) cuerpo.fecha = new Date(campoFecha.value).toISOString();
    return conBloqueo(async () => {
      const r = await api(base, `/api/clips/${encodeURIComponent(id)}/${accion}`, { method: "POST", body: cuerpo });
      const lista = r.resultados || [];
      const malas = lista.filter((x) => !x.ok);
      const buenas = lista.filter((x) => x.ok).map((x) => x.etiqueta);
      if (malas.length) {
        const detalle = malas.map((x) => `${x.etiqueta}: ${x.error}`).join(" | ");
        mostrar((buenas.length ? `Parcial — OK en ${buenas.join(", ")}. Falló: ` : "Falló: ") + detalle, "err");
      } else mostrar(accion === "programar" ? "Programado correctamente." : "Publicado correctamente.", "ok");
    });
  }

  function cancelar(id) {
    return conBloqueo(async () => {
      await api(base, `/api/programador/${encodeURIComponent(id)}/cancelar`, { method: "POST" });
      mostrar("Cancelado.", "ok");
    });
  }

  function reintentar(id) {
    return conBloqueo(async () => {
      await api(base, `/api/programador/${encodeURIComponent(id)}/reintentar`, { method: "POST" });
      mostrar("Vuelto a encolar.", "ok");
    });
  }

  function iniciarSondeo() {
    detenerSondeo();
    temporizador = setInterval(() => { if (!document.hidden && !ocupado) actualizar(); }, intervaloMs);
  }
  function detenerSondeo() { if (temporizador) clearInterval(temporizador); temporizador = null; }

  pintar();
  actualizar();
  iniciarSondeo();

  return {
    actualizar,
    refrescarBotones,
    seleccion: selector.seleccion,
    destruir() { detenerSondeo(); raiz.replaceChildren(); },
  };
}
