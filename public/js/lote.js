// Controles de lote para "Todos los clips": seleccion multiple, velocidad, tono, color, encuadre, espejo, logo/foto sin fondo,
// "Aplicar a todos" y "Aplicar tambien a clips nuevos".
//
// Convive con flujo.js SIN tocarlo:
//   - La barra vive FUERA de #lista-flujo-clips (que flujo.js repinta con innerHTML en cada sondeo), asi los controles,
//     el logo y la seleccion no se pierden al refrescar.
//   - Las casillas y chips de cada tarjeta se agregan con un MutationObserver que re-decora tras cada repintado; la
//     seleccion vive en este modulo (no en el DOM) y se guarda en sessionStorage.
//   - Los botones usan data-lote (flujo.js solo reacciona a data-accion / data-filtro).
import { obtenerEstado, registrarAjustesNuevos, subirLogo, obtenerLogoUrl, aplicarLote } from './api.js';
import * as A from './ajustes.js';
import { esc } from './views.js';

const LS_LOTE = 'cliplab.lote.v1';
const LS_SEL = 'cliplab.lote.seleccion';
const SONDEO_MS = 6000;

const $ = (id) => document.getElementById(id);

function leer(almacen, clave, defecto) {
  try {
    const crudo = almacen.getItem(clave);
    return crudo ? JSON.parse(crudo) : defecto;
  } catch {
    return defecto;
  }
}

function guardar(almacen, clave, valor) {
  try {
    almacen.setItem(clave, JSON.stringify(valor));
  } catch {
    // Sin almacenamiento: el estado dura mientras la pestana siga abierta.
  }
}

const guardado = leer(localStorage, LS_LOTE, {});
const s = {
  ajustes: A.normalizarAjustes(guardado.ajustes),
  aplicarNuevos: guardado.aplicarNuevos === true,
  logoInfo: guardado.logoInfo || null,           // { fondoDetectado, conAlfa } del ultimo logo subido
  seleccion: new Set(leer(sessionStorage, LS_SEL, [])),
  clips: new Map(),
  urls: { id: '', original: '', sinFondo: '' },  // blobs de la vista previa del logo
  ocupado: false,
};

const persistirLote = () => guardar(localStorage, LS_LOTE, { ajustes: s.ajustes, aplicarNuevos: s.aplicarNuevos, logoInfo: s.logoInfo });
const persistirSeleccion = () => guardar(sessionStorage, LS_SEL, [...s.seleccion]);

function avisar(texto, tipo = 'info', ms = 6000) {
  const aviso = $('aviso');
  if (!aviso) return;
  aviso.textContent = texto;
  aviso.dataset.tipo = tipo;
  aviso.hidden = false;
  if (ms > 0) setTimeout(() => { if (aviso.textContent === texto) aviso.hidden = true; }, ms);
}

/* ---------- Barra ---------- */

