// Logica pura del flujo Proyectos / Clips (sin DOM, sin red): agrupa, filtra, ordena y resume los datos
// prehechos por el backend (clip.ficha del curador: gancho, flujo, valor, interes, puntaje, titulo,
// descripcion y revisionTecnica). Misma entrada => misma salida, para poder probarla con node:test.

export const ENCUADRES = Object.freeze({
  recorte: 'Conversación — quien habla',
  blur: 'Plano amplio (fondo desenfocado)',
});

export const CANTIDAD_MAX = 5;

// Mismos valores que valida el backend (src/estilos-subtitulos.js y src/upload.js).
export const ESTILOS_SUBTITULOS = Object.freeze({
  dinamico: 'Dinámico por palabra',
  clasico: 'Clásico',
  minimal: 'Minimal',
});
export const ESTILO_DEFECTO = 'dinamico';
export const EXTENSIONES_VIDEO = Object.freeze(['.mp4', '.mov', '.mkv', '.webm']);
export const INSTRUCCION_MAX = 300;

export const BLOQUES = Object.freeze([
  { clave: 'gancho', etiqueta: 'Gancho' },
  { clave: 'flujo', etiqueta: 'Flujo' },
  { clave: 'valor', etiqueta: 'Valor' },
  { clave: 'interes', etiqueta: 'Interés' },
]);

const NOMBRES_ENCUADRE = {
  centrado: 'Centrado',
  seguimiento: 'Seguimiento del rostro',
  'rostro-fijo': 'Rostro fijo',
  split: 'Pantalla dividida',
  'mixto-split': 'Mixto con pantalla dividida',
  blur: 'Fondo desenfocado',
};

const NOMBRES_INTERLOCUTOR = {
  'no-detectado': 'No detectado',
  'sin-rostro': 'Sin rostro',
  unico: 'Un hablante',
  'dialogo-activo': 'Diálogo (sigue a quien habla)',
  'dialogo-split': 'Diálogo en pantalla dividida',
  grupo: 'Grupo',
};

export const esTerminado = (clip) => Boolean(clip) && (clip.estado === 'listo' || clip.estado === 'publicado');

