const $ = id => document.getElementById(id);
const NOMBRE = { tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook" };

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
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

const decir = (t, err) => { const m = $("msg"); m.textContent = t || ""; m.className = err ? "error" : ""; };
const fmt = s => { s = Math.round(Number(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };
const fecha = t => t ? new Date(t).toLocaleString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
const accion = (fn, okMsg) => async () => { try { await fn(); if (okMsg) decir(okMsg); await refrescar(true); } catch (e) { decir(e.message, true); } };

// ---------- Sesiones ----------
function pintarSesiones(e) {
  const box = $("ses"); box.replaceChildren();
  for (const p of e.plataformas) {
    const s = e.sesiones.find(x => x.plataforma === p);
    const input = el("input", { type: "file", accept: ".json,application/json", hidden: true });
    input.addEventListener("change", async () => {
      try {
        const txt = await input.files[0].text();
        const r = await api("/sesiones/" + p, { method: "PUT", body: txt });
        decir("Sesión de " + NOMBRE[p] + " guardada" + (r.expira ? " (vence " + fecha(r.expira) + ")" : "") + "." + (r.avisos?.length ? " " + r.avisos.join(" ") : ""));
        await refrescar(true);
      } catch (err) { decir(err.message, true); }
      input.value = "";
    });
    const estado = !s ? el("span", { class: "chip warn" }, "sin sesión")
      : el("span", { class: "chip " + (s.test_ok === false ? "err" : s.test_ok ? "ok" : "") },
          (s.test_ok === true ? "válida · probada " + fecha(s.ultimo_test) : s.test_ok === false ? "falló la prueba" : "cargada " + fecha(s.actualizado_en)) + (s.expira_en ? " · vence " + fecha(s.expira_en) : ""));
    box.append(el("div", { class: "row" },
      el("b", {}, NOMBRE[p]), estado,
      el("button", { class: "ghost", onclick: () => input.click() }, s ? "Reemplazar" : "Subir sesión"), input,
      s ? el("button", { class: "ghost", onclick: accion(async () => { decir("Probando " + NOMBRE[p] + "… (puede tardar 30 s)"); const r = await api("/sesiones/" + p + "/probar", { method: "POST" }); decir(NOMBRE[p] + ": " + (r.ok ? "sesión válida" : "sesión NO válida (" + r.detalle + ")"), !r.ok); }) }, "Probar") : null,
      s ? el("button", { class: "ghost", onclick: accion(async () => { if (confirm("¿Eliminar la sesión de " + NOMBRE[p] + "?")) await api("/sesiones/" + p, { method: "DELETE" }); }) }, "Eliminar") : null,
      s && s.test_ok === false ? el("small", { class: "err-txt" }, s.test_detalle) : null));
  }
}

// ---------- Clips ----------
const ESTADOS = { pendiente: "en cola", cortando: "cortando…", listo: "listo", publicando: "publicando…", publicado: "publicado", error: "error", expirado: "archivo purgado" };

function tarjeta(c) {
  const pubs = (c.pubs || []).map(p => el("span", { class: "chip " + (p.e === "ok" ? "ok" : p.e === "error" ? "err" : "warn") }, NOMBRE[p.p] + ": " + (p.e === "simulado" ? "prueba" : p.e)));
  const publicar = lista => accion(async () => { await api("/clips/" + c.id + "/publicar", { method: "POST", body: JSON.stringify({ plataformas: lista }) }); decir("Publicación en cola."); });
  const ocupado = ["pendiente", "cortando", "publicando"].includes(c.estado);
  return el("div", { class: "clip" },
    c.tiene_archivo ? el("video", { controls: true, preload: "none", playsinline: true, src: "/media/" + c.token + ".mp4" }) : el("div", { class: "ph" }, ESTADOS[c.estado] || c.estado),
    el("div", { class: "body" },
      el("h3", {}, c.titulo),
      c.gancho ? el("small", { class: "muted" }, "“" + c.gancho + "”") : null,
      el("div", { class: "chips" },
        el("span", { class: "chip" }, fmt(c.inicio_seg) + " → " + fmt(c.fin_seg)),
        c.puntaje != null ? el("span", { class: "chip" }, c.puntaje + "/100") : null,
        c.angulo ? el("span", { class: "chip" }, c.angulo) : null,
        el("span", { class: "chip " + (c.estado === "error" ? "err" : c.estado === "publicado" ? "ok" : "") }, ESTADOS[c.estado] || c.estado), pubs),
      c.error ? el("small", { class: "err-txt" }, c.error) : null,
      el("div", { class: "acts" },
        ...Object.keys(NOMBRE).map(p => el("button", { class: "ghost", disabled: ocupado, onclick: publicar([p]) }, "→ " + NOMBRE[p])),
        el("button", { class: "ghost", disabled: ocupado, onclick: () => { if (confirm("¿Publicar en todas las plataformas?")) publicar(Object.keys(NOMBRE))(); } }, "→ Todas"),
        el("button", { class: "ghost", disabled: ocupado, onclick: accion(() => api("/clips/" + c.id + "/recortar", { method: "POST" })) }, "Recortar de nuevo"),
        c.tiene_archivo ? el("button", { class: "ghost", disabled: ocupado, onclick: accion(() => api("/clips/" + c.id + "/archivo", { method: "DELETE" })) }, "Borrar archivo") : null,
        ...(c.pubs || []).filter(p => p.e === "incierto").flatMap(p => [
          el("button", { class: "ghost", onclick: accion(() => api("/clips/" + c.id + "/resolver", { method: "POST", body: JSON.stringify({ plataforma: p.p, accion: "publicado" }) }), "Marcado como publicado.") }, "Ya se publicó en " + NOMBRE[p.p]),
          el("button", { class: "ghost", onclick: accion(() => api("/clips/" + c.id + "/resolver", { method: "POST", body: JSON.stringify({ plataforma: p.p, accion: "reintentar" }) }), "Listo para reintentar.") }, "Reintentar " + NOMBRE[p.p])
        ]))));
}

// ---------- Refresco ----------
let ultimo = "";
async function refrescar(forzar) {
  const [e, clips] = await Promise.all([api("/estado"), api("/clips")]);
  $("modo").textContent = e.publicarReal ? "MODO REAL" : "MODO PRUEBA";
  $("info").textContent = e.discoMb + " MB en disco" + (e.agenteOcupado ? " · agente trabajando" : "");
  $("fuentes").replaceChildren(...e.fuentes.map(f => el("div", {}, f.video_id + ": " + f.estado + (f.error ? " — " + f.error : ""))));
  const firma = JSON.stringify([e.sesiones, clips, e.evidencias]);
  if (!forzar && firma === ultimo) return;
  if ([...document.querySelectorAll("video")].some(v => !v.paused)) return;   // no cortar la reproducción
  ultimo = firma;
  pintarSesiones(e);
  $("clips").replaceChildren(...(clips.length ? clips.map(tarjeta) : [el("div", { class: "card muted" }, "Aún no hay clips.")]));
  $("evid").replaceChildren(...(e.evidencias.length ? e.evidencias.map(n => el("div", {}, el("a", { href: "/evidencia/" + n, target: "_blank", rel: "noopener" }, n))) : ["Sin capturas todavía."]));
}

function armarAuto() {
  $("auto").replaceChildren(...Object.keys(NOMBRE).map(p => el("label", {}, el("input", { type: "checkbox", value: p }), NOMBRE[p])));
}

$("f").addEventListener("submit", async ev => {
  ev.preventDefault();
  $("go").disabled = true; decir("");
  try {
    const plataformas = [...document.querySelectorAll("#auto input:checked")].map(i => i.value);
    await api("/fuentes", { method: "POST", body: JSON.stringify({ url: $("url").value.trim(), plataformas }) });
    $("url").value = "";
    decir("Video en cola: se analiza y se cortan los clips.");
    await refrescar(true);
  } catch (e) { decir(e.message, true); }
  $("go").disabled = false;
});

armarAuto();
refrescar(true).catch(e => decir(e.message, true));
setInterval(() => refrescar(false).catch(() => {}), 5000);
