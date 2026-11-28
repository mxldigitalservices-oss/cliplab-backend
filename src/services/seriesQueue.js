// ---------------------------------------------------------------------------
// Cola ORDENADA de publicacion de series hacia Instagram (Graph API).
//  - Orden estricto: la Parte N+1 NO sale hasta que la Parte N este publicada. Si una parte falla definitivamente, las
//    siguientes quedan retenidas (no se publica una serie con huecos) hasta que se reintente la parte caida.
//  - Sin saturar a Meta: UNA publicacion a la vez, separacion minima entre publicaciones (SERIES_INTERVALO_MIN, 30),
//    tope en 24 h (SERIES_MAX_DIA, 20; maximo duro 50; Meta permite 100 por API) y comprobacion de la cuota real en cada envio.
//  - Reintentos: errores transitorios con backoff exponencial (2 min x 2^n, tope 60 min, SERIES_MAX_INTENTOS = 5). Los limites
//    de Meta (LIMITE_API / LIMITE_PUBLICACION) esperan 30 min y NO gastan intentos. Errores permanentes: la parte queda 'failed'.
//  - Un trabajo 'running' al arrancar = el proceso murio a mitad de publicar: NO se reintenta solo (podria duplicar el Reel).
//  - Persistencia: dataDir/series-queue.json (escritura atomica). Tras publicar se borra el mp4 temporal.
// ---------------------------------------------------------------------------
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { store } from '../storage/store.js';
import { comoAppError } from '../utils/errores.js';
import { limpiarClipPublicado } from '../utils/tmpCleaner.js';
import { publishInstagramReel, urlPublicaDeClip, instagramConfigurado } from './instagramPublisher.js';

const MIN = 60 * 1000;
const num = (v, d) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : d; };
const iso = (ms) => new Date(ms).toISOString();

