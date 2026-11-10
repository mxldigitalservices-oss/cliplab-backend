import { getLlave } from '/js/api.js';

const API = '/api/motor';
const $ = (s) => document.querySelector(s);
const el = (t, a = {}, ...c) => { const e = document.createElement(t); Object.assign(e, a); e.append(...c); return e; };

async function pedir(ruta, opt = {}) {
  const headers = { 'content-type': 'application/json' };
  const llave = getLlave();
  if (llave) headers['x-master-key'] = llave;
  const r = await fetch(API + ruta, { credentials: 'same-origin', ...opt, headers });
  const tipo = r.headers.get('content-type') || '';
  if (r.status === 401 || r.redirected || !tipo.includes('json')) throw new Error('Sesión no válida: abre el panel e inicia sesión.');
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Error ' + r.status);
  return d;
}

const badge = (nombre, ok) => el('span', { className: 'badge ' + (ok ? 'ok' : 'bad'), textContent: nombre + (ok ? ' ✓' : ' ✗') });

async function salud() {
  try {
    const s = await pedir('/salud');
    const box = $('#salud'); box.textContent = '';
    box.append(badge('ffmpeg', s.ffmpeg), badge('whisper', s.whisper), badge('yt-dlp', s.ytdlp));
  } catch (e) { $('#salud').textContent = e.message; }
}

function pintarTrabajos(lista) {
  const box = $('#trabajos'); box.textContent = '';
  if (!lista.length) { box.textContent = 'Sin trabajos.'; return; }
  for (const j of lista) {
    const est = el('span', {
      className: j.estado === 'error' ? 'bad' : j.estado === 'listo' ? 'ok' : 'mut',
      textContent: j.estado + (j.clips != null ? ` (${j.clips} clips)` : '') + (j.error ? ` — ${j.error}` : ''),
    });
    box.append(el('div', { className: 'fila' }, el('span', { textContent: j.fuente }), est));
  }
}

let firmaBib = '';
function pintarBiblioteca(lista) {
  const firma = JSON.stringify(lista);
  if (firma === firmaBib) return;
  firmaBib = firma;
  const box = $('#biblioteca'); box.textContent = '';
  if (!lista.length) { box.textContent = 'Aún no hay videos.'; return; }
  for (const v of lista) {
    box.append(el('h3', { textContent: v.nombre }));
    const g = el('div', { className: 'grid' });
    for (const c of v.clips) {
      const url = `${API}/archivo/${encodeURIComponent(v.nombre)}/${encodeURIComponent(c.file)}`;
      const vid = el('video', { controls: true, preload: 'none', src: url });
      const texto = `${c.caption}\n${(c.hashtags || []).join(' ')}`;
      const copiar = el('button', { textContent: 'Copiar texto' });
      copiar.addEventListener('click', () => {
        navigator.clipboard.writeText(texto).then(() => {
          copiar.textContent = 'Copiado';
          setTimeout(() => { copiar.textContent = 'Copiar texto'; }, 1500);
        });
      });
      const bajar = el('a', { className: 'btn', href: url, download: c.file, textContent: 'Descargar' });
      g.append(el('div', { className: 'clip' }, vid,
        el('div', { className: 'cap', textContent: `#${c.id} · ${c.duration}s · puntaje ${c.score}` }),
        el('div', { className: 'cap mut', textContent: texto }),
        el('div', { className: 'acciones' }, bajar, copiar)));
    }
    box.append(g);
  }
}

let ocupado = false;
async function refrescar() {
  if (ocupado) return;
  ocupado = true;
  try {
    const [t, b] = await Promise.all([pedir('/trabajos'), pedir('/biblioteca')]);
    pintarTrabajos(t); pintarBiblioteca(b);
  } catch (e) { $('#msg').textContent = e.message; }
  ocupado = false;
}

$('#f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const v = $('#fuente').value.trim();
  const body = /^https?:\/\//i.test(v) ? { url: v } : { archivo: v };
  $('#msg').textContent = 'Enviando...';
  try {
    await pedir('/trabajos', { method: 'POST', body: JSON.stringify(body) });
    $('#msg').textContent = 'En cola.';
    $('#fuente').value = '';
    refrescar();
  } catch (e) { $('#msg').textContent = e.message; }
});

salud(); refrescar();
setInterval(refrescar, 4000);
setInterval(salud, 60000);
