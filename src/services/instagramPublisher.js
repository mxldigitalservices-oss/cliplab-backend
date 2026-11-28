// ---------------------------------------------------------------------------
// Publicacion OFICIAL en Instagram con la Graph API de Meta (v21.0 o superior).
//
//  Variables de entorno (Railway). NUNCA se escriben tokens en el codigo:
//    IG_ACCESS_TOKEN   token de larga duracion (o de usuario del sistema) con instagram_basic + instagram_content_publish
//    IG_USER_ID        id de la cuenta profesional de Instagram (p. ej. @farol_al_dia)
//    META_APP_ID / META_APP_SECRET   permiten firmar con appsecret_proof y consultar la vigencia del token (debug_token)
//    IG_GRAPH_VERSION  (opcional) por defecto v21.0; se rechaza cualquier version menor
//    IG_CROSSPOST_FACEBOOK=on  declara que el envio automatico a Facebook esta activo en Meta Accounts Center
//    IG_PUBLISH_TIMEOUT_MIN (10), IG_POLL_MIN_SEG (3), IG_POLL_MAX_SEG (10)
//    PUBLIC_BASE_URL o RAILWAY_PUBLIC_DOMAIN   para armar la URL publica del clip (Meta DESCARGA el video desde ahi)
//
//  Flujo de un Reel (3 pasos oficiales):
//    1) POST /{IG_USER_ID}/media          media_type=REELS, video_url, caption, share_to_feed=true  -> id de contenedor
//    2) GET  /{container}?fields=status_code,status  hasta FINISHED (IN_PROGRESS = seguir; ERROR/EXPIRED = fallo)
//    3) POST /{IG_USER_ID}/media_publish  creation_id=<contenedor>                                   -> id del Reel
//
//  Todo es inyectable (fetch, env, sleep) para probarlo sin red. Los errores son AppError con `codigo` y `transitorio`.
// ---------------------------------------------------------------------------
import crypto from 'node:crypto';
import path from 'node:path';
import { config as configApp } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { AppError, ocultarSecretos } from '../utils/errores.js';

export const VERSION_MINIMA = 21;
export const MAX_CAPTION = 2200;
const BASE_GRAPH = 'https://graph.facebook.com';

export class ErrorInstagram extends AppError {}

const verdadero = (v) => /^(1|true|si|sí|on|yes)$/i.test(String(v ?? '').trim());
const numero = (v, porDefecto) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : porDefecto;
};
const dormirReal = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Lee y valida la configuracion. Nunca lanza: `faltan` lista lo que no esta definido. */
export function leerConfigInstagram(env = process.env) {
  const version = String(env.IG_GRAPH_VERSION || 'v21.0').trim();
  const m = /^v(\d+)\.(\d+)$/.exec(version);
  const versionValida = Boolean(m) && Number(m[1]) >= VERSION_MINIMA;
  const cfg = {
    token: String(env.IG_ACCESS_TOKEN || '').trim(),
    igUserId: String(env.IG_USER_ID || '').trim(),
    appId: String(env.META_APP_ID || '').trim(),
    appSecret: String(env.META_APP_SECRET || '').trim(),
    version: versionValida ? version : 'v21.0',
    versionSolicitada: version,
    versionValida,
    crosspostFacebook: verdadero(env.IG_CROSSPOST_FACEBOOK),
    timeoutPublicacionMs: numero(env.IG_PUBLISH_TIMEOUT_MIN, 10) * 60 * 1000,
    sondeoMinMs: numero(env.IG_POLL_MIN_SEG, 3) * 1000,
    sondeoMaxMs: numero(env.IG_POLL_MAX_SEG, 10) * 1000,
    timeoutHttpMs: numero(env.IG_HTTP_TIMEOUT_SEG, 30) * 1000,
  };
  cfg.faltan = [['IG_ACCESS_TOKEN', cfg.token], ['IG_USER_ID', cfg.igUserId]].filter(([, v]) => !v).map(([k]) => k);
  return cfg;
}

