import { api } from './api.js';
import { el, badge, chips, fmtTiempo, hace, num, pct } from './ui.js';

const vacio = (msg) => el('div', { class: 'vacio', text: msg });
const dur = (c) => Math.max(0, Number(c.marca_fin) - Number(c.marca_tiempo));

function barraProgreso(listas, total) {
  if (!total) return el('div', { class: 'bar' }, el('span'));
  const p = Math.round((listas / total) * 100);
  return el('div', { class: 'progreso' },
    el('div', { class: 'bar anim' }, el('span', { style: `width:${Math.max(8, p)}%` })),
    el('span', { class: 'muted meta', text: `${listas}/${total} variantes · ${p}%` }));
}

function tarjetaClip(c, lotePorId) {
  const lote = lotePorId.get(c.trabajo_id);
  return el('article', { class: `card clip ${c.estado}` },
    el('div', { class: 'card-head' }, badge(c.estado), el('span', { class: 'muted meta', text: `Clip #${c.id} · ${hace(c.created_at)}` })),
    el('h3', { class: 'card-title', text: c.titulo }),
    el('div', { class: 'muted meta', text:
      `⏱ ${fmtTiempo(c.marca_tiempo)} – ${fmtTiempo(c.marca_fin)} (${fmtTiempo(dur(c))}) · Lote #${c.trabajo_id}` +
      (lote && lote.video_titulo ? ` · ${lote.video_titulo}` : '') }),
    c.resumen && el('p', { class: 'resumen', text: c.resumen }),
    c.error && el('p', { class: 'error-text', text: c.error }),
    c.estado === 'procesando' && el('div', { class: 'bar' }, el('span')),
    c.estado === 'completado' && el('div', { class: 'acciones' },
      el('a', { class: 'btn small primary', href: api.urlDescarga(c.id), text: '⬇ Descargar' }))
  );
}

function filaTrabajo(t, ctx) {
  const vs = ctx.variantesPorLote.get(t.id) || [];
  const listas = vs.filter((v) => v.estado === 'completado').length;
  return el('article', { class: `card ${t.estado}` },
    el('div', { class: 'card-head' }, badge(t.estado), el('span', { class: 'muted meta', text: `Lote #${t.id} · ${hace(t.updated_at)}` })),
    el('h3', { class: 'card-title', text: t.video_titulo || t.url }),
    t.estado === 'procesando' && barraProgreso(listas, vs.length),
    t.estado === 'pendiente' && el('div', { class: 'muted meta', text: 'En cola, esperando turno…' }),
    t.error && el('p', { class: t.estado === 'error' ? 'error-text' : 'warn-text', text: t.error }),
    t.estado === 'error' && el('div', { class: 'acciones' },
      el('button', { class: 'btn small primary', type: 'button', text: '↻ Reintentar', onclick: (ev) => ctx.onReintentar(t.id, ev.currentTarget) }))
  );
}

/* ---------- RESUMEN ---------- */
export function renderResumen(roots, data, ctx) {
  const c = data.conteo || {};
  const kpis = [
    ['pendiente', c.pendiente || 0, 'Pendientes'],
    ['procesando', c.procesando || 0, 'Procesando'],
    ['completado', c.completado || 0, 'Completados'],
    ['error', c.error || 0, 'Errores'],
    ['pro', data.clips.filter((x) => x.estado === 'completado').length, 'Clips listos'],
  ];
  roots.kpis.innerHTML = '';
  kpis.forEach(([k, v, label]) => roots.kpis.append(
    el('div', { class: `kpi ${k}` }, el('b', { text: num(v) }), el('span', { text: label }))
  ));

  roots.activos.innerHTML = '';
  const activosT = data.trabajos.filter((t) => t.estado === 'procesando' || t.estado === 'pendiente');
  const activosC = data.clips.filter((x) => x.estado === 'procesando');
  activosT.forEach((t) => roots.activos.append(filaTrabajo(t, ctx)));
  activosC.forEach((x) => roots.activos.append(tarjetaClip(x, ctx.lotePorId)));
  if (!activosT.length && !activosC.length) roots.activos.append(vacio('No hay slots activos en este momento.'));

  roots.listos.innerHTML = '';
  const listos = data.clips.filter((x) => x.estado === 'completado').slice(0, 4);
  listos.forEach((x) => roots.listos.append(tarjetaClip(x, ctx.lotePorId)));
  if (!listos.length) roots.listos.append(vacio('Aún no hay clips exportados.'));

  roots.recientes.innerHTML = '';
  data.trabajos.slice(0, 6).forEach((t) => roots.recientes.append(filaTrabajo(t, ctx)));
  if (!data.trabajos.length) roots.recientes.append(vacio('Sin trabajos. Encola un enlace para empezar.'));
}

