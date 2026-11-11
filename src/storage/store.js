import crypto from 'node:crypto';

const PLATAFORMAS = ['tiktok', 'instagram', 'facebook'];
const LIMITE = 500;

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

function recortar(lista) {
  if (lista.length > LIMITE) {
    lista.length = LIMITE;
  }
}

function buscar(id) {
  return datos.clips.find((clip) => clip.id === id) || null;
}

function encolar(url) {
  const marca = ahora();
  const clip = {
    id: nuevoId('clip'),
    titulo: url,
    fuente: url,
    url: null,
    estado: 'procesando',
    etapa: 'En cola',
    progreso: 0,
    duracion: null,
    copy: '',
    cta: '',
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

function registrarIncidencia(nivel, mensaje, origen) {
  const incidencia = {
    id: nuevoId('inc'),
    nivel,
    mensaje,
    origen: origen || 'sistema',
    resuelta: false,
    creadoEn: ahora(),
  };
  datos.incidencias.unshift(incidencia);
  recortar(datos.incidencias);
  return incidencia;
}

function fallar(id, mensaje) {
  const clip = actualizar(id, { estado: 'error', etapa: 'Error' });
  const nombre = clip ? clip.titulo : id;
  registrarIncidencia('error', 'Clip "' + nombre + '": ' + mensaje, 'cola');
  return clip;
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
    incidencias: datos.incidencias,
    clips,
  };
}

export const store = {
  encolar,
  actualizar,
  completar,
  fallar,
  retirarVideo,
  registrarIncidencia,
  snapshot,
};
