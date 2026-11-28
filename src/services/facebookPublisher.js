// ---------------------------------------------------------------------------
// Publicacion DIRECTA en la Pagina de Facebook con la Graph API oficial (sin Chromium ni cookies).
//
//  Variables de entorno (Railway). Nunca se escriben tokens en el codigo:
//    FB_PAGE_ID             id de la Pagina
//    FB_PAGE_ACCESS_TOKEN   token DE PAGINA (no de usuario) con pages_manage_posts y pages_read_engagement
//    META_APP_SECRET        (opcional) firma cada llamada con appsecret_proof
//    FB_GRAPH_VERSION       (opcional) por defecto IG_GRAPH_VERSION o v21.0; se rechaza cualquier version menor a v21
//    FB_PUBLISH_MODE        reels (por defecto) | videos
//    FB_PUBLICAR_DIRECTO=on publica directo en la Pagina AUNQUE el reenvio desde Instagram (Accounts Center) este activo.
//                           Ojo: con ambos activos el Reel puede salir dos veces; desactiva el reenvio en Accounts Center.
//    FB_PUBLISH_TIMEOUT_MIN (10) tiempo maximo esperando a que Facebook procese el video
//    PUBLIC_BASE_URL        Meta descarga el video desde una URL publica (/clips/<archivo>.mp4)
//
//  Modo "reels" (3 pasos, /{FB_PAGE_ID}/video_reels):
//    1) POST upload_phase=start                       -> video_id + upload_url
//    2) POST {upload_url}  (cabeceras Authorization: OAuth <token>, file_url: <URL publica>)   Facebook descarga el mp4
//    3) POST upload_phase=finish, video_state=PUBLISHED, description   -> publica el Reel
//    4) (informativo) GET /{video_id}?fields=status hasta "ready"
//  Modo "videos": POST /{FB_PAGE_ID}/videos con file_url + description (una sola llamada).
//
//  Regla anti-duplicados: una vez aceptado el paso 3 (o el POST de /videos) el video YA esta publicado en Facebook; si despues
//  falla o se agota la espera del estado, se devuelve ok con `confirmado:false` y NUNCA un error que provoque otro intento.
//  Todo es inyectable (fetch, env, sleep) para probarlo sin red.
// ---------------------------------------------------------------------------
import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import { AppError, ocultarSecretos } from '../utils/errores.js';
import { VERSION_MINIMA, clasificarErrorGraph, prepararCaption } from './instagramPublisher.js';

export class ErrorFacebook extends AppError {}

const BASE_GRAPH = 'https://graph.facebook.com';
const verdadero = (v) => /^(1|true|si|sí|on|yes)$/i.test(String(v ?? '').trim());
const numero = (v, porDefecto) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : porDefecto;
};
const dormirReal = (ms) => new Promise((ok) => setTimeout(ok, ms));

export function leerConfigFacebook(env = process.env) {
  const pedida = String(env.FB_GRAPH_VERSION || env.IG_GRAPH_VERSION || 'v21.0').trim();
  const m = /^v(\d+)\.(\d+)$/.exec(pedida);
  const versionValida = Boolean(m) && Number(m[1]) >= VERSION_MINIMA;
  const modo = String(env.FB_PUBLISH_MODE || 'reels').trim().toLowerCase();
  const cfg = {
    token: String(env.FB_PAGE_ACCESS_TOKEN || '').trim(),
    pageId: String(env.FB_PAGE_ID || '').trim(),
    appSecret: String(env.META_APP_SECRET || '').trim(),
    version: versionValida ? pedida : 'v21.0',
    versionSolicitada: pedida,
    versionValida,
    modo: modo === 'videos' ? 'videos' : 'reels',
    directoForzado: verdadero(env.FB_PUBLICAR_DIRECTO),
    timeoutPublicacionMs: numero(env.FB_PUBLISH_TIMEOUT_MIN, 10) * 60 * 1000,
    sondeoMinMs: numero(env.FB_POLL_MIN_SEG, 3) * 1000,
    sondeoMaxMs: numero(env.FB_POLL_MAX_SEG, 10) * 1000,
    timeoutHttpMs: numero(env.FB_HTTP_TIMEOUT_SEG, 60) * 1000,
  };
  cfg.faltan = [['FB_PAGE_ACCESS_TOKEN', cfg.token], ['FB_PAGE_ID', cfg.pageId]].filter(([, v]) => !v).map(([k]) => k);
  return cfg;
}

