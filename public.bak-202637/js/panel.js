import { api, getLlave, setLlave } from './api.js';
import { toast } from './ui.js';
import { renderResumen, renderClips, renderLotes, renderIncidencias, incidenciasDe } from './views.js';

const POLL_MS = 4000;
const $ = (s) => document.querySelector(s);

const state = {
  data: null,
  tab: sessionStorage.getItem('tab') || 'resumen',
  filtro: { estado: 'todos', q: '' },
  abiertos: new Set(),
  enVuelo: false,
  pausado: false,
};

const roots = {
  resumen: { kpis: $('#r-kpis'), activos: $('#r-activos'), listos: $('#r-listos'), recientes: $('#r-recientes') },
  clips: $('#clips-lista'),
  clipsTotal: $('#clips-total'),
  lotes: $('#lotes-lista'),
  inc: $('#inc-lista'),
};

function contexto() {
  const lotePorId = new Map();
  const variantesPorLote = new Map();
  state.data.trabajos.forEach((t) => lotePorId.set(t.id, t));
  state.data.clips.forEach((c) => {
    if (!variantesPorLote.has(c.trabajo_id)) variantesPorLote.set(c.trabajo_id, []);
    variantesPorLote.get(c.trabajo_id).push(c);
  });
  variantesPorLote.forEach((v) => v.sort((a, b) => a.marca_tiempo - b.marca_tiempo));
  return { lotePorId, variantesPorLote, abiertos: state.abiertos, onReintentar: reintentar, onToggleLote: alternarLote };
}

function render() {
  if (!state.data) return;
  const ctx = contexto();
  renderResumen(roots.resumen, state.data, ctx);
  renderClips(roots.clips, roots.clipsTotal, state.data, ctx, state.filtro);
  renderLotes(roots.lotes, state.data, ctx);
  renderIncidencias(roots.inc, state.data, ctx);

  const inc = incidenciasDe(state.data).length;
  document.querySelector('[data-count="clips"]').textContent = state.data.clips.length;
  document.querySelector('[data-count="lotes"]').textContent = state.data.trabajos.length;
  const cInc = document.querySelector('[data-count="incidencias"]');
  cInc.textContent = inc;
  cInc.classList.toggle('hay', inc > 0);
}

function conexion(ok, detalle) {
  $('#sync-dot').className = `dot ${ok ? 'ok' : 'bad'}`;
  $('#sync-texto').textContent = ok
    ? `Sincronizado ${new Date().toLocaleTimeString('es-DO')}`
    : `Sin sincronizar: ${detalle}`;
}

function pedirLlave(mensaje) {
  $('#llave-msg').textContent = mensaje || 'Introduce la llave para acceder a la API.';
  $('#input-llave').value = '';
  const dlg = $('#dlg-llave');
  if (!dlg.open) dlg.showModal();
}

async function tick() {
  if (state.enVuelo || state.pausado || document.hidden) return;
  state.enVuelo = true;
  try {
    state.data = await api.estado();
    conexion(true);
    render();
  } catch (e) {
    if (e.status === 401) {
      state.pausado = true;
      conexion(false, 'llave requerida');
      pedirLlave(getLlave() ? 'La llave es incorrecta. Inténtalo de nuevo.' : 'Este panel requiere llave maestra.');
    } else {
      conexion(false, e.message);
    }
  } finally {
    state.enVuelo = false;
  }
}

async function reintentar(id, boton) {
  if (boton) boton.disabled = true;
  try {
    await api.reintentar(id);
    toast(`Lote #${id} reencolado`, 'ok');
    tick();
  } catch (e) {
    toast(e.message, 'error');
    if (boton) boton.disabled = false;
  }
}

function alternarLote(id) {
  if (state.abiertos.has(id)) state.abiertos.delete(id);
  else state.abiertos.add(id);
  render();
}

function activarTab(nombre) {
  state.tab = nombre;
  sessionStorage.setItem('tab', nombre);
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('activa', b.dataset.tab === nombre));
  document.querySelectorAll('.vista').forEach((v) => { v.hidden = v.dataset.vista !== nombre; });
}

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => activarTab(b.dataset.tab)));

$('#f-estado').addEventListener('change', (e) => { state.filtro.estado = e.target.value; render(); });
$('#f-texto').addEventListener('input', (e) => { state.filtro.q = e.target.value; render(); });

$('#form-url').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = $('#input-url');
  const btn = ev.submitter;
  if (btn) btn.disabled = true;
  try {
    const r = await api.encolar(input.value.trim());
    input.value = '';
    toast(`Lote #${r.id} encolado`, 'ok');
    tick();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
});

$('#btn-llave').addEventListener('click', () => pedirLlave('Actualiza la llave maestra.'));
$('#llave-cancelar').addEventListener('click', () => $('#dlg-llave').close());
$('#form-llave').addEventListener('submit', (ev) => {
  ev.preventDefault();
  setLlave($('#input-llave').value);
  $('#dlg-llave').close();
  state.pausado = false;
  tick();
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

activarTab(state.tab);
tick();
setInterval(tick, POLL_MS);
