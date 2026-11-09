// Modales de acción sobre un clip: ver, publicar, reciclar (multi-ángulo) y resolver publicación incierta.
import { h, abrirModal, toast } from "./ui.js";
import { medidorDuracion } from "./ui.js";
import { api } from "./api.js";
import { refrescar } from "./tiempo.js";
import { checksPlataformas, infoEstado, sesionesConectadas } from "./componentes.js";
import { duracionDe, evaluarDuracion, DURACION, nombrePlat } from "./esquema.js";

const avisoDuracion = ev => h("div", { class: "aviso bad" }, `Este clip dura más de ${DURACION.MAX} s. La regla de oro lo bloquea: recórtalo a ${DURACION.IDEAL_MIN}–${DURACION.MAX} s antes de publicarlo o reciclarlo.`);

export function modalVideo(c) {
  abrirModal({
    titulo: c.titulo || `Clip #${c.id}`, ancho: "ancho",
    cuerpo: h("div", null,
      h("video", { class: "video", controls: true, preload: "metadata", src: `/media/${c.token}.mp4`, playsInline: true }),
      medidorDuracion(duracionDe(c)))
  });
}

export async function modalPublicar(c) {
  const est = await infoEstado();
  const conectadas = sesionesConectadas(est);
  const checks = checksPlataformas(est.plataformas || [], { conectadas, exigirSesion: true });
  const ev = evaluarDuracion(duracionDe(c));
  abrirModal({
    titulo: `Publicar: ${c.titulo || "clip #" + c.id}`,
    cuerpo: h("div", null, medidorDuracion(duracionDe(c)), ev.bloquea ? avisoDuracion() : null,
      h("p", { class: "muted" }, est.publicarReal ? "Modo REAL: se publicará de verdad." : "Modo PRUEBA: el agente simula la publicación."),
      checks.el),
    botones: [{ texto: "Cancelar", clase: "ghost" }, {
      texto: "Publicar", clase: "primary",
      onClick: async () => {
        if (ev.bloquea) { toast("Clip fuera de la regla de 60 s.", "error"); return false; }
        const plataformas = checks.valores();
        if (!plataformas.length) { toast("Elige al menos una plataforma.", "error"); return false; }
        await api.post(`/clips/${c.id}/publicar`, { plataformas });
        toast("Publicación encolada."); refrescar("clips", "monitor", "estado");
      }
    }]
  });
}

export async function modalReciclar(c) {
  const est = await infoEstado();
  const conectadas = sesionesConectadas(est);
  const checks = checksPlataformas(est.plataformas || [], { conectadas, exigirSesion: true });
  const ev = evaluarDuracion(duracionDe(c));
  const f = {
    cantidad: h("input", { type: "number", min: 1, max: 20, value: 3 }),
    nombre: h("input", { type: "text", placeholder: "Opcional" }),
    desde: h("input", { type: "datetime-local" }),
    sep: h("input", { type: "number", min: 1, placeholder: "90" }),
    ventanas: h("input", { type: "text", placeholder: "09:00-11:00, 18:00-20:00" }),
    manual: h("textarea", { rows: 4, placeholder: '[{"titulo":"…","gancho":"…","descripcion":"…","cta":"…","hashtags":"…","angulo":"…"}]' })
  };
  const campo = (etq, el, nota) => h("div", { class: "campo" }, h("label", null, etq), el, nota ? h("small", { class: "muted" }, nota) : null);

  abrirModal({
    titulo: `Reciclar: ${c.titulo || "clip #" + c.id}`, ancho: "ancho",
    cuerpo: h("div", { class: "form-grid" },
      h("div", { class: "span2" }, medidorDuracion(duracionDe(c)), ev.bloquea ? avisoDuracion() : h("p", { class: "muted sm" }, `Todas las variantes reutilizan este corte: duran ${duracionDe(c) ?? "?"} s (máximo ${DURACION.MAX} s).`)),
      campo("Cantidad de variantes", f.cantidad), campo("Nombre del lote", f.nombre),
      h("div", { class: "span2 campo" }, h("label", null, "Plataformas"), checks.el),
      campo("Desde", f.desde, "Vacío = ahora."), campo("Separación (min)", f.sep, "Entre publicaciones."),
      h("div", { class: "span2" }, campo("Ventanas horarias", f.ventanas, "Separadas por coma. Vacío = valores por defecto.")),
      h("div", { class: "span2" }, campo("Variantes manuales (JSON, opcional)", f.manual, "Si lo rellenas, sustituyen a las generadas por IA."))),
    botones: [{ texto: "Cancelar", clase: "ghost" }, {
      texto: "Crear reciclaje", clase: "primary",
      onClick: async cerrar => {
        if (ev.bloquea) { toast("Clip fuera de la regla de 60 s.", "error"); return false; }
        const plataformas = checks.valores();
        if (!plataformas.length) { toast("Elige al menos una plataforma.", "error"); return false; }
        const cuerpo = { plataformas, cantidad: Number(f.cantidad.value) || 3 };
        if (f.nombre.value.trim()) cuerpo.nombre = f.nombre.value.trim();
        if (f.desde.value) cuerpo.desde = new Date(f.desde.value).toISOString();
        if (f.sep.value) cuerpo.separacion_min = Number(f.sep.value);
        const vent = f.ventanas.value.split(",").map(s => s.trim()).filter(Boolean);
        if (vent.length) cuerpo.ventanas = vent;
        if (f.manual.value.trim()) {
          try { const m = JSON.parse(f.manual.value); if (!Array.isArray(m)) throw new Error(); cuerpo.variantes = m; }
          catch { toast("El JSON de variantes manuales no es una lista válida.", "error"); return false; }
        }
        await api.post(`/clips/${c.id}/reciclar`, cuerpo);
        toast("Reciclaje creado."); refrescar("clips", "monitor", "lotes");
        location.hash = `#/variantes?clip=${c.id}`;
      }
    }]
  });
}

/** Resuelve una publicación "incierta" de un clip (POST /clips/:id/resolver). */
export function modalResolverClip(c, plataforma) {
  const enviar = accion => async cerrar => {
    await api.post(`/clips/${c.id}/resolver`, { plataforma, accion });
    toast(accion === "publicado" ? "Marcada como publicada." : "Listo para reintentar."); refrescar("clips"); cerrar(true); return false;
  };
  abrirModal({
    titulo: "Resolver publicación incierta",
    cuerpo: h("p", null, `El agente no pudo confirmar si "${c.titulo || "el clip"}" se publicó en ${nombrePlat(plataforma)}. Revisa la cuenta y decide:`),
    botones: [{ texto: "Cancelar", clase: "ghost" }, { texto: "Ya se publicó", onClick: enviar("publicado") }, { texto: "Reintentar", clase: "primary", onClick: enviar("reintentar") }]
  });
}
