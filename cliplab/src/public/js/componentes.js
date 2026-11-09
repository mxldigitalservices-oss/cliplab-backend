// Componentes compartidos por las vistas.
import { h, badge, etiqueta, fechaHora, hace, toast, confirmar, abrirModal, conBoton, aInputLocal, medidorDuracion } from "./ui.js";
import { api } from "./api.js";
import { refrescar, ultimo } from "./tiempo.js";
import { CAMPOS, pick, progresoLote, loteTerminal, loteEnPausa, varianteCerrada, duracionDe, nombrePlat } from "./esquema.js";

// ---------- Básicos ----------
export const vacio = msg => h("div", { class: "vacio" }, msg);
export const tile = (etq, valor, extra) => h("div", { class: `tile ${extra || ""}` }, h("div", { class: "tile-v" }, valor), h("div", { class: "tile-l" }, etq));

const _ultimo = new WeakMap();
/** Repinta `cont` solo si `datos` cambió (evita parpadeo y pérdida de foco con el sondeo). */
export function pintar(cont, datos, fn) {
  const firma = JSON.stringify(datos);
  if (_ultimo.get(cont) === firma) return;
  _ultimo.set(cont, firma);
  cont.replaceChildren(fn());
}

export function tablaDe(filas, cols) {
  if (!filas?.length) return vacio("Sin datos.");
  return h("div", { class: "tabla-wrap" }, h("table", { class: "tabla" },
    h("thead", null, h("tr", null, cols.map(c => h("th", null, c.t)))),
    h("tbody", null, filas.map(f => h("tr", null, cols.map(c => h("td", null, c.v(f))))))));
}

// ---------- Render genérico (monitor, detalle de lote, eventos…) ----------
const esFecha = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T/.test(s);
const esEscalar = v => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
export function valorTxt(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "sí" : "no";
  return esFecha(v) ? fechaHora(v) : String(v);
}
export function generico(v, nivel = 0) {
  if (esEscalar(v)) return h("span", null, valorTxt(v));
  if (Array.isArray(v)) {
    if (!v.length) return h("span", { class: "muted" }, "(vacío)");
    if (v.every(esEscalar)) return h("span", null, v.map(valorTxt).join(", "));
    const filas = v.filter(x => x && typeof x === "object" && !Array.isArray(x)).slice(0, 25);
    const cols = [];
    for (const f of filas) for (const k of Object.keys(f)) if (esEscalar(f[k]) && !cols.includes(k)) cols.push(k);
    return tablaDe(filas, cols.slice(0, 8).map(k => ({ t: etiqueta(k), v: f => (/estado/.test(k) && f[k] ? badge(f[k]) : valorTxt(f[k])) })));
  }
  const esc = Object.entries(v).filter(([, x]) => esEscalar(x));
  const resto = Object.entries(v).filter(([, x]) => !esEscalar(x));
  return h("div", { class: "gen" },
    esc.length ? h("div", { class: "grid kpis" }, esc.map(([k, x]) => tile(etiqueta(k), /estado/.test(k) && x ? badge(x) : valorTxt(x)))) : null,
    resto.map(([k, x]) => h("div", { class: "gen-sec" }, h("h3", null, etiqueta(k)), nivel < 3 ? generico(x, nivel + 1) : h("span", null, "…"))));
}

export function barraProgreso(pct, fallPct = 0) {
  const ok = h("span", { class: "bp-ok" }); ok.style.width = `${pct}%`;
  const mal = h("span", { class: "bp-mal" }); mal.style.width = `${fallPct}%`;
  return h("div", { class: "bp", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct }, ok, mal);
}

// ---------- Estado global / sesiones ----------
export async function infoEstado() { return ultimo("estado") || api.get("/estado"); }
export const sesionesConectadas = est => new Set((est?.sesiones || []).map(r => pick(r, CAMPOS.sesion.plataforma)).filter(Boolean));

/** Casillas de plataformas. Con `exigirSesion`, las que no tienen sesión quedan desactivadas. */
export function checksPlataformas(plataformas, { conectadas = new Set(), exigirSesion = false, marcadas = [] } = {}) {
  const items = plataformas.map(p => {
    const sin = exigirSesion && !conectadas.has(p);
    const cb = h("input", { type: "checkbox", value: p, disabled: sin, checked: !sin && marcadas.includes(p) });
    return { p, cb, el: h("label", { class: `check ${sin ? "off" : ""}` }, cb, h("span", null, nombrePlat(p)), sin ? h("small", { class: "muted" }, "sin sesión") : null) };
  });
  return { el: h("div", { class: "checks" }, items.map(i => i.el)), valores: () => items.filter(i => i.cb.checked && !i.cb.disabled).map(i => i.p) };
}