/* ---------- CLIPS ---------- */
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

/* ---------- LOTES / VARIANTES ---------- */
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
        ? el('div', { class: 'bar fijo' }, el('span', { style: `width:${Math.round((listas / variantes.length) * 100)}%` }))
        : null,
      el('div', { class: 'muted meta', text: variantes.length ? `${listas}/${variantes.length} variantes listas` : 'Sin variantes aún' }),
      t.error && el('p', { class: t.estado === 'error' ? 'error-text' : 'warn-text', text: t.error }),
      el('div', { class: 'acciones' },
        variantes.length ? el('button', {
          class: 'btn small ghost', type: 'button',
          text: abierto ? '▾ Ocultar variantes' : '▸ Ver variantes',
          onclick: () => ctx.onToggleLote(t.id),
        }) : null,
        t.estado === 'error' ? el('button', {
          class: 'btn small primary', type: 'button', text: '↻ Reintentar',
          onclick: (ev) => ctx.onReintentar(t.id, ev.currentTarget),
        }) : null
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

/* ---------- INCIDENCIAS ---------- */
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
        el('div', { class: 'card-head' }, badge(i.tipo), el('span', { class: 'muted meta', text: `Lote #${t.id} · ${hace(t.updated_at)}` })),
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

/* ---------- MARKETING Y ANALITICAS ---------- */
const claveDia = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function aplanar(obj, pref = '', out = [], prof = 0) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (out.length >= 16) break;
    const etiqueta = `${pref}${k}`.replace(/[_.]+/g, ' ').trim();
    if (typeof v === 'number' && Number.isFinite(v)) out.push([etiqueta, Number.isInteger(v) ? num(v) : v.toFixed(2)]);
    else if (typeof v === 'boolean') out.push([etiqueta, v ? 'sí' : 'no']);
    else if (typeof v === 'string' && v && v.length <= 24) out.push([etiqueta, v]);
    else if (Array.isArray(v)) out.push([etiqueta, `${v.length} elementos`]);
    else if (v && typeof v === 'object' && prof < 1) aplanar(v, `${k}.`, out, prof + 1);
  }
  return out;
}

function renderPublicacion(root, notaEl, inst) {
  root.innerHTML = '';
  if (inst.estado === 'cargando') { notaEl.textContent = 'Cargando métricas de publicación…'; return; }
  if (inst.estado === 'error') {
    notaEl.textContent = `Métricas de publicación no disponibles (${inst.msg}). Las analíticas de arriba se calculan con los datos de lotes y clips.`;
    return;
  }
  const filas = aplanar(inst.data);
  filas.forEach(([e, v]) => root.append(el('div', { class: 'kpi pro' }, el('b', { text: v }), el('span', { text: e }))));
  notaEl.textContent = filas.length
    ? 'Valores leídos en vivo del endpoint /api/panel/instantanea del motor de automatización.'
    : 'El endpoint respondió sin métricas numéricas todavía.';
}

