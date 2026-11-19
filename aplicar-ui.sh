#!/usr/bin/env bash
# ClipLab Pro - Flujo Proyectos / Todos los clips (frontend). Ejecutar desde la raiz del repo:  bash aplicar-ui.sh
set -euo pipefail

[ -f package.json ] && [ -f public/js/panel.js ] && [ -f src/server.js ] || { echo "ERROR: ejecuta esto dentro de la carpeta del repo (cliplab-limpio)."; exit 1; }
if [ -f public/js/flujo.js ]; then echo "ERROR: public/js/flujo.js ya existe; el flujo ya esta aplicado."; exit 1; fi

# 1) Parches exactos sobre api.js y panel.js. Si algo no coincide, aborta ANTES de escribir nada mas.
cat > /tmp/parche-ui.mjs <<'FIN_PARCHE'
// Parches exactos sobre api.js y panel.js: si un texto no se encuentra, aborta sin tocar nada.
import fs from 'node:fs';

function parchar(ruta, cambios) {
  let texto = fs.readFileSync(ruta, 'utf8');
  for (const [antes, despues, nombre] of cambios) {
    const veces = texto.split(antes).length - 1;
    if (veces !== 1) {
      console.error('ABORTADO: "' + nombre + '" aparece ' + veces + ' veces en ' + ruta + ' (se esperaba 1). No se modifico nada.');
      process.exit(1);
    }
    texto = texto.replace(antes, () => despues);
  }
  fs.writeFileSync(ruta, texto);
  console.log('OK ' + ruta);
}

parchar('public/js/api.js', [
  [
    "export function encolarVideo(url) {\n  return solicitar('/api/panel/encolar', { metodo: 'POST', cuerpo: { url } });\n}",
    "export function encolarVideo(url, opciones = {}) {\n  return solicitar('/api/panel/encolar', { metodo: 'POST', cuerpo: { url, ...opciones } });\n}",
    'encolarVideo',
  ],
]);

parchar('public/js/panel.js', [
  ["import * as V from './views.js';\n", "import * as V from './views.js';\nimport * as F from './flujo.js';\n", 'import views'],
  ["const VISTAS = ['resumen', 'conexiones', 'clips',", "const VISTAS = ['resumen', 'conexiones', 'proyectos', 'clips',", 'VISTAS'],
  [
    "    case 'clips':\n      renderClipsVista();\n      break;",
    "    case 'proyectos':\n    case 'clips':\n      F.render(estado.vista, estado.datos);\n      break;",
    'renderActual clips',
  ],
  [
    "  $('n-clips').textContent = String(clips.length);\n",
    "  $('n-clips').textContent = String(clips.filter((c) => c.estado === 'listo' || c.estado === 'publicado').length);\n  F.contadores(estado.datos);\n",
    'contadores',
  ],
  [
    "  iniciarEncolar();\n  iniciarCopiar();",
    "  F.iniciar({ mostrarAviso, abrirLlave, sondearYa, activarVista });\n  iniciarCopiar();",
    'iniciar flujo',
  ],
  [
    "  $('clip-estado').addEventListener('change', (evento) => {\n    estado.filtroEstado = evento.target.value;\n    if (estado.datos) renderClipsVista();\n  });\n\n  $('clip-buscar').addEventListener('input', (evento) => {\n    clearTimeout(estado.temporizadorBusqueda);\n    const valor = evento.target.value;\n    estado.temporizadorBusqueda = setTimeout(() => {\n      estado.filtroTexto = valor;\n      if (estado.datos) renderClipsVista();\n    }, 150);\n  });\n\n",
    '',
    'filtros viejos',
  ],
]);
FIN_PARCHE
node /tmp/parche-ui.mjs
rm -f /tmp/parche-ui.mjs

echo "-> public/js/proyectos.js"
cat > public/js/proyectos.js <<'FIN_PROYECTOS_JS'
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
FIN_PROYECTOS_JS

echo "-> public/js/flujo.js"
cat > public/js/flujo.js <<'FIN_FLUJO_JS'
// Flujo de trabajo de ClipLab: crear -> Proyectos -> Todos los clips. Solo pinta y reacciona; toda la
// logica de datos (agrupar, filtrar, puntajes, revision tecnica) vive en proyectos.js.
import { encolarVideo } from './api.js';
import { esc, formatoFecha } from './views.js';
import {
  ENCUADRES, agruparProyectos, filtrarProyectos, filtrarClipsFlujo, bloquesDe, revisionDe, nivelDe,
  puntajeDe, tituloDe, descripcionDe, ganchoDe, formatoSeg, slug, prepararEncolar, esTerminado,
} from './proyectos.js';

const LS_FAV = 'cliplab.favoritos';
const LS_ED = 'cliplab.ediciones';
const CLASE_NIVEL = { alto: 'ok', medio: 'info', bajo: 'warn', sin: 'neutro' };

const $ = (id) => document.getElementById(id);

function leerLocal(clave, defecto) {
  try {
    const crudo = localStorage.getItem(clave);
    return crudo ? JSON.parse(crudo) : defecto;
  } catch {
    return defecto;
  }
}

function guardarLocal(clave, valor) {
  try {
    localStorage.setItem(clave, JSON.stringify(valor));
  } catch {
    // Sin almacenamiento disponible: favoritos y ediciones solo duran mientras la pestana siga abierta.
  }
}

const e = {
  datos: null,
  favoritos: new Set(leerLocal(LS_FAV, [])),
  ediciones: leerLocal(LS_ED, {}),
  textoProyectos: '',
  textoClips: '',
  soloFavoritos: false,
  orden: 'recientes',
  filtroProyecto: '',
  abierto: '',
  paneles: new Map(),
  revisiones: new Set(),
  html: { proyectos: '', clips: '' },
  editando: null,
  ayudas: null,
};

/* ---------- Piezas de HTML ---------- */

function urlLocal(url) {
  return typeof url === 'string' && /^(https?:\/\/|\/(?!\/))/i.test(url) ? url : '';
}

