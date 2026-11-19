// Logica pura del flujo Proyectos / Clips (sin DOM, sin red): agrupa, filtra, ordena y resume los datos
// prehechos por el backend (clip.ficha del curador: gancho, flujo, valor, interes, puntaje, titulo,
// descripcion y revisionTecnica). Misma entrada => misma salida, para poder probarla con node:test.

export const ENCUADRES = Object.freeze({
  recorte: 'Conversación — quien habla',
  blur: 'Plano amplio (fondo desenfocado)',
});

export const CANTIDAD_MAX = 5;

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
  return numero(clip && clip.ficha && clip.ficha.puntaje);
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
  return clip.copy || '';
}

export function ganchoDe(clip) {
  return (clip.ficha && clip.ficha.gancho && clip.ficha.gancho.frase) || '';
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
    normalizarTexto([p.titulo, p.fuente, ...p.clips.map((c) => (c.ficha && c.ficha.titulo) || '')].join(' ')).includes(q)
  );
}

/**
 * Filtra y ordena los clips terminados para "Todos los clips".
 * opciones: { texto, soloFavoritos, favoritos:Set|Array, proyecto (jobId), orden:'recientes'|'puntaje', ediciones }
 */
export function filtrarClipsFlujo(clips, opciones = {}) {
  const { texto = '', soloFavoritos = false, proyecto = '', orden = 'recientes', ediciones = {} } = opciones;
  const favoritos = opciones.favoritos instanceof Set ? opciones.favoritos : new Set(opciones.favoritos || []);
  const q = normalizarTexto(texto);

  const lista = (clips || []).filter((clip) => {
    if (!esTerminado(clip)) return false;
    if (soloFavoritos && !favoritos.has(clip.id)) return false;
    if (proyecto && (clip.jobId || clip.id) !== proyecto) return false;
    if (!q) return true;
    const contenido = normalizarTexto([tituloDe(clip, ediciones), clip.titulo, clip.transcripcion, ganchoDe(clip), clip.copy].join(' '));
    return contenido.includes(q);
  });

  if (orden === 'puntaje') {
    return lista.sort((a, b) => (puntajeDe(b) ?? -1) - (puntajeDe(a) ?? -1) || String(b.creadoEn).localeCompare(String(a.creadoEn)));
  }
  return lista.sort((a, b) => String(b.creadoEn).localeCompare(String(a.creadoEn)) || posicion(a) - posicion(b));
}

/** Valida el formulario de creacion y arma el cuerpo de POST /api/panel/encolar (url, modo, cantidad). */
export function prepararEncolar({ url, modo, cantidad } = {}) {
  const enlace = String(url || '').trim();
  if (!/^https?:\/\//i.test(enlace)) return { ok: false, error: 'Pega un enlace válido que empiece con https://' };
  const m = modo || 'recorte';
  if (!Object.hasOwn(ENCUADRES, m)) return { ok: false, error: 'Elige un encuadre válido.' };

  const cuerpo = { url: enlace, modo: m };
  if (cantidad !== undefined && cantidad !== null && cantidad !== '' && cantidad !== 'auto') {
    const n = Number(cantidad);
    if (!Number.isInteger(n) || n < 1 || n > CANTIDAD_MAX) {
      return { ok: false, error: 'La cantidad de clips debe ser un entero entre 1 y ' + CANTIDAD_MAX + '.' };
    }
    cuerpo.cantidad = n;
  }
  return { ok: true, cuerpo };
}
