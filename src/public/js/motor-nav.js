(() => {
  const HREF = '/motor.html';
  const EN_MOTOR = location.pathname.endsWith('/motor.html');
  const ACTIVA = /^(active|activa|activo|selected|is-active|on|sel)$/i;

  function volver() {
    if (document.getElementById('motor-volver')) return;
    const a = document.createElement('a');
    a.id = 'motor-volver';
    a.href = '/';
    a.textContent = '← Panel';
    a.style.cssText = 'color:#ffd400;text-decoration:none;font-weight:700;margin-right:12px';
    (document.querySelector('header') || document.body).prepend(a);
  }

  function buscarNav() {
    const sels = ['[role="tablist"]', 'nav', '.tabs', '#tabs', '.tab-bar', '.menu', '#menu', '.nav', '#nav'];
    for (const s of sels) {
      const e = document.querySelector(s);
      if (e && e.children.length >= 2) return e;
    }
    return null;
  }

  function inyectar() {
    if (document.getElementById('motor-link')) return;
    const nav = buscarNav();
    const ref = nav && nav.lastElementChild;
    const esBoton = ref && ref.tagName === 'BUTTON';
    const el = document.createElement(esBoton ? 'button' : 'a');
    el.id = 'motor-link';
    el.textContent = 'Motor local';
    if (esBoton) { el.type = 'button'; el.addEventListener('click', () => { location.href = HREF; }); }
    else el.href = HREF;
    el.addEventListener('click', (e) => e.stopPropagation());

    if (nav) {
      el.className = (ref ? ref.className.split(/\s+/).filter((c) => !ACTIVA.test(c)).join(' ') : '');
      if (!esBoton) el.style.textDecoration = 'none';
      nav.append(el);
    } else {
      el.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;background:#ffd400;color:#000;padding:10px 14px;border-radius:99px;font:700 13px system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.4)';
      document.body.append(el);
    }
  }

  function iniciar() {
    if (EN_MOTOR) { volver(); return; }
    inyectar();
    let pendiente = false;
    new MutationObserver(() => {
      if (pendiente || document.getElementById('motor-link')) return;
      pendiente = true;
      requestAnimationFrame(() => { pendiente = false; inyectar(); });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