export function normalizarTexto(texto) {
  return String(texto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const numero = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function puntajeDe(clip) {
  const f = clip && clip.ficha;
  const total = numero(f && f.puntaje);
  if (total !== null) return total;
  // Sin puntaje total pero con bloques puntuados: promedio de los bloques (no se pierde la ficha por un campo vacío).
  const parciales = f ? BLOQUES.map(({ clave }) => numero(f[clave] && f[clave].puntaje)).filter((n) => n !== null) : [];
  return parciales.length ? parciales.reduce((a, b) => a + b, 0) / parciales.length : null;
}

export function nivelDe(puntaje) {
  if (puntaje === null || puntaje === undefined) return 'sin';
  if (puntaje >= 70) return 'alto';
  if (puntaje >= 45) return 'medio';
  return 'bajo';
}

export function tituloDe(clip, ediciones = {}) {
  const editado = ediciones[clip.id] && ediciones[clip.id].titulo;
  return editado || (clip.ficha && clip.ficha.titulo) || (clip.marketing && clip.marketing.titulo) || clip.titulo || 'Clip sin título';
}

export function descripcionDe(clip, ediciones = {}) {
  const editada = ediciones[clip.id] && ediciones[clip.id].descripcion;
  if (editada) return editada;
  if (clip.ficha && clip.ficha.descripcion) return clip.ficha.descripcion;
  if (clip.copy) return clip.copy;
  const m = clip.marketing;
  if (m && m.descripcion) return [m.descripcion, m.cta, Array.isArray(m.hashtags) ? m.hashtags.join(' ') : ''].filter(Boolean).join('\n\n');
  return '';
}

/** Instruccion ("que buscar") con la que se creo el clip o su proyecto ('' si no hubo). */
export function instruccionDe(clip) {
  const texto = (clip && clip.instruccion) || (clip && clip.ficha && clip.ficha.instruccion && clip.ficha.instruccion.texto) || '';
  return String(texto).trim();
}

/** true si el curador marco este clip como coincidente con la instruccion; null si no hubo instruccion. */
export function coincideInstruccion(clip) {
  const i = clip && clip.ficha && clip.ficha.instruccion;
  return i ? Boolean(i.coincide) : null;
}

export const esArchivoLocal = (clip) => Boolean(clip) && clip.origen === 'archivo';

export function estiloDe(clip) {
  return (clip && ESTILOS_SUBTITULOS[clip.estiloSubtitulos]) || '';
}

export function ganchoDe(clip) {
  const g = clip.ficha && clip.ficha.gancho;
  return (g && typeof g === 'object' ? g.frase : g) || clip.gancho || '';
}

/** Los cuatro bloques de la ficha (Gancho / Flujo / Valor / Interés) con puntaje, nivel y un detalle corto. */
export function bloquesDe(clip) {
  const f = (clip && clip.ficha) || {};
  return BLOQUES.map(({ clave, etiqueta }) => {
    const bloque = f[clave] || {};
    const puntaje = numero(bloque.puntaje);
    let detalle = '';
    if (clave === 'gancho') detalle = bloque.frase || '';
    else if (clave === 'flujo' && numero(bloque.frases) !== null) {
      detalle = bloque.frases + (bloque.frases === 1 ? ' frase' : ' frases') + (bloque.cierre ? ' · cierre ' + bloque.cierre : '');
    } else if (Array.isArray(bloque.claves)) detalle = bloque.claves.join(', ');
    return { clave, etiqueta, puntaje, nivel: nivelDe(puntaje), detalle };
  });
}

const si = (v) => (v === null || v === undefined ? '—' : v ? 'Sí' : 'No');

/** Resume ficha.revisionTecnica para mostrarla: estado, clase del badge, filas y alertas. */
export function revisionDe(clip) {
  const rt = clip && clip.ficha && clip.ficha.revisionTecnica;
  if (!rt) return { estado: 'sin-datos', texto: 'Sin revisión', clase: 'neutro', filas: [], alertas: [] };

  const estados = {
    verificado: { texto: 'Verificado', clase: 'ok' },
    'con-alertas': { texto: 'Con alertas', clase: 'warn' },
    pendiente: { texto: 'Pendiente', clase: 'neutro' },
  };
  const e = estados[rt.estado] || estados.pendiente;
  const enc = rt.encuadre || {};
  const medido = rt.medido ? rt.medido.ancho + 'x' + rt.medido.alto : null;

  const filas = [
    ['Formato', rt.formato || '9:16'],
    ['Resolución', (rt.resolucion || '1080x1920') + (medido ? ' (medido ' + medido + ')' : '')],
    ['Encuadre', NOMBRES_ENCUADRE[enc.tipo] || enc.tipo || '—'],
    ['Interlocutor', NOMBRES_INTERLOCUTOR[enc.interlocutor] || enc.interlocutor || '—'],
    ['Subtítulos', si(rt.subtitulos)],
    ['Marca de agua', si(rt.logo)],
  ];
  if (numero(rt.duracionSeg) !== null) filas.push(['Duración', formatoSeg(rt.duracionSeg)]);

  return {
    estado: rt.estado || 'pendiente',
    texto: e.texto + (medido && rt.cumpleFormato ? ' · ' + medido : ''),
    clase: e.clase,
    filas,
    alertas: Array.isArray(rt.alertas) ? rt.alertas : [],
  };
}

export function formatoSeg(segundos) {
  const total = Number(segundos);
  if (!Number.isFinite(total) || total <= 0) return '—';
  return Math.floor(total / 60) + ':' + String(Math.round(total % 60)).padStart(2, '0');
}

export function slug(texto) {
  return normalizarTexto(texto).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'clip';
}

function posicion(clip) {
  const inicio = numero(clip.inicio) ?? numero(clip.segmento && clip.segmento.inicio);
  return inicio === null ? Number.POSITIVE_INFINITY : inicio;
}

/** Un proyecto = un video fuente (jobId) con todos los clips que salieron de el. */
export function agruparProyectos(clips) {
  const mapa = new Map();
  for (const clip of clips || []) {
    const id = clip.jobId || clip.id;
    if (!mapa.has(id)) mapa.set(id, []);
    mapa.get(id).push(clip);
  }

  const proyectos = [];
  for (const [id, lista] of mapa) {
    lista.sort((a, b) => posicion(a) - posicion(b) || String(a.creadoEn).localeCompare(String(b.creadoEn)));
    const terminados = lista.filter(esTerminado);
    const enProceso = lista.filter((c) => c.estado === 'procesando').length;
    const errores = lista.filter((c) => c.estado === 'error').length;
    const puntajes = terminados.map(puntajeDe).filter((p) => p !== null);
    const creado = lista.reduce((min, c) => (String(c.creadoEn) < min ? String(c.creadoEn) : min), String(lista[0].creadoEn));
    const base = lista.find((c) => c.id === id) || lista[0];
    proyectos.push({
      id,
      titulo: base.titulo || base.fuente || 'Proyecto',
      fuente: base.fuente || '',
      origen: base.origen || 'url',
      instruccion: instruccionDe(base),
      estilo: estiloDe(base),
      coinciden: lista.filter((c) => coincideInstruccion(c) === true).length,
      creadoEn: creado,
      clips: lista,
      total: lista.length,
      listos: terminados.length,
      enProceso,
      errores,
      duracionTotal: terminados.reduce((s, c) => s + (numero(c.duracion) || 0), 0),
      mejorPuntaje: puntajes.length ? Math.max(...puntajes) : null,
      miniatura: terminados.find((c) => c.url) || null,
      estado: enProceso > 0 ? 'procesando' : terminados.length === 0 ? 'error' : errores > 0 ? 'parcial' : 'listo',
    });
  }
  return proyectos.sort((a, b) => String(b.creadoEn).localeCompare(String(a.creadoEn)));
}

export function filtrarProyectos(proyectos, texto) {
  const q = normalizarTexto(texto);
  if (!q) return proyectos;
  return proyectos.filter((p) =>
    normalizarTexto([p.titulo, p.fuente, p.instruccion, ...p.clips.map((c) => (c.ficha && c.ficha.titulo) || '')].join(' ')).includes(q)
  );
}

/* ---------- Busqueda ---------- */

/** true si a y b difieren como mucho en 1 letra (cambio, falta o sobra); solo se aplica a palabras de 5+ letras. */
function diferenciaDeUnaLetra(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (++d > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
}

/** { ok, peso }: peso 2 si la palabra aparece tal cual, 1 si aparece con una letra de diferencia. */
function coincidePalabra(termino, todo, palabras) {
  if (todo.includes(termino)) return { ok: true, peso: 2 };
  if (termino.length >= 5 && palabras.some((p) => diferenciaDeUnaLetra(termino, p))) return { ok: true, peso: 1 };
  return { ok: false, peso: 0 };
}

/** Fragmento del texto original alrededor de la primera coincidencia, para mostrar "por que salio este clip". */
function fragmentoAlrededor(original, terminos) {
  const crudo = String(original || '').replace(/\s+/g, ' ').trim();
  if (!crudo || terminos.length === 0) return crudo.slice(0, 140);
  const normal = normalizarTexto(crudo);
  for (const t of terminos) {
    const pos = normal.indexOf(t);
    if (pos === -1) continue;
    const ini = Math.max(0, pos - 35);
    const fin = Math.min(crudo.length, pos + t.length + 65);
    return (ini > 0 ? '…' : '') + crudo.slice(ini, fin).trim() + (fin < crudo.length ? '…' : '');
  }
  return crudo.slice(0, 140);
}

const esEnVivo = (clip) => Boolean(clip.envivo) || clip.origen === 'envivo' || clip.origen === 'live';
const numeroOpcional = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Filtra y ordena los clips para "Todos los clips". Compatible con el filtro anterior y con la busqueda nueva.
 *
 * opciones:
 *   texto | q | busqueda   palabras sueltas, en cualquier orden, sin acentos; tolera 1 letra de diferencia (palabras de 5+)
 *   estado                 'todos' (por defecto: solo clips terminados) | 'listo' | 'procesando' | 'error' | ...
 *   origen                 'todos' | 'envivo' | 'enlace' | cualquier valor de clip.origen
 *   proyecto               jobId (o proyectoId) del proyecto
 *   soloFavoritos          true -> solo favoritos: ids en `favoritos` (Set|Array) o clip.favorito === true
 *   puntajeMin             puntaje minimo de la ficha (0-100)
 *   orden                  'relevancia' (si hay texto) | 'recientes' | 'puntaje'
 *   ediciones              ediciones locales de titulo/descripcion (mandan sobre la ficha)
 *
 * Devuelve copias de los clips con `relevancia` y `contextoCoincidencia` (fragmento alrededor de la coincidencia).
 */
export function filtrarClipsFlujo(clips, opciones = {}) {
  const f = opciones && typeof opciones === 'object' ? opciones : {};
  const ediciones = f.ediciones || {};
  const favoritos = f.favoritos instanceof Set ? f.favoritos : new Set(f.favoritos || []);
  const terminos = normalizarTexto(f.texto || f.q || f.busqueda || '').split(' ').filter(Boolean);
  const estado = normalizarTexto(f.estado);
  const origen = normalizarTexto(f.origen);
  const proyecto = String(f.proyecto || '').toLowerCase();
  const minimo = numeroOpcional(f.puntajeMin);
  const lista = Array.isArray(clips) ? clips : [];

  const resultado = [];
  for (const clip of lista) {
    if (!clip) continue;

    if (estado && estado !== 'todos') {
      if (normalizarTexto(clip.estado) !== estado) continue;
    } else if (!esTerminado(clip)) {
      continue;
    }

    if (origen && origen !== 'todos') {
      if (origen === 'envivo' && !esEnVivo(clip)) continue;
      if (origen === 'enlace' && esEnVivo(clip)) continue;
      if (origen !== 'envivo' && origen !== 'enlace' && normalizarTexto(clip.origen) !== origen) continue;
    }

    if (proyecto && proyecto !== 'todos') {
      const ids = [clip.jobId, clip.id, clip.proyectoId, clip.proyecto].map((v) => String(v || '').toLowerCase());
      if (!ids.includes(proyecto)) continue;
    }

    if (f.soloFavoritos && !(favoritos.has(clip.id) || clip.favorito === true)) continue;

    if (minimo !== null) {
      const p = puntajeDe(clip) ?? numero(clip.puntaje);
      if ((p ?? -1) < minimo) continue;
    }

    const titulo = String(tituloDe(clip, ediciones) || '');
    const gancho = String(ganchoDe(clip) || '');
    const descripcion = String(descripcionDe(clip, ediciones) || '');
    const transcripcion = String(clip.transcripcion || '');
    const tN = normalizarTexto(titulo + ' ' + (clip.titulo || ''));
    const gN = normalizarTexto(gancho);
    const dN = normalizarTexto(descripcion);
    const trN = normalizarTexto(transcripcion);
    const todo = [tN, gN, dN, trN].filter(Boolean).join(' ');
    const palabras = todo.split(/[^a-z0-9]+/).filter(Boolean);

    let relevancia = 0;
    let coincide = true;
    for (const termino of terminos) {
      const m = coincidePalabra(termino, todo, palabras);
      if (!m.ok) { coincide = false; break; }
      if (tN.includes(termino)) relevancia += 10 * m.peso;
      else if (gN.includes(termino)) relevancia += 6 * m.peso;
      else if (dN.includes(termino)) relevancia += 4 * m.peso;
      else if (trN.includes(termino)) relevancia += 3 * m.peso;
      else relevancia += m.peso;
    }
    if (!coincide) continue;

    resultado.push({
      ...clip,
      relevancia,
      contextoCoincidencia: terminos.length ? fragmentoAlrededor(transcripcion || descripcion || gancho || titulo, terminos) : '',
    });
  }

  const orden = normalizarTexto(f.orden) || (terminos.length ? 'relevancia' : 'recientes');
  const porFecha = (a, b) => String(b.creadoEn).localeCompare(String(a.creadoEn)) || posicion(a) - posicion(b);
  if (orden === 'puntaje') {
    return resultado.sort((a, b) => (puntajeDe(b) ?? -1) - (puntajeDe(a) ?? -1) || String(b.creadoEn).localeCompare(String(a.creadoEn)));
  }
  if (orden === 'relevancia') return resultado.sort((a, b) => b.relevancia - a.relevancia || porFecha(a, b));
  return resultado.sort(porFecha);
}

const extensionDe = (nombre) => {
  const n = String(nombre || '').toLowerCase();
  const punto = n.lastIndexOf('.');
  return punto < 0 ? '' : n.slice(punto);
};

/**
 * Valida el formulario de creacion y arma lo que acepta POST /api/panel/encolar.
 * Entrada: { url, modo, cantidad, instruccion, estiloSubtitulos, archivo } (archivo = File | null).
 * Salida: { ok, cuerpo, archivo? }. `cuerpo` lleva los campos de texto; `archivo` solo existe si se eligio uno,
 * y entonces la peticion va como multipart/form-data (el backend no admite URL y archivo a la vez).
 */
export function prepararEncolar({ url, modo, cantidad, instruccion, estiloSubtitulos, archivo } = {}) {
  const enlace = String(url || '').trim();
  const hayArchivo = Boolean(archivo);
  if (hayArchivo && enlace) return { ok: false, error: 'Usa un enlace o un archivo, no ambos.' };
  if (hayArchivo && !EXTENSIONES_VIDEO.includes(extensionDe(archivo.name))) {
    return { ok: false, error: 'Formato no permitido: usa mp4, mov, mkv o webm.' };
  }
  if (!hayArchivo && !/^https?:\/\//i.test(enlace)) {
    return { ok: false, error: 'Pega un enlace válido que empiece con https:// o elige un archivo de video.' };
  }
  const m = modo || 'recorte';
  if (!Object.hasOwn(ENCUADRES, m)) return { ok: false, error: 'Elige un encuadre válido.' };

  const cuerpo = hayArchivo ? { modo: m } : { url: enlace, modo: m };
  if (cantidad !== undefined && cantidad !== null && cantidad !== '' && cantidad !== 'auto') {
    const n = Number(cantidad);
    if (!Number.isInteger(n) || n < 1 || n > CANTIDAD_MAX) {
      return { ok: false, error: 'La cantidad de clips debe ser un entero entre 1 y ' + CANTIDAD_MAX + '.' };
    }
    cuerpo.cantidad = n;
  }

  const estilo = String(estiloSubtitulos ?? '').trim().toLowerCase();
  if (estilo) {
    if (!Object.hasOwn(ESTILOS_SUBTITULOS, estilo)) return { ok: false, error: 'Elige un estilo de subtítulos válido.' };
    cuerpo.estiloSubtitulos = estilo;
  }

  const texto = String(instruccion ?? '').replace(/\s+/g, ' ').trim();
  if (texto) cuerpo.instruccion = texto.slice(0, INSTRUCCION_MAX);

  return hayArchivo ? { ok: true, cuerpo, archivo } : { ok: true, cuerpo };
}
