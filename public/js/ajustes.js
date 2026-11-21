// Logica pura de los controles de lote (sin DOM, sin red): catalogos, normalizacion, resumen y plan de aplicacion.
// Mismos valores que src/ajustes.js (una prueba los compara para que no se desalineen).

export const VELOCIDADES = Object.freeze([
  { valor: 1, etiqueta: 'Normal' },
  { valor: 1.1, etiqueta: '1.1x' },
  { valor: 1.2, etiqueta: '1.2x' },
  { valor: 1.25, etiqueta: '1.25x' },
  { valor: 1.5, etiqueta: '1.5x' },
]);

export const TONOS = Object.freeze([
  { valor: -2, etiqueta: 'Grave −2' },
  { valor: -1, etiqueta: 'Grave −1' },
  { valor: 0, etiqueta: 'Normal' },
  { valor: 1, etiqueta: 'Agudo +1' },
  { valor: 2, etiqueta: 'Agudo +2' },
]);

export const COLORES = Object.freeze({
  normal: 'Normal',
  calido: 'Cálido',
  frio: 'Frío',
  vivido: 'Vívido',
  bn: 'Blanco y negro',
});

export const ENCUADRES_AJUSTE = Object.freeze({
  auto: 'Automático (sigue a quien habla)',
  centrado: 'Centrado fijo',
  amplio: 'Plano amplio (fondo desenfocado)',
});

export const LOGO_ESCALA = Object.freeze({ min: 0.08, max: 0.6 });
export const LOGO_MAX_BYTES = 5 * 1024 * 1024;
export const LOGO_TIPOS = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const LOGO_DEFECTO = Object.freeze({ x: 0.5, y: 0.15, escala: 0.25 });
const ID_LOGO = /^logo_[0-9a-f]{16}$/;

const acotar = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r3 = (v) => Math.round(v * 1000) / 1000;
const num = (v, def) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : def);

export function ajustesVacios() {
  return { velocidad: 1, tono: 0, color: 'normal', encuadre: 'auto', espejo: false, logo: null };
}

/** Lo que haya en localStorage o en un formulario -> ajustes validos (valores raros vuelven al neutro, nunca lanza). */
export function normalizarAjustes(crudo) {
  const base = ajustesVacios();
  if (!crudo || typeof crudo !== 'object') return base;
  const velocidad = num(crudo.velocidad, 1);
  const tono = num(crudo.tono, 0);
  base.velocidad = VELOCIDADES.some((v) => v.valor === velocidad) ? velocidad : 1;
  base.tono = TONOS.some((t) => t.valor === tono) ? tono : 0;
  base.color = Object.hasOwn(COLORES, crudo.color) ? crudo.color : 'normal';
  base.encuadre = Object.hasOwn(ENCUADRES_AJUSTE, crudo.encuadre) ? crudo.encuadre : 'auto';
  base.espejo = crudo.espejo === true;
  const l = crudo.logo;
  if (l && typeof l === 'object' && ID_LOGO.test(String(l.id))) {
    base.logo = {
      id: String(l.id),
      recorteFondo: l.recorteFondo === true,
      x: r3(acotar(num(l.x, LOGO_DEFECTO.x), 0, 1)),
      y: r3(acotar(num(l.y, LOGO_DEFECTO.y), 0, 1)),
      escala: r3(acotar(num(l.escala, LOGO_DEFECTO.escala), LOGO_ESCALA.min, LOGO_ESCALA.max)),
    };
  }
  return base;
}

export const esNulo = (a) => !a || (a.velocidad === 1 && a.tono === 0 && a.color === 'normal' && a.encuadre === 'auto' && !a.espejo && !a.logo);

export const igualesAjustes = (a, b) => JSON.stringify(normalizarAjustes(a)) === JSON.stringify(normalizarAjustes(b));

/** Etiquetas cortas para chips y avisos: ["1.25x", "Espejo", "Tono +1", ...]. Vacio si no hay nada que aplicar. */
export function resumenAjustes(a) {
  if (esNulo(a)) return [];
  const t = [];
  if (a.velocidad !== 1) t.push(a.velocidad + 'x');
  if (a.tono !== 0) t.push('Tono ' + (a.tono > 0 ? '+' : '') + a.tono);
  if (a.color !== 'normal') t.push(COLORES[a.color]);
  if (a.encuadre !== 'auto') t.push(ENCUADRES_AJUSTE[a.encuadre].split(' (')[0]);
  if (a.espejo) t.push('Espejo');
  if (a.logo) t.push(a.logo.recorteFondo ? 'Logo sin fondo' : 'Logo');
  return t;
}

/** Valida la imagen elegida ANTES de subirla. */
export function validarArchivoLogo(archivo) {
  if (!archivo) return { ok: false, error: 'Elige una imagen' };
  if (!LOGO_TIPOS.includes(archivo.type)) return { ok: false, error: 'Usa una imagen PNG, JPG o WebP' };
  if (archivo.size > LOGO_MAX_BYTES) return { ok: false, error: 'La imagen supera los ' + LOGO_MAX_BYTES / 1048576 + ' MB' };
  return { ok: true };
}

/** Mueve el logo a un punto del recuadro de vista previa (px dentro de un recuadro ancho x alto). Siempre queda dentro del cuadro. */
export function posicionDesdePunto(px, py, ancho, alto) {
  return { x: r3(acotar(px / Math.max(1, ancho), 0, 1)), y: r3(acotar(py / Math.max(1, alto), 0, 1)) };
}

export function desplazarLogo(logo, dx, dy) {
  return { ...logo, x: r3(acotar(logo.x + dx, 0, 1)), y: r3(acotar(logo.y + dy, 0, 1)) };
}

export function redimensionarLogo(logo, escala) {
  return { ...logo, escala: r3(acotar(num(escala, logo.escala), LOGO_ESCALA.min, LOGO_ESCALA.max)) };
}

/** Plan de "Aplicar a todos": que ids se envian y por que no se puede (nada seleccionado, ajustes neutros...). */
export function planAplicar({ seleccion, visibles = null, ajustes }) {
  const ids = [...seleccion].filter((id) => !visibles || visibles.has(id));
  if (ids.length === 0) return { ok: false, error: 'Selecciona al menos un clip con las casillas de las tarjetas.' };
  if (esNulo(ajustes)) return { ok: false, error: 'Cambia algún control (velocidad, tono, color, espejo o logo) antes de aplicar.' };
  return { ok: true, ids, resumen: resumenAjustes(ajustes) };
}

/** Quita de la seleccion lo que ya no existe (un clip borrado no puede quedar "seleccionado" para siempre). */
export function podarSeleccion(seleccion, existentes) {
  return new Set([...seleccion].filter((id) => existentes.has(id)));
}

/** Lo que se envia con un proyecto nuevo: solo si el toggle esta activo y hay algo que aplicar. */
export const ajustesParaNuevos = ({ aplicarNuevos, ajustes }) => (aplicarNuevos && !esNulo(ajustes) ? normalizarAjustes(ajustes) : null);
