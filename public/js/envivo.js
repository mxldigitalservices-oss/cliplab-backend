// Panel "En Vivo" + limpieza de bandeja. Modulo independiente: no toca panel.js ni flujo.js.
//  - Pegar enlace, iniciar/detener captura, marcar momentos (manual o automatico).
//  - Lista de momentos con titulo y descripcion; tanda de 5 hacia "Todos los clips" (#clips) o para descargar.
//  - Limpiar descargados / procesados: archiva en el servidor (los archivos no se borran) y libera los <video> del navegador.
// Liviano: el sondeo solo corre con la pestana visible, la lista no carga videos y el visor mantiene UN video a la vez.
import { leerLlave } from './api.js';
import { esc } from './views.js';
import { liberarVideos, textoEstado, slug } from './envivo-lib.js';

const LS_AUTOLIMPIAR = 'cliplab.envivo.autolimpiar';
const SONDEO_MS = 5000;
const TANDA = 5;
const $ = (id) => document.getElementById(id);

const e = { lista: [], mostrar: TANDA, firma: '', sesion: null, resumen: { descargados: 0, procesados: 0, archivados: 0 }, enVuelo: false, temporizador: null };

function autoLimpiar() {
  try { return localStorage.getItem(LS_AUTOLIMPIAR) !== '0'; } catch { return true; }
}

async function pedir(ruta, metodo = 'GET', cuerpo) {
  const cabeceras = { Accept: 'application/json' };
  const llave = leerLlave();
  if (llave && /^[\x20-\x7E]+$/.test(llave)) cabeceras['x-master-key'] = llave;
  if (cuerpo !== undefined) cabeceras['Content-Type'] = 'application/json';
  const controlador = new AbortController();
  const t = setTimeout(() => controlador.abort(), 30000);
  try {
    const r = await fetch(ruta, { method: metodo, headers: cabeceras, body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined, cache: 'no-store', signal: controlador.signal });
    let datos = null;
    try { datos = await r.json(); } catch { datos = null; }
    if (!r.ok || (datos && datos.success === false)) throw new Error((datos && datos.error) || 'Error ' + r.status);
    return datos && 'success' in datos ? { ok: true, ...(datos.data || {}) } : datos;
  } finally {
    clearTimeout(t);
  }
}

function aviso(texto, tipo = 'info') {
  let n = $('ev-aviso');
  if (!n) { n = document.createElement('div'); n.id = 'ev-aviso'; n.setAttribute('role', 'status'); document.body.append(n); }
  n.textContent = texto;
  n.dataset.tipo = tipo;
  n.hidden = false;
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => { n.hidden = true; }, 4200);
}

const visible = () => !document.hidden && $('vista-envivo') && !$('vista-envivo').hidden;
const refrescarPanelPrincipal = () => { const b = $('btn-refrescar'); if (b) b.click(); };

/* ---------- Pintado ---------- */

function htmlTarjeta(m) {
  const listo = m.estado === 'listo' || m.estado === 'publicado';
  const estado = m.estado === 'error' ? 'Con error' : listo ? (m.enviadoEn ? 'Enviado a Clips' : 'Listo') : (m.etapa || 'Procesando') + ' ' + Math.round(m.progreso || 0) + '%';
  const url = typeof m.url === 'string' && /^(https?:\/\/|\/(?!\/))/i.test(m.url) ? m.url : '';
  return '<article class="card ev-card" data-id="' + esc(m.id) + '">' +
    '<div class="card-cab"><h3>' + esc(m.titulo) + '</h3><span class="badge ' + (listo ? 'badge-ok' : 'badge-info') + '">' + esc(estado) + '</span></div>' +
    '<details class="ev-desc"><summary>Descripción</summary><pre>' + esc(m.descripcion || 'Aún sin descripción: se genera al terminar de procesar.') + '</pre></details>' +
    '<div class="card-acciones">' +
      (listo && url ? '<button class="btn" type="button" data-ev="ver" data-url="' + esc(url) + '">Ver</button>' : '') +
      (m.descripcion ? '<button class="btn" type="button" data-ev="copiar" data-id="' + esc(m.id) + '">Copiar descripción</button>' : '') +
      (listo && url ? '<a class="btn" href="' + esc(url) + '" download="' + esc(slug(m.titulo)) + '.mp4" data-ev-descarga>Descargar</a>' : '') +
      (listo && !m.enviadoEn ? '<button class="btn" type="button" data-ev="enviar" data-id="' + esc(m.id) + '">Enviar a Clips</button>' : '') +
    '</div></article>';
}