const badge = (texto, clase) => '<span class="badge badge-' + esc(clase) + '">' + esc(texto) + '</span>';
const vacio = (mensaje) => '<div class="vacio">' + esc(mensaje) + '</div>';

function insigniaPuntaje(clip) {
  const p = puntajeDe(clip);
  return p === null ? badge('Sin puntaje', 'neutro') : badge('★ ' + Math.round(p), CLASE_NIVEL[nivelDe(p)]);
}

function video(clip, clase, miniatura = false) {
  const url = urlLocal(clip.url);
  if (!url) return '<div class="sin-video">Archivo no disponible</div>';
  return miniatura
    ? '<video class="' + clase + '" src="' + esc(url) + '#t=0.2" preload="metadata" muted playsinline></video>'
    : '<video class="' + clase + '" src="' + esc(url) + '" controls preload="metadata" playsinline></video>';
}

function chipsBloques(clip) {
  return '<div class="chips-bloques">' + bloquesDe(clip).map((b) =>
    '<span class="chip-bloque nivel-' + b.nivel + '" title="' + esc(b.detalle) + '">' + esc(b.etiqueta) + ' <b>' +
    (b.puntaje === null ? '—' : Math.round(b.puntaje)) + '</b></span>'
  ).join('') + '</div>';
}

/* ---------- Proyectos ---------- */

function tarjetaProyecto(p) {
  const estados = {
    procesando: badge('Procesando ' + p.enProceso, 'info'),
    listo: badge('Listo', 'ok'),
    parcial: badge('Con errores', 'warn'),
    error: badge('Con error', 'err'),
  };
  const mejor = p.mejorPuntaje === null ? '' : badge('★ ' + Math.round(p.mejorPuntaje), CLASE_NIVEL[nivelDe(p.mejorPuntaje)]);
  return '<article class="card proyecto">' +
    '<div class="miniatura" data-accion="abrir-proyecto" data-id="' + esc(p.id) + '">' +
      (p.miniatura ? video(p.miniatura, 'mini-video', true) : '<div class="sin-video">' + (p.estado === 'procesando' ? 'Procesando…' : 'Sin vista previa') + '</div>') +
    '</div>' +
    '<div class="card-cab"><h3>' + esc(p.titulo) + '</h3>' + mejor + '</div>' +
    '<div class="meta"><span>' + p.listos + (p.listos === 1 ? ' clip generado' : ' clips generados') + '</span>' +
      '<span>Duración ' + esc(formatoSeg(p.duracionTotal)) + '</span><span>' + esc(formatoFecha(p.creadoEn)) + '</span></div>' +
    '<div class="card-acciones">' + (estados[p.estado] || '') +
      '<button class="btn btn-primario" type="button" data-accion="abrir-proyecto" data-id="' + esc(p.id) + '">Abrir proyecto</button></div>' +
  '</article>';
}

function miniClip(clip) {
  if (clip.estado === 'procesando') return '<div class="mini mini-estado"><span>Procesando…</span></div>';
  if (clip.estado === 'error') return '<div class="mini mini-estado"><span>Este clip falló</span></div>';
  return '<article class="mini">' +
    '<div class="visor visor-mini">' + video(clip, 'v916') + '<span class="dur">' + esc(formatoSeg(clip.duracion)) + '</span></div>' +
    '<div class="mini-cab"><strong>' + esc(tituloDe(clip, e.ediciones)) + '</strong>' + insigniaPuntaje(clip) + '</div>' +
    '<p class="mini-gancho">' + (ganchoDe(clip) ? '“' + esc(ganchoDe(clip)) + '”' : '<span class="suave">Sin gancho detectado</span>') + '</p>' +
    chipsBloques(clip) +
  '</article>';
}

function htmlProyectos(clips) {
  const proyectos = agruparProyectos(clips);
  const abierto = e.abierto && proyectos.find((p) => p.id === e.abierto);
  if (abierto) {
    return '<div class="detalle-cab"><button class="btn" type="button" data-accion="cerrar-proyecto">← Proyectos</button>' +
        '<div><h2>' + esc(abierto.titulo) + '</h2><div class="meta"><span>' + abierto.listos + ' de ' + abierto.total + ' clips listos</span>' +
        '<span>Duración ' + esc(formatoSeg(abierto.duracionTotal)) + '</span>' +
        (abierto.fuente ? '<a href="' + esc(urlLocal(abierto.fuente)) + '" target="_blank" rel="noopener noreferrer">Ver video original</a>' : '') + '</div></div>' +
        '<button class="btn" type="button" data-accion="ver-clips" data-id="' + esc(abierto.id) + '">Ver en Todos los clips</button></div>' +
      '<div class="fila-clips">' + abierto.clips.map(miniClip).join('') + '</div>';
  }
  const filtrados = filtrarProyectos(proyectos, e.textoProyectos);
  return filtrados.length
    ? '<div class="grid">' + filtrados.map(tarjetaProyecto).join('') + '</div>'
    : vacio(proyectos.length ? 'Ningún proyecto coincide con la búsqueda.' : 'Aún no hay proyectos. Pega un enlace arriba para crear el primero.');
}

/* ---------- Todos los clips ---------- */

function htmlPanel(clip, tipo) {
  if (tipo === 'descripcion') {
    const texto = descripcionDe(clip, e.ediciones);
    return '<div class="panel-extra"><strong>Descripción para publicar</strong><pre>' + esc(texto || 'Sin descripción generada.') + '</pre>' +
      (texto ? '<button class="btn" type="button" data-accion="copiar-desc" data-id="' + esc(clip.id) + '">Copiar</button>' : '') + '</div>';
  }
  if (tipo === 'dicho') {
    return '<div class="panel-extra"><strong>Lo que se dice</strong><pre>' + esc(clip.transcripcion || 'Sin voz detectada en este clip.') + '</pre></div>';
  }
  return '';
}

