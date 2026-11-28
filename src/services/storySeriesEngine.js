// ---------------------------------------------------------------------------
// Historias seriadas: un video largo -> episodios verticales (9:16) de EXACTAMENTE 60 s, con cortes limpios de frase.
//
//  Como se logran "60 s exactos" Y "cortes limpios" a la vez:
//    1) El episodio empieza en una palabra (con 0.2 s de aire) y termina en el ULTIMO final de frase que cabe en 60 s
//       (+0.25 s de respiro), usando los timestamps de whisper.cpp. Si no hay frase que cierre dentro de la tolerancia
//       (SERIE_MAX_RELLENO_SEG, 6 s) se corta en la mejor pausa; solo si tampoco hay pausa se corta "duro" a los 60 s
//       (tipoCorte = 'duro', corteLimpio = false: queda registrado).
//    2) Lo que sobra hasta los 60.000 s se completa con el ultimo cuadro congelado y silencio (render.js: duracionExacta).
//    3) El episodio siguiente arranca en la primera palabra despues del corte: no se pierde contenido.
//  Encuadre 9:16: renderizarClip() (FFmpeg) con seguimiento del sujeto por OpenCV (scripts/sujeto.py) y subtitulos.
//  Cada episodio lleva metadatos seriados (series_id, part_number, total_parts, caption_con_gancho) y, opcionalmente,
//  se entrega a la cola ordenada de publicacion (seriesQueue.js) hacia Instagram.
//
//  El plan (planificarSerie / metadatosSerie) es PURO: no toca disco ni red.
// ---------------------------------------------------------------------------
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { store as storeDefecto } from '../storage/store.js';
import { dividirFrases } from '../engine/curador.js';
import { renderizarClip } from '../engine/render.js';
import { escribirAss } from '../engine/subtitles.js';
import { construirAssEstilo } from '../estilos-subtitulos.js';
import { perfilesDeTrabajo } from '../engine/rotacion-flujo.js';
import { AppError } from '../utils/errores.js';
import { borrarSeguro } from '../utils/tmpCleaner.js';
import colaSeries from './seriesQueue.js';

const num = (nombre, defecto) => {
  const n = Number(process.env[nombre]);
  return process.env[nombre] !== undefined && process.env[nombre] !== '' && Number.isFinite(n) && n >= 0 ? n : defecto;
};
export const SERIE = Object.freeze({
  DURACION: 60,
  COLCHON_INICIO: 0.2,   // aire antes de la primera palabra del episodio
  COLCHON_FIN: 0.25,     // respiro despues de la ultima palabra
  PAUSA_MIN: 0.25,       // hueco entre palabras que se acepta como corte de respaldo
});
const redondear = (x) => Math.round(x * 1000) / 1000;

/**
 * Plan de episodios. `palabras` = [{ texto, inicio, fin }] de whisper (segundos del video fuente).
 * @returns {{ episodios: object[], omitido: {desde:number,hasta:number,segundos:number}|null, sinVoz: boolean }}
 */
