import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { store } from '../storage/store.js';
import { descargarVideo } from './download.js';
import { transcribirAudio } from './transcribe.js';
import { escribirAss } from './subtitles.js';
import { renderizarClip } from './render.js';
import { planificarSegmentos, leerHistorial, registrarPasada } from './segmentos.js';
import { generarMarketing } from './marketing.js';
import { enriquecerClip } from './cerebro-marketing.js';
import { ajustarAFrases, cortesEnCaliente, planDePlanos } from './editorial.js';
import { AJUSTES, curarVideo, fichaDeVentana, armarRevisionTecnica } from './curador.js';
import { detalleDeError } from '../utils/run.js';
import { borrarUpload } from '../upload.js';
import { construirAssEstilo } from '../estilos-subtitulos.js';
import { perfilesDeTrabajo } from './rotacion-flujo.js';

let avisoLogo = false;

function crearAvance(id) {
  let ultimoProgreso = 0;
  let ultimaEtapa = '';

  return (etapa, valor) => {
    const progreso = Math.max(ultimoProgreso, Math.min(99, Math.round(valor)));
    if (progreso === ultimoProgreso && etapa === ultimaEtapa) return;
    ultimoProgreso = progreso;
    ultimaEtapa = etapa;
    store.actualizar(id, { etapa, progreso });
  };
}

function registrarTiempo(id, etapa, inicioMs) {
  logger.info('Etapa completada', {
    id,
    etapa,
    segundos: Math.round((Date.now() - inicioMs) / 100) / 10,
  });
}

async function podarClips() {
  let archivos;
  try {
    archivos = await fs.readdir(config.clipsDir);
  } catch {
    return;
  }

  const videos = [];
  for (const nombre of archivos) {
    if (!nombre.endsWith('.mp4')) continue;
    try {
      const info = await fs.stat(path.join(config.clipsDir, nombre));
      videos.push({ nombre, modificado: info.mtimeMs });
    } catch {
      // El archivo desaparecio mientras se listaba: se ignora.
    }
  }

  videos.sort((a, b) => b.modificado - a.modificado);
  for (const viejo of videos.slice(config.maxClipsStored)) {
    await fs.rm(path.join(config.clipsDir, viejo.nombre), { force: true });
    store.retirarVideo('/clips/' + viejo.nombre);
  }
}

/** Directorio de trabajo exclusivo del job: tmp/jobs/<id>. Nunca se comparte con otro trabajo. */
export function directorioDeTrabajo(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id))) {
    throw new Error('Identificador de trabajo invalido: ' + id);
  }
  const raiz = path.resolve(config.tmpDir, 'jobs');
  const dir = path.resolve(raiz, String(id));
  if (path.dirname(dir) !== raiz) {
    throw new Error('Directorio de trabajo fuera de la zona permitida');
  }
  return dir;
}

function etiquetaSegmento(indice, total) {
  return total > 1 ? ' (clip ' + indice + '/' + total + ')' : '';
}

// ---------------------------------------------------------------------------
// Transcripcion del video completo (una sola vez, por trozos) con cache en disco por video.
// El curador necesita el texto de TODO el video; los clips reutilizan estas palabras en vez de volver a transcribir.
// ---------------------------------------------------------------------------

const ID_CACHE = /^[A-Za-z0-9_-]{3,64}$/;
const MAX_CACHE_ASR = 30;
const rutaCacheAsr = (id) => path.join(config.dataDir, 'transcripciones', id + '.json');

async function leerCacheAsr(video) {
  if (!ID_CACHE.test(String(video.id))) return null;
  try {
    const datos = JSON.parse(await fs.readFile(rutaCacheAsr(video.id), 'utf8'));
    if (datos && datos.version === 1 && Array.isArray(datos.palabras) && Math.abs(Number(datos.duracion) - video.duracion) <= 2) {
      return datos.palabras.map(([texto, inicio, fin]) => ({ texto, inicio, fin }));
    }
  } catch {
    // Sin cache o ilegible: se transcribe de nuevo.
  }
  return null;
}

