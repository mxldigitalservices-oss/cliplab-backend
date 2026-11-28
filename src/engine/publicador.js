// ---------------------------------------------------------------------------
// Publicador: sube un clip ya renderizado a TikTok / Instagram / Facebook usando las cookies de sesion que guarda el
// modulo de conexiones (src/sesion/cookiesRedes.js). Devuelve un resultado ESTRUCTURADO por canal.
//
//   publicarClip({ rutaVideo, descripcion, etiquetas, plataformas }, opciones?)
//     -> { ok, modo, inicio, fin, resultados: { [red]: { ok, error, codigo, detalle, timestamp, transitorio } } }
//
//  - Un canal que falla no impide los demas; nunca lanza (todo error queda en su canal).
//  - Ritmo humano: la descripcion se teclea por bloques con esperas variables (mas largas tras espacios, signos y saltos
//    de linea, con pausas de "pensar" ocasionales) y hay pausas aleatorias entre cada accion (adjuntar, escribir, publicar).
//  - Navegador: Playwright (`playwright-core`, carga perezosa) o un driver inyectado. Sin el, el error es DRIVER_NO_DISPONIBLE
//    (no transitorio): nunca publica "a medias" ni finge un exito. Modo 'seco' (PUBLICADOR_MODO=seco) recorre el flujo sin red.
//  - Los selectores de cada red viven en SELECTORES y se pueden ajustar sin tocar codigo con PUBLICADOR_SELECTORES (JSON).
//    OJO: las webs cambian; los selectores por defecto son un punto de partida y deben validarse contra la UI real.
// ---------------------------------------------------------------------------
import fs from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import { opcionesLanzamiento } from './chromium.js';
import * as instagramOficial from '../services/instagramPublisher.js';
import * as facebookOficial from '../services/facebookPublisher.js';
import { store as almacenDefecto } from '../storage/store.js';

export const REDES_SOPORTADAS = ['tiktok', 'instagram', 'facebook'];

export class ErrorPublicador extends Error {
  constructor(codigo, mensaje, transitorio = true) {
    super(mensaje);
    this.name = 'ErrorPublicador';
    this.codigo = codigo;
    this.transitorio = transitorio;
  }
}

// ------------------------------ ritmo humano --------------------------------

const PAUSA_DEFECTO = [600, 2400];

/**
 * @param {object} [o]
 * @param {() => number} [o.azar]
 * @param {(ms:number) => Promise<void>} [o.dormir]
 */
