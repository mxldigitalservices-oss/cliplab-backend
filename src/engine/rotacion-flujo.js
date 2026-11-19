// Conexion de la rotacion ciclica (rotacion-estado.js) con el flujo real de ClipLab: estilo de subtitulos y modo de render.
//
// Reglas:
//   - Valor manual explicito (dinamico | clasico | minimal, recorte | blur) -> se respeta tal cual y NO toca el estado de la rotacion.
//   - Valor vacio o "auto" -> rota como bolsa que se vacia: no repite hasta agotar la tanda y reinicia solo al completar el ciclo.
//   - El trabajo viaja con el marcador AUTO hasta el pipeline, que ya conoce cuantos clips saldran y pide UNA tanda por canal
//     (asi los 4-5 clips de un mismo video salen con estilos/modos distintos y el ciclo continua entre videos).
//   - Si el disco falla al guardar el estado, el trabajo NO se cae: se usa el valor de respaldo y se deja un aviso en el log.
//
// Este es el UNICO archivo que conoce la firma del rotador:
//   rotador.elegirTanda(canal, opciones, cantidad) -> { valores, reinicios }   (`valores`: array con `cantidad` elementos).
import { rotador } from './rotacion-estado.js';
import { AUTO } from './rotacion.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { nombresEstilos, normalizarEstilo } from '../estilos-subtitulos.js';

export { AUTO };
export const CANAL_ESTILO = 'estilo';
export const CANAL_MODO = 'modo';
export const MODOS = Object.freeze(['recorte', 'blur']);
export const ESTILO_RESPALDO = 'dinamico';

/** true si el valor significa "que decida la rotacion": ausente, vacio o "auto". */
export function esAuto(valor) {
  if (valor === undefined || valor === null) return true;
  const texto = String(valor).trim().toLowerCase();
  return texto === '' || texto === String(AUTO).toLowerCase();
}

/** Valida el estilo que llega del cliente: vacio/auto -> AUTO; valido -> su nombre; desconocido -> Error (el endpoint responde 400). */
export function pedirEstilo(valor) {
  return esAuto(valor) ? AUTO : normalizarEstilo(valor);
}

/**
 * Valida el modo que llega del cliente: vacio/auto -> AUTO; recorte | blur -> tal cual; otro -> Error.
 * Si el operador fijo DEFAULT_RENDER_MODE en el entorno, un modo VACIO usa ese valor fijo (un "auto" explicito siempre rota).
 */
export function pedirModo(valor) {
  const vacio = valor === undefined || valor === null || String(valor).trim() === '';
  if (vacio && config.defaultRenderModeFijo) return config.defaultRenderMode;
  if (esAuto(valor)) return AUTO;
  const modo = String(valor).trim().toLowerCase();
  if (!MODOS.includes(modo)) throw new Error('El modo debe ser recorte, blur o auto');
  return modo;
}

async function tandaDeCanal(canal, valor, opciones, cantidad, respaldo) {
  const n = Math.max(1, Math.floor(Number(cantidad)) || 1);
  if (valor !== AUTO) return Array(n).fill(valor);   // manual explicito: intacto, sin tocar el estado
  try {
    const resultado = await rotador.elegirTanda(canal, opciones, n);
    const lista = Array.isArray(resultado) ? resultado : resultado && resultado.valores;
    if (!Array.isArray(lista) || lista.length !== n || !lista.every((v) => opciones.includes(v))) {
      throw new Error('Respuesta invalida del rotador');
    }
    return lista;
  } catch (error) {
    logger.warn('La rotacion no pudo elegir; se usa el valor de respaldo', { canal, respaldo, mensaje: error.message });
    return Array(n).fill(respaldo);
  }
}

/**
 * Perfil de cada clip de un trabajo: [{ estilo, modo }] con `total` entradas.
 *   - trabajo.estiloSubtitulos: AUTO rota; un nombre se respeta; falsy conserva el subtitulado clasico del pipeline (estilo = null).
 *   - trabajo.modo: AUTO rota; recorte | blur se respeta; cualquier otra cosa se deja pasar tal cual (el render lo valida).
 */
export async function perfilesDeTrabajo(trabajo, total) {
  const n = Math.max(1, Math.floor(Number(total)) || 1);
  const estilos = trabajo.estiloSubtitulos
    ? await tandaDeCanal(CANAL_ESTILO, trabajo.estiloSubtitulos, nombresEstilos(), n, ESTILO_RESPALDO)
    : Array(n).fill(null);
  const modos = await tandaDeCanal(CANAL_MODO, trabajo.modo, [...MODOS], n, config.defaultRenderMode);
  return Array.from({ length: n }, (_, i) => ({ estilo: estilos[i], modo: modos[i] }));
}