async function guardarCacheAsr(video, palabras) {
  if (!ID_CACHE.test(String(video.id)) || palabras.length === 0) return;
  try {
    const ruta = rutaCacheAsr(video.id);
    await fs.mkdir(path.dirname(ruta), { recursive: true });
    const temporal = ruta + '.' + process.pid + '.tmp';
    const compactas = palabras.map((p) => [p.texto, Math.round(p.inicio * 100) / 100, Math.round(p.fin * 100) / 100]);
    await fs.writeFile(temporal, JSON.stringify({ version: 1, duracion: video.duracion, palabras: compactas }));
    await fs.rename(temporal, ruta);

    const nombres = (await fs.readdir(path.dirname(ruta))).filter((n) => n.endsWith('.json'));
    const info = [];
    for (const nombre of nombres) {
      try {
        info.push({ nombre, modificado: (await fs.stat(path.join(path.dirname(ruta), nombre))).mtimeMs });
      } catch {
        // desaparecio mientras se listaba
      }
    }
    info.sort((a, b) => b.modificado - a.modificado);
    for (const viejo of info.slice(MAX_CACHE_ASR)) await fs.rm(path.join(path.dirname(ruta), viejo.nombre), { force: true });
  } catch (error) {
    logger.warn('No se pudo guardar la transcripcion en cache', { mensaje: error.message });
  }
}

async function transcribirFuente(video, dirTrabajo, { signal, onProgreso }) {
  const cache = await leerCacheAsr(video);
  if (cache) {
    logger.info('Transcripcion del video tomada de la cache', { id: video.id, palabras: cache.length });
    return cache;
  }

  const trozo = AJUSTES.trozoAsrSeg;
  const trozos = Math.max(1, Math.ceil(video.duracion / trozo));
  const palabras = [];
  for (let k = 0; k < trozos; k++) {
    if (signal && signal.aborted) throw new Error('Trabajo cancelado');
    const desde = k * trozo;
    const largo = Math.min(trozo, video.duracion - desde);
    if (largo < 1) break;
    const parte = await transcribirAudio(video.archivo, path.join(dirTrabajo, 'asr'), {
      inicio: desde,
      duracion: largo,
      signal,
      onProgreso: (fraccion) => onProgreso((k + fraccion) / trozos),
    });
    for (const p of parte) palabras.push({ texto: p.texto, inicio: p.inicio + desde, fin: p.fin + desde });
  }
  await guardarCacheAsr(video, palabras);
  return palabras;
}

/** Palabras de la transcripcion completa que caen dentro de [base, base + largo], con tiempos relativos a `base`. */
function recortarPalabras(palabras, base, largo) {
  const fin = base + largo;
  return palabras
    .filter((p) => p.fin > base && p.inicio < fin)
    .map((p) => ({ texto: p.texto, inicio: Math.max(0, p.inicio - base), fin: Math.min(largo, p.fin - base) }));
}

