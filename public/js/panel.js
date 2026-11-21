import { montarPublicador } from "./publicador-ui.js";
import { obtenerEstado, encolarVideo, obtenerIncidencia, guardarCookiesRed, quitarCookiesRed, leerLlave, guardarLlave } from './api.js';
import * as V from './views.js';
import * as F from './flujo.js';

const INTERVALO_MS = 4000;
const INTERVALO_MAX_MS = 30000;
const VISTAS = ['resumen', 'conexiones', 'proyectos', 'clips', 'lotes', 'incidencias', 'marketing'];

const $ = (id) => document.getElementById(id);

const estado = {
  datos: null,
  firma: '',
  vista: 'resumen',
  filtroEstado: 'todos',
  filtroTexto: '',
  ocultarResueltas: false,
  errores: 0,
  pausado: false,
  enVuelo: false,
  temporizador: null,
  controlador: null,
  temporizadorAviso: null,
  temporizadorBusqueda: null,
  incAbiertas: new Set(),
  incTextos: new Map(),
};

const contextoIncidencias = () => ({ abiertas: estado.incAbiertas, textos: estado.incTextos });

/* ---------- Indicadores y avisos ---------- */

function setSync(tipo, texto) {
  $('sync').dataset.estado = tipo;
  $('sync-texto').textContent = texto;
}

function mostrarAviso(texto, tipo = 'info', duracion = 4000) {
  const aviso = $('aviso');
  aviso.textContent = texto;
  aviso.dataset.tipo = tipo;
  aviso.hidden = false;
  clearTimeout(estado.temporizadorAviso);
  if (duracion > 0) {
    estado.temporizadorAviso = setTimeout(() => {
      aviso.hidden = true;
    }, duracion);
  }
}

function actualizarBotonLlave() {
  $('btn-llave').classList.toggle('con-llave', Boolean(leerLlave()));
}

/* ---------- Renderizado por vista (solo la pestana activa) ---------- */

function renderContadores() {
  if (!estado.datos) return;
  const { clips, lotes, incidencias } = estado.datos;
  $('n-clips').textContent = String(clips.filter((c) => c.estado === 'listo' || c.estado === 'publicado').length);
  F.contadores(estado.datos);
  $('n-lotes').textContent = String(lotes.length);
  $('n-incidencias').textContent = String(incidencias.filter((i) => !i.resuelta).length);
}

function renderResumen() {
  const { resumen, clips } = estado.datos;
  $('kpis').innerHTML = V.renderKpis(resumen.kpis);
  $('trabajos-activos').innerHTML = V.renderTrabajos(resumen.trabajosActivos);
  $('clips-listos').innerHTML = V.renderClips(
    clips.filter((c) => c.estado === 'listo').slice(0, 6),
    'Aun no hay clips listos.'
  );
}

function renderClipsVista() {
  const filtrados = V.filtrarClips(estado.datos.clips, estado.filtroEstado, estado.filtroTexto);
  $('lista-clips').innerHTML = V.renderClips(filtrados, 'No hay clips que coincidan con el filtro.');
}

function renderActual() {
  if (!estado.datos) return;
  renderContadores();
  switch (estado.vista) {
    case 'resumen':
      renderResumen();
      break;
    case 'conexiones':
      $('lista-conexiones').innerHTML = V.renderConexiones(estado.datos.conexiones);
      break;
    case 'proyectos':
    case 'clips':
      F.render(estado.vista, estado.datos);
      break;
    case 'lotes':
      $('lista-lotes').innerHTML = V.renderLotes(estado.datos.lotes);
      break;
    case 'incidencias':
      $('lista-incidencias').innerHTML = V.renderIncidencias(estado.datos.incidencias, estado.ocultarResueltas, contextoIncidencias());
      break;
    case 'marketing':
      $('marketing').innerHTML = V.renderMarketing(estado.datos.clips);
      break;
    default:
      break;
  }
}

/* ---------- Pestanas ---------- */

function activarVista(nombre, renderizar = true) {
  estado.vista = nombre;
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.vista === nombre));
  });
  document.querySelectorAll('.vista').forEach((seccion) => {
    seccion.hidden = seccion.dataset.vista !== nombre;
  });
  try {
    history.replaceState(null, '', '#' + nombre);
  } catch {
    // Sin historial disponible: se ignora.
  }
  if (renderizar) renderActual();
}

/* ---------- Sondeo en tiempo real ---------- */

function programar() {
  clearTimeout(estado.temporizador);
  if (document.hidden || estado.pausado) return;
  const espera = Math.min(INTERVALO_MS * 2 ** Math.min(estado.errores, 3), INTERVALO_MAX_MS);
  estado.temporizador = setTimeout(sondear, espera);
}