function pintar() {
  const firma = JSON.stringify([e.lista.map((m) => [m.id, m.titulo, m.estado, m.etapa, Math.round(m.progreso || 0), m.enviadoEn, !!m.descripcion]), e.mostrar, e.resumen, e.sesion && [e.sesion.estado, e.sesion.auto, e.sesion.momentos, e.sesion.error, Math.floor((e.sesion.segundosGrabados || 0) / 5)]]);
  if (firma === e.firma) return;
  e.firma = firma;
  const s = e.sesion || { estado: 'inactivo' };
  const activa = s.estado === 'iniciando' || s.estado === 'grabando';
  $('ev-estado').textContent = textoEstado(s);
  $('ev-estado').dataset.estado = s.estado;
  $('ev-iniciar').disabled = activa;
  $('ev-detener').disabled = !(activa || s.estado === 'terminado');
  $('ev-marcar').disabled = !(s.estado === 'grabando' || s.estado === 'terminado');
  $('ev-auto').checked = Boolean(s.auto);
  $('ev-auto').disabled = !activa;
  $('n-envivo').textContent = String(e.lista.length);
  const listos = e.lista.filter((m) => m.estado === 'listo' && !m.enviadoEn).length;
  $('ev-tanda-enviar').disabled = listos === 0;
  $('ev-tanda-bajar').disabled = e.lista.filter((m) => m.estado === 'listo' && m.url).length === 0;
  document.querySelectorAll('[data-ev-limpiar="descargados"] .ev-n').forEach((n) => { n.textContent = e.resumen.descargados; });
  document.querySelectorAll('[data-ev-limpiar="procesados"] .ev-n').forEach((n) => { n.textContent = e.resumen.procesados; });
  document.querySelectorAll('[data-ev-restaurar] .ev-n').forEach((n) => { n.textContent = e.resumen.archivados; });
  const grupo = e.lista.slice(0, e.mostrar);
  const lista = $('ev-lista');
  liberarVideos(lista);
  lista.innerHTML = grupo.length
    ? '<div class="grid">' + grupo.map(htmlTarjeta).join('') + '</div>' +
      (e.lista.length > grupo.length ? '<p class="ev-mas"><button class="btn" type="button" data-ev="mas">Mostrar ' + Math.min(TANDA, e.lista.length - grupo.length) + ' más (' + (e.lista.length - grupo.length) + ' ocultos)</button></p>' : '')
    : '<div class="vacio">Aún no hay momentos. Inicia una captura y pulsa “Marcar momento”, o activa la detección automática.</div>';
}

async function sondear() {
  if (e.enVuelo || !visible()) return;
  e.enVuelo = true;
  try {
    const [estado, resumen] = await Promise.all([pedir('/api/panel/envivo/estado'), pedir('/api/panel/limpieza/resumen')]);
    e.sesion = estado.sesion;
    e.lista = estado.momentos || [];
    e.resumen = resumen;
    pintar();
  } catch (error) {
    $('ev-estado').textContent = error.message;
  } finally {
    e.enVuelo = false;
  }
}

/* ---------- Acciones ---------- */

async function conAviso(fn, okTexto) {
  try {
    const r = await fn();
    if (okTexto) aviso(typeof okTexto === 'function' ? okTexto(r) : okTexto, 'ok');
    return r;
  } catch (error) {
    aviso(error.message, 'error');
    return null;
  } finally {
    e.firma = '';
    sondear();
  }
}

async function limpiar(modo) {
  const r = await conAviso(() => pedir('/api/panel/limpieza', 'POST', { modo }), (x) => x.archivados + (x.archivados === 1 ? ' clip retirado' : ' clips retirados') + ' de la bandeja');
  if (r) {
    liberarVideos(document.body);   // pausa y suelta todos los videos antes de que los paneles se repinten
    refrescarPanelPrincipal();
  }
}

