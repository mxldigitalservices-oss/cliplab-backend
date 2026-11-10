export function el(tag, props = {}, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const h of hijos.flat()) {
    if (h == null || h === false) continue;
    n.append(h.nodeType ? h : document.createTextNode(String(h)));
  }
  return n;
}

export function fmtTiempo(seg) {
  const s = Math.max(0, Math.floor(Number(seg) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function hace(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 5) return 'ahora';
  if (s < 60) return `hace ${s}s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}

export const num = (n) => new Intl.NumberFormat('es-DO').format(Number(n) || 0);
export const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

export const badge = (estado) => el('span', { class: `badge ${estado}`, text: estado });

export function chips(lista) {
  const items = Array.isArray(lista) ? lista.slice(0, 10) : [];
  if (!items.length) return null;
  return el('div', { class: 'chips' }, (items ?? []).map((p) => el('span', { class: 'chip', text: p })));
}

export function toast(mensaje, tipo = 'info') {
  const cont = document.getElementById('toasts');
  while (cont.children.length >= 3) cont.firstChild.remove();
  const t = el('div', { class: `toast ${tipo}`, text: mensaje });
  cont.append(t);
  setTimeout(() => t.remove(), 3800);
}
