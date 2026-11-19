// Flujo de trabajo de ClipLab: crear -> Proyectos -> Todos los clips. Solo pinta y reacciona; toda la
// logica de datos (agrupar, filtrar, puntajes, revision tecnica) vive en proyectos.js.
import { encolarVideo } from './api.js';
import { esc, formatoFecha } from './views.js';
import {
  ENCUADRES, agruparProyectos, filtrarProyectos, filtrarClipsFlujo, bloquesDe, revisionDe, nivelDe,
  puntajeDe, tituloDe, descripcionDe, ganchoDe, formatoSeg, slug, prepararEncolar, esTerminado,
} from './proyectos.js';

const LS_FAV = 'cliplab.favoritos';
const LS_ED = 'cliplab.ediciones';
const CLASE_NIVEL = { alto: 'ok', medio: 'info', bajo: 'warn', sin: 'neutro' };

const $ = (id) => document.getElementById(id);

function leerLocal(clave, defecto) {
  try {
    const crudo = localStorage.getItem(clave);
    return crudo ? JSON.parse(crudo) : defecto;
  } catch {
    return defecto;
  }
}

function guardarLocal(clave, valor) {
  try {
    localStorage.setItem(clave, JSON.stringify(valor));
  } catch {
    // Sin almacenamiento disponible: favoritos y ediciones solo duran mientras la pestana siga abierta.
  }
}

const e = {
  datos: null,
  favoritos: new Set(leerLocal(LS_FAV, [])),
  ediciones: leerLocal(LS_ED, {}),
  textoProyectos: '',
  textoClips: '',
  soloFavoritos: false,
  orden: 'recientes',
  filtroProyecto: '',
  abierto: '',
  paneles: new Map(),
  revisiones: new Set(),
  html: { proyectos: '', clips: '' },
  editando: null,
  ayudas: null,
};

/* ---------- Piezas de HTML ---------- */

function urlLocal(url) {
  return typeof url === 'string' && /^(https?:\/\/|\/(?!\/))/i.test(url) ? url : '';
}

const badge = (texto, clase) => '<span class="badge badge-' + esc(clase) + '">' + esc(texto) + '</span>';
const vacio = (mensaje) => '<div class="vacio">' + esc(mensaje) + '</div>';

function insigniaPuntaje(clip) {
  const p = puntajeDe(clip);
  return p === null ? badge('Sin puntaje', 'neutro') : badge('★ ' + Math.round(p), CLASE_NIVEL[nivelDe(p)]);
}

function video(clip, clase, miniatura = false) {
  const url = urlLocal(clip.url);
  if (!url) return '<div class="sin-video">Archivo no disponible</div>';
  return miniatura
    ? '<video class="' + clase + '" src="' + esc(url) + '#t=0.2" preload="metadata" muted playsinline></video>'
    : '<video class="' + clase + '" src="' + esc(url) + '" controls preload="metadata" playsinline></video>';
}

function chipsBloques(clip) {
  return '<div class="chips-bloques">' + bloquesDe(clip).map((b) =>
    '<span class="chip-bloque nivel-' + b.nivel + '" title="' + esc(b.detalle) + '">' + esc(b.etiqueta) + ' <b>' +
    (b.puntaje === null ? '—' : Math.round(b.puntaje)) + '</b></span>'
  ).join('') + '</div>';
}

/* ---------- Proyectos ---------- */