async function restaurar() {
  const r = await conAviso(() => pedir('/api/panel/limpieza/restaurar', 'POST', {}), (x) => x.restaurados + ' clips restaurados');
  if (r) refrescarPanelPrincipal();
}

async function enviarTanda(ids) {
  const r = await conAviso(() => pedir('/api/panel/envivo/tanda', 'POST', { cantidad: TANDA, ids }), (x) => x.enviados.length + ' enviados a Todos los clips');
  if (r && r.enviados.length) {
    refrescarPanelPrincipal();
    const tab = document.querySelector('.tab[data-vista="clips"]');
    if (tab) tab.click();
  }
}

async function descargarTanda() {
  const listos = e.lista.filter((m) => m.estado === 'listo' && m.url).reverse().slice(0, TANDA);
  for (const m of listos) {
    const a = document.createElement('a');
    a.href = m.url;
    a.download = slug(m.titulo) + '.mp4';
    a.dataset.evDescarga = '';
    a.dataset.idClip = m.id;
    document.body.append(a);
    a.click();
    a.remove();
    await new Promise((ok) => setTimeout(ok, 700));   // el navegador acepta mejor las descargas escalonadas
  }
}

function ver(url) {
  const visor = $('ev-visor');
  liberarVideos(visor);
  visor.hidden = false;
  visor.innerHTML = '<div class="ev-visor-cab"><span>Vista previa</span><button class="btn" type="button" data-ev="cerrar-visor">Cerrar</button></div>';
  const v = document.createElement('video');
  v.controls = true;
  v.playsInline = true;
  v.preload = 'metadata';
  v.className = 'v916';
  v.src = url;
  visor.append(v);
}

function cerrarVisor() {
  const visor = $('ev-visor');
  liberarVideos(visor);
  visor.innerHTML = '';
  visor.hidden = true;
}

async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); return true; } catch { return false; }
}

async function alDescargar(a) {
  const tarjeta = a.closest('[data-id]');
  const id = a.dataset.idClip || (tarjeta && tarjeta.dataset.id);
  if (!id) return;
  try {
    const r = await pedir('/api/panel/limpieza/descargado/' + encodeURIComponent(id), 'POST', { archivar: autoLimpiar() });
    if (r.archivados) {
      liberarVideos(document.body);
      refrescarPanelPrincipal();
      e.firma = '';
      sondear();
    }
  } catch { /* la descarga ya empezo: si falla el aviso, el clip simplemente sigue en la bandeja */ }
}

/* ---------- Montaje ---------- */

