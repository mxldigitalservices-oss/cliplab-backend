import crypto from 'node:crypto';

const PLATAFORMAS = ['tiktok', 'instagram', 'facebook'];
const LIMITE = 500;
const LIMITE_INCIDENCIAS = 200;
const MAX_DETALLE = 64 * 1024;
const DETALLE_INLINE = 1500;

const datos = {
  clips: [],
  lotes: [],
  incidencias: [],
  conexiones: PLATAFORMAS.map((plataforma) => ({
    plataforma,
    estado: 'sin_sesion',
    cuenta: null,
    ultimaVerificacion: null,
  })),
};

function ahora() {
  return new Date().toISOString();
}

function nuevoId(prefijo) {
  return prefijo + '_' + crypto.randomBytes(4).toString('hex');
}

function recortar(lista, limite = LIMITE) {
  if (lista.length > limite) {
    lista.length = limite;
  }
}

function buscar(id) {
  return datos.clips.find((clip) => clip.id === id) || null;
}

function encolar(url) {
  const marca = ahora();
  const clip = {
    id: nuevoId('clip'),
    jobId: null,
    titulo: url,
    fuente: url,
    url: null,
    estado: 'procesando',
    etapa: 'En cola',
    progreso: 0,
    duracion: null,
    copy: '',
    cta: '',
    marketing: null,
    segmento: null,
    transcripcion: '',
    plataformas: [],
    creadoEn: marca,
    actualizadoEn: marca,
    publicadoEn: null,
  };
  clip.jobId = clip.id;
  datos.clips.unshift(clip);
  recortar(datos.clips);
  return clip;
}

/** Crea un clip adicional del mismo trabajo (extraccion multiple: un video -> varios clips). */
function crearHijo(jobId, campos = {}) {
  const padre = buscar(jobId);
  const marca = ahora();
  const clip = {
    ...(padre || {}),
    ...campos,
    id: nuevoId('clip'),
    jobId,
    url: null,
    estado: 'procesando',
    etapa: 'En cola',
    progreso: 0,
    duracion: null,
    copy: '',
    cta: '',
    marketing: null,
    transcripcion: '',
    plataformas: [],
    creadoEn: marca,
    actualizadoEn: marca,
    publicadoEn: null,
  };
  datos.clips.unshift(clip);
  recortar(datos.clips);
  return clip;
}

function actualizar(id, parche) {
  const clip = buscar(id);
  if (!clip) return null;
  Object.assign(clip, parche, { actualizadoEn: ahora() });
  return clip;
}

function completar(id, campos) {
  return actualizar(id, { ...campos, estado: 'listo', etapa: 'Listo', progreso: 100 });
}

function registrarIncidencia(nivel, mensaje, origen, detalle) {
  const incidencia = {
    id: nuevoId('inc'),
    nivel,
    mensaje,
    origen: origen || 'sistema',
    detalle: detalle ? String(detalle).slice(-MAX_DETALLE) : null,
    resuelta: false,
    creadoEn: ahora(),
  };
  datos.incidencias.unshift(incidencia);
  recortar(datos.incidencias, LIMITE_INCIDENCIAS);
  return incidencia;
}

function obtenerIncidencia(id) {
  return datos.incidencias.find((i) => i.id === id) || null;
}

// Vista ligera para el sondeo: los detalles cortos (<= DETALLE_INLINE, el tope historico) siguen viajando en
// /estado; los largos (stderr completo, hasta 64 KB) NO, para que el sondeo cada 4 s no se infle. El panel
// los pide bajo demanda a GET /api/panel/incidencias/:id.
function resumenIncidencia(incidencia) {
  const { detalle, ...resto } = incidencia;
  const lineas = detalle ? detalle.split('\n') : [];
  return {
    ...resto,
    detalle: detalle && detalle.length <= DETALLE_INLINE ? detalle : null,
    tieneDetalle: lineas.length > 0,
    detalleResumen: lineas.slice(-2).join('\n').slice(-240),
    detalleBytes: detalle ? detalle.length : 0,
  };
}

function fallar(id, mensaje, detalle) {
  const clip = actualizar(id, { estado: 'error', etapa: 'Error' });
  const nombre = clip ? clip.titulo : id;
  registrarIncidencia('error', 'Clip "' + nombre + '": ' + mensaje, 'cola', detalle);
  return clip;
}

/** Marca como fallidos todos los clips aun en proceso de un trabajo (p. ej. fallo de descarga) con UNA incidencia. */
function fallarTrabajo(jobId, mensaje, detalle) {
  const afectados = datos.clips.filter((c) => c.jobId === jobId && c.estado === 'procesando');
  for (const clip of afectados) {
    Object.assign(clip, { estado: 'error', etapa: 'Error', actualizadoEn: ahora() });
  }
  const nombre = afectados[0] ? afectados[0].titulo : jobId;
  registrarIncidencia('error', 'Clip \"' + nombre + '\": ' + mensaje, 'cola', detalle);
  return afectados;
}

function retirarVideo(rutaUrl) {
  for (const clip of datos.clips) {
    if (clip.url === rutaUrl) {
      clip.url = null;
      clip.etapa = 'Archivo eliminado por limite de almacenamiento';
      clip.actualizadoEn = ahora();
    }
  }
}

function snapshot() {
  const clips = datos.clips;
  const hoy = new Date().toISOString().slice(0, 10);
  const enProceso = clips.filter((c) => c.estado === 'procesando');

  return {
    generadoEn: ahora(),
    resumen: {
      kpis: {
        clipsListos: clips.filter((c) => c.estado === 'listo').length,
        enProceso: enProceso.length,
        lotesActivos: datos.lotes.filter((l) => l.estado === 'activo').length,
        incidenciasAbiertas: datos.incidencias.filter((i) => !i.resuelta).length,
        publicadosHoy: clips.filter(
          (c) => c.estado === 'publicado' && c.publicadoEn && c.publicadoEn.startsWith(hoy)
        ).length,
      },
      trabajosActivos: enProceso.slice(0, 10),
    },
    conexiones: datos.conexiones,
    lotes: datos.lotes,
    incidencias: datos.incidencias.map(resumenIncidencia),
    clips,
  };
}

export const store = {
  encolar,
  crearHijo,
  buscar,
  fallarTrabajo,
  obtenerIncidencia,
  actualizar,
  completar,
  fallar,
  retirarVideo,
  registrarIncidencia,
  snapshot,
};