export function planificarSerie({
  palabras, duracionVideo, duracion = SERIE.DURACION,
  maxRelleno = num('SERIE_MAX_RELLENO_SEG', 6), minUltimo = num('SERIE_MIN_ULTIMO_SEG', 20), maxPartes = num('SERIE_MAX_PARTES', 30),
} = {}) {
  const total = Number(duracionVideo);
  if (!Number.isFinite(total) || total <= 0) throw new AppError('Se necesita la duracion del video para dividirlo en una serie.', { status: 422, codigo: 'SIN_DURACION' });
  const { lista, frases } = dividirFrases(Array.isArray(palabras) ? palabras : []);
  const episodios = [];
  let omitido = null;

  // Sin voz: ventanas fijas de 60 s (todas con corte "duro").
  if (lista.length === 0) {
    for (let s = 0; s < total && episodios.length < maxPartes; s += duracion) {
      const e = Math.min(s + duracion, total);
      if (e - s < minUltimo && episodios.length > 0) { omitido = { desde: redondear(s), hasta: redondear(e), segundos: redondear(e - s) }; break; }
      episodios.push({ parte: episodios.length + 1, inicio: redondear(s), fin: redondear(e), contenido: redondear(e - s), relleno: redondear(duracion - (e - s)), duracion, tipoCorte: 'duro', corteLimpio: false, ultimo: false, gancho: '', palabras: [] });
    }
    if (episodios.length) episodios[episodios.length - 1].ultimo = true;
    return { episodios, omitido, sinVoz: true };
  }

  const finVoz = lista[lista.length - 1].fin;
  // Candidatos de corte: finales de frase (preferidos) y pausas entre palabras (respaldo).
  const cortes = [];
  frases.forEach((f, i) => cortes.push({ fin: f.fin, sig: frases[i + 1] ? frases[i + 1].inicio : Infinity, tipo: 'frase' }));
  for (let k = 0; k < lista.length - 1; k++) {
    const hueco = lista[k + 1].inicio - lista[k].fin;
    if (hueco >= SERIE.PAUSA_MIN && !cortes.some((c) => c.tipo === 'frase' && Math.abs(c.fin - lista[k].fin) < 0.001)) {
      cortes.push({ fin: lista[k].fin, sig: lista[k + 1].inicio, tipo: 'pausa' });
    }
  }
  cortes.sort((a, b) => a.fin - b.fin);

  let inicio = lista[0].inicio < 3 ? 0 : Math.max(0, lista[0].inicio - 0.5);
  while (episodios.length < maxPartes && inicio < finVoz - 0.05) {
    const limite = Math.min(inicio + duracion, total);
    const cabe = (c) => c.fin > inicio && c.fin + SERIE.COLCHON_FIN <= limite + 1e-6 && limite - (c.fin + SERIE.COLCHON_FIN) <= maxRelleno + 1e-6;
    const mejor = (tipo) => cortes.filter((c) => c.tipo === tipo && cabe(c)).pop();
    const queda = finVoz + SERIE.COLCHON_FIN <= limite + 1e-6;   // todo lo que falta de voz cabe en este episodio

    let fin;
    let tipoCorte;
    if (queda) {
      fin = Math.min(finVoz + SERIE.COLCHON_FIN, total);
      tipoCorte = 'final';
    } else {
      const c = mejor('frase') || mejor('pausa');
      if (c) {
        fin = Math.max(c.fin, Math.min(c.fin + SERIE.COLCHON_FIN, c.sig - 0.03));
        tipoCorte = c.tipo;
      } else {
        fin = limite;
        tipoCorte = 'duro';
      }
    }
    const contenido = fin - inicio;
    const esUltimo = tipoCorte === 'final' || fin >= finVoz - 0.001;
    if (esUltimo && contenido < minUltimo && episodios.length > 0) {
      omitido = { desde: redondear(inicio), hasta: redondear(fin), segundos: redondear(contenido) };   // resto demasiado corto: no vale un episodio
      break;
    }
    const dentro = lista.filter((w) => w.fin > inicio && w.inicio < fin);
    const delEpisodio = frases.filter((f) => f.inicio >= inicio - 0.05 && f.inicio < Math.min(fin, inicio + 25));
    const elegida = delEpisodio.length
      ? delEpisodio.reduce((m, f) => ((f.gancho || 0) + (f.interes || 0) + (f.pregunta ? 2 : 0) > (m.gancho || 0) + (m.interes || 0) + (m.pregunta ? 2 : 0) ? f : m), delEpisodio[0])
      : null;
    episodios.push({
      parte: episodios.length + 1,
      inicio: redondear(inicio),
      fin: redondear(fin),
      contenido: redondear(contenido),
      relleno: redondear(Math.max(0, duracion - contenido)),
      duracion,
      tipoCorte,
      corteLimpio: tipoCorte !== 'duro',
      ultimo: esUltimo,
      gancho: elegida ? recortarFrase(elegida.texto) : '',
      palabras: dentro.map((w) => ({ texto: w.texto, inicio: redondear(Math.max(0, w.inicio - inicio)), fin: redondear(Math.min(contenido, w.fin - inicio)) })),
    });
    if (esUltimo) break;
    const siguiente = lista.find((w) => w.inicio >= fin - 0.02);
    if (!siguiente) break;
    inicio = Math.max(fin, siguiente.inicio - SERIE.COLCHON_INICIO);
  }
  if (episodios.length && !episodios[episodios.length - 1].ultimo && episodios.length < maxPartes) episodios[episodios.length - 1].ultimo = true;
  if (episodios.length >= maxPartes) {
    const resto = finVoz - episodios[episodios.length - 1].fin;
    if (resto > minUltimo) omitido = { desde: episodios[episodios.length - 1].fin, hasta: redondear(finVoz), segundos: redondear(resto) };
  }
  return { episodios, omitido, sinVoz: false };
}

function recortarFrase(texto, max = 90) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const base = t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') + '…' : t;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

const limpiarTitulo = (titulo, max = 80) => {
  const t = String(titulo || 'Historia').replace(/\s+/g, ' ').trim() || 'Historia';
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') : t;
};

