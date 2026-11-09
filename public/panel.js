(() => {
  const POLL_MS = 4000;
  const TIMEOUT_MS = 8000;
  const $cola = document.getElementById('cola');
  const $clips = document.getElementById('clips');
  const $conteo = document.getElementById('conteo');
  const $banner = document.getElementById('banner');

  let clave = sessionStorage.getItem('mk') || '';
  let enVuelo = false;
  let pidiendoClave = false;

  const fmt = (s) => {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  async function api(ruta, opts = {}) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(ruta, {
        ...opts,
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-master-key': clave, ...(opts.headers || {}) },
      });
      if (r.status === 401) {
        if (!pidiendoClave) {
          pidiendoClave = true;
          const k = window.prompt('Llave maestra:');
          pidiendoClave = false;
          if (k) { clave = k; sessionStorage.setItem('mk', k); }
        }
        throw new Error('No autorizado');
      }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      return data;
    } finally {
      clearTimeout(to);
    }
  }

  function slotTrabajo(t) {
    const d = el('div', 'slot');
    const titulo = el('div', 't');
    titulo.appendChild(el('span', `badge ${t.estado}`, t.estado));
    titulo.appendChild(document.createTextNode(t.video_titulo || t.url));
    d.appendChild(titulo);
    d.appendChild(el('div', 'm', `#${t.id} · intentos: ${t.intentos}`));
    const kws = Array.isArray(t.palabras_clave) ? t.palabras_clave.slice(0, 6).join(', ') : '';
    if (kws) d.appendChild(el('div', 'm', `Claves: ${kws}`));
    if (t.error) d.appendChild(el('div', 'err', t.error));
    if (t.estado === 'error') {
      const b = el('button', 'sec', 'Reintentar');
      b.onclick = async () => {
        try { await api(`/api/trabajos/${t.id}/reintentar`, { method: 'POST' }); tick(); }
        catch (e) { mostrarError(e.message); }
      };
      d.appendChild(b);
    }
    return d;
  }

  function slotClip(c) {
    const d = el('div', 'slot');
    const titulo = el('div', 't');
    titulo.appendChild(el('span', `badge ${c.estado}`, c.estado));
    titulo.appendChild(document.createTextNode(c.titulo));
    d.appendChild(titulo);
    d.appendChild(el('div', 'm', `Trabajo #${c.trabajo_id} · ${fmt(c.marca_tiempo)} – ${fmt(c.marca_fin)}`));
    if (c.resumen) d.appendChild(el('div', 'm', c.resumen));
    if (c.error) d.appendChild(el('div', 'err', c.error));
    if (c.estado === 'completado') {
      const a = el('a', null, 'Descargar');
      a.href = `/api/clips/${c.id}/descargar?key=${encodeURIComponent(clave)}`;
      d.appendChild(a);
    }
    return d;
  }

  function pintar(data) {
    $cola.innerHTML = '';
    $clips.innerHTML = '';
    const c = data.conteo || {};
    $conteo.textContent =
      `Pendientes: ${c.pendiente || 0} · Procesando: ${c.procesando || 0} · ` +
      `Completados: ${c.completado || 0} · Errores: ${c.error || 0}`;
    (data.trabajos || []).forEach((t) => $cola.appendChild(slotTrabajo(t)));
    (data.clips || []).forEach((k) => $clips.appendChild(slotClip(k)));
    if (!data.trabajos.length) $cola.appendChild(el('div', 'm', 'Sin trabajos.'));
    if (!data.clips.length) $clips.appendChild(el('div', 'm', 'Sin cortes.'));
  }

  function mostrarError(m) {
    $banner.style.display = 'block';
    $banner.textContent = `Sin sincronizar: ${m}`;
  }

  async function tick() {
    if (enVuelo) return;
    enVuelo = true;
    try {
      const data = await api('/api/estado');
      $banner.style.display = 'none';
      pintar(data);
    } catch (e) {
      mostrarError(e.name === 'AbortError' ? 'tiempo de espera agotado' : e.message);
    } finally {
      enVuelo = false;
    }
  }

  document.getElementById('form-url').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = document.getElementById('url');
    try {
      await api('/api/trabajos', { method: 'POST', body: JSON.stringify({ url: input.value.trim() }) });
      input.value = '';
      tick();
    } catch (e) {
      mostrarError(e.message);
    }
  });

  tick();
  setInterval(tick, POLL_MS);
})();
