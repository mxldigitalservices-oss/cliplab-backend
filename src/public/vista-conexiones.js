// Pestaña "Conexiones": sesiones de TikTok, Instagram, Facebook y YouTube. Se activan con un botón que valida la
// variable Base64 de Railway contra el backend; cada tarjeta muestra el semáforo (verde válida / rojo inválida).
(() => {
  "use strict";
  const { $, el, api, chip, barra, tiempo, pintar, bannerListo, aviso, NOMBRE_CX, TXT_CX, PLATS, fecha } = CL;

  const activando = new Set();
  const probando = new Set();
  let ocupadoTodas = false, verificando = false;
  let ultimo = null;

  const fila = (k, ...v) => el("div", { class: "kv" }, el("span", { class: "muted" }, k), el("span", { class: "v" }, ...v));
  const icono = n => el("span", { class: "ico " + n, "aria-hidden": "true" }, n === "ok" ? "✓" : n === "mal" ? "✗" : "!");
  const semaforo = c => el("span", { class: "semaforo " + c.estado }, el("i", { "aria-hidden": "true" }), { valida: "Válida", invalida: "Inválida", sin_variable: "Sin variable" }[c.estado]);

  async function activar(p, silencioso = false) {
    activando.add(p); repintar();
    try {
      const r = await api("/panel/conexiones/" + p + "/activar", { method: "POST" });
      if (!silencioso) aviso(`${NOMBRE_CX[p]}: sesión activada (${r.cookies} cookies${r.expira ? ", vence " + fecha(r.expira) : ""}).` + (r.avisos?.length ? " " + r.avisos.join(" ") : ""));
      return true;
    } catch (e) {
      aviso(`${NOMBRE_CX[p]}: ${e.message}`, true);
      return false;
    } finally { activando.delete(p); await CL.refrescarYa(); }
  }

  async function activarTodas() {
    const lista = (ultimo?.listo.conexiones || []).filter(c => c.presente);
    if (!lista.length) { aviso("No hay ninguna variable de sesión definida en Railway.", true); return; }
    ocupadoTodas = true; repintar();
    let ok = 0;
    try { for (const c of lista) if (await activar(c.plataforma, true)) ok++; }
    finally { ocupadoTodas = false; repintar(); }
    aviso(`Sesiones activadas: ${ok} de ${lista.length}.`, ok < lista.length);
  }

  async function verificar() {
    verificando = true; repintar();
    try {
      const lista = await api("/panel/conexiones");
      aviso(lista.map(c => `${c.nombre}: ${TXT_CX[c.estado]}`).join(" · "), lista.some(c => c.estado === "invalida"));
      await CL.refrescarYa();
    } catch (e) { aviso(e.message, true); }
    finally { verificando = false; repintar(); }
  }

  async function probar(p) {
    probando.add(p); repintar();
    try {
      aviso("Probando " + NOMBRE_CX[p] + " en el navegador… puede tardar 30 s.");
      const r = await api("/sesiones/" + p + "/probar", { method: "POST" });
      aviso(NOMBRE_CX[p] + ": " + (r.ok ? "sesión válida" : "sesión NO válida (" + r.detalle + ")"), !r.ok);
    } catch (e) { aviso(e.message, true); }
    finally { probando.delete(p); await CL.refrescarYa(); }
  }

  function tarjeta(c, red, ocupado) {
    const accionesBloqueadas = activando.has(c.plataforma) || ocupadoTodas;
    const prob = red && c.testOk != null
      ? el("span", {}, chip(c.testOk ? "válida" : "falló", c.testOk ? "ok" : "err"), " ", tiempo(c.ultimoTest))
      : el("span", { class: "muted" }, "sin probar");
    return el("article", { class: "card red p-" + c.plataforma, "data-conexion": c.plataforma },
      el("div", { class: "cabecera" }, el("h3", {}, c.nombre), semaforo(c)),
      c.estado === "valida" ? el("p", { class: "bien" }, c.fuente === "variable" ? "La variable responde como válida." : "Usando la sesión guardada.") : null,
      c.motivo ? el("p", { class: "err-txt" }, c.motivo) : null,
      c.avisos.length ? el("ul", { class: "lista-av" }, c.avisos.map(t => el("li", { class: "aviso" }, t))) : null,
      fila("Variable en Railway", el("code", {}, c.variable), " ", chip(c.presente ? "definida" : "no definida", c.presente ? "ok" : "warn")),
      c.presente ? fila("Cookies / vence", `${c.cookies} · `, c.expira ? [fecha(c.expira), " (", tiempo(c.expira), ")"] : el("span", { class: "muted" }, "sin fecha")) : null,
      fila(c.publicable ? "Sesión activa en el agente" : "Cookies para yt-dlp", c.activa ? chip(c.activadaEn ? "activa" : "activa", "ok") : chip("sin activar", "warn"), c.activadaEn ? [" ", tiempo(c.activadaEn)] : null),
      red ? [
        fila("Última prueba", prob),
        fila("Publicaciones en 24 h", `${red.usoDia} / ${red.maxPubDia}`),
        barra(red.usoDia, red.maxPubDia, red.usoDia >= red.maxPubDia ? "mal" : red.usoDia >= red.maxPubDia * 0.8 ? "" : "ok"),
        fila("Última publicación", red.ultimaOk ? tiempo(red.ultimaOk) : el("span", { class: "muted" }, "—"))
      ] : null,
      el("div", { class: "acts" },
        el("button", { type: "button", class: "run chico", disabled: !c.presente || accionesBloqueadas, title: c.presente ? "Valida la variable y deja la sesión lista" : "Define " + c.variable + " en Railway", onclick: () => activar(c.plataforma) },
          activando.has(c.plataforma) ? "Activando…" : c.activa ? "Reactivar sesión" : "Activar sesión"),
        c.publicable ? el("button", { type: "button", class: "ghost chico", disabled: !c.activa || ocupado || probando.has(c.plataforma), onclick: () => probar(c.plataforma) },
          probando.has(c.plataforma) ? "Probando…" : "Probar en navegador") : null,
        c.publicable && c.activa ? el("button", { type: "button", class: "ghost chico", onclick: CL.accion(async () => {
          if (!confirm("¿Desactivar la sesión de " + c.nombre + "? La variable de Railway no se toca.")) return false;
          return api("/sesiones/" + c.plataforma, { method: "DELETE" });
        }, "Sesión desactivada.") }, "Desactivar") : null));
  }

  function verificacion(s) {
    const { listo, sistema: si } = s;
    const ia = listo.ia;
    return [
      fila("Base de datos", icono("ok"), " responde"),
      fila("Gemini (" + ia.modelo + ")", ia.roles.map(r => chip(r.rol + (r.configurada ? "" : r.cubierta ? " (respaldo)" : " (falta)") + (r.enfriamientoSeg ? " · " + r.enfriamientoSeg + " s" : ""),
        !r.cubierta ? "err" : r.enfriamientoSeg || !r.configurada ? "warn" : "ok"))),
      fila("Modo de publicación", icono(si.modo === "real" ? "ok" : "av"), si.modo === "real" ? " real" : " prueba (no publica)"),
      fila("Agente de navegador", icono(si.agenteOcupado ? "av" : "ok"), si.agenteOcupado ? " ocupado" : " libre"),
      fila("Redes listas", icono(listo.plataformasListas ? "ok" : "mal"), ` ${listo.plataformasListas} de ${PLATS.length}`),
      fila("Disco de clips", icono(si.discoMb > si.maxDiscoMb * 0.9 ? "av" : "ok"), ` ${si.discoMb} / ${si.maxDiscoMb} MB`)
    ];
  }

  function dibujar(s, forzar = false) {
    const cx = s.listo.conexiones || [];
    pintar($("cx-listo"), JSON.stringify(s.listo), () => [bannerListo(s.listo)], forzar);
    pintar($("cx-redes"), JSON.stringify([cx, s.listo.plataformas, s.listo.agenteOcupado, [...activando], [...probando], ocupadoTodas]), () =>
      cx.map(c => tarjeta(c, s.listo.plataformas.find(p => p.plataforma === c.plataforma), s.listo.agenteOcupado)), forzar);
    pintar($("cx-checks"), JSON.stringify([s.listo, s.sistema]), () => verificacion(s), forzar);
    $("cx-activar-todas").disabled = ocupadoTodas || !cx.some(c => c.presente);
    $("cx-verificar").disabled = verificando;
  }
  function repintar() { if (ultimo) dibujar(ultimo, true); }

  $("cx-verificar").addEventListener("click", () => verificar());
  $("cx-activar-todas").addEventListener("click", () => activarTodas());

  CL.registrar("conexiones", { alSnapshot(s) { ultimo = s; dibujar(s); } });
})();