// `perfil` = { estilo, modo } ya resuelto para ESTE clip (valor manual del trabajo o el que le toco en la rotacion ciclica).
async function procesarSegmento({ clipId, trabajo, video, segmento, indice, total, dirSegmento, palabrasFuente, perfil, signal }) {
  const avanzar = crearAvance(clipId);
  const { inicio, duracion } = segmento;
  const token = crypto.randomBytes(16).toString('hex');
  const salida = path.join(config.clipsDir, token + '.mp4');
  let exito = false;

  try {
    await fs.mkdir(dirSegmento, { recursive: true });

    // Transcripcion (30-55 %): si el video completo ya se transcribio se reutiliza; si no, se transcribe esta ventana.
    let marca = Date.now();
    // Con criterio editorial se toma una ventana con colchon para poder arrancar y cerrar en frases completas.
    // Un clip curado ya viene alineado a frases, asi que solo necesita 1 s de colchon.
    const curado = Boolean(segmento.ficha);
    const editorial = config.editorialEnabled && Boolean(video.duracion);
    const colchon = curado ? 1 : config.editorialPad;
    const base = editorial ? Math.max(0, inicio - colchon) : inicio;
    const largoVentana = editorial
      ? Math.min(Math.min(video.duracion, inicio + duracion + colchon) - base, config.maxClipSeconds)
      : duracion;
    let palabrasVentana;
    if (palabrasFuente) {
      avanzar('Preparando subtitulos', 40);
      palabrasVentana = recortarPalabras(palabrasFuente, base, largoVentana);
    } else {
      avanzar('Transcribiendo audio', 30);
      palabrasVentana = await transcribirAudio(video.archivo, dirSegmento, {
        inicio: base,
        duracion: largoVentana,
        signal,
        onProgreso: (fraccion) => avanzar('Transcribiendo audio', 30 + fraccion * 25),
      });
    }
    registrarTiempo(clipId, 'transcripcion', marca);

    let palabras = palabrasVentana;
    let cortes = null;
    let inicioReal = inicio;
    if (editorial && palabrasVentana.length >= 3) {
      const ajuste = curado
        ? { inicio: inicio - base, fin: inicio - base + duracion, ajustado: false }
        : ajustarAFrases(palabrasVentana, {
          objetivoInicio: inicio - base,
          objetivoFin: inicio - base + duracion,
          minSeg: Math.min(config.segmentMinSeconds, duracion),
          maxSeg: Math.min(config.maxClipSeconds - 2, config.segmentMaxSeconds + config.editorialPad),
        });
      const caliente = cortesEnCaliente(palabrasVentana, { desde: ajuste.inicio, hasta: Math.min(ajuste.fin, largoVentana) });
      if (caliente.tramos.length > 0) {
        cortes = planDePlanos(caliente.tramos, palabrasVentana);
        palabras = caliente.palabras;
        inicioReal = base + ajuste.inicio;
        logger.info('Plan editorial', {
          id: clipId,
          curado,
          ajustadoAFrases: ajuste.ajustado,
          beats: cortes.length,
          pausasEliminadasSeg: Math.round(caliente.eliminado * 10) / 10,
        });
      }
    }

    // Subtitulos (55-60 %)
    avanzar('Generando subtitulos', 56);
    let subtitulos = null;
    if (palabras.length > 0) {
      const rutaAss = path.join(dirSegmento, 'subtitulos.ass');
      if (perfil.estilo) {
        // Estilo manual o de la rotacion (dinamico | clasico | minimal); sin estilo se conserva el subtitulado de siempre.
        await fs.writeFile(rutaAss, construirAssEstilo(
          palabras.map((p) => ({ t: p.texto, i: p.inicio, f: p.fin })),
          { estilo: perfil.estilo, ancho: 1080, alto: 1920, fuente: config.subtitleFont, tamano: 96, margenV: 560 }
        ), 'utf8');
        subtitulos = rutaAss;
      } else {
        subtitulos = await escribirAss(palabras, rutaAss);
      }
    } else {
      store.registrarIncidencia(
        'warn',
        'No se detecto voz en "' + video.titulo + '"' + etiquetaSegmento(indice, total) + '; el clip se genero sin subtitulos',
        'pipeline'
      );
    }

    // Render 9:16 con logo (60-97 %)
    marca = Date.now();
    avanzar('Renderizando 9:16', 60);
    const resultado = await renderizarClip({
      entrada: video.archivo,
      salida,
      inicio: cortes ? base : inicio,
      duracion: cortes ? largoVentana : duracion,
      subtitulos,
      modo: perfil.modo,
      cortes,
      signal,
      onProgreso: (fraccion) => avanzar('Renderizando 9:16', 60 + fraccion * 37),
    });
    registrarTiempo(clipId, 'render', marca);

    if (resultado.logoOmitido && !avisoLogo) {
      avisoLogo = true;
      store.registrarIncidencia(
        'warn',
        'No se encontro el logo de Klikap (' + config.logoPath + '): los clips salen sin marca de agua',
        'render'
      );
    }

    // Ficha del clip (gancho, flujo, valor, interes, puntaje, titulo, descripcion, revisionTecnica) y metadatos de
    // marketing. Un fallo aqui no tumba el clip.
    const transcripcion = palabras.map((p) => p.texto).join(' ');
    let marketing = null;
    let ficha = null;
    try {
      ficha = segmento.ficha
        ? { ...segmento.ficha }
        : fichaDeVentana({ palabras, tituloVideo: video.titulo, semilla: clipId + '|' + inicio, indice, total });
      ficha.revisionTecnica = armarRevisionTecnica({
        modo: perfil.modo,
        duracion: resultado.duracion,
        resultado,
        analisis: resultado.analisis,
        palabras: palabras.length,
        cpu: { preset: resultado.preset, hilos: resultado.hilos },
      });
      marketing = { titulo: ficha.titulo, descripcion: ficha.descripcion, cta: ficha.cta, hashtags: ficha.hashtags, nicho: ficha.nicho, version: 2, generadoEn: new Date().toISOString() };
    } catch (error) {
      store.registrarIncidencia('warn', 'No se pudo armar la ficha del clip', 'curador', detalleDeError(error));
      try {
        marketing = generarMarketing({ tituloVideo: video.titulo, transcripcion, semilla: clipId + '|' + inicio, indice, total });
      } catch (errorMarketing) {
        store.registrarIncidencia('warn', 'No se pudieron generar los metadatos de marketing del clip', 'marketing', detalleDeError(errorMarketing));
      }
    }

    // Cerebro de marketing: angulo (incluye reality y chisme), puntaje y veredicto del clip. Ollama es opcional y solo se
    // consulta si OLLAMA_MODEL esta definido; sin el, el analisis es 100 % local. Un fallo aqui no tumba el clip.
    {
      const mejorado = await enriquecerClip(
        { ficha, marketing, transcripcion, duracion: resultado.duracion, instruccion: trabajo.instruccion || '', tituloVideo: video.titulo },
        { ollama: Boolean(process.env.OLLAMA_MODEL) }
      );
      ficha = mejorado.ficha;
      marketing = mejorado.marketing;
    }

    store.completar(clipId, {
      url: '/clips/' + token + '.mp4',
      duracion: resultado.duracion,
      bytes: resultado.bytes,
      ancho: resultado.ancho,
      alto: resultado.alto,
      modo: perfil.modo,
      inicio: inicioReal,
      conLogo: resultado.conLogo,
      transcripcion,
      ficha,
      marketing,
      copy: ficha ? ficha.descripcion : marketing ? marketing.descripcion + '\n\n' + marketing.hashtags.join(' ') : '',
      cta: marketing ? marketing.cta : '',
    });
    exito = true;
    await podarClips();
  } finally {
    if (!exito) await fs.rm(salida, { force: true });
    await fs.rm(dirSegmento, { recursive: true, force: true });
  }
}