function tarjetaClip(clip) {
  const rev = revisionDe(clip);
  const fav = e.favoritos.has(clip.id);
  const url = urlLocal(clip.url);
  const proyecto = clip.jobId || clip.id;
  return '<article class="card clip" data-id="' + esc(clip.id) + '">' +
    '<div class="card-cab"><h3>' + esc(tituloDe(clip, e.ediciones)) + '</h3><div class="clip-der">' + insigniaPuntaje(clip) +
      '<button class="fav" type="button" data-accion="fav" data-id="' + esc(clip.id) + '" aria-pressed="' + fav + '" title="' + (fav ? 'Quitar de Me gustan' : 'Me gusta') + '">' + (fav ? '★' : '☆') + '</button></div></div>' +
    '<div class="visor">' + video(clip, 'v916') + '<span class="dur">' + esc(formatoSeg(clip.duracion)) + '</span></div>' +
    '<div class="meta"><span>' + esc(formatoFecha(clip.creadoEn)) + '</span><a href="#" data-accion="ver-clips" data-id="' + esc(proyecto) + '">Mismo proyecto</a></div>' +
    '<div class="bloques">' + bloquesDe(clip).map((b) =>
      '<div class="bloque nivel-' + b.nivel + '"><div class="bloque-cab"><strong>' + esc(b.etiqueta) + '</strong><span>' + (b.puntaje === null ? '—' : Math.round(b.puntaje)) + '</span></div>' +
      '<div class="barra"><span style="width:' + (b.puntaje === null ? 0 : Math.round(b.puntaje)) + '%"></span></div>' +
      (b.detalle ? '<p>' + esc(b.detalle) + '</p>' : '') + '</div>'
    ).join('') + '</div>' +
    '<details class="revision" data-id="' + esc(clip.id) + '"' + (e.revisiones.has(clip.id) ? ' open' : '') + '><summary>Revisión técnica ' + badge(rev.texto, rev.clase) + '</summary>' +
      (rev.filas.length ? '<dl>' + rev.filas.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('') + '</dl>' : '<p class="suave">Sin datos de revisión.</p>') +
      (rev.alertas.length ? '<ul class="alertas">' + rev.alertas.map((a) => '<li>' + esc(a) + '</li>').join('') + '</ul>' : '') + '</details>' +
    '<div class="card-acciones">' +
      '<button class="btn" type="button" data-accion="panel" data-tipo="descripcion" data-id="' + esc(clip.id) + '">Descripción para publicar</button>' +
      '<button class="btn" type="button" data-accion="panel" data-tipo="dicho" data-id="' + esc(clip.id) + '">Lo que se dice</button>' +
      '<button class="btn" type="button" data-accion="editar" data-id="' + esc(clip.id) + '">Editar</button>' +
      (url ? '<a class="btn" href="' + esc(url) + '" download="' + esc(slug(tituloDe(clip, e.ediciones))) + '.mp4">Exportar</a>' : '') +
    '</div>' +
    '<div class="panel-slot">' + htmlPanel(clip, e.paneles.get(clip.id)) + '</div>' +
  '</article>';
}

function htmlClips(clips) {
  const lista = filtrarClipsFlujo(clips, {
    texto: e.textoClips, soloFavoritos: e.soloFavoritos, favoritos: e.favoritos,
    proyecto: e.filtroProyecto, orden: e.orden, ediciones: e.ediciones,
  });
  if (lista.length) return '<div class="grid grid-clips">' + lista.map(tarjetaClip).join('') + '</div>';
  if (e.soloFavoritos && e.favoritos.size === 0) return vacio('Aún no marcaste ningún clip con ★. Pulsa la estrella de un clip para guardarlo en Me gustan.');
  return vacio(clips.some(esTerminado) ? 'Ningún clip coincide con los filtros.' : 'Aún no hay clips listos.');
}

/* ---------- Pintado ---------- */

const hayReproduccion = (contenedor) => [...contenedor.querySelectorAll('video')].some((v) => !v.paused && !v.ended);

function pintar(contenedor, clave, html, forzar = false) {
  if (e.html[clave] === html) return;
  if (!forzar && hayReproduccion(contenedor)) return; // no cortar un video en reproduccion; se pinta en el siguiente sondeo
  contenedor.innerHTML = html;
  e.html[clave] = html;
}

export function contadores(datos) {
  if (!datos) return;
  $('n-proyectos').textContent = String(agruparProyectos(datos.clips).length);
}

