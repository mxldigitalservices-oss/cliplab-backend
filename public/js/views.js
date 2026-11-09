import { api } from './api.js';
import { el, badge, chips, fmtTiempo, hace } from './ui.js';

const vacio = (msg) => el('div', { class: 'vacio', text: msg });

function tarjetaClip(c, lotePorId) {
  const lote = lotePorId.get(c.trabajo_id);
  return el('article', { class: `card clip ${c.estado}` },
    el('div', { class: 'card-head' }, badge(c.estado), el('span', { class: 'muted meta', text: `Clip #${c.id} · ${hace(c.created_at)}` })),
    el('h3', { class: 'card-title', text: c.titulo }),
    el('div', { class: 'muted meta', text:
      `⏱ ${fmtTiempo(c.marca_tiempo)} – ${fmtTiempo(c.marca_fin)} (${fmtTiempo(c.marca_fin - c.marca_tiempo)}) · Lote #${c.trabajo_id}` +
      (lote && lote.video_titulo ? ` · ${lote.video_titulo}` : '') }),
    c.resumen && el('p', { class: 'resumen', text: c.resumen }),
    c.error && el('p', { class: 'error-text', text: c.error }),
    c.estado === 'procesando' && el('div', { class: 'bar' }, el('span')),
    c.estado === 'completado' && el('div', { class: 'acciones' },
      el('a', { class: 'btn small primary', href: api.urlDescarga(c.id), text: '⬇ Descargar' }))
  );
}

function filaTrabajo(t, ctx, { compacta = false } = {}) {
  return el('article', { class: `card ${t.estado}` },
    el('div', { class: 'card-head' }, badge(t.estado), el('span', { class: 'muted meta', text: `Lote #${t.id} · ${hace(t.updated_at)}` })),
    el('h3', { class: 'card-title', text: t.video_titulo || t.url }),
    !compacta && el('div', { class: 'muted meta' }, el('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer', text: t.url })),
    t.estado === 'procesando' && el('div', { class: 'bar' }, el('span')),
    t.error && el('p', { class: t.estado === 'error' ? 'error-text' : 'warn-text', text: t.error }),
    t.estado === 'error' && botonReintentar(t.id, ctx)
  );
}

function botonReintentar(id, ctx) {
  return el('div', { class: 'acciones' },
    el('button', {
      class: 'btn small primary', type: 'button', text: '↻ Reintentar',
      onclick: (ev) => ctx.onReintentar(id, ev.currentTarget),
    }));
}

export function renderResumen(roots, data, ctx) {
  const c = data.conteo || {};
  const kpis = [
    ['pendiente', 'Pendientes'], ['procesando', 'Procesando'], ['completado', 'Completados'], ['error', 'Errores'],
  ];
  roots.kpis.innerHTML = '';
  kpis.forEach(([k, label]) => roots.kpis.append(
    el('div', { class: `kpi ${k}` }, el('b', { text: c[k] || 0 }), el('span', { text: label }))
  ));
  roots.kpis.append(el('div', { class: 'kpi completado' },
    el('b', { text: data.clips.filter((x) => x.estado === 'completado').length }), el('span', { text: 'Clips listos' })));

  roots.activos.innerHTML = '';
  const activosT = data.trabajos.filter((t) => t.estado === 'procesando' || t.estado === 'pendiente');
  const activosC = data.clips.filter((x) => x.estado === 'procesando');
  activosT.forEach((t) => roots.activos.append(filaTrabajo(t, ctx, { compacta: true })));
  activosC.forEach((x) => roots.activos.append(tarjetaClip(x, ctx.lotePorId)));
  if (!activosT.length && !activosC.length) roots.activos.append(vacio('No hay slots activos en este momento.'));

  roots.listos.innerHTML = '';
  const listos = data.clips.filter((x) => x.estado === 'completado').slice(0, 4);
  listos.forEach((x) => roots.listos.append(tarjetaClip(x, ctx.lotePorId)));
  if (!listos.length) roots.listos.append(vacio('Aún no hay clips exportados.'));

  roots.recientes.innerHTML = '';
  data.trabajos.slice(0, 6).forEach((t) => roots.recientes.append(filaTrabajo(t, ctx, { compacta: true })));
  if (!data.trabajos.length) roots.recientes.append(vacio('Sin trabajos. Encola un enlace para empezar.'));
}

export function renderClips(root, totalEl, data, ctx, filtro) {
  const q = filtro.q.trim().toLowerCase();
  const lista = data.clips.filter((c) =>
    (filtro.estado === 'todos' || c.estado === filtro.estado) &&
    (!q || `${c.titulo} ${c.resumen || ''}`.toLowerCase().includes(q))
  );
  root.innerHTML = '';
  lista.forEach((c) => root.append(tarjetaClip(c, ctx.lotePorId)));
  if (!lista.length) root.append(vacio('No hay clips que coincidan con el filtro.'));
  totalEl.textContent = `${lista.length} de ${data.clips.length}`;
}

