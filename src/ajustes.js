// ---------------------------------------------------------------------------
// Ajustes de edicion de un clip (velocidad, tono, color, encuadre, espejo y logo/foto propio).
// Puro y determinista: valida lo que llega del panel y arma los fragmentos de filtro de FFmpeg.
// Mismos valores que public/js/ajustes.js (una prueba los compara para que no se desalineen).
//
//   { velocidad: 1 | 1.1 | 1.2 | 1.25 | 1.5,        tono: -2..2 semitonos (el audio cambia de tono, no de duracion),
//     color: normal | calido | frio | vivido | bn,   encuadre: auto | centrado | amplio,
//     espejo: boolean,
//     logo: { id, recorteFondo, x, y, escala } | null }   x,y = centro del logo (0..1 del cuadro), escala = ancho (0.08..0.6)
// ---------------------------------------------------------------------------

export const VELOCIDADES = Object.freeze([1, 1.1, 1.2, 1.25, 1.5]);
export const TONOS = Object.freeze([-2, -1, 0, 1, 2]);
export const COLORES = Object.freeze(['normal', 'calido', 'frio', 'vivido', 'bn']);
export const ENCUADRES = Object.freeze(['auto', 'centrado', 'amplio']);
export const LOGO_ESCALA = Object.freeze({ min: 0.08, max: 0.6 });
export const ID_LOGO = /^logo_[0-9a-f]{16}$/;

export class ErrorAjustes extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.status = 400;   // el manejador de errores de Express ya respeta e.status
  }
}

const acotar = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r3 = (v) => Math.round(v * 1000) / 1000;

function saneaLogo(raw) {
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ErrorAjustes('El logo debe ser un objeto { id, x, y, escala }');
  if (!ID_LOGO.test(String(raw.id))) throw new ErrorAjustes('Logo desconocido: sube la imagen de nuevo');
  const x = Number(raw.x ?? 0.5);
  const y = Number(raw.y ?? 0.15);
  const escala = Number(raw.escala ?? 0.25);
  if (![x, y, escala].every(Number.isFinite)) throw new ErrorAjustes('Posicion o tamano de logo invalidos');
  return {
    id: String(raw.id),
    recorteFondo: raw.recorteFondo === true || raw.recorteFondo === 'true',
    x: r3(acotar(x, 0, 1)),
    y: r3(acotar(y, 0, 1)),
    escala: r3(acotar(escala, LOGO_ESCALA.min, LOGO_ESCALA.max)),
  };
}

/**
 * Devuelve los ajustes normalizados, o null si no hay nada que aplicar (todo neutro y sin logo).
 * Acepta objeto o texto JSON (multipart). Lanza ErrorAjustes (400) con valores fuera de catalogo.
 */
export function sanearAjustes(raw) {
  let a = raw;
  if (a === undefined || a === null || a === '') return null;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { throw new ErrorAjustes('Los ajustes no son un JSON valido'); }
  }
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new ErrorAjustes('Los ajustes deben ser un objeto');

  const velocidad = a.velocidad === undefined || a.velocidad === '' ? 1 : Number(a.velocidad);
  if (!VELOCIDADES.includes(velocidad)) throw new ErrorAjustes('Velocidad no permitida: usa ' + VELOCIDADES.join(', ') + 'x');
  const tono = a.tono === undefined || a.tono === '' ? 0 : Number(a.tono);
  if (!TONOS.includes(tono)) throw new ErrorAjustes('Tono no permitido: usa entre ' + TONOS[0] + ' y +' + TONOS[TONOS.length - 1] + ' semitonos');
  const color = a.color === undefined || a.color === '' ? 'normal' : String(a.color).toLowerCase();
  if (!COLORES.includes(color)) throw new ErrorAjustes('Color no permitido: usa ' + COLORES.join(', '));
  const encuadre = a.encuadre === undefined || a.encuadre === '' ? 'auto' : String(a.encuadre).toLowerCase();
  if (!ENCUADRES.includes(encuadre)) throw new ErrorAjustes('Encuadre no permitido: usa ' + ENCUADRES.join(', '));
  const espejo = a.espejo === true || a.espejo === 'true';
  const logo = saneaLogo(a.logo);

  const limpio = { velocidad, tono, color, encuadre, espejo, logo };
  return esNeutro(limpio) ? null : limpio;
}

export function esNeutro(a) {
  return !a || (a.velocidad === 1 && a.tono === 0 && a.color === 'normal' && a.encuadre === 'auto' && !a.espejo && !a.logo);
}

const FILTRO_COLOR = {
  normal: '',
  calido: 'eq=saturation=1.1,colorbalance=rs=0.06:bs=-0.06:rm=0.04:bm=-0.04',
  frio: 'colorbalance=rs=-0.06:bs=0.08:rm=-0.04:bm=0.05',
  vivido: 'eq=saturation=1.35:contrast=1.08',
  bn: 'hue=s=0',
};

/** Espejo + color: van justo despues del encuadre y ANTES de logo y subtitulos (asi el texto nunca sale al reves). */
export function filtroImagen(a) {
  if (!a) return '';
  return [a.espejo ? 'hflip' : '', FILTRO_COLOR[a.color] || ''].filter(Boolean).join(',');
}

/** Velocidad del video: va al FINAL de la cadena, con subtitulos y logos ya pintados en los cuadros (siguen sincronizados). */
export function filtroVelocidadVideo(a) {
  return a && a.velocidad !== 1 ? 'setpts=PTS/' + a.velocidad : '';
}

/**
 * Audio: velocidad y tono juntos. El tono se cambia remuestreando (asetrate) y se compensa la duracion con atempo,
 * de modo que `atempo = velocidad / factor` (siempre dentro del rango 0.5-2 de FFmpeg con estos catalogos).
 */
export function filtroAudio(a) {
  if (!a || (a.velocidad === 1 && a.tono === 0)) return '';
  const factor = 2 ** (a.tono / 12);
  const partes = [];
  if (a.tono !== 0) partes.push('aresample=44100', 'asetrate=' + Math.round(44100 * factor), 'aresample=44100');
  const tempo = a.velocidad / factor;
  if (Math.abs(tempo - 1) > 1e-6) partes.push('atempo=' + tempo.toFixed(5));
  return partes.join(',');
}

/** Texto corto para chips y registros: ["1.25x", "Espejo", "Tono +1", ...]. */
export function resumen(a) {
  if (!a) return [];
  const t = [];
  if (a.velocidad !== 1) t.push(a.velocidad + 'x');
  if (a.tono !== 0) t.push('Tono ' + (a.tono > 0 ? '+' : '') + a.tono);
  if (a.color !== 'normal') t.push('Color ' + a.color);
  if (a.encuadre !== 'auto') t.push('Encuadre ' + a.encuadre);
  if (a.espejo) t.push('Espejo');
  if (a.logo) t.push(a.logo.recorteFondo ? 'Logo sin fondo' : 'Logo');
  return t;
}