function sondearYa() {
  clearTimeout(estado.temporizador);
  if (!estado.enVuelo) sondear();
}

function manejarError(error) {
  if (error.status === 401) {
    estado.pausado = true;
    setSync('error', 'Llave requerida o invalida');
    mostrarAviso('El servidor rechazo la llave maestra. Configurala con el boton Llave.', 'error', 0);
    abrirLlave();
    return;
  }
  if (error.status === 503) {
    estado.pausado = true;
    setSync('error', 'Servidor sin MASTER_KEY');
    mostrarAviso(error.message, 'error', 0);
    return;
  }
  setSync('error', 'Sin sincronizar: ' + error.message);
}

async function sondear() {
  if (estado.enVuelo) return;
  estado.enVuelo = true;
  estado.controlador = new AbortController();

  try {
    const datos = await obtenerEstado(estado.controlador.signal);
    estado.errores = 0;
    estado.datos = datos;

    const firma = JSON.stringify([datos.resumen, datos.conexiones, datos.lotes, datos.incidencias, datos.clips]);
    if (firma !== estado.firma) {
      try {
        renderActual();
        estado.firma = firma; // solo se da por pintado si el render no fallo: se reintenta en el siguiente sondeo
      } catch (errorRender) {
        console.error('Error al pintar el panel', errorRender);
        mostrarAviso('No se pudo pintar la pestana: ' + errorRender.message, 'error', 6000);
      }
    }

    if ($('aviso').dataset.tipo === 'error') $('aviso').hidden = true;
    setSync('ok', 'Sincronizado - ' + new Date().toLocaleTimeString('es-DO'));
  } catch (error) {
    if (!error.cancelado) {
      estado.errores += 1;
      manejarError(error);
    }
  } finally {
    estado.enVuelo = false;
    estado.controlador = null;
    programar();
  }
}

/* ---------- Llave maestra ---------- */

function abrirLlave() {
  const dialogo = $('dlg-llave');
  if (dialogo.open) return;
  $('input-llave').value = leerLlave();
  dialogo.showModal();
  $('input-llave').focus();
}

function reanudarSondeo() {
  estado.pausado = false;
  estado.errores = 0;
  setSync('pendiente', 'Conectando...');
  sondearYa();
}

function iniciarLlave() {
  $('btn-llave').addEventListener('click', abrirLlave);

  $('form-llave').addEventListener('submit', (evento) => {
    evento.preventDefault();
    guardarLlave($('input-llave').value.trim());
    actualizarBotonLlave();
    $('dlg-llave').close();
    mostrarAviso('Llave guardada en este navegador.', 'ok');
    reanudarSondeo();
  });

  $('llave-borrar').addEventListener('click', () => {
    guardarLlave('');
    $('input-llave').value = '';
    actualizarBotonLlave();
    $('dlg-llave').close();
    mostrarAviso('Llave eliminada de este navegador.', 'info');
    reanudarSondeo();
  });

  $('llave-cancelar').addEventListener('click', () => $('dlg-llave').close());
}

/* ---------- Encolar ---------- */

function iniciarEncolar() {
  $('form-encolar').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const url = $('input-url').value.trim();
    if (!/^https?:\/\//i.test(url)) {
      mostrarAviso('Pega un enlace valido que empiece con https://', 'error');
      return;
    }

    const boton = $('btn-encolar');
    boton.disabled = true;
    try {
      await encolarVideo(url);
      $('input-url').value = '';
      mostrarAviso('Video encolado correctamente.', 'ok');
      activarVista('clips', false);
      sondearYa();
    } catch (error) {
      if (error.status === 401) {
        abrirLlave();
      }
      mostrarAviso('No se pudo encolar: ' + error.message, 'error', 6000);
    } finally {
      boton.disabled = false;
    }
  });
}

/* ---------- Copiar copy / CTA ---------- */

async function copiarTexto(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = texto;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let copiado = false;
    try {
      copiado = document.execCommand('copy');
    } catch {
      copiado = false;
    }
    area.remove();
    return copiado;
  }
}

function iniciarCopiar() {
  document.addEventListener('click', async (evento) => {
    const boton = evento.target.closest('[data-copiar]');
    if (!boton || !estado.datos) return;
    const clip = estado.datos.clips.find((c) => c.id === boton.dataset.copiar);
    if (!clip) return;
    const titulo = clip.marketing && clip.marketing.titulo;
    const texto = [titulo, clip.copy, clip.cta].filter(Boolean).join('\n\n');
    const copiado = await copiarTexto(texto);
    mostrarAviso(copiado ? 'Copy copiado al portapapeles.' : 'No se pudo copiar el texto.', copiado ? 'ok' : 'error');
  });
}