// ---------- Lotes ----------
export function tarjetaLote(l, { onAbrir, onCambio } = {}) {
  const p = progresoLote(l);
  const terminal = loteTerminal(l.estado), pausa = loteEnPausa(l.estado);
  const hecho = () => { refrescar("lotes", "monitor", "ciclos"); onCambio?.(); };
  const accion = (txt, ruta, clase, conf, ok) => h("button", {
    type: "button", class: `btn sm ${clase || ""}`,
    onClick: ev => conBoton(ev, async () => {
      if (conf && !(await confirmar(conf, { peligro: true, texto: txt }))) return;
      await api.post(ruta);
      toast(ok);
      hecho();
    })
  }, txt);

  return h("article", { class: "card lote" },
    h("div", { class: "card-h" },
      h("div", null, h("strong", null, pick(l, CAMPOS.lote.nombre, `Lote #${l.id}`)), h("div", { class: "muted sm" }, `#${l.id}`, l.creado_en ? ` · ${hace(l.creado_en)}` : "")),
      badge(l.estado)),
    barraProgreso(p.pct, p.fallPct),
    h("div", { class: "lote-meta" },
      h("span", null, `${p.hechos}/${p.total || "?"} listos`),
      p.fall ? h("span", { class: "t-bad-txt" }, `${p.fall} con error`) : null,
      h("span", { class: "muted" }, `${p.pct}%`)),
    h("div", { class: "acciones" },
      onAbrir ? h("button", { type: "button", class: "btn sm", onClick: () => onAbrir(l) }, "Detalle") : null,
      !terminal && !pausa ? accion("Pausar", `/lotes/${l.id}/pausar`, "", null, "Lote en pausa.") : null,
      !terminal && pausa ? accion("Reanudar", `/lotes/${l.id}/reanudar`, "primary", null, "Lote reanudado.") : null,
      !terminal ? accion("Cancelar", `/lotes/${l.id}/cancelar`, "danger", `Se cancelará el lote ${pick(l, CAMPOS.lote.nombre, "#" + l.id)}. Los elementos pendientes no se procesarán.`, "Lote cancelado.") : null));
}

export function tablaCiclos(ciclos, limite = 12) {
  const filas = [...(Array.isArray(ciclos) ? ciclos : [])].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, limite);
  const C = CAMPOS.ciclo;
  const cols = [
    { t: "Ciclo", v: f => `#${pick(f, C.numero, "—")}` },
    { t: "Lote", v: f => (pick(f, C.lote) !== undefined ? `#${pick(f, C.lote)}` : "—") },
    { t: "Estado", v: f => badge(f.estado) },
    { t: "Elementos (10–20)", v: f => { const t = pick(f, C.total), k = pick(f, C.hechos); return t === undefined ? "—" : `${k ?? 0}/${t}`; } },
    { t: "Inicio", v: f => (pick(f, C.inicio) ? hace(pick(f, C.inicio)) : "—") },
    { t: "Fin", v: f => (pick(f, C.fin) ? hace(pick(f, C.fin)) : "—") }
  ];
  return tablaDe(filas, cols);
}

// ---------- Variantes ----------
export function tarjetaVariante(v, { clip, onCambio } = {}) {
  const V = CAMPOS.variante;
  const plat = pick(v, V.plataforma), prog = pick(v, V.programada);
  const dur = duracionDe(v) ?? duracionDe(clip);   // misma regla: ≤ 60 s (ideal 30–60 s)
  const incierto = String(v.estado).toLowerCase() === "incierto";
  const cerrada = varianteCerrada(v.estado);
  const hecho = () => { refrescar("monitor"); onCambio?.(); };

  const reprogramar = () => {
    const inp = h("input", { type: "datetime-local", value: aInputLocal(prog && !isNaN(new Date(prog)) ? new Date(prog) : new Date(Date.now() + 3600e3)) });
    abrirModal({
      titulo: "Reprogramar variante", cuerpo: h("div", { class: "campo" }, h("label", null, "Nueva fecha y hora"), inp),
      botones: [{ texto: "Cancelar", clase: "ghost" }, {
        texto: "Guardar", clase: "primary",
        onClick: async () => {
          if (!inp.value) { toast("Elige una fecha.", "error"); return false; }
          await api.post(`/variantes/${v.id}/reprogramar`, { programada_para: new Date(inp.value).toISOString() });
          toast("Variante reprogramada."); hecho();
        }
      }]
    });
  };
  const cancelar = ev => conBoton(ev, async () => {
    if (!(await confirmar("Se cancelará esta variante programada.", { peligro: true, texto: "Cancelar variante" }))) return;
    await api.post(`/variantes/${v.id}/cancelar`);
    toast("Variante cancelada."); hecho();
  });
  const resolver = () => {
    const enviar = accion => async cerrar => {
      await api.post(`/variantes/${v.id}/resolver`, { plataforma: plat, accion });
      toast(accion === "publicado" ? "Marcada como publicada." : "Se reintentará."); hecho(); cerrar(true); return false;
    };
    abrirModal({
      titulo: "Resolver publicación incierta",
      cuerpo: h("p", null, `El agente no pudo confirmar si la variante #${v.id} se publicó en ${nombrePlat(plat)}. Revisa la cuenta y decide:`),
      botones: [{ texto: "Cancelar", clase: "ghost" }, { texto: "Ya se publicó", onClick: enviar("publicado") }, { texto: "Reintentar", clase: "primary", onClick: enviar("reintentar") }]
    });
  };

  return h("article", { class: `card variante ${incierto ? "incierta" : ""}` },
    h("div", { class: "card-h" },
      h("div", null, h("strong", null, pick(v, V.titulo, `Variante #${v.id}`)), h("div", { class: "muted sm" }, pick(v, V.angulo) ? `Ángulo: ${pick(v, V.angulo)}` : `#${v.id}`)),
      h("div", { class: "fila" }, plat ? h("span", { class: "chip" }, nombrePlat(plat)) : null, badge(v.estado))),
    pick(v, V.gancho) ? h("p", { class: "muted gancho" }, pick(v, V.gancho)) : null,
    medidorDuracion(dur),
    h("div", { class: "muted sm" }, prog ? `Programada: ${fechaHora(prog)} (${hace(prog)})` : "Sin programar"),
    pick(v, V.detalle) ? h("div", { class: "aviso sm" }, String(pick(v, V.detalle))) : null,
    h("div", { class: "acciones" },
      incierto ? h("button", { type: "button", class: "btn sm primary", onClick: resolver }, "Resolver") : null,
      !cerrada ? h("button", { type: "button", class: "btn sm", onClick: reprogramar }, "Reprogramar") : null,
      !cerrada ? h("button", { type: "button", class: "btn sm danger", onClick: cancelar }, "Cancelar") : null));
}
