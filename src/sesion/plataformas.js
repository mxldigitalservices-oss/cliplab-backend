// Definicion de las redes sociales (Facebook, Instagram, TikTok) para el login manual y la validacion de la sesion.
// Modulo puro: sin dependencias de config ni de disco, para poder usarlo tambien desde scripts/login-local.js.

export const PLATAFORMAS_RED = {
  facebook: {
    nombre: 'Facebook',
    urlLogin: 'https://www.facebook.com/login',
    dominio: /(^|\.)(facebook\.com|fbcdn\.net|messenger\.com)$/i,
    // La sesion esta iniciada cuando existen TODAS estas cookies (c_user = id de la cuenta, xs = token).
    autenticacion: [['c_user', 'xs']],
    cuenta: 'c_user',
  },
  instagram: {
    nombre: 'Instagram',
    urlLogin: 'https://www.instagram.com/accounts/login/',
    dominio: /(^|\.)(instagram\.com|cdninstagram\.com)$/i,
    autenticacion: [['sessionid']],
    cuenta: 'ds_user_id',
  },
  tiktok: {
    nombre: 'TikTok',
    urlLogin: 'https://www.tiktok.com/login',
    dominio: /(^|\.)(tiktok\.com|tiktokv\.com|tiktokcdn\.com)$/i,
    autenticacion: [['sessionid'], ['sessionid_ss'], ['sid_tt']],
    cuenta: null,
  },
};

export const esPlataformaRed = (nombre) => Object.prototype.hasOwnProperty.call(PLATAFORMAS_RED, nombre);

const hostDe = (dominio) => String(dominio || '').replace(/^\./, '');

function vigente(cookie, ahora) {
  // expires -1 / 0 / undefined = cookie de sesion (vive mientras dure el navegador): se considera vigente.
  const expira = Number(cookie.expires);
  return !(Number.isFinite(expira) && expira > 0 && expira < ahora);
}

/**
 * Valida y depura un storageState de Playwright para una plataforma.
 * Conserva solo cookies/origins del dominio de la red (no se guarda nada ajeno) y exige las cookies de sesion.
 * @returns {{ok:true, estado:object, cuenta:string|null, expira:number|null}|{ok:false, error:string}}
 */
export function validarEstado(plataforma, estadoCrudo, ahora = Math.floor(Date.now() / 1000)) {
  const def = PLATAFORMAS_RED[plataforma];
  if (!def) return { ok: false, error: 'Plataforma no soportada' };
  if (!estadoCrudo || typeof estadoCrudo !== 'object' || !Array.isArray(estadoCrudo.cookies)) {
    return { ok: false, error: 'El estado de sesion no tiene cookies' };
  }

  const cookies = estadoCrudo.cookies
    .filter((c) => c && c.name && c.domain && def.dominio.test(hostDe(c.domain)))
    .map((c) => ({
      name: String(c.name),
      value: String(c.value ?? ''),
      domain: String(c.domain),
      path: c.path || '/',
      expires: Number.isFinite(Number(c.expires)) ? Number(c.expires) : -1,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
    }));

  if (cookies.length === 0) {
    return { ok: false, error: 'No hay cookies de ' + def.nombre + ' en la sesion capturada' };
  }

  const vivas = cookies.filter((c) => c.value && vigente(c, ahora));
  const tiene = (grupo) => grupo.every((n) => vivas.some((c) => c.name === n));
  if (!def.autenticacion.some(tiene)) {
    const falta = def.autenticacion.map((g) => g.join(' + ')).join(' o ');
    return { ok: false, error: 'La sesion de ' + def.nombre + ' no esta iniciada (faltan cookies de acceso: ' + falta + ')' };
  }

  const origins = (Array.isArray(estadoCrudo.origins) ? estadoCrudo.origins : [])
    .filter((o) => o && o.origin && def.dominio.test(new URL(o.origin).hostname));

  const cuentaCookie = def.cuenta ? vivas.find((c) => c.name === def.cuenta) : null;
  const caducables = vivas.filter((c) => c.expires > 0 && def.autenticacion.flat().includes(c.name));
  return {
    ok: true,
    estado: { cookies, origins },
    cuenta: cuentaCookie ? 'ID ' + cuentaCookie.value : null,
    expira: caducables.length ? Math.min(...caducables.map((c) => c.expires)) : null,
  };
}

/**
 * Espera a que la persona inicie sesion a mano en la ventana y devuelve el storageState.
 * Sondea las cookies del contexto; en cuanto aparecen las de acceso espera un instante para que terminen
 * de escribirse las demas (redirecciones) y devuelve el estado.
 */
export async function esperarLogin(contexto, plataforma, { timeoutMs = 5 * 60 * 1000, intervaloMs = 1500, asentarMs = 2500, ahora = Date.now } = {}) {
  const limite = ahora() + timeoutMs;
  for (;;) {
    let cookies;
    try {
      cookies = await contexto.cookies();
    } catch {
      throw new Error('Se cerro la ventana del navegador antes de terminar de iniciar sesion');
    }
    if (validarEstado(plataforma, { cookies }).ok) {
      await new Promise((r) => setTimeout(r, asentarMs));
      return contexto.storageState();
    }
    if (ahora() >= limite) {
      throw new Error('Se agoto el tiempo (' + Math.round(timeoutMs / 60000) + ' min) esperando el inicio de sesion');
    }
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
}