function actualizarCabeceras(clips) {
  const proyectos = agruparProyectos(clips);
  $('proy-contador').textContent = proyectos.length + (proyectos.length === 1 ? ' proyecto' : ' proyectos');
  $('proy-toolbar').hidden = Boolean(e.abierto);
  const terminados = clips.filter(esTerminado).length;
  const proceso = clips.filter((c) => c.estado === 'procesando').length;
  $('clips-contador').textContent = terminados + (terminados === 1 ? ' clip' : ' clips') + (proceso ? ' · ' + proceso + ' en proceso' : '');
  $('clips-chip-proyecto').hidden = !e.filtroProyecto;
  document.querySelectorAll('[data-filtro]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filtro === 'favoritos' === e.soloFavoritos)));
  $('clips-favs').textContent = String(e.favoritos.size);
}

export function render(vista, datos, forzar = false) {
  if (datos) e.datos = datos;
  if (!e.datos) return;
  const clips = e.datos.clips;
  contadores(e.datos);
  actualizarCabeceras(clips);
  if (vista === 'proyectos') pintar($('lista-proyectos'), 'proyectos', htmlProyectos(clips), forzar);
  if (vista === 'clips') pintar($('lista-flujo-clips'), 'clips', htmlClips(clips), forzar);
}

/* ---------- Acciones ---------- */

async function copiarTexto(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = texto;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

const clipPorId = (id) => (e.datos ? e.datos.clips.find((c) => c.id === id) : null);

function alternarFavorito(id, boton) {
  if (e.favoritos.has(id)) e.favoritos.delete(id);
  else e.favoritos.add(id);
  guardarLocal(LS_FAV, [...e.favoritos]);
  const fav = e.favoritos.has(id);
  boton.setAttribute('aria-pressed', String(fav));
  boton.textContent = fav ? '★' : '☆';
  boton.title = fav ? 'Quitar de Me gustan' : 'Me gusta';
  $('clips-favs').textContent = String(e.favoritos.size);
  e.html.clips = ''; // el HTML guardado ya no coincide con el DOM: se repinta en el proximo cambio
  if (e.soloFavoritos) render('clips', null, true);
}

function alternarPanel(id, tipo, tarjeta) {
  const clip = clipPorId(id);
  if (!clip) return;
  if (e.paneles.get(id) === tipo) e.paneles.delete(id);
  else e.paneles.set(id, tipo);
  tarjeta.querySelector('.panel-slot').innerHTML = htmlPanel(clip, e.paneles.get(id));
  e.html.clips = '';
}

function abrirEditor(id) {
  const clip = clipPorId(id);
  if (!clip) return;
  e.editando = id;
  $('ed-titulo').value = tituloDe(clip, e.ediciones);
  $('ed-desc').value = descripcionDe(clip, e.ediciones);
  $('dlg-editar').showModal();
  $('ed-titulo').focus();
}

function cerrarEditor() {
  $('dlg-editar').close();
  e.editando = null;
}

function irAClips(proyecto) {
  e.filtroProyecto = proyecto;
  e.ayudas.activarVista('clips', false);
  render('clips', null, true);
}

function iniciarVistas() {
  $('vista-proyectos').addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-accion]');
    if (!el) return;
    ev.preventDefault();
    if (el.dataset.accion === 'abrir-proyecto') { e.abierto = el.dataset.id; render('proyectos', null, true); }
    if (el.dataset.accion === 'cerrar-proyecto') { e.abierto = ''; render('proyectos', null, true); }
    if (el.dataset.accion === 'ver-clips') irAClips(el.dataset.id);
  });

  $('vista-clips').addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-accion], [data-filtro]');
    if (!el) return;
    if (el.dataset.filtro) {
      e.soloFavoritos = el.dataset.filtro === 'favoritos';
      render('clips', null, true);
      return;
    }
    const tarjeta = el.closest('.clip');
    const id = el.dataset.id;
    switch (el.dataset.accion) {
      case 'fav': alternarFavorito(id, el); break;
      case 'panel': alternarPanel(id, el.dataset.tipo, tarjeta); break;
      case 'editar': abrirEditor(id); break;
      case 'ver-clips': ev.preventDefault(); irAClips(id); break;
      case 'quitar-proyecto': e.filtroProyecto = ''; render('clips', null, true); break;
      case 'copiar-desc': {
        const clip = clipPorId(id);
        const ok = clip ? await copiarTexto(descripcionDe(clip, e.ediciones)) : false;
        e.ayudas.mostrarAviso(ok ? 'Descripción copiada al portapapeles.' : 'No se pudo copiar la descripción.', ok ? 'ok' : 'error');
        break;
      }
      default: break;
    }
  });

  // <details> no propaga "toggle": se escucha en captura para recordar que revisiones estan abiertas.
  $('vista-clips').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (!d.classList || !d.classList.contains('revision')) return;
    if (d.open) e.revisiones.add(d.dataset.id);
    else e.revisiones.delete(d.dataset.id);
  }, true);

  let temporizador = null;
  const conRetardo = (fn) => (ev) => {
    clearTimeout(temporizador);
    const valor = ev.target.value;
    temporizador = setTimeout(() => fn(valor), 150);
  };
  $('proy-buscar').addEventListener('input', conRetardo((v) => { e.textoProyectos = v; render('proyectos', null, true); }));
  $('clips-buscar').addEventListener('input', conRetardo((v) => { e.textoClips = v; render('clips', null, true); }));
  $('clips-orden').addEventListener('change', (ev) => { e.orden = ev.target.value; render('clips', null, true); });
}

function iniciarEditor() {
  $('form-editar').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!e.editando) return;
    const titulo = $('ed-titulo').value.trim();
    const descripcion = $('ed-desc').value.trim();
    if (titulo || descripcion) e.ediciones[e.editando] = { titulo, descripcion };
    else delete e.ediciones[e.editando];
    guardarLocal(LS_ED, e.ediciones);
    cerrarEditor();
    render('clips', null, true);
    e.ayudas.mostrarAviso('Cambios guardados en este navegador.', 'ok');
  });
  $('ed-restaurar').addEventListener('click', () => {
    if (e.editando) delete e.ediciones[e.editando];
    guardarLocal(LS_ED, e.ediciones);
    cerrarEditor();
    render('clips', null, true);
    e.ayudas.mostrarAviso('Se restauró el texto original del clip.', 'info');
  });
  $('ed-cancelar').addEventListener('click', cerrarEditor);
}

/* ---------- Creacion ---------- */

function iniciarCrear() {
  const select = $('sel-encuadre');
  select.innerHTML = Object.entries(ENCUADRES).map(([valor, texto]) => '<option value="' + esc(valor) + '">' + esc(texto) + '</option>').join('');

  $('form-encolar').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const entrada = prepararEncolar({ url: $('input-url').value, modo: select.value, cantidad: $('sel-cantidad').value });
    if (!entrada.ok) {
      e.ayudas.mostrarAviso(entrada.error, 'error', 6000);
      return;
    }
    const boton = $('btn-encolar');
    boton.disabled = true;
    try {
      const { url, ...opciones } = entrada.cuerpo;
      await encolarVideo(url, opciones);
      $('input-url').value = '';
      e.ayudas.mostrarAviso('Proyecto en cola: el sistema elegirá los mejores momentos.', 'ok');
      e.abierto = '';
      e.ayudas.activarVista('proyectos', false);
      e.ayudas.sondearYa();
    } catch (error) {
      if (error.status === 401) e.ayudas.abrirLlave();
      e.ayudas.mostrarAviso('No se pudo crear el proyecto: ' + error.message, 'error', 6000);
    } finally {
      boton.disabled = false;
    }
  });
}

/** ayudas: { mostrarAviso, abrirLlave, sondearYa, activarVista } provistas por panel.js */
export function iniciar(ayudas) {
  e.ayudas = ayudas;
  iniciarCrear();
  iniciarVistas();
  iniciarEditor();
}
FIN_FLUJO_JS

