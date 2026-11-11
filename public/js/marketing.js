import { api, descargarBlob } from './api.js';
import { el, toast, hace } from './ui.js';

// Estado propio del módulo: sobrevive a los re-renders del polling.
const store = { cache: new Map(), abiertos: new Set(), cargando: new Set(), ocupado: new Set() };
let rerender = () => {};
export const setRerender = (fn) => { rerender = fn; };

const datos = (clip) => store.cache.get(clip.id) || (clip.copy_marketing
  ? { copy: clip.copy_marketing, distribucion: { estado: clip.distribucion_estado, at: clip.distribucion_at, error: clip.distribucion_error } }
  : null);

async function copiar(texto, etiqueta) {
  try {
    await navigator.clipboard.writeText(texto);
  } catch (_) {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = texto;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) { toast('No se pudo copiar', 'error'); return; }
  }
  toast(`${etiqueta} copiado`, 'ok');
}

async function cargar(id) {
  if (store.cargando.has(id)) return;
  store.cargando.add(id);
  try { store.cache.set(id, await api.copy(id)); }
  catch (e) { store.abiertos.delete(id); toast(e.message, 'error'); }
  finally { store.cargando.delete(id); rerender(); }
}

function alternar(clip) {
  if (store.abiertos.has(clip.id)) store.abiertos.delete(clip.id);
  else { store.abiertos.add(clip.id); if (!datos(clip)) cargar(clip.id); }
  rerender();
}

async function accion(id, fn) {
  if (store.ocupado.has(id)) return;
  store.ocupado.add(id);
  rerender();
  try { await fn(); }
  catch (e) { toast(e.message, 'error'); }
  finally { store.ocupado.delete(id); rerender(); }
}

const regenerar = (id) => accion(id, async () => {
  store.cache.set(id, await api.regenerarCopy(id));
  toast('Nueva variante generada', 'ok');
});

const distribuir = (id) => accion(id, async () => {
  try {
    const r = await api.distribuir(id);
    store.cache.set(id, { ...(store.cache.get(id) || {}), distribucion: r.distribucion });
    toast(`Clip #${id} enviado a distribución`, 'ok');
  } catch (e) {
    const prev = store.cache.get(id) || {};
    store.cache.set(id, { ...prev, distribucion: { estado: 'error', error: e.message } });
    throw e;
  }
});

const btnCopiar = (etiqueta, texto) => el('button', {
  class: 'btn small ghost', type: 'button', text: `📋 ${etiqueta}`, onclick: () => copiar(texto, etiqueta),
});

const bloque = (titulo, texto) => el('div', { class: 'mk-bloque' },
  el('div', { class: 'mk-cab' }, el('strong', { text: titulo }), btnCopiar('Copiar', texto)),
  el('p', { class: 'mk-texto', text: texto }));

function estadoDist(d) {
  if (!d || !d.estado) return null;
  if (d.estado === 'enviado') return el('span', { class: 'chip mk-ok', text: `✔ Enviado ${hace(d.at)}` });
  if (d.estado === 'enviando') return el('span', { class: 'chip', text: '⏳ Enviando…' });
  return el('span', { class: 'warn-text', text: `⚠ ${d.error || 'Error de distribución'}` });
}

export function panelMarketing(clip) {
  const abierto = store.abiertos.has(clip.id);
  const d = datos(clip);
  const ocupado = store.ocupado.has(clip.id);
  const nodo = el('div', { class: 'mk' },
    el('div', { class: 'acciones' },
      el('button', {
        class: 'btn small ghost', type: 'button',
        text: abierto ? '▾ Ocultar copy' : '▸ Copy de marketing', onclick: () => alternar(clip),
      }),
      d && estadoDist(d.distribucion)));
  if (!abierto) return nodo;
  if (!d) { nodo.append(el('p', { class: 'muted meta', text: 'Generando copy…' })); return nodo; }

  const c = d.copy;
  const p = c.plataformas || {};
  const hashtags = (c.hashtags || []).join(' ');
  const todo = [c.gancho, c.descripcion, c.cta, hashtags].join('\n\n');
  const enviando = d.distribucion && d.distribucion.estado === 'enviando';

  nodo.append(
    bloque('🎯 Gancho', c.gancho),
    bloque('📝 Descripción', c.descripcion),
    bloque('#️⃣ Hashtags', hashtags),
    bloque('📣 CTA', c.cta),
    el('div', { class: 'acciones' },
      el('span', { class: 'muted meta', text: 'Listo para:' }),
      p.tiktok && btnCopiar('TikTok', p.tiktok.texto),
      p.reels && btnCopiar('Reels', p.reels.texto),
      p.shorts && btnCopiar('Shorts', `${p.shorts.titulo}\n\n${p.shorts.descripcion}`),
      btnCopiar('Todo', todo)),
    el('div', { class: 'acciones' },
      el('button', { class: 'btn small ghost', type: 'button', text: '🔄 Otra variante', disabled: ocupado, onclick: () => regenerar(clip.id) }),
      el('button', {
        class: 'btn small primary', type: 'button', disabled: ocupado || enviando,
        text: ocupado ? 'Procesando…' : (d.distribucion && d.distribucion.estado === 'enviado' ? '📤 Reenviar' : '📤 Distribuir'),
        onclick: () => distribuir(clip.id),
      }))
  );
  return nodo;
}

/** Descarga segura: la llave viaja en cabecera, nunca en la URL. */
export function botonDescarga(clip) {
  return el('button', {
    class: 'btn small primary', type: 'button', text: '⬇ Descargar',
    onclick: async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true;
      try {
        const { blob, nombre } = await descargarBlob(clip.id);
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: nombre });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e) { toast(e.message, 'error'); }
      finally { b.disabled = false; }
    },
  });
}