const HTML_BARRA = `
<div class="lote-cab">
  <strong>Edición en lote</strong>
  <span id="lote-contador" class="suave" aria-live="polite">0 seleccionados</span>
  <div class="lote-cab-acc">
    <button class="btn" type="button" data-lote="todos">Seleccionar todos</button>
    <button class="btn" type="button" data-lote="ninguno">Ninguno</button>
  </div>
</div>
<div class="lote-controles">
  <div class="campo">Velocidad
    <div id="lote-vel" class="segmento" role="group" aria-label="Velocidad">${A.VELOCIDADES.map((v) =>
      '<button class="btn" type="button" data-lote="vel" data-valor="' + v.valor + '" aria-pressed="false">' + esc(v.etiqueta) + '</button>').join('')}</div>
  </div>
  <label class="campo">Tono de audio <select id="lote-tono">${A.TONOS.map((t) => '<option value="' + t.valor + '">' + esc(t.etiqueta) + '</option>').join('')}</select></label>
  <label class="campo">Color <select id="lote-color">${Object.entries(A.COLORES).map(([k, t]) => '<option value="' + k + '">' + esc(t) + '</option>').join('')}</select></label>
  <label class="campo">Encuadre <select id="lote-encuadre">${Object.entries(A.ENCUADRES_AJUSTE).map(([k, t]) => '<option value="' + k + '">' + esc(t) + '</option>').join('')}</select></label>
  <div class="campo">Espejo <button id="lote-espejo" class="btn" type="button" data-lote="espejo" aria-pressed="false">Espejo</button></div>
</div>
<details id="lote-logo-det" class="lote-logo">
  <summary>Foto / logo sin fondo <span id="lote-logo-estado" class="suave"></span></summary>
  <div class="lote-logo-cuerpo">
    <div class="lote-logo-izq">
      <label class="campo campo-ancho">Imagen (PNG, JPG o WebP, máx. 5 MB) <input id="lote-logo-archivo" type="file" accept="image/png,image/jpeg,image/webp"></label>
      <label class="check"><input id="lote-logo-fondo" type="checkbox"> Quitar fondo</label>
      <p id="lote-logo-nota" class="suave"></p>
      <label class="campo campo-ancho">Tamaño <input id="lote-logo-escala" type="range" min="${A.LOGO_ESCALA.min * 100}" max="${A.LOGO_ESCALA.max * 100}" step="1"></label>
      <button class="btn" type="button" data-lote="logo-quitar">Quitar logo</button>
    </div>
    <div id="lote-prev" class="lote-prev" tabindex="0" role="group" aria-label="Vista previa vertical: arrastra el logo o usa las flechas del teclado">
      <img id="lote-logo-img" alt="" hidden draggable="false">
      <span id="lote-prev-vacio" class="suave">Sin logo</span>
    </div>
  </div>
</details>
<div class="lote-pie">
  <button id="lote-aplicar" class="btn btn-primario" type="button" data-lote="aplicar">Aplicar a todos</button>
  <label class="check"><input id="lote-nuevos" type="checkbox"> Aplicar también a clips nuevos</label>
  <button class="btn" type="button" data-lote="reset">Restablecer controles</button>
  <span id="lote-resumen" class="suave"></span>
</div>`;

function nombreLogo() {
  const l = s.ajustes.logo;
  return l ? (l.recorteFondo ? 'activo, sin fondo' : 'activo') : 'sin imagen';
}

function notaLogo() {
  if (!s.ajustes.logo || !s.logoInfo) return 'Sube una imagen para ponerla sobre los clips.';
  if (s.logoInfo.conAlfa) return 'La imagen ya tiene transparencia: no hace falta quitar el fondo.';
  if (!s.logoInfo.fondoDetectado) return 'No detecté un fondo liso: usa un PNG transparente o una imagen con fondo de un solo color.';
  return 'Se quita el color liso del fondo (funciona mejor con fondos de un solo color).';
}