echo "-> public/index.html"
cat > public/index.html <<'FIN_INDEX_HTML'
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#0a0d14">
  <title>ClipLab Pro</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%236d7bff'/%3E%3Cpath d='M12 9l12 7-12 7z' fill='white'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="/css/styles.css">
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <div class="logo" aria-hidden="true">&#9654;</div>
        <div>
          <h1>ClipLab <span>Pro</span></h1>
          <p id="sync" class="sync" data-estado="pendiente" role="status">
            <span class="dot"></span><span id="sync-texto">Conectando...</span>
          </p>
        </div>
      </div>
      <div class="acciones">
        <button id="btn-refrescar" class="btn btn-icono" type="button" title="Actualizar ahora" aria-label="Actualizar ahora">&#10227;</button>
        <a class="btn" id="lnk-sesion" href="/sesion.html" style="text-decoration:none">&#127850; Sesion</a>
        <button id="btn-llave" class="btn" type="button">&#128273; Llave</button>
      </div>
    </header>

    <form id="form-encolar" class="crear" autocomplete="off">
      <div class="crear-fila">
        <input id="input-url" type="url" inputmode="url" placeholder="Pega el enlace del video (https://...)" required>
        <button id="btn-encolar" class="btn btn-primario" type="submit">Crear clips</button>
      </div>
      <div class="crear-opciones">
        <label class="campo">Formato
          <select id="sel-formato" disabled title="El motor siempre exporta en vertical"><option>9:16 vertical</option></select>
        </label>
        <label class="campo">Calidad
          <select id="sel-calidad" disabled title="Resolución fija del motor"><option>1080x1920</option></select>
        </label>
        <label class="campo">Encuadre
          <select id="sel-encuadre" title="Conversación: sigue a quien habla. Plano amplio: video completo sobre fondo desenfocado."></select>
        </label>
        <label class="campo">Clips
          <select id="sel-cantidad" title="Cuántos momentos extraer del video">
            <option value="auto">Automático (4-5)</option>
            <option value="1">1</option><option value="2">2</option><option value="3">3</option>
            <option value="4">4</option><option value="5">5</option>
          </select>
        </label>
        <label class="campo">Subtítulos
          <select id="sel-subtitulos" disabled title="Estilo único disponible por ahora"><option>Dinámico por palabra</option></select>
        </label>
      </div>
      <details class="proximamente">
        <summary>Próximamente: subir archivo local e instrucción</summary>
        <div class="crear-opciones">
          <label class="campo campo-ancho">Subir archivo local <input type="file" disabled></label>
          <label class="campo campo-ancho">Qué buscar (opcional) <input type="text" disabled placeholder="Ej.: los momentos donde hablan de precios"></label>
        </div>
        <p class="suave">El servidor todavía solo procesa enlaces de YouTube y elige los momentos solo. Estos dos campos se activan cuando el backend los soporte.</p>
      </details>
    </form>

    <p id="aviso" class="aviso" hidden role="status"></p>

    <nav class="tabs" role="tablist" aria-label="Secciones">
      <button class="tab" role="tab" type="button" data-vista="resumen">Resumen</button>
      <button class="tab" role="tab" type="button" data-vista="conexiones">Conexiones</button>
      <button class="tab" role="tab" type="button" data-vista="proyectos">Proyectos <span id="n-proyectos" class="contador">0</span></button>
      <button class="tab" role="tab" type="button" data-vista="clips">Todos los clips <span id="n-clips" class="contador">0</span></button>
      <button class="tab" role="tab" type="button" data-vista="lotes">Lotes / Variantes <span id="n-lotes" class="contador">0</span></button>
      <button class="tab" role="tab" type="button" data-vista="incidencias">Incidencias <span id="n-incidencias" class="contador">0</span></button>
      <button class="tab" role="tab" type="button" data-vista="marketing">Marketing y Analiticas</button>
    </nav>

    <main>
      <section id="vista-resumen" class="vista" data-vista="resumen" role="tabpanel">
        <div id="kpis" class="kpis"></div>
        <h2 class="titulo-seccion">Trabajos activos</h2>
        <div id="trabajos-activos" class="lista"></div>
        <h2 class="titulo-seccion">Clips listos</h2>
        <div id="clips-listos" class="grid"></div>
      </section>

      <section id="vista-conexiones" class="vista" data-vista="conexiones" role="tabpanel" hidden>
        <div id="lista-conexiones" class="grid"></div>
      </section>

      <section id="vista-proyectos" class="vista" data-vista="proyectos" role="tabpanel" hidden>
        <div id="proy-toolbar" class="toolbar">
          <input id="proy-buscar" type="search" placeholder="Buscar proyecto..." aria-label="Buscar proyectos">
          <span id="proy-contador" class="suave">0 proyectos</span>
        </div>
        <div id="lista-proyectos"></div>
      </section>

      <section id="vista-clips" class="vista" data-vista="clips" role="tabpanel" hidden>
        <div class="toolbar">
          <input id="clips-buscar" type="search" placeholder="Buscar por título o lo que se dice..." aria-label="Buscar clips">
          <div class="segmento" role="group" aria-label="Filtro">
            <button class="btn" type="button" data-filtro="todos" aria-pressed="true">Todos</button>
            <button class="btn" type="button" data-filtro="favoritos" aria-pressed="false">Me gustan <span id="clips-favs" class="contador">0</span></button>
          </div>
          <select id="clips-orden" aria-label="Ordenar">
            <option value="recientes">Más recientes</option>
            <option value="puntaje">Mejor puntaje</option>
          </select>
          <span id="clips-contador" class="suave">0 clips</span>
          <span id="clips-chip-proyecto" class="chip-filtro" hidden>Solo un proyecto <button type="button" data-accion="quitar-proyecto" aria-label="Quitar filtro de proyecto">&times;</button></span>
        </div>
        <div id="lista-flujo-clips"></div>
      </section>

      <section id="vista-lotes" class="vista" data-vista="lotes" role="tabpanel" hidden>
        <div id="lista-lotes" class="grid"></div>
      </section>

      <section id="vista-incidencias" class="vista" data-vista="incidencias" role="tabpanel" hidden>
        <div class="toolbar">
          <label class="check"><input id="inc-ocultar" type="checkbox"> Ocultar resueltas</label>
        </div>
        <div id="lista-incidencias" class="lista"></div>
      </section>

      <section id="vista-marketing" class="vista" data-vista="marketing" role="tabpanel" hidden>
        <div id="marketing"></div>
      </section>
    </main>
  </div>

  <dialog id="dlg-llave">
    <form id="form-llave" autocomplete="off">
      <h2>Llave maestra</h2>
      <p>Se guarda solo en este navegador y se envia en la cabecera <code>x-master-key</code>.</p>
      <input id="input-llave" class="secreto" type="text" name="clave-maestra-cliplab" placeholder="MASTER_KEY" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
      <div class="dlg-acciones">
        <button id="llave-borrar" class="btn" type="button">Borrar</button>
        <button id="llave-cancelar" class="btn" type="button">Cancelar</button>
        <button class="btn btn-primario" type="submit">Guardar</button>
      </div>
    </form>
  </dialog>

  <dialog id="dlg-red">
    <form id="form-red" autocomplete="off">
      <h2 id="red-titulo">Pegar cookies</h2>
      <p id="red-pasos"></p>
      <textarea id="input-cookies" class="area-cookies" rows="8" spellcheck="false" autocomplete="off" placeholder='[ { "name": "sessionid", "value": "...", "domain": ".tiktok.com" } ]'></textarea>
      <p id="red-error" class="red-error" role="alert" hidden></p>
      <div class="dlg-acciones">
        <button id="red-cancelar" class="btn" type="button">Cancelar</button>
        <button id="red-guardar" class="btn btn-primario" type="submit">Guardar</button>
      </div>
    </form>
  </dialog>

  <dialog id="dlg-editar">
    <form id="form-editar" autocomplete="off">
      <h2>Editar clip</h2>
      <p>Los cambios se guardan solo en este navegador; el video y la ficha del servidor no se modifican.</p>
      <label class="campo-bloque">Título <input id="ed-titulo" type="text" maxlength="120"></label>
      <label class="campo-bloque">Descripción para publicar <textarea id="ed-desc" class="area-cookies" rows="8"></textarea></label>
      <div class="dlg-acciones">
        <button id="ed-restaurar" class="btn" type="button">Restaurar original</button>
        <button id="ed-cancelar" class="btn" type="button">Cancelar</button>
        <button class="btn btn-primario" type="submit">Guardar</button>
      </div>
    </form>
  </dialog>

  <noscript><p class="aviso">ClipLab Pro necesita JavaScript para funcionar.</p></noscript>
  <script type="module" src="/js/panel.js"></script>