function tarjetaProyecto(p) {
  const estados = {
    procesando: badge('Procesando ' + p.enProceso, 'info'),
    listo: badge('Listo', 'ok'),
    parcial: badge('Con errores', 'warn'),
    error: badge('Con error', 'err'),
  };
  const mejor = p.mejorPuntaje === null ? '' : badge('★ ' + Math.round(p.mejorPuntaje), CLASE_NIVEL[nivelDe(p.mejorPuntaje)]);
  return '<article class="card proyecto">' +
    '<div class="miniatura" data-accion="abrir-proyecto" data-id="' + esc(p.id) + '">' +
      (p.miniatura ? video(p.miniatura, 'mini-video', true) : '<div class="sin-video">' + (p.estado === 'procesando' ? 'Procesando…' : 'Sin vista previa') + '</div>') +
    '</div>' +
    '<div class="card-cab"><h3>' + esc(p.titulo) + '</h3>' + mejor + '</div>' +
    '<div class="meta"><span>' + p.listos + (p.listos === 1 ? ' clip generado' : ' clips generados') + '</span>' +
      '<span>Duración ' + esc(formatoSeg(p.duracionTotal)) + '</span><span>' + esc(formatoFecha(p.creadoEn)) + '</span></div>' +
    '<div class="card-acciones">' + (estados[p.estado] || '') +
      '<button class="btn btn-primario" type="button" data-accion="abrir-proyecto" data-id="' + esc(p.id) + '">Abrir proyecto</button></div>' +
  '</article>';
}

function miniClip(clip) {
  if (clip.estado === 'procesando') return '<div class="mini mini-estado"><span>Procesando…</span></div>';
  if (clip.estado === 'error') return '<div class="mini mini-estado"><span>Este clip falló</span></div>';
  return '<article class="mini">' +
    '<div class="visor visor-mini">' + video(clip, 'v916') + '<span class="dur">' + esc(formatoSeg(clip.duracion)) + '</span></div>' +
    '<div class="mini-cab"><strong>' + esc(tituloDe(clip, e.ediciones)) + '</strong>' + insigniaPuntaje(clip) + '</div>' +
    '<p class="mini-gancho">' + (ganchoDe(clip) ? '“' + esc(ganchoDe(clip)) + '”' : '<span class="suave">Sin gancho detectado</span>') + '</p>' +
    chipsBloques(clip) +
  '</article>';
}

function htmlProyectos(clips) {
  const proyectos = agruparProyectos(clips);
  const abierto = e.abierto && proyectos.find((p) => p.id === e.abierto);
  if (abierto) {
    return '<div class="detalle-cab"><button class="btn" type="button" data-accion="cerrar-proyecto">← Proyectos</button>' +
        '<div><h2>' + esc(abierto.titulo) + '</h2><div class="meta"><span>' + abierto.listos + ' de ' + abierto.total + ' clips listos</span>' +
        '<span>Duración ' + esc(formatoSeg(abierto.duracionTotal)) + '</span>' +
        (abierto.fuente ? '<a href="' + esc(urlLocal(abierto.fuente)) + '" target="_blank" rel="noopener noreferrer">Ver video original</a>' : '') + '</div></div>' +
        '<button class="btn" type="button" data-accion="ver-clips" data-id="' + esc(abierto.id) + '">Ver en Todos los clips</button></div>' +
      '<div class="fila-clips">' + abierto.clips.map(miniClip).join('') + '</div>';
  }
  const filtrados = filtrarProyectos(proyectos, e.textoProyectos);
  return filtrados.length
    ? '<div class="grid">' + filtrados.map(tarjetaProyecto).join('') + '</div>'
    : vacio(proyectos.length ? 'Ningún proyecto coincide con la búsqueda.' : 'Aún no hay proyectos. Pega un enlace arriba para crear el primero.');
}

/* ---------- Todos los clips ---------- */

function htmlPanel(clip, tipo) {
  if (tipo === 'descripcion') {
    const texto = descripcionDe(clip, e.ediciones);
    return '<div class="panel-extra"><strong>Descripción para publicar</strong><pre>' + esc(texto || 'Sin descripción generada.') + '</pre>' +
      (texto ? '<button class="btn" type="button" data-accion="copiar-desc" data-id="' + esc(clip.id) + '">Copiar</button>' : '') + '</div>';
  }
  if (tipo === 'dicho') {
    return '<div class="panel-extra"><strong>Lo que se dice</strong><pre>' + esc(clip.transcripcion || 'Sin voz detectada en este clip.') + '</pre></div>';
  }
  return '';
}