export function renderMarketing(roots, data, inst) {
  const lotes = data.trabajos;
  const clips = data.clips;
  const c = data.conteo || {};
  const listos = clips.filter((x) => x.estado === 'completado');
  const cerradosClips = listos.length + clips.filter((x) => x.estado === 'error').length;
  const cerradosLotes = (c.completado || 0) + (c.error || 0);
  const durMedia = listos.length ? listos.reduce((s, x) => s + dur(x), 0) / listos.length : 0;
  const totalLotes = Object.values(c).reduce((s, n) => s + Number(n || 0), 0);

  roots.kpis.innerHTML = '';
  [
    ['completado', pct(c.completado || 0, cerradosLotes), 'Éxito de lotes'],
    ['completado', pct(listos.length, cerradosClips), 'Éxito de clips'],
    ['pro', num(listos.length), 'Clips exportados'],
    ['pro', fmtTiempo(durMedia), 'Duración media'],
    ['pro', lotes.length && clips.length ? (clips.length / lotes.length).toFixed(1) : '—', 'Variantes por lote'],
    ['pro', num(totalLotes), 'Lotes totales'],
  ].forEach(([k, v, l]) => roots.kpis.append(el('div', { class: `kpi ${k}` }, el('b', { text: v }), el('span', { text: l }))));

  // Producción 7 días
  const dias = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    dias.push({ d, k: claveDia(d), total: 0, ok: 0, err: 0 });
  }
  clips.forEach((cl) => {
    const dia = dias.find((x) => x.k === claveDia(new Date(cl.created_at)));
    if (!dia) return;
    dia.total++;
    if (cl.estado === 'completado') dia.ok++;
    if (cl.estado === 'error') dia.err++;
  });
  const max = Math.max(1, ...dias.map((x) => x.total));
  const h = (n) => `height:${(n / max) * 100}%`;
  roots.actividad.innerHTML = '';
  roots.actividad.append(
    el('div', { class: 'cols' }, dias.map((x) =>
      el('div', { class: 'col' },
        el('span', { class: 'n', text: x.total || '' }),
        el('div', { class: 'pila' },
          el('i', { class: 'ok', style: h(x.ok) }),
          el('i', { class: 'er', style: h(x.err) }),
          el('i', { class: 'ot', style: h(x.total - x.ok - x.err) })),
        el('span', { class: 'd', text: x.d.toLocaleDateString('es-DO', { weekday: 'short', day: 'numeric' }) })
      ))),
    el('div', { class: 'leyenda' },
      el('span', {}, el('b', { style: 'background:var(--ok)' }), 'Listos'),
      el('span', {}, el('b', { style: 'background:var(--er)' }), 'Con error'),
      el('span', {}, el('b', { style: 'background:var(--pe)' }), 'En curso o en cola'),
      el('span', { text: `Basado en los últimos ${clips.length} clips registrados` }))
  );

  // Palabras clave
  const freq = new Map();
  lotes.forEach((t) => (Array.isArray(t.palabras_clave) ? t.palabras_clave : []).forEach((p) => freq.set(p, (freq.get(p) || 0) + 1)));
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  roots.claves.innerHTML = '';
  const maxF = top.length ? top[0][1] : 1;
  top.forEach(([p, n]) => roots.claves.append(
    el('div', { class: 'fila-barra' },
      el('span', { class: 'e', text: p }),
      el('div', { class: 'b' }, el('span', { style: `width:${(n / maxF) * 100}%` })),
      el('span', { class: 'v', text: n }))
  ));
  if (!top.length) roots.claves.append(vacio('Aún no hay palabras clave extraídas.'));

  // Rendimiento por lote
  roots.lotes.innerHTML = '';
  lotes.slice(0, 8).forEach((t) => {
    const vs = clips.filter((x) => x.trabajo_id === t.id);
    const ok = vs.filter((x) => x.estado === 'completado');
    roots.lotes.append(el('div', { class: 'fila-lote' },
      el('div', { class: 'card-head' }, badge(t.estado), el('span', { class: 'muted meta', text: `Lote #${t.id}` })),
      el('span', { class: 't', text: t.video_titulo || t.url }),
      el('span', { class: 'muted meta', text:
        `${ok.length}/${vs.length} variantes · éxito ${pct(ok.length, vs.length)} · ${fmtTiempo(ok.reduce((s, x) => s + dur(x), 0))} de contenido listo` })
    ));
  });
  if (!lotes.length) roots.lotes.append(vacio('Sin lotes para analizar.'));

  renderPublicacion(roots.publicacion, roots.nota, inst);
}