export function renderLotes(root, data, ctx) {
  root.innerHTML = '';
  data.trabajos.forEach((t) => {
    const variantes = ctx.variantesPorLote.get(t.id) || [];
    const listas = variantes.filter((v) => v.estado === 'completado').length;
    const abierto = ctx.abiertos.has(t.id);

    const card = el('article', { class: `card ${t.estado}` },
      el('div', { class: 'card-head' }, badge(t.estado), el('span', { class: 'muted meta', text: `Lote #${t.id} · intentos ${t.intentos} · ${hace(t.updated_at)}` })),
      el('h3', { class: 'card-title', text: t.video_titulo || t.url }),
      el('div', { class: 'muted meta' }, el('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer', text: t.url })),
      chips(t.palabras_clave),
      t.resumen && el('p', { class: 'resumen', text: t.resumen }),
      variantes.length
        ? el('div', { class: `bar fijo` }, el('span', { style: `width:${Math.round((listas / variantes.length) * 100)}%` }))
        : null,
      el('div', { class: 'muted meta', text: variantes.length ? `${listas}/${variantes.length} variantes listas` : 'Sin variantes aún' }),
      t.error && el('p', { class: t.estado === 'error' ? 'error-text' : 'warn-text', text: t.error }),
      el('div', { class: 'acciones' },
        variantes.length && el('button', {
          class: 'btn small ghost', type: 'button',
          text: abierto ? '▾ Ocultar variantes' : '▸ Ver variantes',
          onclick: () => ctx.onToggleLote(t.id),
        }),
        t.estado === 'error' && el('button', {
          class: 'btn small primary', type: 'button', text: '↻ Reintentar',
          onclick: (ev) => ctx.onReintentar(t.id, ev.currentTarget),
        })
      )
    );

    if (abierto && variantes.length) {
      card.append(el('div', { class: 'variantes' }, variantes.map((v) =>
        el('div', { class: 'variante' },
          el('div', { class: 'card-head' }, badge(v.estado), el('span', { class: 'muted meta', text: `${fmtTiempo(v.marca_tiempo)} – ${fmtTiempo(v.marca_fin)}` })),
          el('strong', { text: v.titulo }),
          v.resumen && el('p', { class: 'resumen', text: v.resumen }),
          v.error && el('p', { class: 'error-text', text: v.error }),
          v.estado === 'completado' && el('div', { class: 'acciones' },
            el('a', { class: 'btn small primary', href: api.urlDescarga(v.id), text: '⬇ Descargar' }))
        )
      )));
    }
    root.append(card);
  });
  if (!data.trabajos.length) root.append(vacio('Sin lotes todavía.'));
}

export function incidenciasDe(data) {
  const lotePorId = new Map(data.trabajos.map((t) => [t.id, t]));
  const items = [];
  data.trabajos.forEach((t) => {
    if (t.estado === 'error') items.push({ tipo: 'error', fecha: t.updated_at, trabajo: t });
    else if (t.error) items.push({ tipo: 'advertencia', fecha: t.updated_at, trabajo: t });
  });
  data.clips.forEach((c) => {
    if (c.estado !== 'error') return;
    const padre = lotePorId.get(c.trabajo_id);
    if (padre && padre.estado === 'error') return;
    items.push({ tipo: 'error', fecha: c.created_at, clip: c });
  });
  return items.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
}

export function renderIncidencias(root, data, ctx) {
  root.innerHTML = '';
  const items = incidenciasDe(data);
  items.forEach((i) => {
    if (i.trabajo) {
      const t = i.trabajo;
      root.append(el('article', { class: `card ${i.tipo === 'error' ? 'error' : ''}` },
        el('div', { class: 'card-head' }, badge(i.tipo === 'error' ? 'error' : 'advertencia'), el('span', { class: 'muted meta', text: `Lote #${t.id} · ${hace(t.updated_at)}` })),
        el('h3', { class: 'card-title', text: t.video_titulo || t.url }),
        el('p', { class: i.tipo === 'error' ? 'error-text' : 'warn-text', text: t.error || 'Sin detalle' }),
        i.tipo === 'error' && el('div', { class: 'acciones' },
          el('button', { class: 'btn small primary', type: 'button', text: '↻ Reintentar', onclick: (ev) => ctx.onReintentar(t.id, ev.currentTarget) }))
      ));
    } else {
      const c = i.clip;
      root.append(el('article', { class: 'card error' },
        el('div', { class: 'card-head' }, badge('error'), el('span', { class: 'muted meta', text: `Clip #${c.id} · Lote #${c.trabajo_id} · ${hace(c.created_at)}` })),
        el('h3', { class: 'card-title', text: c.titulo }),
        el('p', { class: 'error-text', text: c.error || 'Sin detalle' })
      ));
    }
  });
  if (!items.length) root.append(vacio('Sin incidencias. Todo en orden ✔'));
}