/**
 * Metadatos seriados. `caption_con_gancho` sigue el formato: "Parte 1/5 — <Titulo> | Sigue para la Parte 2".
 * `caption` es el texto completo para publicar (titular + gancho del episodio + hashtags).
 */
export function metadatosSerie({ titulo, episodios, serieId, hashtags = ['#historias', '#serie', '#parati'] } = {}) {
  const total = episodios.length;
  const t = limpiarTitulo(titulo);
  const etiquetas = [...new Set((hashtags || []).map((h) => '#' + String(h).replace(/[^\p{L}\p{N}_]/gu, '')).filter((h) => h.length > 1))].slice(0, 10);
  return episodios.map((ep) => {
    const n = ep.parte;
    const cierre = n < total ? 'Sigue para la Parte ' + (n + 1) : 'Fin de la serie';
    const caption_con_gancho = 'Parte ' + n + '/' + total + ' — ' + t + ' | ' + cierre;
    return {
      series_id: serieId,
      part_number: n,
      total_parts: total,
      titulo_parte: 'Parte ' + n + '/' + total + ' — ' + t,
      caption_con_gancho,
      gancho: ep.gancho || '',
      hashtags: etiquetas,
      caption: [caption_con_gancho, ep.gancho ? '“' + ep.gancho.replace(/…$/, '') + '”' : '', etiquetas.join(' ')].filter(Boolean).join('\n\n'),
      cta: cierre,
    };
  });
}

/**
 * Corre una serie completa dentro de un trabajo de la cola normal (ya con el video descargado/validado).
 * Todo o nada: si un episodio falla se borran los demas (una serie con huecos rompe el orden de publicacion).
 */
