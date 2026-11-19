// ---------------------------------------------------------------------------
// Rotacion ciclica (funciones puras: sin disco, sin reloj, sin estado global).
//
// Reparte las opciones disponibles de un "canal" (por ejemplo los estilos de subtitulos o los modos de render) como una
// bolsa que se vacia: cada opcion sale UNA vez por ciclo, en orden variable, y cuando se usaron todas el ciclo se reinicia
// solo. Al empezar un ciclo nuevo nunca se elige primero la ultima usada (no hay repeticion seguida en el cruce).
//
// Estado de un canal: { usadas: string[], ultima: string|null, ciclo: number, total: number }
//   usadas  opciones ya entregadas en el ciclo actual
//   ultima  la ultima opcion entregada (sobrevive a los reinicios de ciclo)
//   ciclo   numero de ciclos COMPLETADOS
//   total   cuantas opciones se entregaron en toda la vida del canal
// Un valor "manual" valido se respeta tal cual y NO consume el ciclo; "auto" (o vacio) usa la rotacion.
// ---------------------------------------------------------------------------

export const AUTO = 'auto';
export const NOMBRE_CANAL = /^[a-z][a-z0-9_-]{0,31}$/i;   // empieza con letra: nada de "__proto__" ni rutas

/** Estado de un canal recien creado. */
export const estadoInicial = () => ({ usadas: [], ultima: null, ciclo: 0, total: 0 });

/** Lista de opciones limpia: textos no vacios, sin duplicados, en el orden dado. Lanza si no queda ninguna. */
export function normalizarOpciones(opciones) {
  const lista = [...new Set((Array.isArray(opciones) ? opciones : []).map((o) => String(o ?? '').trim()).filter(Boolean))];
  if (lista.length === 0) throw new Error('La rotacion necesita al menos una opcion disponible');
  return lista;
}

/**
 * Sanea un estado recibido de disco (o de cualquier parte) contra las opciones actuales: descarta lo desconocido y los
 * duplicados, corrige contadores invalidos y, si el ciclo ya estaba completo, lo reinicia. Nunca muta la entrada.
 */
export function sanearEstado(estado, opciones) {
  const lista = normalizarOpciones(opciones);
  const crudo = estado && typeof estado === 'object' && !Array.isArray(estado) ? estado : {};
  const usadas = [...new Set((Array.isArray(crudo.usadas) ? crudo.usadas : []).filter((u) => lista.includes(u)))];
  const entero = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  let limpio = {
    usadas,
    ultima: lista.includes(crudo.ultima) ? crudo.ultima : null,
    ciclo: entero(crudo.ciclo),
    total: entero(crudo.total),
  };
  if (limpio.usadas.length >= lista.length) limpio = { ...limpio, usadas: [], ciclo: limpio.ciclo + 1 };
  return limpio;
}

/** Foto del ciclo en curso para mostrar en el panel o registrar en logs. */
export function resumenCiclo(estado, opciones) {
  const lista = normalizarOpciones(opciones);
  const e = sanearEstado(estado, lista);
  return {
    opciones: lista,
    usadas: e.usadas,
    restantes: lista.filter((o) => !e.usadas.includes(o)),
    ultima: e.ultima,
    ciclo: e.ciclo,
    total: e.total,
  };
}

/**
 * Elige la siguiente opcion del ciclo.
 * @param {object} estado    estado del canal (se sanea; no se muta)
 * @param {string[]} opciones opciones disponibles ahora
 * @param {object} [o]
 * @param {string} [o.manual]  opcion fijada a mano: se devuelve tal cual sin tocar el ciclo ("auto" o vacio = rotar)
 * @param {() => number} [o.azar]  funcion tipo Math.random (inyectable para pruebas); por defecto Math.random
 * @returns {{ valor: string, origen: 'manual'|'rotacion', estado: object, reinicio: boolean }}
 *   reinicio = true cuando esta eleccion abrio un ciclo nuevo (la bolsa estaba agotada)
 */
export function siguiente(estado, opciones, { manual, azar = Math.random } = {}) {
  const lista = normalizarOpciones(opciones);
  const actual = sanearEstado(estado, lista);

  const pedido = String(manual ?? '').trim();
  if (pedido && pedido.toLowerCase() !== AUTO) {
    if (!lista.includes(pedido)) throw new Error(`Opcion invalida: "${pedido.slice(0, 40)}". Usa: ${lista.join(', ')} o ${AUTO}.`);
    return { valor: pedido, origen: 'manual', estado: actual, reinicio: false };
  }

  const abreCiclo = actual.usadas.length === 0;
  const reinicio = abreCiclo && actual.total > 0; // el primer uso de la historia no cuenta como "reinicio"
  let candidatas = lista.filter((o) => !actual.usadas.includes(o));
  // Ciclo nuevo: la ultima usada queda fuera de la primera eleccion (solo si hay otra opcion).
  if (abreCiclo && lista.length > 1 && actual.ultima) candidatas = candidatas.filter((o) => o !== actual.ultima);

  const indice = Math.min(candidatas.length - 1, Math.max(0, Math.floor(Number(azar()) * candidatas.length) || 0));
  const valor = candidatas[indice];
  const usadas = [...actual.usadas, valor];
  return {
    valor,
    origen: 'rotacion',
    reinicio,
    // El ciclo se da por completado cuando se usa la ultima opcion: el siguiente `siguiente` ya parte de una bolsa llena.
    estado: { usadas, ultima: valor, ciclo: actual.ciclo, total: actual.total + 1 },
  };
}

/** Entrega n opciones seguidas (por ejemplo una por clip de la tanda). Devuelve { valores, estado, reinicios }. */
export function tanda(estado, opciones, n, { manual, azar } = {}) {
  const cantidad = Number(n);
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 100) throw new Error('La tanda debe ser un entero entre 1 y 100');
  const valores = [];
  let reinicios = 0;
  let actual = estado;
  for (let i = 0; i < cantidad; i++) {
    const r = siguiente(actual, opciones, { manual, azar });
    valores.push(r.valor);
    if (r.reinicio) reinicios++;
    actual = r.estado;
  }
  return { valores, estado: sanearEstado(actual, opciones), reinicios };
}