</body>
</html>
FIN_INDEX_HTML

echo "-> tests/proyectos.test.js"
cat > tests/proyectos.test.js <<'FIN_TEST_PROYECTOS'
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL = 'error';

const P = await import('../public/js/proyectos.js');
const { curarVideo, armarRevisionTecnica } = await import('../src/engine/curador.js');

// Clips con fichas REALES del curador (lo que el backend deja en clip.ficha), no inventadas.
const FRASES = [
  '¿Sabías que el error más caro en tu negocio es nunca medir los resultados?',
  'El primer paso de la estrategia es medir tus ventas cada semana con una herramienta simple.',
  'Un ejemplo claro: un cliente subió sus ingresos 40 por ciento con este método.',
  'La clave es aplicar el sistema todos los días sin excepción.',
];
const PLANAS = ['El clima de la ciudad estuvo bastante normal durante la tarde.', 'La gente caminaba por la calle principal sin mucha prisa.'];

function charla() {
  const palabras = [];
  let t = 0;
  for (let i = 0; i < 160; i++) {
    const caliente = (i >= 60 && i < 85) || (i >= 120 && i < 135);
    for (const w of (caliente ? FRASES[i % FRASES.length] : PLANAS[i % PLANAS.length]).split(' ')) {
      palabras.push({ texto: w, inicio: t, fin: t + 0.33 });
      t += 0.36;
    }
    t += 0.3;
  }
  return { palabras, duracion: Math.ceil(t) };
}

const { palabras, duracion } = charla();
const curado = curarVideo({ palabras, duracionVideo: duracion, tituloVideo: 'Charla de negocios' });
assert.ok(curado.clips.length >= 2, 'el curador debe devolver clips para la prueba');

function clipDe(c, i, extra = {}) {
  const ficha = { ...c.ficha, revisionTecnica: armarRevisionTecnica({ modo: 'recorte', duracion: c.duracion, resultado: { ancho: 1080, alto: 1920, duracion: c.duracion, conLogo: true }, palabras: 40 }) };
  return {
    id: 'clip_' + i, jobId: 'clip_0', titulo: 'Charla de negocios', fuente: 'https://youtu.be/abc',
    url: '/clips/' + i + '.mp4', estado: 'listo', duracion: c.duracion, inicio: c.inicio,
    transcripcion: 'texto del clip ' + i + ' sobre estrategia', ficha, marketing: null, copy: ficha.descripcion,
    creadoEn: '2026-11-18T10:0' + i + ':00.000Z', ...extra,
  };
}
const clips = curado.clips.map((c, i) => clipDe(c, i));

test('bloquesDe devuelve Gancho / Flujo / Valor / Interés con los puntajes del curador', () => {
  const b = P.bloquesDe(clips[0]);
  assert.deepEqual(b.map((x) => x.etiqueta), ['Gancho', 'Flujo', 'Valor', 'Interés']);
  assert.equal(b[0].puntaje, clips[0].ficha.gancho.puntaje);
  assert.equal(b[2].puntaje, clips[0].ficha.valor.puntaje);
  assert.ok(b.every((x) => ['alto', 'medio', 'bajo'].includes(x.nivel)));
});