export async function procesarSerie({
  trabajo, video, dirTrabajo, signal, transcribir, avanceDe, avanzarJob = () => {},
  almacen = storeDefecto, cola = colaSeries, renderizar = renderizarClip, perfiles = perfilesDeTrabajo, clipsDir = config.clipsDir,
}) {
  const opciones = trabajo.serie || {};
  const duracion = SERIE.DURACION;
  if (!video.duracion) throw new AppError('No se pudo leer la duracion del video.', { status: 422, codigo: 'SIN_DURACION' });
  if (video.duracion > config.maxVideoSeconds) throw new AppError('El video supera el maximo de ' + config.maxVideoSeconds + ' s.', { status: 422, codigo: 'VIDEO_LARGO' });
  if (config.maxClipSeconds < duracion) throw new AppError('MAX_CLIP_SECONDS debe ser al menos ' + duracion + ' para generar episodios de ' + duracion + ' s.', { status: 500, codigo: 'CONFIG' });

  avanzarJob('Transcribiendo video completo', 30);
  const palabras = await transcribir();
  avanzarJob('Planificando episodios', 55);
  const plan = planificarSerie({ palabras, duracionVideo: video.duracion });
  if (plan.episodios.length < 2) {
    throw new AppError('El video da para ' + plan.episodios.length + ' episodio(s) de ' + duracion + ' s; una serie necesita al menos 2.', { status: 422, codigo: 'SERIE_CORTA' });
  }
  const serieId = 'serie_' + crypto.randomBytes(4).toString('hex');
  const tituloSerie = opciones.titulo || video.titulo;
  const meta = metadatosSerie({ titulo: tituloSerie, episodios: plan.episodios, serieId, hashtags: opciones.hashtags });
  const total = plan.episodios.length;
  const perfil = await perfiles(trabajo, total);

  // Un registro de clip por episodio (el primero reutiliza el del trabajo).
  const registros = plan.episodios.map((ep, i) => {
    const base = {
      titulo: meta[i].titulo_parte,
      serie: { series_id: serieId, part_number: ep.parte, total_parts: total, caption: meta[i].caption, caption_con_gancho: meta[i].caption_con_gancho },
      segmento: { indice: ep.parte, total, inicio: ep.inicio, duracion },
      ...(perfil[i].estilo ? { estiloSubtitulos: perfil[i].estilo } : {}),
      ...(perfil[i].modo ? { modo: perfil[i].modo } : {}),
    };
    if (i === 0) {
      almacen.actualizar(trabajo.id, { ...base, etapa: 'En cola (parte 1/' + total + ')' });
      return almacen.buscar(trabajo.id);
    }
    return almacen.crearHijo(trabajo.id, { ...base, etapa: 'En cola (parte ' + ep.parte + '/' + total + ')' });
  });

  const hechos = [];   // { clipId, salida }
  try {
    for (let i = 0; i < total; i += 1) {
      if (signal && signal.aborted) throw new Error('Trabajo cancelado');
      const ep = plan.episodios[i];
      const clipId = registros[i].id;
      const avanzar = avanceDe ? avanceDe(clipId) : () => {};
      const dirEp = path.join(dirTrabajo, 'ep-' + ep.parte);
      const token = crypto.randomBytes(16).toString('hex');
      const salida = path.join(clipsDir, token + '.mp4');
      try {
        await fs.mkdir(dirEp, { recursive: true });
        avanzar('Subtitulos (parte ' + ep.parte + '/' + total + ')', 56);
        let subtitulos = null;
        if (ep.palabras.length > 0) {
          const rutaAss = path.join(dirEp, 'subtitulos.ass');
          if (perfil[i].estilo) {
            await fs.writeFile(rutaAss, construirAssEstilo(ep.palabras.map((p) => ({ t: p.texto, i: p.inicio, f: p.fin })), { estilo: perfil[i].estilo, ancho: 1080, alto: 1920, fuente: config.subtitleFont, tamano: 96, margenV: 560 }), 'utf8');
            subtitulos = rutaAss;
          } else {
            subtitulos = await escribirAss(ep.palabras, rutaAss);
          }
        }
        avanzar('Renderizando 9:16 (parte ' + ep.parte + '/' + total + ')', 60);
        const r = await renderizar({
          entrada: video.archivo, salida, inicio: ep.inicio, duracion: ep.contenido, subtitulos, modo: perfil[i].modo,
          cortes: [{ desde: 0, hasta: ep.contenido, plano: 'medio' }],   // un solo plano: activa el seguimiento del sujeto (OpenCV)
          duracionExacta: duracion, signal, onProgreso: (f) => avanzar('Renderizando 9:16 (parte ' + ep.parte + '/' + total + ')', 60 + f * 37),
        });
        hechos.push({ clipId, salida });
        if (Number.isFinite(r.duracion) && Math.abs(r.duracion - duracion) > 0.25) {
          store_warn(almacen, 'La parte ' + ep.parte + ' de la serie midio ' + r.duracion + ' s (se esperaban ' + duracion + ' s)', serieId);
        }
        const m = meta[i];
        const ficha = { titulo: m.titulo_parte, descripcion: m.caption, cta: m.cta, hashtags: m.hashtags, nicho: 'historia_seriada' };
        almacen.completar(clipId, {
          url: '/clips/' + token + '.mp4', duracion: r.duracion, bytes: r.bytes, ancho: r.ancho, alto: r.alto, modo: perfil[i].modo,
          inicio: ep.inicio, conLogo: r.conLogo, transcripcion: ep.palabras.map((p) => p.texto).join(' '), ficha,
          marketing: { titulo: m.titulo_parte, descripcion: m.caption, cta: m.cta, hashtags: m.hashtags, nicho: 'historia_seriada', version: 2, generadoEn: new Date().toISOString() },
          copy: m.caption, cta: m.cta,
          serie: { series_id: serieId, part_number: ep.parte, total_parts: total, caption: m.caption, caption_con_gancho: m.caption_con_gancho, tipoCorte: ep.tipoCorte, corteLimpio: ep.corteLimpio },
        });
      } finally {
        await borrarSeguro(dirEp, [dirTrabajo]);   // subtitulos y temporales del episodio, pase lo que pase
      }
    }
  } catch (error) {
    // Todo o nada: se quitan los episodios ya renderizados y se marca la serie entera como fallida.
    for (const h of hechos) await borrarSeguro(h.salida, [clipsDir]);
    for (const reg of registros) {
      try { almacen.fallar(reg.id, 'Serie cancelada: ' + error.message, ''); } catch { /* ya estaba cerrado */ }
    }
    throw error;
  }

  let publicacion = null;
  if (opciones.publicarInstagram === true) {
    publicacion = cola.encolarSerie({
      serieId, titulo: limpiarTitulo(tituloSerie), inicio: opciones.inicioPublicacion, intervaloMin: opciones.intervaloMin,
      episodios: registros.map((reg, i) => ({ clipId: reg.id, parte: i + 1, total, rutaVideo: path.join(clipsDir, path.basename(almacen.buscar(reg.id).url)), caption: meta[i].caption })),
    });
  }
  logger.info('Serie generada', { serieId, partes: total, omitido: plan.omitido, publicacion: Boolean(publicacion) });
  return { serieId, partes: total, omitido: plan.omitido, publicacion };
}

function store_warn(almacen, mensaje, serieId) {
  try { almacen.registrarIncidencia('warn', mensaje, 'serie', serieId); } catch { /* informativo */ }
}