/* ---------- Conexiones: pegar cookies de Cookie Editor ---------- */

let redActual = null;

function cerrarRed() {
  $('dlg-red').close();
  $('input-cookies').value = '';
  $('red-error').hidden = true;
  redActual = null;
}

function iniciarCookiesRedes() {
  $('lista-conexiones').addEventListener('click', async (evento) => {
    const boton = evento.target.closest('[data-red-accion]');
    if (!boton) return;
    const red = boton.dataset.red;
    const nombre = V.nombrePlataforma(red);

    if (boton.dataset.redAccion === 'pegar') {
      redActual = red;
      $('red-titulo').textContent = 'Pegar cookies de ' + nombre;
      $('red-pasos').textContent = 'Abre ' + nombre + ' con tu sesion iniciada, abre Cookie Editor, pulsa Exportar, elige JSON y pegalo aqui. Se guardan cifradas en el servidor.';
      $('red-error').hidden = true;
      $('dlg-red').showModal();
      $('input-cookies').focus();
      return;
    }

    if (!window.confirm('Quitar la sesion de ' + nombre + '? Se borran las cookies guardadas.')) return;
    boton.disabled = true;
    try {
      await quitarCookiesRed(red);
      mostrarAviso('Sesion de ' + nombre + ' eliminada.', 'info');
      sondearYa();
    } catch (error) {
      if (error.status === 401) abrirLlave();
      mostrarAviso(error.message, 'error', 6000);
    } finally {
      boton.disabled = false;
    }
  });

  $('red-cancelar').addEventListener('click', cerrarRed);

  $('form-red').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    if (!redActual) return;
    const valor = $('input-cookies').value.trim();
    if (!valor) {
      $('red-error').textContent = 'Pega primero el JSON exportado por Cookie Editor.';
      $('red-error').hidden = false;
      return;
    }
    const boton = $('red-guardar');
    boton.disabled = true;
    $('red-error').hidden = true;
    try {
      const nombre = V.nombrePlataforma(redActual);
      const r = await guardarCookiesRed(redActual, valor);
      cerrarRed();
      mostrarAviso(nombre + ' conectado (' + r.total + ' cookies guardadas cifradas).', 'ok', 6000);
      sondearYa();
    } catch (error) {
      if (error.status === 401) {
        cerrarRed();
        abrirLlave();
      } else {
        $('red-error').textContent = error.message;
        $('red-error').hidden = false;
      }
    } finally {
      boton.disabled = false;
    }
  });
}

/* ---------- Incidencias: stderr completo bajo demanda ---------- */

function iniciarIncidencias() {
  // 'toggle' no burbujea: se escucha en captura. Se recuerda que detalles estan abiertos y su texto
  // para que el repintado periodico no los cierre ni pierda el stderr ya descargado.
  document.addEventListener('toggle', async (evento) => {
    const detalles = evento.target;
    if (!(detalles instanceof HTMLDetailsElement) || !detalles.dataset.inc) return;
    const id = detalles.dataset.inc;

    if (!detalles.open) {
      estado.incAbiertas.delete(id);
      return;
    }
    estado.incAbiertas.add(id);
    if (estado.incTextos.has(id)) return;

    const pre = detalles.querySelector('pre');
    const previo = pre ? pre.textContent : '';
    if (pre) pre.textContent = 'Cargando stderr completo...';
    try {
      const { incidencia } = await obtenerIncidencia(id);
      const texto = (incidencia && incidencia.detalle) || previo || '(sin detalle)';
      estado.incTextos.set(id, texto);
      if (pre) pre.textContent = texto;
    } catch (error) {
      if (pre) pre.textContent = previo;
      mostrarAviso('No se pudo cargar el detalle: ' + error.message, 'error', 5000);
    }
  }, true);
}

/* ---------- Filtros ---------- */

function iniciarFiltros() {
  $('inc-ocultar').addEventListener('change', (evento) => {
    estado.ocultarResueltas = evento.target.checked;
    if (estado.datos) {
      $('lista-incidencias').innerHTML = V.renderIncidencias(estado.datos.incidencias, estado.ocultarResueltas, contextoIncidencias());
    }
  });
}

/* ---------- Arranque ---------- */