function montar() {
  const raiz = $('panel-envivo');
  if (!raiz) return;
  raiz.innerHTML =
    '<form id="ev-form" class="crear" autocomplete="off"><div class="crear-fila">' +
      '<input id="ev-url" type="url" inputmode="url" placeholder="Pega el enlace de la transmisión en vivo (https://youtube.com/live/…)" required>' +
      '<button id="ev-iniciar" class="btn btn-primario" type="submit">Iniciar captura</button>' +
      '<button id="ev-detener" class="btn" type="button" disabled>Detener</button></div></form>' +
    '<p id="ev-estado" class="ev-estado" role="status" data-estado="inactivo">Sin captura</p>' +
    '<div class="ev-barra">' +
      '<label class="campo">Momento = últimos <select id="ev-seg"><option value="30">30 s</option><option value="45" selected>45 s</option><option value="60">60 s</option><option value="90">90 s</option></select></label>' +
      '<button id="ev-marcar" class="btn btn-primario" type="button" disabled>✂ Marcar momento</button>' +
      '<label class="check"><input id="ev-auto" type="checkbox" disabled> Detectar momentos automáticamente</label></div>' +
    '<div class="ev-barra">' +
      '<button id="ev-tanda-enviar" class="btn" type="button" disabled>Enviar tanda de ' + TANDA + ' a Clips</button>' +
      '<button id="ev-tanda-bajar" class="btn" type="button" disabled>Descargar tanda de ' + TANDA + '</button>' +
      botonesLimpieza() +
      '<label class="check"><input id="ev-autolimpiar" type="checkbox"> Auto-limpiar al descargar</label></div>' +
    '<div id="ev-visor" class="ev-visor" hidden></div><div id="ev-lista"></div>';
  $('ev-autolimpiar').checked = autoLimpiar();

  $('ev-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await conAviso(() => pedir('/api/panel/envivo/iniciar', 'POST', { url: $('ev-url').value.trim(), auto: $('ev-auto').checked }), 'Conectando con la transmisión…');
  });
  $('ev-detener').addEventListener('click', () => conAviso(() => pedir('/api/panel/envivo/detener', 'POST', {}), 'Captura detenida'));
  $('ev-marcar').addEventListener('click', () => conAviso(() => pedir('/api/panel/envivo/marcar', 'POST', { segundos: Number($('ev-seg').value) }), 'Momento enviado a procesar'));
  $('ev-auto').addEventListener('change', (ev) => conAviso(() => pedir('/api/panel/envivo/auto', 'POST', { activo: ev.target.checked })));
  $('ev-autolimpiar').addEventListener('change', (ev) => { try { localStorage.setItem(LS_AUTOLIMPIAR, ev.target.checked ? '1' : '0'); } catch { /* sin almacenamiento */ } });
  $('ev-tanda-enviar').addEventListener('click', () => enviarTanda());
  $('ev-tanda-bajar').addEventListener('click', descargarTanda);

  raiz.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-ev]');
    if (!b) return;
    const accion = b.dataset.ev;
    if (accion === 'ver') ver(b.dataset.url);
    if (accion === 'cerrar-visor') cerrarVisor();
    if (accion === 'mas') { e.mostrar += TANDA; e.firma = ''; pintar(); }
    if (accion === 'enviar') enviarTanda([b.dataset.id]);
    if (accion === 'copiar') {
      const m = e.lista.find((x) => x.id === b.dataset.id);
      aviso(m && await copiar(m.descripcion) ? 'Descripción copiada' : 'No se pudo copiar', m ? 'ok' : 'error');
    }
  });
}

function botonesLimpieza() {
  return '<button class="btn" type="button" data-ev-limpiar="descargados">Limpiar descargados (<span class="ev-n">0</span>)</button>' +
    '<button class="btn" type="button" data-ev-limpiar="procesados">Limpiar procesados (<span class="ev-n">0</span>)</button>' +
    '<button class="btn" type="button" data-ev-restaurar>Restaurar (<span class="ev-n">0</span>)</button>';
}

function iniciar() {
  montar();
  const barraClips = document.querySelector('#vista-clips .toolbar');
  if (barraClips) {
    const caja = document.createElement('span');
    caja.className = 'ev-limpieza-clips';
    caja.innerHTML = botonesLimpieza();   // fuera de #lista-flujo-clips: flujo.js no lo repinta
    barraClips.append(caja);
  }
  document.addEventListener('click', (ev) => {
    const lim = ev.target.closest('[data-ev-limpiar]');
    if (lim) { limpiar(lim.dataset.evLimpiar); return; }
    if (ev.target.closest('[data-ev-restaurar]')) { restaurar(); return; }
    const a = ev.target.closest('a[download]');
    if (a && (a.hasAttribute('data-ev-descarga') || a.closest('.clip'))) alDescargar(a);
  }, true);
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    if (t.dataset.vista === 'envivo' || t.dataset.vista === 'clips') setTimeout(sondear, 150);
    if (t.dataset.vista !== 'envivo') cerrarVisor();   // al salir de En Vivo no queda ningun video cargado
  }));
  e.temporizador = setInterval(sondear, SONDEO_MS);
  document.addEventListener('visibilitychange', () => { if (document.hidden) liberarVideos($('ev-visor')); else sondear(); });
  if (location.hash === '#envivo') { const t = document.querySelector('.tab[data-vista="envivo"]'); if (t) t.click(); }
}

if (typeof document !== 'undefined') iniciar();
