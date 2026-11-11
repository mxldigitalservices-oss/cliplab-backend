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

function nuevoId(prefijo) {
  return prefijo + '_' + crypto.randomBytes(4).toString('hex');
}

function recortar(lista) {
  if (lista.length > LIMITE) {
    lista.length = LIMITE;
  }
}

export const store = {
  encolar(url) {
    const ahora = new Date().toISOString();
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
      creadoEn: ahora,
      actualizadoEn: ahora,
      publicadoEn: null,
    };
    datos.clips.unshift(clip);
    recortar(datos.clips);
    return clip;
  },

  registrarIncidencia(nivel, mensaje, origen) {
    const incidencia = {
      id: nuevoId('inc'),
      nivel,
      mensaje,
      origen: origen || 'sistema',
      resuelta: false,
      creadoEn: new Date().toISOString(),
    };
    datos.incidencias.unshift(incidencia);
    recortar(datos.incidencias);
    return incidencia;
  },

  snapshot() {
    const clips = datos.clips;
    const hoy = new Date().toISOString().slice(0, 10);
    const enProceso = clips.filter((c) => c.estado === 'procesando');

    return {
      generadoEn: new Date().toISOString(),
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
  },
};