function iniciar() {
  const hash = location.hash.slice(1);
  if (VISTAS.includes(hash)) estado.vista = hash;

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => activarVista(tab.dataset.vista));
  });
  activarVista(estado.vista, false);

  $('btn-refrescar').addEventListener('click', () => {
    setSync('pendiente', 'Actualizando...');
    estado.pausado = false;
    sondearYa();
  });

  iniciarLlave();
  F.iniciar({ mostrarAviso, abrirLlave, sondearYa, activarVista });
  iniciarCopiar();
  iniciarIncidencias();
  iniciarCookiesRedes();
  iniciarFiltros();
  actualizarBotonLlave();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(estado.temporizador);
      if (estado.controlador) estado.controlador.abort();
    } else if (!estado.pausado) {
      sondearYa();
    }
  });

  window.addEventListener('online', () => {
    if (!estado.pausado) sondearYa();
  });

  sondear();
}

iniciar();

const __pubCont = document.getElementById("panel-publicador-ui");
if (__pubCont) {
  const __barraClip = document.createElement("div");
  __barraClip.style.cssText = "margin-bottom:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#16161d;border:1px solid #2b2b38;border-radius:12px;padding:12px 16px;max-width:980px;color:#e8e8ee;font-family:system-ui,sans-serif;";
  __barraClip.innerHTML = "<label for=\"sel-clip-pub\" style=\"font-size:13px;color:#a9a9bd;font-weight:600;\">Clip listo a publicar:</label><select id=\"sel-clip-pub\" style=\"flex:1;min-width:240px;background:#1f1f2b;border:1px solid #3a3a4d;color:#e8e8ee;border-radius:8px;padding:9px 10px;\"><option value=\"\">Cargando clips...</option></select>";
  __pubCont.parentNode.insertBefore(__barraClip, __pubCont);
  const __selClip = document.getElementById("sel-clip-pub");

  function __extraerClipsDeObjeto(obj) {
    if (!obj || typeof obj !== "object") return [];
    const candidatos = [
      obj.clips,
      obj.items,
      obj.estado && obj.estado.clips,
      obj.datos && obj.datos.clips,
      obj.data && obj.data.clips,
    ];
    for (const arr of candidatos) {
      if (Array.isArray(arr) && arr.length) return arr;
    }
    return [];
  }

  function __extraerClipsDelDom() {
    const nodos = [...document.querySelectorAll("[data-clip-id], [data-id]")];
    return nodos
      .map((el) => {
        const id = el.getAttribute("data-clip-id") || el.getAttribute("data-id") || "";
        const tit = (el.querySelector("h3, h4, .titulo, .clip-titulo")?.textContent || id).trim();
        return id ? { id, titulo: tit } : null;
      })
      .filter(Boolean);
  }

  // Clips listos (o ya publicados en otra red) tomados del estado del panel, con la llave maestra. Nada queda preseleccionado.
  async function __cargarClipsPublicador() {
    try {
      let lista = [];
      try {
        const d = await obtenerEstado();
        lista = (Array.isArray(d && d.clips) ? d.clips : []).filter((c) => c && c.id && (c.estado === 'listo' || c.estado === 'publicado') && c.url);
      } catch { /* sin llave o sin conexión: el aviso general del panel ya lo informa */ }

      const actual = __selClip.value;
      if (!lista.length) {
        __selClip.innerHTML = "<option value=\"\">No hay clips listos todavía</option>";
        window.__CLIP_SELECCIONADO_ID__ = "";
        if (__pubInst) __pubInst.refrescarBotones();
        return;
      }
      const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      __selClip.innerHTML = "<option value=\"\">— Elige un clip —</option>" + lista
        .map((c) => {
          const tit = String((c.ficha && c.ficha.titulo) || (c.marketing && c.marketing.titulo) || c.titulo || c.id).slice(0, 75);
          return "<option value=\"" + esc(c.id) + "\">" + esc(tit) + " (" + esc(c.id) + ")</option>";
        })
        .join("");
      if (actual && [...__selClip.options].some((o) => o.value === actual)) __selClip.value = actual;   // conserva la selección del usuario
      window.__CLIP_SELECCIONADO_ID__ = __selClip.value;
      if (__pubInst) __pubInst.refrescarBotones();
    } catch {}
  }

  var __pubInst = montarPublicador(__pubCont, {
    obtenerClipId: () => __selClip.value || window.__CLIP_SELECCIONADO_ID__ || "",
    intervaloMs: 5000,
  });

  __selClip.addEventListener("change", () => {
    window.__CLIP_SELECCIONADO_ID__ = __selClip.value;
    __pubInst.refrescarBotones();
  });

  __cargarClipsPublicador();
  setInterval(() => { if (!document.hidden) __cargarClipsPublicador(); }, 15000);
  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-vista=\"publicador\"], [data-vista=\"clips\"], [data-vista=\"resumen\"]");
    if (t) {
      setTimeout(__cargarClipsPublicador, 250);
      if (__pubInst) __pubInst.actualizar();
    }
  });
}