/** Refleja el estado en los controles ya existentes (no recrea nada: no se pierde foco ni valores). */
function sincronizar() {
  const a = s.ajustes;
  document.querySelectorAll('#lote-vel [data-valor]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.valor) === a.velocidad)));
  $('lote-tono').value = String(a.tono);
  $('lote-color').value = a.color;
  $('lote-encuadre').value = a.encuadre;
  $('lote-espejo').setAttribute('aria-pressed', String(a.espejo));
  $('lote-nuevos').checked = s.aplicarNuevos;

  const logo = a.logo;
  $('lote-logo-estado').textContent = '· ' + nombreLogo();
  const puedeQuitar = Boolean(logo && s.logoInfo && s.logoInfo.fondoDetectado);
  $('lote-logo-fondo').disabled = !puedeQuitar;
  $('lote-logo-fondo').checked = Boolean(logo && logo.recorteFondo && puedeQuitar);
  $('lote-logo-escala').disabled = !logo;
  if (logo) $('lote-logo-escala').value = String(Math.round(logo.escala * 100));
  $('lote-logo-nota').textContent = notaLogo();
  pintarVistaPrevia();

  const n = s.seleccion.size;
  $('lote-contador').textContent = n + (n === 1 ? ' seleccionado' : ' seleccionados');
  $('lote-aplicar').textContent = 'Aplicar a todos' + (n ? ' (' + n + ')' : '');
  $('lote-aplicar').disabled = s.ocupado;
  const resumen = A.resumenAjustes(a);
  $('lote-resumen').textContent = resumen.length ? 'Ajustes: ' + resumen.join(' · ') : 'Sin ajustes: todo en normal.';

  const info = $('lote-nuevos-info');
  if (info) {
    const activos = A.ajustesParaNuevos(s);
    info.hidden = !activos;
    info.textContent = activos ? 'Se aplicarán a los clips nuevos: ' + A.resumenAjustes(activos).join(' · ') + ' (cámbialo en Todos los clips › Edición en lote).' : '';
  }
}

/** Aplica un cambio parcial a los controles (un `logo` en el parche reemplaza al actual; null lo quita), guarda y repinta. */
function cambiar(parche) {
  s.ajustes = A.normalizarAjustes({ ...s.ajustes, ...parche });
  persistirLote();
  sincronizar();
}

/* ---------- Logo: vista previa, arrastre y subida ---------- */

function soltarUrls() {
  for (const k of ['original', 'sinFondo']) if (s.urls[k]) URL.revokeObjectURL(s.urls[k]);
  s.urls = { id: '', original: '', sinFondo: '' };
}

async function cargarImagenLogo() {
  const logo = s.ajustes.logo;
  if (!logo) { soltarUrls(); return; }
  if (s.urls.id !== logo.id) {
    soltarUrls();
    s.urls.id = logo.id;
    try {
      s.urls.original = await obtenerLogoUrl(logo.id, false);
      if (s.logoInfo && s.logoInfo.fondoDetectado) s.urls.sinFondo = await obtenerLogoUrl(logo.id, true).catch(() => '');
    } catch (error) {
      if (error.status === 404) {   // el servidor ya no la tiene (se purgo): se descarta para no mandar un logo fantasma
        s.urls.id = '';
        avisar('El logo guardado ya no existe en el servidor: sube la imagen de nuevo.', 'info');
        cambiar({ logo: null });
      }
      return;
    }
  }
  pintarVistaPrevia();
}

function pintarVistaPrevia() {
  const logo = s.ajustes.logo;
  const img = $('lote-logo-img');
  const url = logo && s.urls.id === logo.id ? (logo.recorteFondo && s.urls.sinFondo ? s.urls.sinFondo : s.urls.original) : '';
  img.hidden = !url;
  $('lote-prev-vacio').hidden = Boolean(url);
  if (!url) return;
  if (img.getAttribute('src') !== url) img.src = url;
  img.style.left = logo.x * 100 + '%';
  img.style.top = logo.y * 100 + '%';
  img.style.width = logo.escala * 100 + '%';
}

function iniciarArrastre() {
  const prev = $('lote-prev');
  let arrastrando = false;
  const mover = (ev) => {
    const caja = prev.getBoundingClientRect();
    const p = A.posicionDesdePunto(ev.clientX - caja.left, ev.clientY - caja.top, caja.width, caja.height);
    s.ajustes = { ...s.ajustes, logo: { ...s.ajustes.logo, ...p } };
    pintarVistaPrevia();
  };
  prev.addEventListener('pointerdown', (ev) => {
    if (!s.ajustes.logo) return;
    arrastrando = true;
    prev.setPointerCapture(ev.pointerId);
    mover(ev);
    ev.preventDefault();
  });
  prev.addEventListener('pointermove', (ev) => { if (arrastrando) mover(ev); });
  const soltar = () => {
    if (!arrastrando) return;
    arrastrando = false;
    cambiar({ logo: s.ajustes.logo });   // normaliza, guarda y actualiza resumenes
  };
  prev.addEventListener('pointerup', soltar);
  prev.addEventListener('pointercancel', soltar);
  prev.addEventListener('keydown', (ev) => {
    const pasos = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
    if (!pasos || !s.ajustes.logo) return;
    ev.preventDefault();
    const paso = ev.shiftKey ? 0.1 : 0.02;
    cambiar({ logo: A.desplazarLogo(s.ajustes.logo, pasos[0] * paso, pasos[1] * paso) });
  });
}

async function alElegirLogo(ev) {
  const entrada = ev.target;
  const archivo = entrada.files[0];
  if (!archivo) return;
  const v = A.validarArchivoLogo(archivo);
  if (!v.ok) { avisar(v.error, 'error'); entrada.value = ''; return; }
  entrada.disabled = true;
  $('lote-logo-nota').textContent = 'Subiendo imagen…';
  try {
    const { logo } = await subirLogo(archivo);
    s.logoInfo = { fondoDetectado: logo.fondoDetectado, conAlfa: logo.conAlfa };
    soltarUrls();
    cambiar({ logo: { id: logo.id, recorteFondo: false, ...A.LOGO_DEFECTO } });
    await cargarImagenLogo();
    $('lote-logo-det').open = true;
  } catch (error) {
    if (error.status === 401) $('btn-llave').click();
    avisar('No se pudo subir la imagen: ' + error.message, 'error');
    sincronizar();
  } finally {
    entrada.disabled = false;
    entrada.value = '';
  }
}

/* ---------- Seleccion y decoracion de tarjetas ---------- */

const tarjetas = () => [...document.querySelectorAll('#lista-flujo-clips .clip[data-id]')];

function decorar() {
  for (const tarjeta of tarjetas()) {
    const id = tarjeta.dataset.id;
    let caja = tarjeta.querySelector(':scope > .sel-lote');
    if (!caja) {
      caja = document.createElement('label');
      caja.className = 'sel-lote';
      caja.innerHTML = '<input type="checkbox" data-lote-sel="' + esc(id) + '"> <span>Seleccionar</span>';
      tarjeta.prepend(caja);
    }
    const marcada = s.seleccion.has(id);
    caja.querySelector('input').checked = marcada;
    tarjeta.classList.toggle('lote-sel-on', marcada);

    const clip = s.clips.get(id);
    let chips = tarjeta.querySelector(':scope > .lote-chips');
    const textos = clip ? [...(clip.varianteDe ? ['Variante'] : []), ...A.resumenAjustes(clip.ajustes ? A.normalizarAjustes(clip.ajustes) : null)] : [];
    if (textos.length) {
      if (!chips) {
        chips = document.createElement('div');
        chips.className = 'lote-chips';
        caja.after(chips);
      }
      const html = textos.map((t) => '<span class="chip">' + esc(t) + '</span>').join('');
      if (chips.innerHTML !== html) chips.innerHTML = html;
    } else if (chips) {
      chips.remove();
    }
  }
}

function alCambiarSeleccion(ev) {
  const caja = ev.target.closest('input[data-lote-sel]');
  if (!caja) return;
  if (caja.checked) s.seleccion.add(caja.dataset.loteSel);
  else s.seleccion.delete(caja.dataset.loteSel);
  caja.closest('.clip').classList.toggle('lote-sel-on', caja.checked);
  persistirSeleccion();
  sincronizar();
}

async function refrescarClips() {
  try {
    const datos = await obtenerEstado();
    s.clips = new Map((datos.clips || []).map((c) => [c.id, c]));
    const antes = s.seleccion.size;
    s.seleccion = A.podarSeleccion(s.seleccion, new Set(s.clips.keys()));
    if (s.seleccion.size !== antes) persistirSeleccion();
    decorar();
    sincronizar();
  } catch {
    // Sin llave o sin conexion: el aviso general del panel ya lo informa; aqui no se repite.
  }
}

/* ---------- Acciones ---------- */

async function aplicarATodos() {
  if (s.ocupado) return;
  const plan = A.planAplicar({ seleccion: s.seleccion, ajustes: s.ajustes });
  if (!plan.ok) { avisar(plan.error, 'error'); return; }
  const mensaje = 'Se crearán hasta ' + plan.ids.length + ' clips nuevos (variantes) con: ' + plan.resumen.join(' · ') +
    '.\nLos clips originales no se modifican. Cada variante vuelve a procesar el video original, así que puede tardar. ¿Continuar?';
  if (!window.confirm(mensaje)) return;

  s.ocupado = true;
  sincronizar();
  try {
    const r = await aplicarLote(plan.ids, s.ajustes);
    const hechos = r.encolados.length;
    const omitidos = r.omitidos || [];
    const detalle = omitidos.length ? ' · No se pudo en ' + omitidos.length + ': ' + [...new Set(omitidos.map((o) => o.motivo))].join('; ') : '';
    avisar((hechos ? hechos + (hechos === 1 ? ' variante en cola.' : ' variantes en cola.') : 'No se encoló ninguna variante.') + detalle, hechos ? 'ok' : 'error', 9000);
    refrescarClips();
  } catch (error) {
    if (error.status === 401) $('btn-llave').click();
    avisar('No se pudo aplicar: ' + error.message, 'error');
  } finally {
    s.ocupado = false;
    sincronizar();
  }
}

function alPulsar(ev) {
  const b = ev.target.closest('[data-lote]');
  if (!b) return;
  switch (b.dataset.lote) {
    case 'vel': cambiar({ velocidad: Number(b.dataset.valor) }); break;
    case 'espejo': cambiar({ espejo: !s.ajustes.espejo }); break;
    case 'todos': tarjetas().forEach((t) => s.seleccion.add(t.dataset.id)); persistirSeleccion(); decorar(); sincronizar(); break;
    case 'ninguno': s.seleccion.clear(); persistirSeleccion(); decorar(); sincronizar(); break;
    case 'reset': soltarUrls(); cambiar(A.ajustesVacios()); break;
    case 'logo-quitar': soltarUrls(); cambiar({ logo: null }); break;
    case 'aplicar': aplicarATodos(); break;
    default: break;
  }
}

function iniciarControles() {
  const barra = $('lote-barra');
  barra.addEventListener('click', alPulsar);
  $('lote-tono').addEventListener('change', (ev) => cambiar({ tono: Number(ev.target.value) }));
  $('lote-color').addEventListener('change', (ev) => cambiar({ color: ev.target.value }));
  $('lote-encuadre').addEventListener('change', (ev) => cambiar({ encuadre: ev.target.value }));
  $('lote-nuevos').addEventListener('change', (ev) => { s.aplicarNuevos = ev.target.checked; persistirLote(); sincronizar(); });
  $('lote-logo-archivo').addEventListener('change', alElegirLogo);
  $('lote-logo-fondo').addEventListener('change', (ev) => {
    if (s.ajustes.logo) cambiar({ logo: { ...s.ajustes.logo, recorteFondo: ev.target.checked } });
  });
  $('lote-logo-escala').addEventListener('input', (ev) => {
    if (!s.ajustes.logo) return;
    s.ajustes = { ...s.ajustes, logo: A.redimensionarLogo(s.ajustes.logo, Number(ev.target.value) / 100) };
    pintarVistaPrevia();
  });
  $('lote-logo-escala').addEventListener('change', () => cambiar({ logo: s.ajustes.logo }));
  iniciarArrastre();
}

export function iniciarLote() {
  const vista = $('vista-clips');
  const lista = $('lista-flujo-clips');
  if (!vista || !lista || $('lote-barra')) return;

  const barra = document.createElement('section');
  barra.id = 'lote-barra';
  barra.className = 'lote';
  barra.setAttribute('aria-label', 'Edición en lote');
  barra.innerHTML = HTML_BARRA;
  lista.before(barra);

  const form = $('form-encolar');
  const aviso = document.createElement('p');
  aviso.id = 'lote-nuevos-info';
  aviso.className = 'suave';
  aviso.hidden = true;
  if (form) form.append(aviso);

  iniciarControles();
  registrarAjustesNuevos(() => A.ajustesParaNuevos(s));
  lista.addEventListener('change', alCambiarSeleccion);
  new MutationObserver(decorar).observe(lista, { childList: true });   // flujo.js repinta con innerHTML: se vuelve a decorar

  sincronizar();
  decorar();
  cargarImagenLogo();
  refrescarClips();
  setInterval(() => { if (!document.hidden && !vista.hidden) refrescarClips(); }, SONDEO_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refrescarClips(); });
}

iniciarLote();