export async function procesarClip(trabajo, signal) {
  const id = trabajo.id;
  const dirTrabajo = directorioDeTrabajo(id);
  const avanzarJob = crearAvance(id);

  try {
    await fs.mkdir(config.clipsDir, { recursive: true });
    await fs.mkdir(dirTrabajo, { recursive: true });

    // 1. Descarga unica del video fuente (0-30 % del primer clip)
    const marca = Date.now();
    avanzarJob('Descargando video', 2);
    // Con archivo local ya validado (upload.js) no hay descarga: se usa tal cual.
    const video = trabajo.archivo
      ? {
        id: path.basename(trabajo.archivo.ruta, path.extname(trabajo.archivo.ruta)),
        duracion: trabajo.archivo.duracion,
        archivo: trabajo.archivo.ruta,
        titulo: trabajo.archivo.nombreOriginal || 'Archivo local',
      }
      : await descargarVideo(trabajo.url, dirTrabajo, {
        signal,
        onProgreso: (fraccion) => avanzarJob('Descargando video', 2 + fraccion * 28),
      });
    store.actualizar(id, { titulo: video.titulo });
    registrarTiempo(id, 'descarga', marca);

    // 2. Plan de cortes
    let segmentos;
    let pasada = 0;
    let reiniciado = false;
    let palabrasFuente = null;

    if (trabajo.auto && video.duracion) {
      const historial = await leerHistorial(video.id);
      pasada = historial.pasadas;
      let plan = null;

      // 2a. Curaduria local: se transcribe el video completo una vez y el curador cruza el texto con el diccionario.
      if (AJUSTES.activo && video.duracion <= AJUSTES.maxVideoSeg) {
        try {
          const inicioAsr = Date.now();
          avanzarJob('Transcribiendo video completo', 30);
          palabrasFuente = await transcribirFuente(video, dirTrabajo, {
            signal,
            onProgreso: (fraccion) => avanzarJob('Transcribiendo video completo', 30 + fraccion * 25),
          });
          registrarTiempo(id, 'transcripcion-completa', inicioAsr);

          avanzarJob('Analizando contenido', 55);
          const curar = (rangos) => curarVideo({
            palabras: palabrasFuente,
            duracionVideo: video.duracion,
            historial: rangos,
            cantidad: trabajo.cantidad,
            tituloVideo: video.titulo,
            semilla: video.id,
            instruccion: trabajo.instruccion,
          });
          let curado = curar(historial.rangos);
          // Video "agotado": ya no quedan momentos libres. Se abre un ciclo nuevo (sin historial) y se avisa.
          if (curado.clips.length === 0 && historial.rangos.length > 0 && palabrasFuente.length > 0) {
            curado = curar([]);
            reiniciado = curado.clips.length > 0;
          }
          if (curado.clips.length > 0) {
            plan = { segmentos: curado.clips, faltantes: Math.max(0, curado.objetivo - curado.clips.length) };
            logger.info('Curaduria completada', { id, clips: curado.clips.length, frases: curado.frases, candidatos: curado.candidatos });
          }
        } catch (error) {
          if (signal && signal.aborted) throw error;
          store.registrarIncidencia(
            'warn',
            'La curaduria local no pudo analizar "' + video.titulo + '": se usa el planificador de cortes',
            'curador',
            detalleDeError(error)
          );
          palabrasFuente = null;
        }
      }

      // 2b. Planificador por franjas (sin voz, curador desactivado, video muy largo o curaduria sin resultados).
      if (!plan) {
        plan = planificarSegmentos({
          duracionVideo: video.duracion,
          historial: historial.rangos,
          pasada,
          semilla: video.id,
          cantidad: trabajo.cantidad,
        });
        reiniciado = plan.reiniciado;
      }

      segmentos = plan.segmentos;
      if (trabajo.instruccion) {
        const conCoincidencia = segmentos.filter((s) => s.ficha && s.ficha.instruccion && s.ficha.instruccion.coincide).length;
        if (!conCoincidencia) {
          store.registrarIncidencia(
            'info',
            'Ningun momento de "' + video.titulo + '" coincide con "' + trabajo.instruccion + '": se eligieron los mejores momentos del video',
            'pipeline'
          );
        }
      }
      if (reiniciado) {
        store.registrarIncidencia(
          'info',
          'Todos los momentos de "' + video.titulo + '" ya se habian usado: se abre un ciclo nuevo de cortes',
          'pipeline'
        );
      }
      if (plan.faltantes > 0) {
        store.registrarIncidencia(
          'info',
          'Solo se encontraron ' + segmentos.length + ' momentos libres en "' + video.titulo + '" (se pedian ' + (segmentos.length + plan.faltantes) + ')',
          'pipeline'
        );
      }
    } else {
      // Corte manual (inicio/duracion indicados) o duracion del video desconocida.
      const inicio = trabajo.inicio;
      if (video.duracion && inicio >= video.duracion - 1) {
        throw new Error(
          'El inicio indicado (' + inicio + ' s) supera la duracion del video (' + Math.floor(video.duracion) + ' s)'
        );
      }
      const disponible = video.duracion ? video.duracion - inicio : trabajo.duracion;
      segmentos = [{ inicio, duracion: Math.max(1, Math.min(trabajo.duracion, disponible, config.maxClipSeconds)) }];
    }

    if (segmentos.length === 0) {
      throw new Error('No se pudo planificar ningun corte para este video');
    }

    // 2c. Estilo de subtitulos y modo de cada clip: valor manual del trabajo o rotacion ciclica (una tanda por canal).
    const perfiles = await perfilesDeTrabajo(trabajo, segmentos.length);

    // 3. Un registro de clip por segmento: el primero reutiliza el del trabajo, el resto se crean.
    // Los clips curados ya llevan su ficha (con revisionTecnica "pendiente") antes de renderizarse.
    const total = segmentos.length;
    const registros = segmentos.map((segmento, i) => {
      const ficha = segmento.ficha
        ? { ...segmento.ficha, revisionTecnica: armarRevisionTecnica({ modo: perfiles[i].modo, duracion: segmento.duracion }) }
        : null;
      const base = {
        ...(perfiles[i].estilo ? { estiloSubtitulos: perfiles[i].estilo } : {}),
        ...(perfiles[i].modo ? { modo: perfiles[i].modo } : {}),
        titulo: video.titulo + etiquetaSegmento(i + 1, total),
        segmento: { indice: i + 1, total, inicio: segmento.inicio, duracion: segmento.duracion },
        ficha,
      };
      if (i === 0) {
        store.actualizar(id, { ...base, etapa: total > 1 ? 'En cola (clip 1/' + total + ')' : 'En cola' });
        return store.buscar(id);
      }
      return store.crearHijo(id, { ...base, etapa: 'En cola (clip ' + (i + 1) + '/' + total + ')' });
    });

    // 4. Render secuencial (un solo FFmpeg a la vez para no saturar la CPU)
    const exitosos = [];
    let ultimoError = null;
    for (let i = 0; i < total; i++) {
      if (signal && signal.aborted) throw new Error('Trabajo cancelado');
      const clipId = registros[i].id;
      try {
        await procesarSegmento({
          clipId,
          trabajo,
          video,
          segmento: segmentos[i],
          indice: i + 1,
          total,
          dirSegmento: path.join(dirTrabajo, 'seg-' + (i + 1)),
          palabrasFuente,
          perfil: perfiles[i],
          signal,
        });
        exitosos.push(segmentos[i]);
      } catch (error) {
        if (signal && signal.aborted) throw error;
        // Un clip fallido no detiene a los demas: se registra y se continua.
        ultimoError = error;
        logger.error('Clip fallido', { id: clipId, indice: i + 1, mensaje: error.message });
        store.fallar(clipId, error.message, detalleDeError(error));
      }
    }

    // 5. Historial anti-duplicados: solo los rangos que realmente se renderizaron.
    if (exitosos.length > 0 && trabajo.auto && video.duracion) {
      try {
        await registrarPasada(
          video.id,
          exitosos.map((r) => ({ inicio: r.inicio, fin: r.inicio + r.duracion })),
          { reiniciar: reiniciado }
        );
      } catch (error) {
        store.registrarIncidencia('warn', 'No se pudo guardar el historial de cortes (podrian repetirse momentos)', 'historial', detalleDeError(error));
      }
    }

    if (exitosos.length === 0 && ultimoError) {
      // Todos fallaron y cada uno ya dejo su incidencia: no se duplica el aviso.
      logger.warn('Ningun clip del trabajo pudo generarse', { id });
    }
  } finally {
    await fs.rm(dirTrabajo, { recursive: true, force: true });
    if (trabajo.archivo) await borrarUpload(trabajo.archivo.ruta);   // el archivo subido ya no hace falta
  }
}
