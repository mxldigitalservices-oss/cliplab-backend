// Gestión de sesiones: estado de TikTok / Instagram / Facebook, subir cookies, probar, eliminar y evidencias.
import { h, toast, confirmar, abrirModal, badge, conBoton, fechaHora, hace } from "../ui.js";
import { api } from "../api.js";
import { suscribir, refrescar } from "../tiempo.js";
import { pintar, vacio } from "../componentes.js";
import { CAMPOS, pick, nombrePlat } from "../esquema.js";

let bajas = [];
const S = CAMPOS.sesion;
const SENSIBLE = /(cookie|cifrad|secret|token|clave|estado_sesion|blob|datos|storage)/i;

function tarjeta(plat, fila, ocupado) {
  const conectada = !!fila;
  const testOk = fila ? pick(fila, S.testOk) : undefined;
  const testDet = fila ? pick(fila, S.testDetalle) : undefined;
  const testEn = fila ? pick(fila, S.testEn) : undefined;
  const expira = fila ? pick(fila, S.expira) : undefined;
  const expirada = expira && new Date(expira) < new Date();

  const archivo = h("input", { type: "file", accept: ".json,application/json", hidden: true });
  archivo.addEventListener("change", async () => {
    const f = archivo.files?.[0]; if (!f) return;
    try {
      const estado = JSON.parse(await f.text());
      const r = await api.put(`/sesiones/${plat}`, estado);
      toast(`Sesión de ${nombrePlat(plat)} guardada · ${r.cookies} cookies${r.expira ? " · expira " + fechaHora(r.expira) : ""}.`);
      (r.avisos || []).forEach(a => toast(a, "warn", 8000));
      refrescar("estado");
    } catch (e) { toast(e instanceof SyntaxError ? "El archivo no es un JSON válido." : e.message, "error"); }
    finally { archivo.value = ""; }
  });

  const probar = ev => conBoton(ev, async () => {
    toast(`Probando ${nombrePlat(plat)}… puede tardar un minuto.`, "info", 6000);
    const r = await api.post(`/sesiones/${plat}/probar`);
    toast(`${nombrePlat(plat)}: ${r.ok ? "sesión válida" : "falló"}${r.detalle ? " · " + r.detalle : ""}`, r.ok ? "ok" : "error", 8000);
    refrescar("estado");
  });
  const borrar = ev => conBoton(ev, async () => {
    if (!(await confirmar(`Se eliminará la sesión de ${nombrePlat(plat)}. Tendrás que subir cookies nuevas.`, { peligro: true, texto: "Eliminar sesión" }))) return;
    await api.del(`/sesiones/${plat}`);
    toast("Sesión eliminada."); refrescar("estado");
  });

  const extras = fila ? Object.entries(fila).filter(([k, v]) => !SENSIBLE.test(k) && ["string", "number", "boolean"].includes(typeof v) && String(v).length < 120) : [];

  return h("article", { class: "card sesion" },
    h("div", { class: "card-h" }, h("h2", null, nombrePlat(plat)), badge(conectada ? (expirada ? "expirada" : "conectada") : "sin sesión")),
    conectada ? h("dl", { class: "kv" },
      expira ? [h("dt", null, "Expira"), h("dd", null, `${fechaHora(expira)} (${hace(expira)})`)] : null,
      testOk !== undefined ? [h("dt", null, "Última prueba"), h("dd", null, h("span", { class: testOk ? "t-ok-txt" : "t-bad-txt" }, testOk ? "válida" : "falló"), testEn ? ` · ${hace(testEn)}` : "", testDet ? ` · ${testDet}` : "")] : [h("dt", null, "Última prueba"), h("dd", { class: "muted" }, "sin probar")]
    ) : h("p", { class: "muted" }, "Exporta las cookies con scripts/login-local.js y súbelas aquí."),
    extras.length ? h("details", { class: "sm" }, h("summary", null, "Más datos"), h("dl", { class: "kv" }, extras.map(([k, v]) => [h("dt", null, k), h("dd", null, String(v))]))) : null,
    h("div", { class: "acciones" },
      h("button", { type: "button", class: "btn sm primary", onClick: () => archivo.click() }, conectada ? "Reemplazar sesión" : "Subir sesión"),
      archivo,
      conectada ? h("button", { type: "button", class: "btn sm", disabled: ocupado, title: ocupado ? "El agente está ocupado" : "", onClick: probar }, "Probar") : null,
      conectada ? h("button", { type: "button", class: "btn sm danger", onClick: borrar }, "Eliminar") : null));
}

export const sesiones = {
  id: "sesiones", titulo: "Sesiones", icono: "⚿",
  montar(el) {
    const aviso = h("div");
    const cuentas = h("div", { class: "grid cols" });
    const evid = h("div");
    el.append(aviso, cuentas, h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", null, "Evidencias del agente"), h("span", { class: "muted sm" }, "capturas recientes")), evid));

    bajas.push(suscribir("estado", d => {
      pintar(aviso, { o: d.agenteOcupado }, () => (d.agenteOcupado ? h("div", { class: "aviso" }, "El agente está ocupado: las pruebas de sesión se habilitan cuando termine.") : h("span")));
      pintar(cuentas, { p: d.plataformas, s: d.sesiones, o: d.agenteOcupado }, () => h("div", { class: "contents" },
        (d.plataformas || []).map(p => tarjeta(p, (d.sesiones || []).find(r => pick(r, S.plataforma) === p), d.agenteOcupado))));
      pintar(evid, d.evidencias, () => (d.evidencias?.length
        ? h("div", { class: "galeria" }, d.evidencias.map(n => h("button", {
          type: "button", class: "miniatura", title: n,
          onClick: () => abrirModal({ titulo: n, ancho: "ancho", cuerpo: h("img", { class: "evid-img", src: `/evidencia/${encodeURIComponent(n)}`, alt: n }) })
        }, h("img", { src: `/evidencia/${encodeURIComponent(n)}`, alt: n, loading: "lazy" }))))
        : vacio("Aún no hay capturas.")));
    }));
  },
  desmontar() { bajas.forEach(f => f()); bajas = []; }
};