export function crearColaSeries(o = {}) {
  const ahora = o.ahora || Date.now;
  const env = o.env || process.env;
  const cfg = {
    intervaloMs: num(env.SERIES_INTERVALO_MIN, 30) * MIN,
    maxDia: Math.min(50, Math.max(1, num(env.SERIES_MAX_DIA, 20))),
    maxIntentos: Math.max(1, num(env.SERIES_MAX_INTENTOS, 5)),
    backoffBaseMs: num(env.SERIES_BACKOFF_BASE_MIN, 2) * MIN,
    backoffMaxMs: 60 * MIN,
    esperaLimiteMs: 30 * MIN,
    cicloMs: Math.max(1, num(env.SERIES_CICLO_SEG, 30)) * 1000,
    ...(o.config || {}),
  };
  const rutaJson = o.rutaJson || path.join(config.dataDir, 'series-queue.json');
  const configurado = o.configurado || instagramConfigurado;
  const publicar = o.publicar || (async (item) => publishInstagramReel({ videoUrl: urlPublicaDeClip(item.rutaVideo), caption: item.caption }));
  const limpiar = o.limpiar || limpiarClipPublicado;
  const almacen = o.almacen || store;

  let datos = { items: [], publicaciones: [], ultimaPublicacion: null };
  let cargada = null;
  let ocupado = false;
  let temporizador = null;

  async function guardar() {
    try {
      await fs.mkdir(path.dirname(rutaJson), { recursive: true });
      const tmp = rutaJson + '.' + process.pid + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(datos, null, 1), 'utf8');
      await fs.rename(tmp, rutaJson);
    } catch (error) {
      logger.warn('Cola de series: no se pudo guardar', { mensaje: error.message });
    }
  }

  function cargar() {
    return (cargada ||= (async () => {
      try {
        const leido = JSON.parse(await fs.readFile(rutaJson, 'utf8'));
        if (leido && Array.isArray(leido.items)) datos = { items: leido.items, publicaciones: leido.publicaciones || [], ultimaPublicacion: leido.ultimaPublicacion || null };
      } catch { /* primera vez o archivo ilegible: cola vacia */ }
      let cambio = false;
      for (const it of datos.items) {
        if (it.estado === 'running') {
          it.estado = 'failed';
          it.ultimoError = { codigo: 'INTERRUMPIDO', mensaje: 'El servidor se reinicio durante la publicacion. Revisa Instagram antes de reintentar para no duplicar.', transitorio: false };
          cambio = true;
        }
      }
      if (cambio) await guardar();
    })());
  }

  const pendiente = (it) => it.estado === 'queued' || it.estado === 'running';

  /** Series en orden de llegada; dentro de cada una, por numero de parte. */
  function series() {
    const mapa = new Map();
    for (const it of datos.items) {
      if (!mapa.has(it.serieId)) mapa.set(it.serieId, []);
      mapa.get(it.serieId).push(it);
    }
    return [...mapa.entries()]
      .map(([serieId, items]) => ({ serieId, items: items.sort((a, b) => a.parte - b.parte), creadoEn: Math.min(...items.map((i) => Date.parse(i.creadoEn))) }))
      .sort((a, b) => a.creadoEn - b.creadoEn);
  }

  /** Siguiente parte publicable y, si no hay, el motivo. */
  function elegir(ms) {
    if (!configurado()) return { motivo: 'sin_config' };
    const recientes = datos.publicaciones.filter((t) => t > ms - 24 * 60 * MIN);
    if (recientes.length >= cfg.maxDia) return { motivo: 'tope_diario' };
    if (datos.ultimaPublicacion && ms - datos.ultimaPublicacion < cfg.intervaloMs) return { motivo: 'espaciado', enMs: cfg.intervaloMs - (ms - datos.ultimaPublicacion) };
    let hayAlgoPendiente = false;
    for (const serie of series()) {
      const primera = serie.items.find((it) => it.estado !== 'published' && it.estado !== 'cancelled');
      if (!primera) continue;
      if (primera.estado === 'failed') continue;      // la serie queda retenida hasta reintentar la parte caida
      if (primera.estado !== 'queued') continue;
      hayAlgoPendiente = true;
      if (Date.parse(primera.proximoIntento) <= ms) return { item: primera };
    }
    return { motivo: hayAlgoPendiente ? 'esperando_turno' : 'vacia' };
  }

  async function tick() {
    await cargar();
    if (ocupado) return { ejecutado: false, motivo: 'ocupado' };
    ocupado = true;
    try {
      const ms = ahora();
      const e = elegir(ms);
      if (!e.item) return { ejecutado: false, motivo: e.motivo };
      const it = e.item;
      it.estado = 'running';
      it.intentos += 1;
      it.actualizadoEn = iso(ms);
      await guardar();
      try {
        const r = await publicar(it);
        const fin = ahora();
        it.estado = 'published';
        it.publicadoEn = iso(fin);
        it.resultado = { mediaId: r.mediaId || null, permalink: r.permalink || null };
        it.ultimoError = null;
        datos.ultimaPublicacion = fin;
        datos.publicaciones = [...datos.publicaciones.filter((t) => t > fin - 24 * 60 * MIN), fin];
        try {
          almacen.actualizar(it.clipId, { estado: 'publicado', publicadoEn: iso(fin), instagram: { ...it.resultado, publicadoEn: iso(fin) }, plataformas: ['instagram'] });
        } catch { /* el clip pudo archivarse */ }
        await limpiar({ rutaVideo: it.rutaVideo, almacen });
      } catch (error) {
        const err = comoAppError(error);
        const fin = ahora();
        it.ultimoError = { codigo: err.codigo, mensaje: err.message, transitorio: err.transitorio };
        if (err.transitorio) {
          const esLimite = err.codigo === 'LIMITE_API' || err.codigo === 'LIMITE_PUBLICACION';
          if (esLimite) it.intentos -= 1;              // los limites de Meta no cuentan como intento
          if (it.intentos >= cfg.maxIntentos) it.estado = 'failed';
          else {
            const espera = esLimite ? cfg.esperaLimiteMs : Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * 2 ** Math.max(0, it.intentos - 1));
            it.estado = 'queued';
            it.proximoIntento = iso(fin + espera + Math.round(espera * 0.1 * Math.random()));
          }
        } else {
          it.estado = 'failed';
        }
        logger.warn('Cola de series: publicacion fallida', { serieId: it.serieId, parte: it.parte, codigo: err.codigo, estado: it.estado });
      }
      it.actualizadoEn = iso(ahora());
      await guardar();
      return { ejecutado: true, itemId: it.id, estado: it.estado };
    } finally {
      ocupado = false;
    }
  }

  /** Encola una serie ya renderizada. `inicio` (ISO) = primera publicacion (por defecto, ahora). */
  function encolarSerie({ serieId, titulo = '', episodios, inicio, intervaloMin }) {
    if (!Array.isArray(episodios) || episodios.length === 0) throw new Error('La serie no tiene episodios');
    const ms = ahora();
    const empieza = inicio && Number.isFinite(Date.parse(inicio)) ? Math.max(ms, Date.parse(inicio)) : ms;
    const paso = (Number.isFinite(Number(intervaloMin)) && Number(intervaloMin) > 0 ? Number(intervaloMin) * MIN : cfg.intervaloMs);
    const creados = episodios.map((ep, i) => ({
      id: 'sq_' + crypto.randomBytes(4).toString('hex'), serieId, titulo, parte: ep.parte ?? i + 1, total: ep.total ?? episodios.length,
      clipId: ep.clipId, rutaVideo: ep.rutaVideo, caption: ep.caption, estado: 'queued', intentos: 0,
      proximoIntento: iso(empieza + i * Math.max(paso, cfg.intervaloMs)),   // pista de horario; el orden y el espaciado los garantiza elegir()
      creadoEn: iso(ms), actualizadoEn: iso(ms), publicadoEn: null, resultado: null, ultimoError: null,
    }));
    datos.items.push(...creados);
    guardar();
    return { serieId, partes: creados.length, primeraPublicacion: creados[0].proximoIntento, ultimaPublicacion: creados[creados.length - 1].proximoIntento };
  }

  function listar({ serieId } = {}) {
    return datos.items.filter((it) => !serieId || it.serieId === serieId).map((it) => ({ ...it, rutaVideo: undefined }));
  }

  function estado() {
    const ms = ahora();
    const sers = series().map((s) => ({
      serieId: s.serieId, titulo: s.items[0].titulo, total: s.items[0].total,
      publicadas: s.items.filter((i) => i.estado === 'published').length,
      retenida: s.items.some((i) => i.estado === 'failed'),
      partes: s.items.map((i) => ({ id: i.id, parte: i.parte, estado: i.estado, intentos: i.intentos, proximoIntento: i.proximoIntento, error: i.ultimoError ? i.ultimoError.mensaje : null, permalink: i.resultado ? i.resultado.permalink : null })),
    }));
    const e = elegir(ms);
    return {
      activa: Boolean(temporizador), configurado: configurado(), series: sers,
      publicadasEn24h: datos.publicaciones.filter((t) => t > ms - 24 * 60 * MIN).length, topeDiario: cfg.maxDia,
      intervaloMin: Math.round(cfg.intervaloMs / MIN), proxima: e.item ? { id: e.item.id, serieId: e.item.serieId, parte: e.item.parte } : { motivo: e.motivo },
    };
  }

  async function cancelarSerie(serieId) {
    await cargar();
    let n = 0;
    for (const it of datos.items) if (it.serieId === serieId && it.estado === 'queued') { it.estado = 'cancelled'; it.actualizadoEn = iso(ahora()); n += 1; }
    if (n) await guardar();
    return n;
  }

  async function reintentar(itemId) {
    await cargar();
    const it = datos.items.find((x) => x.id === itemId);
    if (!it || it.estado !== 'failed') return null;
    it.estado = 'queued';
    it.intentos = 0;
    it.proximoIntento = iso(ahora());
    it.actualizadoEn = iso(ahora());
    await guardar();
    return { ...it, rutaVideo: undefined };
  }

  /** Nombres de archivo en /clips que aun se van a publicar (el barrido de temporales no debe borrarlos). */
  function rutasPendientes() {
    return new Set(datos.items.filter(pendiente).map((it) => path.basename(it.rutaVideo || '')).filter(Boolean));
  }

  function iniciar() {
    if (temporizador) return;
    cargar().then(() => {
      temporizador = setInterval(() => tick().catch((error) => logger.warn('Cola de series: fallo en el ciclo', { mensaje: error.message })), cfg.cicloMs);
      temporizador.unref?.();
    });
  }
  function detener() { clearInterval(temporizador); temporizador = null; }

  return { encolarSerie, tick, listar, estado, cancelarSerie, reintentar, rutasPendientes, iniciar, detener, cargar };
}

export const colaSeries = crearColaSeries();
export default colaSeries;
