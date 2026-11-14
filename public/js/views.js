const ETIQUETAS_CLIP = {
  procesando: { texto: 'Procesando', clase: 'info' },
  listo: { texto: 'Listo', clase: 'ok' },
  publicado: { texto: 'Publicado', clase: 'ok' },
  error: { texto: 'Con error', clase: 'err' },
};

const ETIQUETAS_CONEXION = {
  activa: { texto: 'Sesion activa', clase: 'ok' },
  expirada: { texto: 'Sesion expirada', clase: 'warn' },
  sin_sesion: { texto: 'Sin sesion', clase: 'neutro' },
};

const NOMBRES_PLATAFORMA = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
};

const ETIQUETAS_LOTE = {
  activo: { texto: 'Activo', clase: 'info' },
  completado: { texto: 'Completado', clase: 'ok' },
  pausado: { texto: 'Pausado', clase: 'warn' },
  error: { texto: 'Con error', clase: 'err' },
};

const ETIQUETAS_NIVEL = {
  error: { texto: 'Error', clase: 'err' },
  warn: { texto: 'Alerta', clase: 'warn' },
  info: { texto: 'Info', clase: 'info' },
};

export function esc(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

export function formatoFecha(iso) {
  if (!iso) return '-';
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '-';
  return fecha.toLocaleString('es-DO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function formatoDuracion(segundos) {
  const total = Number(segundos);
  if (!Number.isFinite(total) || total <= 0) return '-';
  const minutos = Math.floor(total / 60);
  const resto = Math.round(total % 60);
  return minutos + ':' + String(resto).padStart(2, '0');
}

function urlSegura(url) {
  return typeof url === 'string' && /^(https?:\/\/|\/(?!\/))/i.test(url) ? url : '';
}

function porcentaje(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return 0;
  return Math.max(0, Math.min(100, Math.round(numero)));
}

function badge(etiqueta) {
  return '<span class="badge badge-' + esc(etiqueta.clase) + '">' + esc(etiqueta.texto) + '</span>';
}

function barraProgreso(valor) {
  return '<div class="progreso" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
    porcentaje(valor) + '"><span style="width:' + porcentaje(valor) + '%"></span></div>';
}

function vacio(mensaje) {
  return '<div class="vacio">' + esc(mensaje) + '</div>';
}

export function filtrarClips(clips, estado, texto) {
  const consulta = String(texto || '').trim().toLowerCase();
  return clips.filter((clip) => {
    if (estado !== 'todos' && clip.estado !== estado) return false;
    if (!consulta) return true;
    const contenido = [clip.titulo, clip.transcripcion, clip.copy, clip.cta].join(' ').toLowerCase();
    return contenido.includes(consulta);
  });
}

export function renderKpis(kpis) {
  const k = kpis || {};
  const items = [
    ['Clips listos', k.clipsListos, 'ok'],
    ['En proceso', k.enProceso, 'info'],
    ['Lotes activos', k.lotesActivos, 'acento'],
    ['Incidencias abiertas', k.incidenciasAbiertas, k.incidenciasAbiertas > 0 ? 'err' : 'neutro'],
    ['Publicados hoy', k.publicadosHoy, 'ok'],
  ];
  return items.map(([titulo, valor, clase]) =>
    '<div class="kpi kpi-' + clase + '"><span class="kpi-valor">' + esc(valor ?? 0) +
    '</span><span class="kpi-titulo">' + esc(titulo) + '</span></div>'
  ).join('');
}

export function renderTrabajos(trabajos) {
  if (!trabajos || trabajos.length === 0) {
    return vacio('No hay trabajos activos en este momento.');
  }
  return trabajos.map((t) =>
    '<div class="fila">' +
      '<div class="fila-cab"><span class="fila-titulo">' + esc(t.titulo) + '</span>' +
      badge({ texto: t.etapa || 'En proceso', clase: 'info' }) + '</div>' +
      barraProgreso(t.progreso) +
      '<div class="meta"><span>' + porcentaje(t.progreso) + '%</span><span>Actualizado ' + esc(formatoFecha(t.actualizadoEn)) + '</span></div>' +
    '</div>'
  ).join('');
}

export function renderClips(clips, mensajeVacio) {
  if (!clips || clips.length === 0) {
    return vacio(mensajeVacio || 'No hay clips para mostrar.');
  }
  return clips.map((clip) => {
    const etiqueta = ETIQUETAS_CLIP[clip.estado] || { texto: clip.estado || 'Desconocido', clase: 'neutro' };
    const video = urlSegura(clip.url);
    const fuente = urlSegura(clip.fuente);
    const plataformas = (clip.plataformas || []).map((p) => NOMBRES_PLATAFORMA[p] || p).join(', ');
    const tieneTexto = Boolean(clip.copy || clip.cta);

    return '<article class="card" data-id="' + esc(clip.id) + '">' +
      '<div class="card-cab"><h3>' + esc(clip.titulo) + '</h3>' + badge(etiqueta) + '</div>' +
      '<div class="meta"><span>Duracion: ' + esc(formatoDuracion(clip.duracion)) + '</span>' +
        '<span>Creado: ' + esc(formatoFecha(clip.creadoEn)) + '</span>' +
        (plataformas ? '<span>Publicado en: ' + esc(plataformas) + '</span>' : '') + '</div>' +
      (clip.estado === 'procesando'
        ? barraProgreso(clip.progreso) + '<div class="meta"><span>' + esc(clip.etapa || 'En proceso') + ' - ' + porcentaje(clip.progreso) + '%</span></div>'
        : '') +
      (clip.marketing && clip.marketing.titulo ? '<div class="copy"><strong>Titulo viral</strong><p>' + esc(clip.marketing.titulo) + '</p></div>' : '') +
      (clip.copy ? '<div class="copy"><strong>Descripcion + hashtags</strong><p>' + esc(clip.copy) + '</p></div>' : '') +
      (clip.cta ? '<div class="copy"><strong>CTA</strong><p>' + esc(clip.cta) + '</p></div>' : '') +
      (fuente && fuente !== clip.titulo ? '<div class="fuente">Fuente: <a href="' + esc(fuente) + '" target="_blank" rel="noopener noreferrer">' + esc(fuente) + '</a></div>' : '') +
      '<div class="card-acciones">' +
        (video ? '<a class="btn" href="' + esc(video) + '" target="_blank" rel="noopener noreferrer">Ver video</a>' : '') +
        (tieneTexto ? '<button class="btn" type="button" data-copiar="' + esc(clip.id) + '">Copiar copy</button>' : '') +
      '</div>' +
    '</article>';
  }).join('');
}

export function renderConexiones(conexiones) {
  if (!conexiones || conexiones.length === 0) {
    return vacio('No hay cuentas vinculadas todavia.');
  }
  return conexiones.map((c) => {
    const etiqueta = ETIQUETAS_CONEXION[c.estado] || { texto: c.estado || 'Desconocido', clase: 'neutro' };
    return '<article class="card">' +
      '<div class="card-cab"><h3>' + esc(NOMBRES_PLATAFORMA[c.plataforma] || c.plataforma) + '</h3>' + badge(etiqueta) + '</div>' +
      '<div class="meta"><span>Cuenta: ' + esc(c.cuenta || 'sin vincular') + '</span>' +
      '<span>Ultima verificacion: ' + esc(formatoFecha(c.ultimaVerificacion)) + '</span></div>' +
    '</article>';
  }).join('');
}

export function renderLotes(lotes) {
  if (!lotes || lotes.length === 0) {
    return vacio('No hay lotes de produccion todavia.');
  }
  return lotes.map((l) => {
    const etiqueta = ETIQUETAS_LOTE[l.estado] || { texto: l.estado || 'Desconocido', clase: 'neutro' };
    const total = Number(l.total) || 0;
    const completados = Number(l.completados) || 0;
    const avance = total > 0 ? (completados / total) * 100 : 0;
    return '<article class="card">' +
      '<div class="card-cab"><h3>' + esc(l.nombre || l.id) + '</h3>' + badge(etiqueta) + '</div>' +
      barraProgreso(avance) +
      '<div class="meta"><span>' + completados + ' de ' + total + ' completados</span>' +
      '<span>Fallidos: ' + esc(l.fallidos ?? 0) + '</span>' +
      '<span>Creado: ' + esc(formatoFecha(l.creadoEn)) + '</span></div>' +
    '</article>';
  }).join('');
}

export function renderIncidencias(incidencias, ocultarResueltas, contexto = {}) {
  const abiertas = contexto.abiertas || new Set();
  const textos = contexto.textos || new Map();
  const visibles = (incidencias || []).filter((i) => !(ocultarResueltas && i.resuelta));
  if (visibles.length === 0) {
    return vacio('Sin incidencias registradas.');
  }
  return visibles.map((i) => {
    const etiqueta = ETIQUETAS_NIVEL[i.nivel] || ETIQUETAS_NIVEL.info;
    // El stderr completo se pide bajo demanda (data-inc); mientras llega se muestra el resumen.
    const tieneDetalle = Boolean(i.tieneDetalle || i.detalle);
    const textoDetalle = textos.get(i.id) || i.detalle || i.detalleResumen || '';
    const kb = i.detalleBytes ? ' (' + Math.max(1, Math.round(i.detalleBytes / 1024)) + ' KB)' : '';
    return '<div class="fila nivel-' + esc(i.nivel in ETIQUETAS_NIVEL ? i.nivel : 'info') + (i.resuelta ? ' resuelta' : '') + '">' +
      '<div class="fila-cab"><span class="fila-titulo">' + esc(i.mensaje) + '</span>' + badge(etiqueta) + '</div>' +
      '<div class="meta"><span>Origen: ' + esc(i.origen || 'sistema') + '</span>' +
      '<span>' + esc(formatoFecha(i.creadoEn)) + '</span>' +
      '<span>' + (i.resuelta ? 'Resuelta' : 'Abierta') + '</span></div>' +
      (tieneDetalle
        ? '<details class="detalle" data-inc="' + esc(i.id) + '"' + (abiertas.has(i.id) ? ' open' : '') + '>' +
          '<summary>Ver stderr completo' + esc(kb) + '</summary><pre>' + esc(textoDetalle) + '</pre></details>'
        : '') +
    '</div>';
  }).join('');
}

export function renderMarketing(clips) {
  const lista = clips || [];
  const total = lista.length;
  const conCopy = lista.filter((c) => c.copy).length;
  const conCta = lista.filter((c) => c.cta).length;
  const publicados = lista.filter((c) => c.estado === 'publicado').length;

  const porPlataforma = {};
  for (const clip of lista) {
    for (const plataforma of clip.plataformas || []) {
      porPlataforma[plataforma] = (porPlataforma[plataforma] || 0) + 1;
    }
  }
  const maximo = Math.max(1, ...Object.values(porPlataforma));

  const kpis = renderKpis({}).length ? '' : '';
  void kpis;

  const resumen = [
    ['Clips totales', total, 'acento'],
    ['Con copy', conCopy, 'info'],
    ['Con CTA', conCta, 'info'],
    ['Publicados', publicados, 'ok'],
  ].map(([titulo, valor, clase]) =>
    '<div class="kpi kpi-' + clase + '"><span class="kpi-valor">' + esc(valor) + '</span><span class="kpi-titulo">' + esc(titulo) + '</span></div>'
  ).join('');

  const barras = Object.keys(porPlataforma).length === 0
    ? vacio('Aun no hay publicaciones por plataforma.')
    : Object.entries(porPlataforma).map(([plataforma, cantidad]) =>
      '<div class="barra-fila"><span>' + esc(NOMBRES_PLATAFORMA[plataforma] || plataforma) + '</span>' +
      '<div class="barra"><span style="width:' + Math.round((cantidad / maximo) * 100) + '%"></span></div>' +
      '<span class="barra-num">' + cantidad + '</span></div>'
    ).join('');

  const recientes = lista.filter((c) => c.copy).slice(0, 5).map((c) =>
    '<div class="fila"><div class="fila-titulo">' + esc(c.titulo) + '</div>' +
    '<div class="copy"><strong>Copy</strong><p>' + esc(c.copy) + '</p></div>' +
    (c.cta ? '<div class="copy"><strong>CTA</strong><p>' + esc(c.cta) + '</p></div>' : '') + '</div>'
  ).join('');

  return '<div class="kpis">' + resumen + '</div>' +
    '<h2 class="titulo-seccion">Publicaciones por plataforma</h2>' + barras +
    '<h2 class="titulo-seccion">Ultimos textos comerciales</h2>' +
    '<div class="lista">' + (recientes || vacio('Aun no hay copies generados.')) + '</div>';
}