test('un clip sin ficha (planificador) no rompe: puntajes nulos y nivel "sin"', () => {
  const sinFicha = { id: 'x', estado: 'listo', titulo: 'Solo titulo', copy: 'copy viejo' };
  assert.equal(P.puntajeDe(sinFicha), null);
  assert.equal(P.tituloDe(sinFicha), 'Solo titulo');
  assert.equal(P.descripcionDe(sinFicha), 'copy viejo');
  assert.ok(P.bloquesDe(sinFicha).every((b) => b.puntaje === null && b.nivel === 'sin'));
  assert.equal(P.revisionDe(sinFicha).estado, 'sin-datos');
});

test('revisionDe resume la revision tecnica verificada y marca alertas', () => {
  const r = P.revisionDe(clips[0]);
  assert.equal(r.estado, 'verificado');
  assert.equal(r.clase, 'ok');
  assert.ok(r.filas.some(([k, v]) => k === 'Resolución' && v.includes('1080x1920')));
  const mala = { ficha: { revisionTecnica: armarRevisionTecnica({ resultado: { ancho: 720, alto: 1280, duracion: 20 }, palabras: 0 }) } };
  const rm = P.revisionDe(mala);
  assert.equal(rm.clase, 'warn');
  assert.ok(rm.alertas.length >= 2);
});

test('agruparProyectos junta los clips por jobId con conteo, duracion y mejor puntaje', () => {
  const otro = clipDe(curado.clips[0], 9, { id: 'clip_9', jobId: 'clip_9', titulo: 'Otro video', creadoEn: '2026-11-18T11:00:00.000Z' });
  const procesando = clipDe(curado.clips[0], 8, { id: 'clip_8', jobId: 'clip_0', estado: 'procesando', url: null, duracion: null });
  const proyectos = P.agruparProyectos([...clips, procesando, otro]);
  assert.equal(proyectos.length, 2);
  assert.equal(proyectos[0].id, 'clip_9', 'el mas reciente primero');
  const p = proyectos[1];
  assert.equal(p.total, clips.length + 1);
  assert.equal(p.listos, clips.length);
  assert.equal(p.estado, 'procesando');
  assert.equal(p.mejorPuntaje, Math.max(...clips.map(P.puntajeDe)));
  assert.ok(Math.abs(p.duracionTotal - clips.reduce((s, c) => s + c.duracion, 0)) < 1e-9);
  assert.equal(p.miniatura.id, p.clips.find((c) => c.url).id);
  const inicios = p.clips.filter((c) => c.inicio !== undefined).map((c) => c.inicio);
  assert.deepEqual(inicios, [...inicios].sort((a, b) => a - b), 'clips en orden cronologico del video');
});

test('estado del proyecto: error cuando nada salio, parcial cuando hay mezcla', () => {
  assert.equal(P.agruparProyectos([{ id: 'a', jobId: 'a', estado: 'error', creadoEn: 'x' }])[0].estado, 'error');
  const mezcla = P.agruparProyectos([clips[0], { ...clips[1], estado: 'error' }])[0];
  assert.equal(mezcla.estado, 'parcial');
});

test('filtrarClipsFlujo: solo terminados, busqueda sin acentos, favoritos, orden y proyecto', () => {
  const todos = [...clips, { ...clips[0], id: 'c_proc', estado: 'procesando' }, clipDe(curado.clips[0], 7, { id: 'c_otro', jobId: 'otro' })];
  assert.equal(P.filtrarClipsFlujo(todos).every(P.esTerminado), true);
  assert.equal(P.filtrarClipsFlujo(todos, { texto: 'ESTRATEGIA' }).length, clips.length + 1);
  assert.equal(P.filtrarClipsFlujo(todos, { texto: 'estratégia' }).length, clips.length + 1, 'ignora acentos');
  assert.equal(P.filtrarClipsFlujo(todos, { texto: 'zzzz' }).length, 0);
  assert.equal(P.filtrarClipsFlujo(todos, { texto: 'estrategia', soloFavoritos: true, favoritos: [clips[1].id] }).length, 1);
  assert.equal(P.filtrarClipsFlujo(todos, { proyecto: 'otro' }).length, 1);
  const porPuntaje = P.filtrarClipsFlujo(clips, { orden: 'puntaje' }).map(P.puntajeDe);
  assert.deepEqual(porPuntaje, [...porPuntaje].sort((a, b) => b - a));
});

test('las ediciones locales mandan sobre la ficha y se buscan por titulo editado', () => {
  const ed = { [clips[0].id]: { titulo: 'Mi titulo propio', descripcion: 'Mi descripcion' } };
  assert.equal(P.tituloDe(clips[0], ed), 'Mi titulo propio');
  assert.equal(P.descripcionDe(clips[0], ed), 'Mi descripcion');
  assert.equal(P.filtrarClipsFlujo(clips, { texto: 'titulo propio', ediciones: ed }).length, 1);
});

test('prepararEncolar valida y arma el cuerpo que acepta /api/panel/encolar', () => {
  assert.deepEqual(P.prepararEncolar({ url: ' https://youtu.be/x ', modo: 'blur', cantidad: '3' }), { ok: true, cuerpo: { url: 'https://youtu.be/x', modo: 'blur', cantidad: 3 } });
  assert.deepEqual(P.prepararEncolar({ url: 'https://youtu.be/x', cantidad: 'auto' }).cuerpo, { url: 'https://youtu.be/x', modo: 'recorte' });
  assert.equal(P.prepararEncolar({ url: 'youtube.com' }).ok, false);
  assert.equal(P.prepararEncolar({ url: 'https://a.b', modo: 'zoom' }).ok, false);
  assert.equal(P.prepararEncolar({ url: 'https://a.b', cantidad: '9' }).ok, false);
  assert.equal(P.prepararEncolar({ url: 'https://a.b', cantidad: '1.5' }).ok, false);
});

test('slug y formatoSeg', () => {
  assert.equal(P.slug('¡Cómo vender MÁS! en 2026'), 'como-vender-mas-en-2026');
  assert.equal(P.slug('???'), 'clip');
  assert.equal(P.formatoSeg(65.4), '1:05');
  assert.equal(P.formatoSeg(null), '—');
});
FIN_TEST_PROYECTOS