function tarjetaClip(clip) {
  const rev = revisionDe(clip);
  const fav = e.favoritos.has(clip.id);
  const url = urlLocal(clip.url);
  const proyecto = clip.jobId || clip.id;
  return '<article class="card clip" data-id="' + esc(clip.id) + '">' +
    '<div class="card-cab"><h3>' + esc(tituloDe(clip, e.ediciones)) + '</h3><div class="clip-der">' + insigniaPuntaje(clip) +
      '<button class="fav" type="button" data-accion="fav" data-id="' + esc(clip.id) + '" aria-pressed="' + fav + '" title="' + (fav ? 'Quitar de Me gustan' : 'Me gusta') + '">' + (fav ? '★' : '☆') + '</button></div></div>' +
    '<div class="visor">' + video(clip, 'v916') + '<span class="dur">' + esc(formatoSeg(clip.duracion)) + '</span></div>' +
    '<div class="meta"><span>' + esc(formatoFecha(clip.creadoEn)) + '</span><a href="#" data-accion="ver-clips" data-id="' + esc(proyecto) + '">Mismo proyecto</a></div>' +
    '<div class="bloques">' + bloquesDe(clip).map((b) =>
      '<div class="bloque nivel-' + b.nivel + '"><div class="bloque-cab"><strong>' + esc(b.etiqueta) + '</strong><span>' + (b.puntaje === null ? '—' : Math.round(b.puntaje)) + '</span></div>' +
      '<div class="barra"><span style="width:' + (b.puntaje === null ? 0 : Math.round(b.puntaje)) + '%"></span></div>' +
      (b.detalle ? '<p>' + esc(b.detalle) + '</p>' : '') + '</div>'
    ).join('') + '</div>' +
    '<details class="revision" data-id="' + esc(clip.id) + '"' + (e.revisiones.has(clip.id) ? ' open' : '') + '><summary>Revisión técnica ' + badge(rev.texto, rev.clase) + '</summary>' +
      (rev.filas.length ? '<dl>' + rev.filas.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('') + '</dl>' : '<p class="suave">Sin datos de revisión.</p>') +
      (rev.alertas.length ? '<ul class="alertas">' + rev.alertas.map((a) => '<li>' + esc(a) + '</li>').join('') + '</ul>' : '') + '</details>' +
    '<div class="card-acciones">' +
      '<button class="btn" type="button" data-accion="panel" data-tipo="descripcion" data-id="' + esc(clip.id) + '">Descripción para publicar</button>' +
      '<button class="btn" type="button" data-accion="panel" data-tipo="dicho" data-id="' + esc(clip.id) + '">Lo que se dice</button>' +
      '<button class="btn" type="button" data-accion="editar" data-id="' + esc(clip.id) + '">Editar</button>' +
      (url ? '<a class="btn" href="' + esc(url) + '" download="' + esc(slug(tituloDe(clip, e.ediciones))) + '.mp4">Exportar</a>' : '') +
    '</div>' +
    '<div class="panel-slot">' + htmlPanel(clip, e.paneles.get(clip.id)) + '</div>' +
  '</article>';
}

function htmlClips(clips) {
  const lista = filtrarClipsFlujo(clips, {
    texto: e.textoClips, soloFavoritos: e.soloFavoritos, favoritos: e.favoritos,
    proyecto: e.filtroProyecto, orden: e.orden, ediciones: e.ediciones,
  });
  if (lista.length) return '<div class="grid grid-clips">' + lista.map(tarjetaClip).join('') + '</div>';
  if (e.soloFavoritos && e.favoritos.size === 0) return vacio('Aún no marcaste ningún clip con ★. Pulsa la estrella de un clip para guardarlo en Me gustan.');
  return vacio(clips.some(esTerminado) ? 'Ningún clip coincide con los filtros.' : 'Aún no hay clips listos.');
}

/* ---------- Pintado ---------- */

const hayReproduccion = (contenedor) => [...contenedor.querySelectorAll('video')].some((v) => !v.paused && !v.ended);

function pintar(contenedor, clave, html, forzar = false) {
  if (e.html[clave] === html) return;
  if (!forzar && hayReproduccion(contenedor)) return; // no cortar un video en reproduccion; se pinta en el siguiente sondeo
  contenedor.innerHTML = html;
  e.html[clave] = html;
}