export function crearClienteFacebook(deps = {}) {
  const env = deps.env || process.env;
  const llamar = deps.fetch || globalThis.fetch;
  const dormir = deps.sleep || dormirReal;
  const reloj = deps.reloj || (() => Date.now());
  const cfg = () => leerConfigFacebook(env);
  const firma = (token, secreto) => crypto.createHmac('sha256', secreto).update(token).digest('hex');
  const secretos = (c) => [c.token, c.appSecret, c.appSecret && c.token ? firma(c.token, c.appSecret) : ''];

  function exigirConfig(c) {
    if (c.faltan.length) throw new ErrorFacebook('Falta configurar en Railway: ' + c.faltan.join(', '), { status: 500, codigo: 'SIN_CONFIG', detalle: c.faltan.join(',') });
    if (!c.versionValida) throw new ErrorFacebook('FB_GRAPH_VERSION debe ser v' + VERSION_MINIMA + '.0 o superior (recibido: ' + c.versionSolicitada + ').', { status: 500, codigo: 'VERSION_GRAPH' });
  }

  async function graph(ruta, { metodo = 'GET', params = {}, c = cfg() } = {}) {
    if (typeof llamar !== 'function') throw new ErrorFacebook('Este entorno no tiene fetch.', { codigo: 'SIN_FETCH' });
    const todos = { ...params, access_token: c.token };
    if (c.appSecret) todos.appsecret_proof = firma(c.token, c.appSecret);
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
      throw new ErrorFacebook('No se pudo contactar con Meta: ' + msg, { status: 502, codigo: 'RED', transitorio: true, detalle: msg });
    }
    let json = null;
    try { json = await respuesta.json(); } catch { json = null; }
    if (!respuesta.ok || (json && json.error)) {
      const e = (json && json.error) || {};
      const clase = clasificarErrorGraph(respuesta.status, e);
      const msg = ocultarSecretos(e.error_user_msg || e.message || ('HTTP ' + respuesta.status), secretos(c));
      throw new ErrorFacebook('Facebook: ' + msg + (clase.codigo === 'APPSECRET_REQUERIDO' ? ' -> Define META_APP_SECRET en Railway.' : ''), {
        ...clase,
        detalle: ocultarSecretos(JSON.stringify({ code: e.code, subcode: e.error_subcode, tipo: e.type, fbtrace_id: e.fbtrace_id, http: respuesta.status }), secretos(c)),
      });
    }
    return json || {};
  }

  /** Paso 2 del Reel: Facebook descarga el mp4 desde la URL publica (rupload.facebook.com). */
  async function subirDesdeUrl(uploadUrl, videoUrl, c) {
    if (!/^https:\/\/[^\s]+$/i.test(String(uploadUrl || ''))) throw new ErrorFacebook('Facebook no devolvio una upload_url valida.', { status: 502, codigo: 'SIN_UPLOAD_URL', transitorio: true });
    let respuesta;
    try {
      respuesta = await llamar(uploadUrl, { method: 'POST', headers: { Authorization: 'OAuth ' + c.token, file_url: videoUrl }, signal: AbortSignal.timeout(c.timeoutHttpMs * 2) });
    } catch (error) {
      const msg = ocultarSecretos(error && error.message, secretos(c));
      throw new ErrorFacebook('No se pudo subir el video a Facebook: ' + msg, { status: 502, codigo: 'RED', transitorio: true, detalle: msg });
    }
    let json = null;
    try { json = await respuesta.json(); } catch { json = null; }
    if (!respuesta.ok || (json && (json.error || json.success === false))) {
      const e = (json && json.error) || {};
      const clase = clasificarErrorGraph(respuesta.status, e);
      const msg = ocultarSecretos(e.message || (json && json.debug_info && json.debug_info.message) || ('HTTP ' + respuesta.status), secretos(c));
      throw new ErrorFacebook('Facebook no pudo descargar el video: ' + msg, { ...clase, detalle: msg });
    }
  }

  const facebookConfigurado = () => { const c = cfg(); return c.faltan.length === 0 && c.versionValida; };

  /** Valida el token de Pagina SIN publicar: GET /{FB_PAGE_ID}?fields=id,name,link. Nunca lanza. */
  async function verifyFacebookConnection() {
    const c = cfg();
    try {
      exigirConfig(c);
      const p = await graph('/' + c.pageId, { params: { fields: 'id,name,link' }, c });
      if (String(p.id) !== c.pageId) throw new ErrorFacebook('El token responde por otra pagina (' + p.id + ') distinta de FB_PAGE_ID.', { status: 409, codigo: 'CUENTA_DISTINTA' });
      return { connected: true, id: String(p.id), name: p.name || null, link: p.link || null, modo: c.modo, graph_version: c.version, verificadoEn: new Date(reloj()).toISOString() };
    } catch (error) {
      const e = error instanceof AppError ? error : new ErrorFacebook(ocultarSecretos(error.message, secretos(c)), { codigo: 'ERROR' });
      return { connected: false, id: c.pageId || null, name: null, modo: c.modo, graph_version: c.version, error: { codigo: e.codigo, mensaje: e.message, transitorio: e.transitorio }, verificadoEn: new Date(reloj()).toISOString() };
    }
  }

  /** Espera (informativa) a que Facebook marque el Reel como listo. Nunca convierte un video ya publicado en error. */
  async function confirmarEstado(videoId, c) {
    const inicio = reloj();
    let espera = c.sondeoMinMs;
    for (;;) {
      try {
        const r = await graph('/' + videoId, { params: { fields: 'status' }, c });
        const estado = String((r.status && r.status.video_status) || '').toLowerCase();
        if (estado === 'ready') return { confirmado: true, estado };
        if (estado === 'error' || estado === 'expired') {
          throw new ErrorFacebook('Facebook no pudo procesar el video (' + estado + ').', { status: 422, codigo: 'MEDIA_INVALIDA', transitorio: false });
        }
      } catch (error) {
        if (error instanceof ErrorFacebook && error.codigo === 'MEDIA_INVALIDA') throw error;
        return { confirmado: false, estado: 'sin_confirmar' };   // fallo al consultar: el video ya esta enviado, no se reintenta
      }
      if (reloj() - inicio + espera > c.timeoutPublicacionMs) return { confirmado: false, estado: 'procesando' };
      await dormir(espera);
      espera = Math.min(c.sondeoMaxMs, Math.round(espera * 1.5));
    }
  }

  /**
   * Publica un Reel/video en la Pagina.
   * @returns {Promise<{ok:true, videoId:string|null, permalink:string|null, modo:string, confirmado:boolean, estado:string, segundos:number}>}
   */
  async function publishFacebookReel({ videoUrl, caption = '', titulo = '', onProgreso } = {}) {
    const c = cfg();
    exigirConfig(c);
    if (!/^https:\/\/[^\s]+$/i.test(String(videoUrl || ''))) throw new ErrorFacebook('videoUrl debe ser una URL https publica del .mp4.', { status: 400, codigo: 'URL_INVALIDA' });
    const t0 = reloj();
    const descripcion = prepararCaption(caption, 5000);
    let videoId = null;

    if (c.modo === 'videos') {
      if (onProgreso) onProgreso({ fase: 'publicando' });
      const r = await graph('/' + c.pageId + '/videos', { metodo: 'POST', c, params: { file_url: videoUrl, description: descripcion, title: String(titulo || '').slice(0, 100), published: 'true' } });
      videoId = r.id ? String(r.id) : null;
      // Aceptado: ya esta en Facebook. Solo se confirma, sin lanzar errores que provoquen otro intento.
      const est = videoId ? await confirmarEstado(videoId, c).catch(() => ({ confirmado: false, estado: 'sin_confirmar' })) : { confirmado: false, estado: 'sin_confirmar' };
      return cerrar(videoId, c, est, t0);
    }

    // Paso 1: sesion de subida del Reel
    if (onProgreso) onProgreso({ fase: 'creando_sesion' });
    const inicio = await graph('/' + c.pageId + '/video_reels', { metodo: 'POST', c, params: { upload_phase: 'start' } });
    videoId = String(inicio.video_id || '');
    if (!videoId) throw new ErrorFacebook('Facebook no devolvio el video_id del Reel.', { status: 502, codigo: 'SIN_VIDEO_ID', transitorio: true });
    // Paso 2: Facebook descarga el mp4
    if (onProgreso) onProgreso({ fase: 'subiendo' });
    await subirDesdeUrl(inicio.upload_url, videoUrl, c);
    // Paso 3: publicar (desde aqui el Reel ya esta enviado)
    if (onProgreso) onProgreso({ fase: 'publicando' });
    await graph('/' + c.pageId + '/video_reels', { metodo: 'POST', c, params: { upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: descripcion } });
    if (onProgreso) onProgreso({ fase: 'procesando' });
    // Si Facebook responde MEDIA_INVALIDA tras el finish, el video fue rechazado (no se publico): es seguro reintentar con otro envio.
    const est = await confirmarEstado(videoId, c);
    return cerrar(videoId, c, est, t0);
  }

  async function cerrar(videoId, c, est, t0) {
    let permalink = null;
    if (videoId) {
      try { permalink = (await graph('/' + videoId, { params: { fields: 'permalink_url' }, c })).permalink_url || null; } catch { /* informativo */ }
      if (permalink && permalink.startsWith('/')) permalink = 'https://www.facebook.com' + permalink;
    }
    const segundos = Math.round((reloj() - t0) / 1000);
    logger.info('Facebook: video publicado en la Pagina', { videoId, modo: c.modo, confirmado: est.confirmado, segundos });
    return { ok: true, videoId, permalink, modo: c.modo, confirmado: est.confirmado, estado: est.estado, segundos };
  }

  return { verifyFacebookConnection, publishFacebookReel, facebookConfigurado, graph };
}

const cliente = crearClienteFacebook();
export const verifyFacebookConnection = cliente.verifyFacebookConnection;
export const publishFacebookReel = cliente.publishFacebookReel;
export const facebookConfigurado = cliente.facebookConfigurado;
/** FB_PUBLICAR_DIRECTO=on: publicar directo en la Pagina aunque Instagram ya la alimente por reenvio. */
export const facebookDirectoForzado = () => verdadero(process.env.FB_PUBLICAR_DIRECTO);

export default cliente;