/** URL base publica del servicio (Meta necesita una URL https alcanzable desde Internet). */
export function baseUrlPublica(env = process.env) {
  const directa = String(env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (directa) return directa;
  const dominio = String(env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (dominio) return 'https://' + dominio.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return '';
}

/** Convierte la ruta local de un clip renderizado en la URL publica /clips/<archivo>.mp4 que Meta puede descargar. */
export function urlPublicaDeClip(rutaVideo, { env = process.env, clipsDir = configApp.clipsDir } = {}) {
  const ruta = String(rutaVideo || '');
  if (/^https:\/\//i.test(ruta)) return ruta;
  if (/^http:\/\//i.test(ruta)) throw new ErrorInstagram('Meta exige una URL https para el video.', { status: 400, codigo: 'URL_NO_HTTPS' });
  const base = baseUrlPublica(env);
  if (!base) {
    throw new ErrorInstagram('Define PUBLIC_BASE_URL (o RAILWAY_PUBLIC_DOMAIN): Meta descarga el video desde una URL publica.', { status: 500, codigo: 'SIN_URL_PUBLICA' });
  }
  const absoluta = path.resolve(ruta);
  const dentro = path.relative(path.resolve(clipsDir), absoluta);
  if (!dentro || dentro.startsWith('..') || path.isAbsolute(dentro)) {
    throw new ErrorInstagram('El video no esta en la carpeta de clips servida publicamente (/clips).', { status: 400, codigo: 'VIDEO_FUERA_DE_CLIPS' });
  }
  return base + '/clips/' + dentro.split(path.sep).map(encodeURIComponent).join('/');
}

/** Descripcion lista para Instagram: espacios normalizados y tope de 2200 caracteres (corte en limite de palabra). */
export function prepararCaption(texto, max = MAX_CAPTION) {
  const limpio = String(texto ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (limpio.length <= max) return limpio;
  const corte = limpio.slice(0, max);
  const ultimoEspacio = corte.search(/\s\S*$/);
  return (ultimoEspacio > max * 0.8 ? corte.slice(0, ultimoEspacio) : corte).trimEnd();
}

/** Clasifica un error de la Graph API: que codigo usar y si merece reintento. */
export function clasificarErrorGraph(httpStatus, err = {}) {
  const code = Number(err.code);
  const sub = Number(err.error_subcode);
  const base = { status: httpStatus >= 400 && httpStatus < 600 ? httpStatus : 502 };
  if (code === 190 || httpStatus === 401) return { ...base, status: 401, codigo: 'TOKEN_INVALIDO', transitorio: false };
  if (code === 10 || (code >= 200 && code <= 299) || httpStatus === 403) return { ...base, status: 403, codigo: 'PERMISOS', transitorio: false };
  if (code === 9 || sub === 2207042) return { ...base, codigo: 'LIMITE_PUBLICACION', transitorio: true };
  if ([4, 17, 32, 613, 80002, 80006].includes(code)) return { ...base, status: 429, codigo: 'LIMITE_API', transitorio: true };
  if (code === 1 || code === 2 || err.is_transient === true || httpStatus >= 500) return { ...base, codigo: 'META_TRANSITORIO', transitorio: true };
  if (code === 100 || (sub >= 2207000 && sub < 2208000)) return { ...base, status: 422, codigo: 'MEDIA_INVALIDA', transitorio: false };
  return { ...base, codigo: 'META_ERROR', transitorio: false };
}

/**
 * Cliente de la Graph API. `deps`: { env, fetch, sleep, reloj }.
 */
export function crearClienteInstagram(deps = {}) {
  const env = deps.env || process.env;
  const llamar = deps.fetch || globalThis.fetch;
  const dormir = deps.sleep || dormirReal;
  const reloj = deps.reloj || (() => Date.now());
  const cfg = () => leerConfigInstagram(env);
  const secretos = (c) => [c.token, c.appSecret, c.appSecret && c.token ? proof(c.token, c.appSecret) : ''];
  const proof = (token, secreto) => crypto.createHmac('sha256', secreto).update(token).digest('hex');

  function exigirConfig(c) {
    if (c.faltan.length) {
      throw new ErrorInstagram('Falta configurar en Railway: ' + c.faltan.join(', '), { status: 500, codigo: 'SIN_CONFIG', detalle: c.faltan.join(',') });
    }
    if (!c.versionValida) {
      throw new ErrorInstagram('IG_GRAPH_VERSION debe ser v' + VERSION_MINIMA + '.0 o superior (recibido: ' + c.versionSolicitada + ').', { status: 500, codigo: 'VERSION_GRAPH' });
    }
  }

  async function graph(ruta, { metodo = 'GET', params = {}, c = cfg(), tokenApp = null } = {}) {
    if (typeof llamar !== 'function') throw new ErrorInstagram('Este entorno no tiene fetch.', { codigo: 'SIN_FETCH' });
    const todos = { ...params };
    if (tokenApp) todos.access_token = tokenApp;
    else {
      todos.access_token = c.token;
      if (c.appSecret) todos.appsecret_proof = proof(c.token, c.appSecret);
    }
    const cuerpo = new URLSearchParams();
    for (const [k, v] of Object.entries(todos)) if (v !== undefined && v !== null && v !== '') cuerpo.set(k, String(v));
    const url = BASE_GRAPH + '/' + c.version + ruta;
    let respuesta;
    try {
      respuesta = metodo === 'GET'
        ? await llamar(url + '?' + cuerpo.toString(), { method: 'GET', signal: AbortSignal.timeout(c.timeoutHttpMs) })
        : await llamar(url, { method: metodo, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: cuerpo.toString(), signal: AbortSignal.timeout(c.timeoutHttpMs) });
    } catch (error) {
      const msg = ocultarSecretos(error && error.message, secretos(c));
      throw new ErrorInstagram('No se pudo contactar con Meta: ' + msg, { status: 502, codigo: 'RED', transitorio: true, detalle: msg });
    }
    let json = null;
    try { json = await respuesta.json(); } catch { json = null; }
    if (!respuesta.ok || (json && json.error)) {
      const e = (json && json.error) || {};
      const clase = clasificarErrorGraph(respuesta.status, e);
      const msg = ocultarSecretos(e.error_user_msg || e.message || ('HTTP ' + respuesta.status), secretos(c));
      throw new ErrorInstagram('Instagram: ' + msg, {
        ...clase,
        detalle: ocultarSecretos(JSON.stringify({ code: e.code, subcode: e.error_subcode, tipo: e.type, fbtrace_id: e.fbtrace_id, http: respuesta.status }), secretos(c)),
      });
    }
    return json || {};
  }

  /** ¿Hay lo minimo para publicar por la API oficial? (si no, el publicador usa las cookies de respaldo). */
  function instagramConfigurado() {
    const c = cfg();
    return c.faltan.length === 0 && c.versionValida;
  }

  /** Cuota de publicacion por API (ventana de 24 h). Devuelve null si no se pudo consultar. */
  async function obtenerCuotaPublicacion() {
    try {
      const c = cfg();
      exigirConfig(c);
      const r = await graph('/' + c.igUserId + '/content_publishing_limit', { params: { fields: 'config,quota_usage' }, c });
      const fila = Array.isArray(r.data) ? r.data[0] : null;
      if (!fila) return null;
      const total = Number(fila.config && fila.config.quota_total);
      const usado = Number(fila.quota_usage);
      return { usado: Number.isFinite(usado) ? usado : null, total: Number.isFinite(total) ? total : null, ventanaSeg: Number(fila.config && fila.config.quota_duration) || 86400 };
    } catch (error) {
      logger.warn('Instagram: no se pudo leer la cuota de publicacion', { mensaje: error.message, codigo: error.codigo });
      return null;
    }
  }

  /** Vigencia y permisos del token via debug_token (necesita META_APP_ID + META_APP_SECRET). null si no se puede. */
  async function inspeccionarToken(c = cfg()) {
    if (!c.token || !c.appId || !c.appSecret) return null;
    try {
      const r = await graph('/debug_token', { params: { input_token: c.token }, c, tokenApp: c.appId + '|' + c.appSecret });
      const d = r.data || {};
      const exp = Number(d.expires_at) || 0;      // 0 = no vence (token de usuario del sistema)
      const scopes = Array.isArray(d.scopes) ? d.scopes : [];
      return {
        valido: d.is_valid === true,
        expiraEn: exp ? new Date(exp * 1000).toISOString() : null,
        diasRestantes: exp ? Math.floor((exp * 1000 - reloj()) / 86400000) : null,
        permisos: scopes,
        puedePublicar: scopes.includes('instagram_content_publish'),
      };
    } catch (error) {
      logger.warn('Instagram: debug_token no disponible', { mensaje: error.message, codigo: error.codigo });
      return null;
    }
  }

  /**
   * Valida el token SIN publicar nada: GET /{IG_USER_ID}?fields=id,username,profile_picture_url.
   * Nunca lanza: devuelve { connected, ... } con `error: { codigo, mensaje, transitorio }` si algo falla.
   */
  async function verifyInstagramConnection() {
    const c = cfg();
    try {
      exigirConfig(c);
      const perfil = await graph('/' + c.igUserId, { params: { fields: 'id,username,profile_picture_url' }, c });
      if (String(perfil.id) !== c.igUserId) {
        throw new ErrorInstagram('El token responde por otra cuenta (' + perfil.id + ') distinta de IG_USER_ID.', { status: 409, codigo: 'CUENTA_DISTINTA' });
      }
      const token = await inspeccionarToken(c);
      return {
        connected: true,
        id: String(perfil.id),
        username: perfil.username || null,
        profile_picture_url: perfil.profile_picture_url || null,
        graph_version: c.version,
        token,
        verificadoEn: new Date(reloj()).toISOString(),
      };
    } catch (error) {
      const e = error instanceof AppError ? error : new ErrorInstagram(ocultarSecretos(error.message, secretos(c)), { codigo: 'ERROR' });
      return {
        connected: false,
        id: c.igUserId || null,
        username: null,
        graph_version: c.version,
        error: { codigo: e.codigo, mensaje: e.message, transitorio: e.transitorio },
        verificadoEn: new Date(reloj()).toISOString(),
      };
    }
  }

  /** Espera a que Meta termine de procesar el video. Sondeo con espera creciente (3 s -> 10 s) y tolerancia a fallos de red. */
  async function esperarContenedor(idContenedor, c, { signal, onProgreso } = {}) {
    const inicio = reloj();
    let espera = c.sondeoMinMs;
    let fallosSeguidos = 0;
    let ultimoEstado = null;
    for (;;) {
      if (signal && signal.aborted) throw new ErrorInstagram('Publicacion cancelada.', { status: 499, codigo: 'CANCELADO' });
      try {
        const r = await graph('/' + idContenedor, { params: { fields: 'status_code,status' }, c });
        fallosSeguidos = 0;
        ultimoEstado = r.status_code || null;
        if (onProgreso) onProgreso({ fase: 'procesando', estado: ultimoEstado, segundos: Math.round((reloj() - inicio) / 1000) });
        if (ultimoEstado === 'FINISHED') return { estado: 'FINISHED' };
        if (ultimoEstado === 'PUBLISHED') return { estado: 'PUBLISHED' };
        if (ultimoEstado === 'ERROR' || ultimoEstado === 'EXPIRED') {
          const motivo = ocultarSecretos(String(r.status || ultimoEstado), secretos(c));
          throw new ErrorInstagram('Meta no pudo procesar el video (' + ultimoEstado + '): ' + motivo, {
            status: 422, codigo: ultimoEstado === 'EXPIRED' ? 'CONTENEDOR_EXPIRADO' : 'MEDIA_INVALIDA', transitorio: ultimoEstado === 'EXPIRED', detalle: motivo,
          });
        }
      } catch (error) {
        if (!(error instanceof ErrorInstagram) || !error.transitorio) throw error;
        fallosSeguidos += 1;
        if (fallosSeguidos >= 3) throw error;   // 3 fallos transitorios seguidos: se aborta (el programador reintenta con backoff)
      }
      if (reloj() - inicio + espera > c.timeoutPublicacionMs) {
        throw new ErrorInstagram('Meta tardo mas de ' + Math.round(c.timeoutPublicacionMs / 60000) + ' min en procesar el video (estado: ' + (ultimoEstado || 'desconocido') + ').', {
          status: 504, codigo: 'TIMEOUT_PROCESAMIENTO', transitorio: true,
        });
      }
      await dormir(espera);
      espera = Math.min(c.sondeoMaxMs, Math.round(espera * 1.5));
    }
  }

  /**
   * Publica un Reel (y, si Meta Accounts Center lo tiene activo, se replica a Facebook por su cuenta).
   * @param {{videoUrl:string, caption?:string, shareToFeed?:boolean, comprobarCuota?:boolean, signal?:AbortSignal, onProgreso?:Function}} p
   * @returns {Promise<{ok:true, containerId:string, mediaId:string|null, permalink:string|null, confirmadoPorEstado:boolean, segundos:number}>}
   */
  async function publishInstagramReel({ videoUrl, caption = '', shareToFeed = true, comprobarCuota = true, signal, onProgreso } = {}) {
    const c = cfg();
    exigirConfig(c);
    if (!/^https:\/\/[^\s]+$/i.test(String(videoUrl || ''))) {
      throw new ErrorInstagram('videoUrl debe ser una URL https publica del .mp4.', { status: 400, codigo: 'URL_INVALIDA' });
    }
    const t0 = reloj();
    if (comprobarCuota) {
      const cuota = await obtenerCuotaPublicacion();
      if (cuota && cuota.total && cuota.usado !== null && cuota.usado >= cuota.total) {
        throw new ErrorInstagram('Se alcanzo el limite de publicaciones por API en 24 h (' + cuota.usado + '/' + cuota.total + ').', { status: 429, codigo: 'LIMITE_PUBLICACION', transitorio: true });
      }
    }

    // Paso 1: contenedor del Reel
    if (onProgreso) onProgreso({ fase: 'creando_contenedor' });
    const creado = await graph('/' + c.igUserId + '/media', {
      metodo: 'POST', c,
      params: { media_type: 'REELS', video_url: videoUrl, caption: prepararCaption(caption), share_to_feed: shareToFeed ? 'true' : 'false' },
    });
    const containerId = String(creado.id || '');
    if (!containerId) throw new ErrorInstagram('Meta no devolvio el id del contenedor.', { status: 502, codigo: 'SIN_CONTENEDOR', transitorio: true });

    // Paso 2: esperar a FINISHED
    const listo = await esperarContenedor(containerId, c, { signal, onProgreso });

    // Paso 3: publicar. Si la respuesta se pierde (red/5xx) se consulta el contenedor antes de reintentar: evita duplicar el Reel.
    let mediaId = null;
    let confirmadoPorEstado = listo.estado === 'PUBLISHED';
    if (!confirmadoPorEstado) {
      if (onProgreso) onProgreso({ fase: 'publicando' });
      try {
        const pub = await graph('/' + c.igUserId + '/media_publish', { metodo: 'POST', c, params: { creation_id: containerId } });
        mediaId = pub.id ? String(pub.id) : null;
      } catch (error) {
        if (!(error instanceof ErrorInstagram) || !error.transitorio) throw error;
        let estado = null;
        try { estado = (await graph('/' + containerId, { params: { fields: 'status_code' }, c })).status_code; } catch { /* sin confirmacion */ }
        if (estado !== 'PUBLISHED') throw error;
        confirmadoPorEstado = true;
      }
    }

    let permalink = null;
    if (mediaId) {
      try { permalink = (await graph('/' + mediaId, { params: { fields: 'permalink' }, c })).permalink || null; } catch { /* es solo informativo */ }
    }
    const segundos = Math.round((reloj() - t0) / 1000);
    logger.info('Instagram: Reel publicado', { containerId, mediaId, segundos, confirmadoPorEstado });
    return { ok: true, containerId, mediaId, permalink, confirmadoPorEstado, segundos };
  }

  return { verifyInstagramConnection, publishInstagramReel, obtenerCuotaPublicacion, inspeccionarToken, instagramConfigurado, graph };
}

// Instancia por defecto (lee process.env en cada llamada, asi un cambio de variables en Railway se nota sin reiniciar codigo).
const cliente = crearClienteInstagram();
export const verifyInstagramConnection = cliente.verifyInstagramConnection;
export const publishInstagramReel = cliente.publishInstagramReel;
export const obtenerCuotaPublicacion = cliente.obtenerCuotaPublicacion;
export const instagramConfigurado = cliente.instagramConfigurado;
/** ¿El operador declaro que Meta Accounts Center reenvia a Facebook? (Meta NO expone este ajuste por API: es una declaracion.) */
export const crosspostFacebookActivo = () => verdadero(process.env.IG_CROSSPOST_FACEBOOK);

export default cliente;