export function contadores(datos) {
  if (!datos) return;
  $('n-proyectos').textContent = String(agruparProyectos(datos.clips).length);
}

function actualizarCabeceras(clips) {
  const proyectos = agruparProyectos(clips);
  $('proy-contador').textContent = proyectos.length + (proyectos.length === 1 ? ' proyecto' : ' proyectos');
  $('proy-toolbar').hidden = Boolean(e.abierto);
  const terminados = clips.filter(esTerminado).length;
  const proceso = clips.filter((c) => c.estado === 'procesando').length;
  $('clips-contador').textContent = terminados + (terminados === 1 ? ' clip' : ' clips') + (proceso ? ' · ' + proceso + ' en proceso' : '');
  $('clips-chip-proyecto').hidden = !e.filtroProyecto;
  document.querySelectorAll('[data-filtro]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filtro === 'favoritos' === e.soloFavoritos)));
  $('clips-favs').textContent = String(e.favoritos.size);
}

export function render(vista, datos, forzar = false) {
  if (datos) e.datos = datos;
  if (!e.datos) return;
  const clips = e.datos.clips;
  contadores(e.datos);
  actualizarCabeceras(clips);
  if (vista === 'proyectos') pintar($('lista-proyectos'), 'proyectos', htmlProyectos(clips), forzar);
  if (vista === 'clips') pintar($('lista-flujo-clips'), 'clips', htmlClips(clips), forzar);
}

/* ---------- Acciones ---------- */

async function copiarTexto(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = texto;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

const clipPorId = (id) => (e.datos ? e.datos.clips.find((c) => c.id === id) : null);

function alternarFavorito(id, boton) {
  if (e.favoritos.has(id)) e.favoritos.delete(id);
  else e.favoritos.add(id);
  guardarLocal(LS_FAV, [...e.favoritos]);
  const fav = e.favoritos.has(id);
  boton.setAttribute('aria-pressed', String(fav));
  boton.textContent = fav ? '★' : '☆';
  boton.title = fav ? 'Quitar de Me gustan' : 'Me gusta';
  $('clips-favs').textContent = String(e.favoritos.size);
  e.html.clips = ''; // el HTML guardado ya no coincide con el DOM: se repinta en el proximo cambio
  if (e.soloFavoritos) render('clips', null, true);
}

function alternarPanel(id, tipo, tarjeta) {
  const clip = clipPorId(id);
  if (!clip) return;
  if (e.paneles.get(id) === tipo) e.paneles.delete(id);
  else e.paneles.set(id, tipo);
  tarjeta.querySelector('.panel-slot').innerHTML = htmlPanel(clip, e.paneles.get(id));
  e.html.clips = '';
}

function abrirEditor(id) {
  const clip = clipPorId(id);
  if (!clip) return;
  e.editando = id;
  $('ed-titulo').value = tituloDe(clip, e.ediciones);
  $('ed-desc').value = descripcionDe(clip, e.ediciones);
  $('dlg-editar').showModal();
  $('ed-titulo').focus();
}

function cerrarEditor() {
  $('dlg-editar').close();
  e.editando = null;
}

function irAClips(proyecto) {
  e.filtroProyecto = proyecto;
  e.ayudas.activarVista('clips', false);
  render('clips', null, true);
}

function iniciarVistas() {
  $('vista-proyectos').addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-accion]');
    if (!el) return;
    ev.preventDefault();
    if (el.dataset.accion === 'abrir-proyecto') { e.abierto = el.dataset.id; render('proyectos', null, true); }
    if (el.dataset.accion === 'cerrar-proyecto') { e.abierto = ''; render('proyectos', null, true); }
    if (el.dataset.accion === 'ver-clips') irAClips(el.dataset.id);
  });

  $('vista-clips').addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-accion], [data-filtro]');
    if (!el) return;
    if (el.dataset.filtro) {
      e.soloFavoritos = el.dataset.filtro === 'favoritos';
      render('clips', null, true);
      return;
    }
    const tarjeta = el.closest('.clip');
    const id = el.dataset.id;
    switch (el.dataset.accion) {
      case 'fav': alternarFavorito(id, el); break;
      case 'panel': alternarPanel(id, el.dataset.tipo, tarjeta); break;
      case 'editar': abrirEditor(id); break;
      case 'ver-clips': ev.preventDefault(); irAClips(id); break;
      case 'quitar-proyecto': e.filtroProyecto = ''; render('clips', null, true); break;
      case 'copiar-desc': {
        const clip = clipPorId(id);
        const ok = clip ? await copiarTexto(descripcionDe(clip, e.ediciones)) : false;
        e.ayudas.mostrarAviso(ok ? 'Descripción copiada al portapapeles.' : 'No se pudo copiar la descripción.', ok ? 'ok' : 'error');
        break;
      }
      default: break;
    }
  });

  // <details> no propaga "toggle": se escucha en captura para recordar que revisiones estan abiertas.
  $('vista-clips').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (!d.classList || !d.classList.contains('revision')) return;
    if (d.open) e.revisiones.add(d.dataset.id);
    else e.revisiones.delete(d.dataset.id);
  }, true);

  let temporizador = null;
  const conRetardo = (fn) => (ev) => {
    clearTimeout(temporizador);
    const valor = ev.target.value;
    temporizador = setTimeout(() => fn(valor), 150);
  };
  $('proy-buscar').addEventListener('input', conRetardo((v) => { e.textoProyectos = v; render('proyectos', null, true); }));
  $('clips-buscar').addEventListener('input', conRetardo((v) => { e.textoClips = v; render('clips', null, true); }));
  $('clips-orden').addEventListener('change', (ev) => { e.orden = ev.target.value; render('clips', null, true); });
}