grep -q 'Flujo: crear, Proyectos' public/css/styles.css || {

echo "-> public/css/styles.css (se anade al final)"
cat >> public/css/styles.css <<'FIN_CSS'

/* ---------- Flujo: crear, Proyectos, Todos los clips ---------- */
.suave { color: var(--suave); }
.crear { display: flex; flex-direction: column; gap: 10px; margin-bottom: 10px; }
.crear-fila { display: flex; gap: 10px; }
.crear-fila .btn { padding: 10px 18px; white-space: nowrap; }
.crear-opciones { display: flex; flex-wrap: wrap; gap: 10px; }
.campo { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--suave); text-transform: uppercase; letter-spacing: .04em; min-width: 140px; }
.campo select, .campo input { text-transform: none; letter-spacing: 0; font-size: 13px; }
.campo select:disabled, .campo input:disabled { opacity: .55; cursor: not-allowed; }
.campo-ancho { flex: 1 1 260px; }
.campo-bloque { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; color: var(--suave); font-size: 12px; }
.proximamente summary { cursor: pointer; color: var(--suave); font-size: 12px; margin-bottom: 8px; }

.toolbar .segmento { display: flex; gap: 0; }
.segmento .btn { border-radius: 0; }
.segmento .btn:first-child { border-radius: 8px 0 0 8px; }
.segmento .btn:last-child { border-radius: 0 8px 8px 0; margin-left: -1px; }
.segmento .btn[aria-pressed="true"] { background: var(--acento); border-color: var(--acento); color: #fff; }
.chip-filtro { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border: 1px solid var(--borde); border-radius: 999px; color: var(--suave); font-size: 12px; }
.chip-filtro button { background: none; border: 0; color: var(--texto); cursor: pointer; font-size: 15px; line-height: 1; }
.toolbar { flex-wrap: wrap; }
.toolbar input[type="search"] { flex: 1 1 220px; }

.proyecto .miniatura { aspect-ratio: 16 / 9; background: var(--panel-2); border-radius: 10px; overflow: hidden; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.mini-video { width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
.sin-video { color: var(--suave); font-size: 12px; padding: 12px; text-align: center; }
.detalle-cab { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; margin-bottom: 14px; }
.detalle-cab > div { flex: 1 1 240px; min-width: 0; }
.detalle-cab h2 { margin: 0 0 4px; font-size: 18px; overflow-wrap: anywhere; }
.fila-clips { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 10px; scroll-snap-type: x proximity; }
.mini { flex: 0 0 200px; scroll-snap-align: start; background: var(--panel); border: 1px solid var(--borde); border-radius: var(--radio); padding: 10px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.mini-estado { align-items: center; justify-content: center; min-height: 200px; color: var(--suave); }
.mini-cab { display: flex; justify-content: space-between; gap: 6px; align-items: flex-start; font-size: 12px; }
.mini-cab strong { overflow-wrap: anywhere; }
.mini-gancho { margin: 0; font-size: 12px; color: var(--texto); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }

.visor { position: relative; background: #000; border-radius: 10px; overflow: hidden; }
.visor .v916 { display: block; width: 100%; aspect-ratio: 9 / 16; object-fit: contain; background: #000; }
.visor .sin-video { aspect-ratio: 9 / 16; display: flex; align-items: center; justify-content: center; }
.visor .dur { position: absolute; right: 8px; top: 8px; background: rgba(0, 0, 0, .65); border-radius: 6px; padding: 1px 7px; font-size: 11px; pointer-events: none; }
.visor-mini .v916 { max-height: 300px; }
.chips-bloques { display: flex; flex-wrap: wrap; gap: 4px; }
.chip-bloque { font-size: 10px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--borde); color: var(--suave); }
.chip-bloque b { color: var(--texto); }
.chip-bloque.nivel-alto, .bloque.nivel-alto .barra span { border-color: rgba(62, 207, 142, .5); }
.chip-bloque.nivel-medio { border-color: rgba(90, 176, 255, .5); }
.chip-bloque.nivel-bajo { border-color: rgba(245, 184, 75, .5); }

.grid-clips { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
.clip-der { display: flex; align-items: center; gap: 6px; flex: none; }
.fav { background: none; border: 1px solid var(--borde); border-radius: 8px; color: var(--warn); font-size: 18px; line-height: 1; padding: 2px 8px; cursor: pointer; }
.fav[aria-pressed="true"] { background: rgba(245, 184, 75, .12); border-color: rgba(245, 184, 75, .5); }
.bloques { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.bloque { background: var(--panel-2); border: 1px solid var(--borde); border-radius: 10px; padding: 8px; min-width: 0; }
.bloque-cab { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
.bloque .barra { height: 6px; }
.bloque.nivel-alto .barra span { background: var(--ok); }
.bloque.nivel-medio .barra span { background: var(--info); }
.bloque.nivel-bajo .barra span { background: var(--warn); }
.bloque p { margin: 6px 0 0; font-size: 11px; color: var(--suave); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.revision { border: 1px solid var(--borde); border-radius: 10px; padding: 8px 10px; }
.revision summary { cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 12px; }
.revision dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 8px 0 0; font-size: 12px; }
.revision dt { color: var(--suave); }
.revision dd { margin: 0; }
.alertas { margin: 8px 0 0; padding-left: 18px; color: var(--warn); font-size: 12px; }
.panel-extra { background: var(--panel-2); border: 1px solid var(--borde); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.panel-extra strong { font-size: 11px; color: var(--suave); text-transform: uppercase; letter-spacing: .05em; }
.panel-extra pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; max-height: 240px; overflow-y: auto; }
.card-acciones a.btn { text-decoration: none; }

@media (max-width: 640px) {
  .crear-fila { flex-direction: column; }
  .campo { min-width: calc(50% - 5px); flex: 1 1 calc(50% - 5px); }
  .bloques { grid-template-columns: 1fr; }
}
FIN_CSS
}

grep -q 'tests/proyectos.test.js' package.json || sed -i 's#tests/curador-pipeline.test.js#tests/curador-pipeline.test.js tests/proyectos.test.js#' package.json

echo
echo "Listo. Ahora ejecuta:  npm test"