export function crearRitmoHumano({ azar = Math.random, dormir = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const entre = (min, max) => Math.round(min + azar() * (max - min));

  /** Plan de tecleo: bloques de 1-5 caracteres con su espera. Unir los `texto` devuelve exactamente la entrada. */
  function planearTecleo(texto) {
    const t = Array.from(String(texto ?? '')); // por codigo de punto: un emoji nunca se parte en dos bloques
    const partes = [];
    let i = 0;
    let palabras = 0;
    let siguientePensar = entre(6, 14);
    while (i < t.length) {
      const tam = azar() < 0.35 ? 1 : entre(2, 5);
      const bloque = t.slice(i, i + tam).join('');
      i += tam;
      let espera = Array.from(bloque).length * entre(45, 170);
      const ultimo = Array.from(bloque).pop();
      if (ultimo === ' ') {
        espera += entre(60, 220);
        palabras += 1;
        if (palabras >= siguientePensar) {
          espera += entre(500, 1400); // pausa de "pensar"
          palabras = 0;
          siguientePensar = entre(6, 14);
        }
      } else if (/[.,;:!?]/.test(ultimo)) espera += entre(150, 500);
      else if (ultimo === '\n') espera += entre(250, 700);
      partes.push({ texto: bloque, espera });
    }
    return partes;
  }

  return {
    entre,
    planearTecleo,
    pausa: async (min = PAUSA_DEFECTO[0], max = PAUSA_DEFECTO[1]) => {
      const ms = entre(min, max);
      await dormir(ms);
      return ms;
    },
    /** Teclea `texto` llamando a `teclear(bloque)` con esperas variables entre bloques. */
    escribir: async (texto, teclear) => {
      const partes = planearTecleo(texto);
      for (const parte of partes) {
        await teclear(parte.texto);
        await dormir(parte.espera);
      }
      return partes.length;
    },
    dormir,
  };
}

/** Descripcion final: texto + etiquetas que aun no estan dentro del texto (limpias, sin repetir, con tope de longitud). */
export function armarTexto(descripcion, etiquetas, { maxCaracteres = 2200, maxEtiquetas = 15 } = {}) {
  const base = String(descripcion ?? '').trim();
  const presentes = new Set((base.match(/#[\p{L}\p{N}_]+/gu) || []).map((h) => h.toLowerCase()));
  const nuevas = [];
  for (const crudo of Array.isArray(etiquetas) ? etiquetas : []) {
    const limpia = String(crudo).replace(/[^\p{L}\p{N}_]/gu, '');
    if (!limpia) continue;
    const etiqueta = '#' + limpia;
    if (presentes.has(etiqueta.toLowerCase())) continue;
    presentes.add(etiqueta.toLowerCase());
    nuevas.push(etiqueta);
  }
  const extra = nuevas.slice(0, maxEtiquetas).join(' ');
  const texto = [base, extra].filter(Boolean).join('\n\n');
  return texto.length > maxCaracteres ? texto.slice(0, maxCaracteres).trimEnd() : texto;
}

// -------------------------------- selectores --------------------------------

export const SELECTORES = {
  tiktok: {
    url: 'https://www.tiktok.com/tiktokstudio/upload',
    archivo: ['input[type="file"]'],
    descripcion: ['div[contenteditable="true"].public-DraftEditor-content', 'div[contenteditable="true"]'],
    publicar: ['button[data-e2e="post_video_button"]:not([disabled]):not([aria-disabled="true"])'],
    exito: /tiktokstudio\/content|tiktokstudio\/manage|upload.*success/i,
  },
  instagram: {
    url: 'https://www.instagram.com/',
    crear: ['a:has(svg[aria-label="New post"])', 'a:has(svg[aria-label="Nueva publicación"])', 'a:has(svg[aria-label="Create"])', 'a:has(svg[aria-label="Crear"])'],
    archivo: ['input[type="file"]'],
    siguiente: ['div[role="button"]:has-text("Next")', 'div[role="button"]:has-text("Siguiente")'],
    descripcion: ['div[aria-label="Write a caption..."]', 'div[aria-label="Escribe una descripción..."]', 'div[role="textbox"][contenteditable="true"]'],
    publicar: ['div[role="button"]:has-text("Share")', 'div[role="button"]:has-text("Compartir")'],
    exito: ['text=/has been shared|se ha compartido/i'],
  },
  facebook: {
    url: 'https://www.facebook.com/reels/create',
    archivo: ['input[type="file"][accept*="video"]', 'input[type="file"]'],
    siguiente: ['div[aria-label="Next"][role="button"]', 'div[aria-label="Siguiente"][role="button"]'],
    descripcion: ['div[role="textbox"][contenteditable="true"]'],
    publicar: ['div[aria-label="Publish"][role="button"]', 'div[aria-label="Publicar"][role="button"]'],
    exito: ['text=/shared|compartid|published|publicad/i'],
  },
};

function selectoresEfectivos(env = process.env) {
  if (!env.PUBLICADOR_SELECTORES) return SELECTORES;
  try {
    const extra = JSON.parse(env.PUBLICADOR_SELECTORES);
    const fusion = {};
    for (const red of REDES_SOPORTADAS) fusion[red] = { ...SELECTORES[red], ...((extra && extra[red]) || {}) };
    return fusion;
  } catch (error) {
    logger.warn('PUBLICADOR_SELECTORES no es JSON valido; se usan los selectores por defecto', { mensaje: error.message });
    return SELECTORES;
  }
}

/** Pasos de cada red. Cada paso es una accion simple del driver; el ritmo humano se aplica entre pasos. */
export function construirPasos(red, sel = SELECTORES) {
  const s = sel[red];
  if (!s) throw new ErrorPublicador('RED_NO_SOPORTADA', 'Red no soportada: ' + red, false);
  if (red === 'tiktok') {
    return [
      { accion: 'ir', url: s.url },
      { accion: 'adjuntar', sel: s.archivo },
      { accion: 'esperar', sel: s.descripcion, subida: true },
      { accion: 'revisar', pausa: [1500, 4500] },
      { accion: 'escribir', sel: s.descripcion, limpiar: true },
      { accion: 'esperar', sel: s.publicar, subida: true },
      { accion: 'revisar', pausa: [1200, 3500] },
      { accion: 'clic', sel: s.publicar },
      { accion: 'esperarUrl', patron: s.exito, subida: true },
    ];
  }
  if (red === 'instagram') {
    return [
      { accion: 'ir', url: s.url },
      { accion: 'clic', sel: s.crear },
      { accion: 'adjuntar', sel: s.archivo },
      { accion: 'esperar', sel: s.siguiente, subida: true },
      { accion: 'clic', sel: s.siguiente },
      { accion: 'esperar', sel: s.siguiente },
      { accion: 'clic', sel: s.siguiente },
      { accion: 'esperar', sel: s.descripcion },
      { accion: 'escribir', sel: s.descripcion },
      { accion: 'revisar', pausa: [1200, 3500] },
      { accion: 'clic', sel: s.publicar },
      { accion: 'esperar', sel: s.exito, subida: true },
    ];
  }
  return [
    { accion: 'ir', url: s.url },
    { accion: 'adjuntar', sel: s.archivo },
    { accion: 'esperar', sel: s.siguiente, subida: true },
    { accion: 'clic', sel: s.siguiente },
    { accion: 'esperar', sel: s.siguiente },
    { accion: 'clic', sel: s.siguiente },
    { accion: 'esperar', sel: s.descripcion },
    { accion: 'escribir', sel: s.descripcion },
    { accion: 'revisar', pausa: [1200, 3500] },
    { accion: 'clic', sel: s.publicar },
    { accion: 'esperar', sel: s.exito, subida: true },
  ];
}

async function correrPasos(pasos, { sesion, humano, texto, rutaVideo, timeouts }) {
  let hechos = 0;
  for (const paso of pasos) {
    if (hechos > 0) await humano.pausa(...(paso.pausa || PAUSA_DEFECTO));
    const ms = paso.subida ? timeouts.subidaMs : timeouts.pasoMs;
    switch (paso.accion) {
      case 'ir':
        await sesion.ir(paso.url);
        break;
      case 'adjuntar':
        await sesion.adjuntar(paso.sel, rutaVideo);
        break;
      case 'esperar':
        await sesion.esperar(paso.sel, ms);
        break;
      case 'esperarUrl':
        await sesion.esperarUrl(paso.patron, ms);
        break;
      case 'clic':
        await sesion.clic(paso.sel);
        break;
      case 'escribir':
        await sesion.enfocar(paso.sel);
        await humano.pausa(300, 1100);
        if (paso.limpiar) {
          await sesion.tecla('Control+A');
          await humano.pausa(150, 500);
          await sesion.tecla('Backspace');
          await humano.pausa(300, 900);
        }
        await humano.escribir(texto, (bloque) => sesion.teclear(bloque));
        break;
      case 'revisar':
        break; // solo la pausa previa: simula mirar la pantalla
      default:
        throw new ErrorPublicador('PASO_DESCONOCIDO', 'Paso desconocido: ' + paso.accion, false);
    }
    hechos += 1;
  }
  return hechos;
}

// -------------------------------- drivers -----------------------------------

/** Driver de ensayo: no abre nada ni toca la red; anota cada accion en `registro`. */
export function crearDriverSeco({ registro = [] } = {}) {
  const anotar = (accion, datos) => {
    registro.push({ accion, ...datos });
    logger.debug('Publicador (seco)', { accion, ...datos });
  };
  return {
    tipo: 'seco',
    registro,
    async abrir({ red, cookies }) {
      anotar('abrir', { red, cookies: Array.isArray(cookies) ? cookies.length : 0 });
      return {
        ir: async (url) => anotar('ir', { url }),
        adjuntar: async (sel, ruta) => anotar('adjuntar', { sel, ruta }),
        esperar: async (sel, ms) => anotar('esperar', { sel, ms }),
        esperarUrl: async (patron, ms) => anotar('esperarUrl', { patron: String(patron), ms }),
        clic: async (sel) => anotar('clic', { sel }),
        enfocar: async (sel) => anotar('enfocar', { sel }),
        tecla: async (combo) => anotar('tecla', { combo }),
        teclear: async (texto) => anotar('teclear', { texto }),
        cerrar: async () => anotar('cerrar', {}),
      };
    },
    async cerrar() {},
  };
}

/** Driver real con playwright-core (carga perezosa). Un navegador por llamada a publicarClip. */
export async function crearDriverPlaywright({ azar = Math.random, importar = () => import('playwright-core') } = {}) {
  let modulo;
  try {
    modulo = await importar();
  } catch (error) {
    throw new ErrorPublicador('DRIVER_NO_DISPONIBLE', 'Falta el paquete playwright-core (npm i playwright-core) y un Chromium instalado: ' + error.message, false);
  }
  const chromium = modulo.chromium || (modulo.default && modulo.default.chromium);
  if (!chromium) throw new ErrorPublicador('DRIVER_NO_DISPONIBLE', 'playwright-core no expone chromium', false);
  let navegador;
  try {
    // --no-sandbox + --disable-dev-shm-usage (chromium.js): sin el segundo, /dev/shm de Railway (64 MB) cierra Chromium a mitad de subida.
    navegador = await chromium.launch(opcionesLanzamiento());
  } catch (error) {
    throw new ErrorPublicador('DRIVER_NO_DISPONIBLE', 'No se pudo abrir Chromium: ' + String(error.message).split('\n')[0] + ' (revisa PLAYWRIGHT_BROWSERS_PATH, CHROMIUM_PATH o el diagnostico en /api/programador/diagnostico?chromium=1)', false);
  }
  return {
    tipo: 'playwright',
    async abrir({ cookies }) {
      const contexto = await navegador.newContext({ viewport: { width: 1366, height: 768 }, locale: 'es-DO', timezoneId: 'America/Santo_Domingo' });
      await contexto.addCookies(cookies);
      const pagina = await contexto.newPage();
      const lista = (sel) => (Array.isArray(sel) ? sel.join(', ') : sel);
      const loc = (sel) => pagina.locator(lista(sel)).first();
      const clicHumano = async (sel) => {
        const el = loc(sel);
        await el.waitFor({ state: 'visible', timeout: 30000 });
        const caja = await el.boundingBox();
        if (!caja) return el.click({ timeout: 30000 });
        const x = caja.x + caja.width * (0.25 + 0.5 * azar());
        const y = caja.y + caja.height * (0.25 + 0.5 * azar());
        await pagina.mouse.move(x, y, { steps: 8 + Math.floor(azar() * 12) });
        await pagina.mouse.click(x, y);
      };
      return {
        ir: (url) => pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }),
        adjuntar: (sel, ruta) => loc(sel).setInputFiles(ruta),
        esperar: (sel, ms) => loc(sel).waitFor({ state: 'visible', timeout: ms }),
        esperarUrl: (patron, ms) => pagina.waitForURL(patron, { timeout: ms }),
        clic: clicHumano,
        enfocar: clicHumano,
        tecla: (combo) => pagina.keyboard.press(combo),
        teclear: (texto) => pagina.keyboard.type(texto),
        cerrar: () => contexto.close(),
      };
    },
    cerrar: () => navegador.close(),
  };
}

// ------------------------------ resultado por canal --------------------------

function clasificar(error) {
  // ErrorPublicador y cualquier AppError (p. ej. ErrorInstagram) ya traen `codigo` y `transitorio` fiables.
  if (error instanceof ErrorPublicador || (error && error.codigo && typeof error.transitorio === 'boolean')) return { codigo: error.codigo, transitorio: error.transitorio };
  const nombre = (error && error.name) || '';
  if (nombre === 'TimeoutError') return { codigo: 'TIMEOUT', transitorio: true };
  return { codigo: 'ERROR', transitorio: true };
}

const fallo = (error, reloj) => ({
  ok: false,
  error: error.message,
  ...clasificar(error),
  detalle: String((error && error.stack) || error.message).split('\n').slice(0, 3).join(' | ').slice(0, 500),
  timestamp: reloj(),
});

async function cookiesDe(red, { leerCookies, obligatorias }) {
  let cookies;
  try {
    cookies = await leerCookies(red);
  } catch (error) {
    throw new ErrorPublicador('SESION_ILEGIBLE', error.message, false);
  }
  if (!cookies || cookies.length === 0) {
    throw new ErrorPublicador('SIN_SESION', 'No hay sesion guardada de ' + red + '. Pega las cookies en la pestana Conexiones.', false);
  }
  const ahoraSeg = Date.now() / 1000;
  const vivas = new Set(cookies.filter((c) => c.expires === -1 || c.expires > ahoraSeg).map((c) => c.name));
  for (const grupo of obligatorias[red] || []) {
    if (!grupo.some((nombre) => vivas.has(nombre))) {
      throw new ErrorPublicador('SESION_EXPIRADA', 'La sesion de ' + red + ' vencio (' + grupo.join(' o ') + '). Vuelve a exportar las cookies.', false);
    }
  }
  return cookies;
}

// ---------------------------------- API ---------------------------------------

/**
 * Publica un clip en UNA red. Nunca lanza: devuelve el resultado del canal.
 * @param {string} red
 * @param {{rutaVideo:string, texto:string}} clip
 * @param {object} ctx  { driver, humano, leerCookies, obligatorias, selectores, timeouts, reloj }
 */
export async function publicarEnRed(red, clip, ctx) {
  let sesion = null;
  try {
    if (!REDES_SOPORTADAS.includes(red)) throw new ErrorPublicador('RED_NO_SOPORTADA', 'Red no soportada: ' + red, false);
    const cookies = await cookiesDe(red, ctx);
    const pasos = construirPasos(red, ctx.selectores);
    sesion = await ctx.driver.abrir({ red, cookies });
    const hechos = await correrPasos(pasos, { sesion, humano: ctx.humano, texto: clip.texto, rutaVideo: clip.rutaVideo, timeouts: ctx.timeouts });
    return {
      ok: true,
      error: null,
      codigo: 'OK',
      detalle: (ctx.driver.tipo === 'seco' ? 'SIMULACION: ' : '') + 'Publicado en ' + red + ' (' + hechos + ' pasos)',
      timestamp: ctx.reloj(),
      transitorio: false,
      simulado: ctx.driver.tipo === 'seco',
    };
  } catch (error) {
    return fallo(error, ctx.reloj);
  } finally {
    if (sesion) await Promise.resolve(sesion.cerrar()).catch(() => {});
  }
}

/** Primera descripcion con texto (una cadena vacia no cuenta). */
function descripcionEfectiva(clip) {
  return [clip.descripcion, clip.description, clip.resumen, clip.summary, clip.caption, clip.titulo, clip.title].find((v) => String(v ?? '').trim() !== '') ?? '';
}

/** Anota en el clip del panel lo publicado por API (mediaId, enlace). Es informativo: un fallo aqui nunca afecta a la publicacion. */
function anotarEnClip(almacen, clip, campos) {
  try {
    if (clip && clip.clipId && almacen && typeof almacen.actualizar === 'function') almacen.actualizar(clip.clipId, campos);
  } catch { /* el clip pudo archivarse o borrarse */ }
}

/** Decide como sale Facebook (ver el comentario de publicarClip). Funcion pura: facilita probar la matriz de casos. */
export function decidirFacebook({ ig, fb, plataformas, igOficial, clip, almacen }) {
  const crosspost = ig.crosspostFacebookActivo();
  const forzado = fb.facebookDirectoForzado();
  if (crosspost && igOficial && !forzado) return 'crosspost';
  let yaEnInstagram = false;
  try { yaEnInstagram = Boolean(clip && clip.clipId && almacen && almacen.buscar(clip.clipId)?.instagram?.mediaId); } catch { /* sin dato */ }
  if (fb.facebookConfigurado()) return crosspost && !forzado && yaEnInstagram ? 'crosspost_previo' : 'directo';
  if (crosspost) return yaEnInstagram ? 'crosspost_previo' : 'esperar_instagram';
  return 'cookies';
}

/** Publica UN clip en la Pagina de Facebook por la Graph API oficial. Nunca lanza. */
async function publicarFacebookOficial(clip, { fb, urlPublica, reloj, almacen }) {
  try {
    const caption = armarTexto(descripcionEfectiva(clip), clip.etiquetas);
    const r = await fb.publishFacebookReel({ videoUrl: urlPublica(clip.rutaVideo), caption, titulo: clip.titulo || clip.title || '' });
    anotarEnClip(almacen, clip, { facebook: { videoId: r.videoId, permalink: r.permalink, publicadoEn: new Date().toISOString() } });
    return {
      ok: true, error: null, codigo: 'OK', transitorio: false, simulado: false, timestamp: reloj(),
      detalle: 'Publicado en la Pagina de Facebook por la API oficial (' + (r.videoId || 'sin id') + (r.confirmado ? '' : ', sin confirmar el procesamiento') + ')',
      videoId: r.videoId || null, permalink: r.permalink || null, confirmado: r.confirmado,
    };
  } catch (error) {
    return fallo(error, reloj);
  }
}

/** Publica UN clip en Instagram por la Graph API oficial. Nunca lanza: devuelve el resultado del canal. */
async function publicarInstagramOficial(clip, { oficial, reloj, almacen }) {
  try {
    const caption = armarTexto(descripcionEfectiva(clip), clip.etiquetas);
    const r = await oficial.publishInstagramReel({ videoUrl: oficial.urlPublicaDeClip(clip.rutaVideo), caption });
    anotarEnClip(almacen, clip, { instagram: { mediaId: r.mediaId || null, permalink: r.permalink || null, publicadoEn: new Date().toISOString() } });
    return {
      ok: true, error: null, codigo: 'OK', transitorio: false, simulado: false, timestamp: reloj(),
      detalle: 'Publicado en Instagram por la API oficial (' + (r.mediaId || 'confirmado por estado') + ')',
      mediaId: r.mediaId || null, permalink: r.permalink || null,
    };
  } catch (error) {
    return fallo(error, reloj);
  }
}

/**
 * Publica un clip en las plataformas indicadas, una tras otra (con pausa aleatoria entre redes).
 * @param {{rutaVideo:string, descripcion?:string, etiquetas?:string[], plataformas:string[]}} clip
 * @param {object} [o]  inyectables: driver, modo ('real'|'seco'), azar, dormir, leerCookies, obligatorias, selectores, timeouts, reloj, pausaEntreRedes
 */
export async function publicarClip(clip, o = {}) {
  const reloj = o.reloj || (() => new Date().toISOString());
  const inicio = reloj();
  const plataformas = [...new Set((clip.plataformas || []).map((p) => String(p).toLowerCase()))];
  const resultados = {};
  const modo = o.modo || process.env.PUBLICADOR_MODO || 'real';
  const humano = o.humano || crearRitmoHumano({ azar: o.azar, dormir: o.dormir });

  const cerrar = (extra = {}) => {
    const ok = plataformas.length > 0 && plataformas.every((p) => resultados[p] && resultados[p].ok);
    return { ok, modo, inicio, fin: reloj(), resultados, ...extra };
  };
  const marcarTodas = (error) => {
    for (const p of plataformas) resultados[p] = fallo(error, reloj);
    return cerrar();
  };

  if (plataformas.length === 0) return marcarTodas(new ErrorPublicador('SIN_PLATAFORMAS', 'No se indicaron plataformas', false));
  if (!clip.rutaVideo) return marcarTodas(new ErrorPublicador('SIN_VIDEO', 'Falta rutaVideo', false));
  try {
    await fs.access(clip.rutaVideo);
  } catch {
    return marcarTodas(new ErrorPublicador('ARCHIVO_NO_ENCONTRADO', 'No existe el video: ' + clip.rutaVideo, false));
  }

  // ---- Redes con API OFICIAL (Graph API). Las cookies/Chromium quedan SOLO de respaldo. ----
  //  Instagram: Graph API si hay IG_ACCESS_TOKEN + IG_USER_ID.
  //  Facebook (decidirFacebook):
  //    crosspost         Instagram va en la misma llamada y el reenvio de Meta Accounts Center esta activo: Facebook sale con el Reel
  //    crosspost_previo  el clip ya esta en Instagram (el reenvio ya ocurrio): no se duplica
  //    directo           FB_PAGE_ACCESS_TOKEN + FB_PAGE_ID: se publica en la Pagina por Graph API
  //    esperar_instagram reenvio activo, sin credenciales de Pagina y el clip aun no salio en Instagram: reintento, NUNCA Chromium
  //    cookies           ninguna API configurada: flujo de siempre
  const resueltas = new Set();
  const ig = o.instagramOficial || instagramOficial;
  const fb = o.facebookOficial || facebookOficial;
  const almacen = o.almacen || almacenDefecto;
  if (modo !== 'seco') {
    const igOficial = plataformas.includes('instagram') && ig.instagramConfigurado();
    if (igOficial) {
      resultados.instagram = await publicarInstagramOficial(clip, { oficial: ig, reloj, almacen });
      resueltas.add('instagram');
    }
    if (plataformas.includes('facebook')) {
      const decision = decidirFacebook({ ig, fb, plataformas, igOficial, clip, almacen });
      if (decision === 'crosspost') {
        const r = resultados.instagram;
        resultados.facebook = r.ok
          ? { ok: true, error: null, codigo: 'CROSSPOST', detalle: 'Reenviado a Facebook por Meta Accounts Center (declarado, no verificable por API)', timestamp: reloj(), transitorio: false, simulado: false, verificado: false }
          : { ...r, detalle: 'Facebook depende de la publicacion en Instagram: ' + String(r.error || '').slice(0, 300) };
        resueltas.add('facebook');
      } else if (decision === 'crosspost_previo') {
        resultados.facebook = { ok: true, error: null, codigo: 'CROSSPOST', detalle: 'El clip ya se publico en Instagram y Meta lo reenvio a Facebook (no se vuelve a publicar)', timestamp: reloj(), transitorio: false, simulado: false, verificado: false };
        resueltas.add('facebook');
      } else if (decision === 'directo') {
        resultados.facebook = await publicarFacebookOficial(clip, { fb, urlPublica: ig.urlPublicaDeClip, reloj, almacen });
        resueltas.add('facebook');
      } else if (decision === 'esperar_instagram') {
        resultados.facebook = fallo(new ErrorPublicador('ESPERANDO_INSTAGRAM', 'Facebook se alimenta del reenvio de Instagram y este clip aun no se publico en Instagram. Programa tambien Instagram o define FB_PAGE_ACCESS_TOKEN y FB_PAGE_ID para publicar directo en la Pagina.', true), reloj);
        resueltas.add('facebook');
      }
    }
  }
  const restantes = plataformas.filter((p) => !resueltas.has(p));
  if (restantes.length === 0) return cerrar();

  let leerCookies = o.leerCookies;
  let obligatorias = o.obligatorias;
  if (!leerCookies || !obligatorias) {
    try {
      const modulo = await import('../sesion/cookiesRedes.js');
      leerCookies ||= modulo.leerCookies;
      obligatorias ||= Object.fromEntries(Object.entries(modulo.REDES).map(([red, def]) => [red, def.obligatorias]));
    } catch (error) {
      return marcarTodas(new ErrorPublicador('SESION_ILEGIBLE', 'No se pudo cargar el modulo de sesiones de redes: ' + error.message, false));
    }
  }

  // La sesion de cada red se comprueba ANTES de abrir el navegador: sin cookies vigentes no hay nada que publicar y
  // Chromium consume cientos de MB. Cada red sin sesion queda con su mensaje claro; si ninguna tiene, no se lanza Chromium.
  const sinSesion = new Set();
  for (const red of restantes) {
    if (!REDES_SOPORTADAS.includes(red)) {
      resultados[red] = fallo(new ErrorPublicador('RED_NO_SOPORTADA', 'Red no soportada: ' + red, false), reloj);
      sinSesion.add(red);
      continue;
    }
    try {
      await cookiesDe(red, { leerCookies, obligatorias });
    } catch (error) {
      resultados[red] = fallo(error, reloj);
      sinSesion.add(red);
    }
  }
  const listas = restantes.filter((red) => !sinSesion.has(red));
  if (listas.length === 0) return cerrar();

  let driver = o.driver;
  let driverPropio = false;
  if (!driver) {
    try {
      const crearDriver = o.crearDriver || (() => crearDriverPlaywright({ azar: o.azar }));
      driver = modo === 'seco' ? crearDriverSeco() : await crearDriver();
      driverPropio = true;
    } catch (error) {
      // Chromium no arranco: las redes que SI tenian sesion quedan con el motivo; las demas conservan el suyo.
      for (const red of listas) resultados[red] = fallo(error, reloj);
      return cerrar();
    }
  }

  const ctx = {
    driver,
    humano,
    leerCookies,
    obligatorias,
    selectores: o.selectores || selectoresEfectivos(),
    timeouts: { pasoMs: 30000, subidaMs: 180000, ...(o.timeouts || {}) },
    reloj,
  };
  // Primera descripcion con texto (una cadena vacia no cuenta): antes un "" publicaba el clip sin descripcion.
  const descEfectiva = descripcionEfectiva(clip);
  const material = { rutaVideo: clip.rutaVideo, texto: armarTexto(descEfectiva, clip.etiquetas) };

  try {
    for (const [i, red] of listas.entries()) {
      if (i > 0) await humano.pausa(...(o.pausaEntreRedes || [1000, 2500]));
      resultados[red] = await publicarEnRed(red, material, ctx);
    }
  } catch (error) {
    // Garantia de "nunca lanza": lo que no llego a intentarse queda marcado con el motivo, el servidor sigue en pie.
    for (const red of listas) if (!resultados[red]) resultados[red] = fallo(error, reloj);
  } finally {
    if (driverPropio) await Promise.resolve(driver.cerrar()).catch(() => {});
  }
  return cerrar();
}