function iniciarEditor() {
  $('form-editar').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!e.editando) return;
    const titulo = $('ed-titulo').value.trim();
    const descripcion = $('ed-desc').value.trim();
    if (titulo || descripcion) e.ediciones[e.editando] = { titulo, descripcion };
    else delete e.ediciones[e.editando];
    guardarLocal(LS_ED, e.ediciones);
    cerrarEditor();
    render('clips', null, true);
    e.ayudas.mostrarAviso('Cambios guardados en este navegador.', 'ok');
  });
  $('ed-restaurar').addEventListener('click', () => {
    if (e.editando) delete e.ediciones[e.editando];
    guardarLocal(LS_ED, e.ediciones);
    cerrarEditor();
    render('clips', null, true);
    e.ayudas.mostrarAviso('Se restauró el texto original del clip.', 'info');
  });
  $('ed-cancelar').addEventListener('click', cerrarEditor);
}

/* ---------- Creacion ---------- */

function iniciarCrear() {
  const select = $('sel-encuadre');
  select.innerHTML = Object.entries(ENCUADRES).map(([valor, texto]) => '<option value="' + esc(valor) + '">' + esc(texto) + '</option>').join('');

  $('form-encolar').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const entrada = prepararEncolar({ url: $('input-url').value, modo: select.value, cantidad: $('sel-cantidad').value });
    if (!entrada.ok) {
      e.ayudas.mostrarAviso(entrada.error, 'error', 6000);
      return;
    }
    const boton = $('btn-encolar');
    boton.disabled = true;
    try {
      const { url, ...opciones } = entrada.cuerpo;
      await encolarVideo(url, opciones);
      $('input-url').value = '';
      e.ayudas.mostrarAviso('Proyecto en cola: el sistema elegirá los mejores momentos.', 'ok');
      e.abierto = '';
      e.ayudas.activarVista('proyectos', false);
      e.ayudas.sondearYa();
    } catch (error) {
      if (error.status === 401) e.ayudas.abrirLlave();
      e.ayudas.mostrarAviso('No se pudo crear el proyecto: ' + error.message, 'error', 6000);
    } finally {
      boton.disabled = false;
    }
  });
}

/** ayudas: { mostrarAviso, abrirLlave, sondearYa, activarVista } provistas por panel.js */
export function iniciar(ayudas) {
  e.ayudas = ayudas;
  iniciarCrear();
  iniciarVistas();
  iniciarEditor();
}
