import { config } from '../config/index.js';
import { generarMarketing } from './marketing.js';
import { puntuarIntensidad } from './cerebro-marketing.js';
import { parsear as parsearInstruccion, puntuarTexto, bonus as bonusInstruccion } from '../instruccion.js';
import {
  INDICE, STOP, FRASES_GANCHO, DEPENDIENTES, DEPENDIENTES_BI, RELLENOS, CONTRASTE, pesoDe, normalizar,
} from './diccionario.js';

// ---------------------------------------------------------------------------
// AGENTE CURADOR Y SEGMENTADOR INTERNO (100 % local, determinista, sin red ni IA de pago).
//
//   Rol:    curador y segmentador interno de clips, basado en nuestro diccionario de palabras clave
//           (diccionario.js) y en heuristicas locales de lenguaje.
//   Mision: analizar la transcripcion completa de un video largo y cruzarla con el diccionario para
//           extraer varios clips coherentes (empiezan y terminan en limites de frase, sin cortes bruscos),
//           dejando prehecha la ficha de cada clip: gancho, flujo, valor, interes, puntaje, titulo de
//           alto impacto, descripcion lista para publicar y revisionTecnica (9:16, 1080x1920, encuadre).
//
// Todo son funciones puras: misma transcripcion + mismos parametros => misma salida.
//   CURADOR=off                  desactiva el agente (el pipeline vuelve al planificador de segmentos.js)
//   CURADOR_MAX_SECONDS          videos mas largos que esto no se curan (por defecto 3600)
//   CURADOR_ASR_CHUNK_SECONDS    tamano de cada trozo al transcribir el video completo (por defecto 600)
// ---------------------------------------------------------------------------

export const CURADOR = Object.freeze({
  rol: 'Curador y segmentador interno de clips basado en el diccionario de palabras clave y heuristicas locales',
  mision: 'Cruzar la transcripcion con el diccionario para extraer clips coherentes de un video largo y dejar la ficha completa de cada uno',
});

const num = (v, def) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : def);
export const AJUSTES = Object.freeze({
  activo: process.env.CURADOR !== 'off',
  maxVideoSeg: Math.max(60, num(process.env.CURADOR_MAX_SECONDS, 3600)),
  trozoAsrSeg: Math.max(120, num(process.env.CURADOR_ASR_CHUNK_SECONDS, 600)),
});

const FIN_FRASE = /[.!?…]["')\]»”]*$/u;
const PAUSA_FRASE = 0.6; // una pausa asi parte la frase aunque no haya puntuacion
const MAX_PALABRAS_FRASE = 40; // sin puntuacion ni pausas, se fuerza el corte aqui
const LEAD = 0.12; // colchon antes de la primera palabra
const COLA = 0.3; // colchon despues de la ultima palabra
const COBERTURA_MIN = 0.25; // menos habla que esto (musica, silencio) descarta la ventana
const PESOS = { gancho: 0.3, flujo: 0.25, valor: 0.25, interes: 0.2 };

const acotar = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const mayuscula = (s) => s.charAt(0).toLocaleUpperCase('es') + s.slice(1);
const limpiarPalabra = (s) => String(s).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

function recortar(texto, max) {
  const s = String(texto || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const corte = s.slice(0, max - 1);
  const i = corte.lastIndexOf(' ');
  return (i > max * 0.6 ? corte.slice(0, i) : corte).replace(/[\s,.;:]+$/, '') + '…';
}

// ---------------------------------------------------------------------------
// 1) Frases y contexto de analisis
// ---------------------------------------------------------------------------

function limpiarPalabras(palabras) {
  return (Array.isArray(palabras) ? palabras : [])
    .filter((p) => p && typeof p.texto === 'string' && Number.isFinite(Number(p.inicio)) && Number.isFinite(Number(p.fin)))
    .map((p) => ({ texto: p.texto, inicio: Number(p.inicio), fin: Math.max(Number(p.fin), Number(p.inicio) + 0.05) }))
    .sort((a, b) => a.inicio - b.inicio);
}

function armarFrase(p, i0, i1, previa) {
  const trozo = p.slice(i0, i1 + 1);
  const tokens = trozo.map((w) => normalizar(w.texto)).filter(Boolean);
  const texto = trozo.map((w) => w.texto).join(' ').replace(/\s+/g, ' ').trim();
  let valor = 0;
  let interes = 0;
  let gancho = 0;
  let numeros = 0;
  let contraste = 0;
  for (const t of tokens) {
    valor += pesoDe(INDICE.valor, t);
    interes += pesoDe(INDICE.interes, t);
    gancho += pesoDe(INDICE.gancho, t);
    if (/\d/.test(t)) numeros++;
    if (CONTRASTE.has(t)) contraste++;
  }
  const unida = ' ' + tokens.join(' ') + ' ';
  return {
    i0,
    i1,
    inicio: trozo[0].inicio,
    fin: trozo[trozo.length - 1].fin,
    texto,
    tokens,
    n: trozo.length,
    contenido: new Set(tokens.filter((t) => t.length >= 4 && !STOP.has(t))),
    pregunta: /[?¿]/.test(texto),
    exclamacion: /[!¡]/.test(texto),
    numeros,
    valor,
    interes,
    gancho,
    contraste,
    frasesGancho: FRASES_GANCHO.filter((f) => unida.includes(' ' + f + ' ')).length,
    dependiente: DEPENDIENTES.has(tokens[0]) || DEPENDIENTES_BI.has(tokens.slice(0, 2).join(' ')),
    relleno: RELLENOS.has(tokens[0]),
    pausaPrevia: previa ? Math.max(0, trozo[0].inicio - previa.fin) : 0,
  };
}

/** Parte las palabras en frases: puntuacion fuerte, pausa >= 0.6 s o tope de 40 palabras. */
export function dividirFrases(palabras) {
  const lista = limpiarPalabras(palabras);
  const frases = [];
  let ini = 0;
  for (let i = 0; i < lista.length; i++) {
    const sig = lista[i + 1];
    const corta = !sig || FIN_FRASE.test(lista[i].texto) || sig.inicio - lista[i].fin >= PAUSA_FRASE || i - ini + 1 >= MAX_PALABRAS_FRASE;
    if (!corta) continue;
    frases.push(armarFrase(lista, ini, i, frases.length ? frases[frases.length - 1] : null));
    ini = i + 1;
  }
  return { lista, frases };
}

const solapeConjuntos = (a, b) => {
  if (a.size === 0 || b.size === 0) return 0;
  let comunes = 0;
  const [chico, grande] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of chico) if (grande.has(t)) comunes++;
  return comunes / chico.size;
};

function unionDe(frases, desde, hasta) {
  const u = new Set();
  for (let i = Math.max(0, desde); i <= Math.min(frases.length - 1, hasta); i++) for (const t of frases[i].contenido) u.add(t);
  return u;
}

/**
 * Contexto de analisis: cohesion lexica entre frases vecinas y fronteras de tema (estilo TextTiling:
 * poca palabra compartida entre las 3 frases de la izquierda y las 3 de la derecha, o una pausa larga).
 */
function prepararContexto(palabras) {
  const { lista, frases } = dividirFrases(palabras);
  const cohesion = frases.map((f, i) => {
    const a = i + 1 < frases.length ? solapeConjuntos(f.contenido, frases[i + 1].contenido) : 0;
    const b = i + 2 < frases.length ? solapeConjuntos(f.contenido, frases[i + 2].contenido) * 0.9 : 0;
    return Math.max(a, b);
  });
  const tema = frases.map((f, i) => i === 0 || f.pausaPrevia >= 1.8 || solapeConjuntos(unionDe(frases, i - 3, i - 1), unionDe(frases, i, i + 2)) <= 0.08);
  return { palabras: lista, frases, cohesion, tema };
}

// ---------------------------------------------------------------------------
// 2) Puntuacion de una ventana de frases [a..b]
// ---------------------------------------------------------------------------

function puntosGancho(f) {
  let p = 0;
  if (f.n >= 4 && f.n <= 16) p += 15;
  else if (f.n <= 24) p += 5;
  else if (f.n < 4) p -= 10;
  if (f.dependiente || f.relleno) p -= 25;
  if (f.pregunta) p += 20;
  if (f.numeros) p += 10;
  p += Math.min(28, f.gancho * 7);
  if (f.frasesGancho) p += 20;
  if (f.exclamacion) p += 5;
  return p;
}

function evaluar(ctx, a, b, { detalle = false, filtrar = true } = {}) {
  const F = ctx.frases;
  const inicio = F[a].inicio;
  const dur = Math.max(0.1, F[b].fin - inicio);
  let n = 0;
  let ntok = 0;
  let valor = 0;
  let interes = 0;
  let numeros = 0;
  let preguntas = 0;
  let exclamaciones = 0;
  let contraste = 0;
  let habla = 0;
  let pausaMax = 0;
  let pausaMuerta = 0;
  let coh = 0;
  const vocab = new Set();
  for (let i = a; i <= b; i++) {
    const f = F[i];
    n += f.n;
    ntok += f.tokens.length;
    valor += f.valor;
    interes += f.interes;
    numeros += f.numeros;
    contraste += f.contraste;
    if (f.pregunta) preguntas++;
    if (f.exclamacion) exclamaciones++;
    habla += f.fin - f.inicio;
    if (i > a) {
      pausaMax = Math.max(pausaMax, f.pausaPrevia);
      if (f.pausaPrevia > 1.2) pausaMuerta += f.pausaPrevia;
      coh += ctx.cohesion[i - 1];
    }
    for (const t of f.tokens) vocab.add(t);
  }
  const cobertura = habla / dur;
  if (filtrar && cobertura < COBERTURA_MIN) return null;

  // Gancho: la frase de apertura (y, con menos peso, la siguiente).
  const gancho = acotar(25 + puntosGancho(F[a]) + (b > a ? 0.4 * Math.max(0, puntosGancho(F[a + 1])) : 0), 0, 100);

  // Flujo: cohesion tematica + sin pausas muertas + arranque y cierre limpios.
  const cohMedia = b > a ? coh / (b - a) : 0.25;
  const siguiente = F[b + 1];
  const cierre = !siguiente ? 'fin' : ctx.tema[b + 1] ? 'tema' : 'frase';
  let flujo = Math.min(1, cohMedia / 0.25) * 45;
  flujo += pausaMax <= 1 ? 20 : pausaMax <= 2 ? 12 : pausaMax <= 3 ? 4 : 0;
  flujo -= Math.min(10, (pausaMuerta / dur) * 40);
  flujo += ctx.tema[a] ? 10 : F[a].dependiente ? -12 : 4;
  flujo += cierre !== 'frase' ? 10 : siguiente.dependiente ? -8 : siguiente.pausaPrevia >= 0.5 ? 6 : 3;
  flujo += dur >= 35 && dur <= 55 ? 10 : 5;
  flujo = acotar(flujo, 0, 100);

  // Valor: densidad de terminos utiles (consejos, metodos, datos) + cifras.
  const puntajeValor = acotar(12 + ((valor / Math.max(1, n)) * 10) * 45 + Math.min(16, numeros * 4), 0, 100);

  // Interes: emocion/curiosidad del diccionario, preguntas, ritmo del habla, contraste y variedad.
  const ritmo = n / dur;
  const variedad = ntok > 0 ? vocab.size / ntok : 0;
  const puntajeInteres = acotar(
    10 + ((interes / Math.max(1, n)) * 10) * 40 + Math.min(12, preguntas * 4) + Math.min(8, exclamaciones * 2) +
      (ritmo >= 2.2 && ritmo <= 3.5 ? 12 : ritmo >= 1.8 && ritmo <= 4.2 ? 6 : 0) + (contraste ? 4 : 0) + (variedad >= 0.5 ? 6 : 0),
    0, 100
  );

  const puntaje = r1(PESOS.gancho * gancho + PESOS.flujo * flujo + PESOS.valor * puntajeValor + PESOS.interes * puntajeInteres);
  const base = { puntaje, gancho: r1(gancho), flujo: r1(flujo), valor: r1(puntajeValor), interes: r1(puntajeInteres) };
  if (!detalle) return base;
  return {
    ...base,
    extra: { cierre, pausaMax: r2(pausaMax), cohesion: r2(cohMedia), inicioEnTema: Boolean(ctx.tema[a]), ritmo: r1(ritmo), preguntas, frases: b - a + 1 },
  };
}

// ---------------------------------------------------------------------------
// 3) Ficha del clip: gancho, flujo, valor, interes, puntaje, titulo, descripcion, revisionTecnica
// ---------------------------------------------------------------------------

const EMOJIS = {
  negocios: ['💰', '📈'], tecnologia: ['🤖', '💻'], debate: ['🔥', '🗣️'], entretenimiento: ['🎬', '😂'], general: ['✨', '👀'],
};

function frasePortada(f, siguiente) {
  let texto = f.texto;
  if (f.n < 4 && siguiente) texto += ' ' + siguiente.texto;
  texto = texto.replace(/^(mira|oye|bueno|pues|entonces|ok|okay|so|look|y|pero|o sea|eh+|mm+|um+)[,\s]+/i, '').replace(/[,;:]+$/, '').trim();
  return recortar(texto, 110);
}

function clavesDe(ctx, a, b, indice) {
  const cuenta = new Map();
  const { frases, palabras } = ctx;
  for (let i = frases[a].i0; i <= frases[b].i1; i++) {
    const w = limpiarPalabra(palabras[i].texto);
    const k = normalizar(w);
    if (!k || !pesoDe(indice, k)) continue;
    const e = cuenta.get(k) || { w, c: 0, peso: pesoDe(indice, k) };
    e.c += 1;
    cuenta.set(k, e);
  }
  return [...cuenta.values()].sort((x, y) => y.peso * y.c - x.peso * x.c || x.w.localeCompare(y.w)).slice(0, 5).map((e) => e.w.toLowerCase());
}

function mejorResumen(ctx, a, b) {
  let mejor = null;
  for (let i = a + 1; i <= b; i++) {
    const f = ctx.frases[i];
    if (f.n < 6 || f.n > 24) continue;
    const puntos = f.valor + f.interes + f.numeros + (f.pregunta ? 1 : 0);
    if (!mejor || puntos > mejor.puntos) mejor = { f, puntos };
  }
  return mejor ? recortar(mejor.f.texto.replace(/[.,;:]+$/, ''), 170) : '';
}

function descripcionPublicable({ titulo, resumen, mk, indice, total }) {
  const [e1, e2] = EMOJIS[mk.nicho] || EMOJIS.general;
  const parte = total > 1 ? ' (parte ' + indice + ' de ' + total + ')' : '';
  const cuerpo = [e1 + ' ' + titulo, resumen ? e2 + ' ' + resumen : '', '⏱️ Mira hasta el final' + parte + '.'].filter(Boolean).join('\n');
  return [cuerpo, mk.cta, mk.hashtags.join(' ')].filter(Boolean).join('\n\n');
}

function construirFicha(ctx, a, b, { tituloVideo, semilla, indice, total, ranking = null, marketing = null }) {
  const ev = evaluar(ctx, a, b, { detalle: true, filtrar: false });
  const F = ctx.frases;
  const transcripcion = ctx.palabras.slice(F[a].i0, F[b].i1 + 1).map((p) => p.texto).join(' ');
  const mk = marketing || generarMarketing({ tituloVideo, transcripcion, semilla, indice, total });
  const frase = frasePortada(F[a], F[a + 1] && a + 1 <= b ? F[a + 1] : null);
  const limpia = frase.replace(/[.,;:]+$/, '');
  const titulo = recortar(ev.gancho >= 50 && limpia.length >= 18 && limpia.length <= 80 ? mayuscula(limpia) : mk.titulo, 90);
  const resumen = mejorResumen(ctx, a, b);
  const senales = [];
  if (F[a].pregunta) senales.push('pregunta');
  if (F[a].numeros) senales.push('cifra');
  if (F[a].gancho) senales.push('palabra-gancho');
  if (F[a].frasesGancho) senales.push('frase-gancho');
  if (F[a].exclamacion) senales.push('exclamacion');
  return {
    origen: 'curador',
    ranking,
    rango: { inicio: r2(F[a].inicio), fin: r2(F[b].fin), duracion: r2(F[b].fin - F[a].inicio) },
    gancho: { puntaje: ev.gancho, frase, senales },
    flujo: { puntaje: ev.flujo, frases: ev.extra.frases, pausaMaxSeg: ev.extra.pausaMax, cohesion: ev.extra.cohesion, inicioEnTema: ev.extra.inicioEnTema, cierre: ev.extra.cierre },
    valor: { puntaje: ev.valor, claves: clavesDe(ctx, a, b, INDICE.valor) },
    interes: { puntaje: ev.interes, claves: clavesDe(ctx, a, b, INDICE.interes), ritmo: ev.extra.ritmo, preguntas: ev.extra.preguntas },
    puntaje: ev.puntaje,
    titulo,
    descripcion: descripcionPublicable({ titulo, resumen, mk, indice, total }),
    cta: mk.cta,
    hashtags: mk.hashtags,
    nicho: mk.nicho,
    revisionTecnica: null,
  };
}

/**
 * Ficha de un clip ya cortado (palabras relativas al clip). Con voz usa el mismo evaluador que el curador;
 * sin voz devuelve una ficha basica (origen 'planificador', puntajes null) para que la estructura sea siempre la misma.
 */
export function fichaDeVentana({ palabras, tituloVideo = '', semilla = '', indice = 1, total = 1, marketing = null } = {}) {
  const ctx = prepararContexto(palabras);
  if (ctx.frases.length > 0 && ctx.palabras.length >= 3) {
    return construirFicha(ctx, 0, ctx.frases.length - 1, { tituloVideo, semilla, indice, total, marketing });
  }
  const mk = marketing || generarMarketing({ tituloVideo, transcripcion: '', semilla, indice, total });
  const vacio = { puntaje: null };
  return {
    origen: 'planificador',
    ranking: null,
    rango: null,
    gancho: { ...vacio, frase: '', senales: [] },
    flujo: vacio,
    valor: { ...vacio, claves: [] },
    interes: { ...vacio, claves: [] },
    puntaje: null,
    titulo: mk.titulo,
    descripcion: [mk.descripcion, mk.cta, mk.hashtags.join(' ')].filter(Boolean).join('\n\n'),
    cta: mk.cta,
    hashtags: mk.hashtags,
    nicho: mk.nicho,
    revisionTecnica: null,
  };
}

// ---------------------------------------------------------------------------
// 4) Revision tecnica (formato 9:16, 1080x1920, tipo de encuadre / interlocutor)
// ---------------------------------------------------------------------------

/** Resume el analisis de rostros de un render ({desde,hasta,plano,sujeto}[]) en tipo de encuadre e interlocutor. */
export function resumirEncuadre(cortes, modo = 'recorte') {
  const base = { tipo: modo === 'blur' ? 'blur' : 'centrado', personas: 0, interlocutor: 'no-detectado', cambiosInterlocutor: 0, splitSeg: 0, planos: { medio: 0, cerrado: 0 } };
  if (!Array.isArray(cortes) || cortes.length === 0) return base;

  let personas = 0;
  let cambios = 0;
  let splitSeg = 0;
  let conSujeto = 0;
  let conSplit = 0;
  let sigue = false;
  for (const c of cortes) {
    if (c.plano === 'cerrado') base.planos.cerrado++;
    else base.planos.medio++;
    const s = c.sujeto;
    if (!s) continue;
    conSujeto++;
    personas = Math.max(personas, s.personas || s.n || 0);
    cambios += s.cambios || 0;
    if (s.split) {
      conSplit++;
      splitSeg += c.hasta - c.desde;
    }
    if (Array.isArray(s.kf) && s.kf.length >= 2 && s.kf.some((k) => k.cx !== s.kf[0].cx)) sigue = true;
  }
  base.personas = personas;
  base.cambiosInterlocutor = cambios;
  base.splitSeg = r1(splitSeg);
  if (conSujeto === 0) return base;
  if (conSplit === cortes.length) base.tipo = 'split';
  else if (conSplit > 0) base.tipo = 'mixto-split';
  else if (modo === 'blur') base.tipo = 'blur';
  else base.tipo = sigue ? 'seguimiento' : 'rostro-fijo';
  base.interlocutor = personas === 0 ? 'sin-rostro' : personas === 1 ? 'unico' : personas === 2 ? (conSplit > 0 ? 'dialogo-split' : 'dialogo-activo') : 'grupo';
  return base;
}

/** Ficha tecnica del clip. Sin `resultado` queda 'pendiente' (antes del render); con el render medido, 'verificado' o 'con-alertas'. */
export function armarRevisionTecnica({ modo = 'recorte', duracion = null, resultado = null, analisis = null, palabras = null, cpu = null } = {}) {
  const medido = resultado && resultado.ancho && resultado.alto ? { ancho: resultado.ancho, alto: resultado.alto } : null;
  const cumpleFormato = medido ? medido.ancho === 1080 && medido.alto === 1920 : null;
  const alertas = [];
  if (medido && !cumpleFormato) alertas.push('Salio en ' + medido.ancho + 'x' + medido.alto + ' y se esperaba 1080x1920');
  if (resultado && resultado.duracion > config.maxClipSeconds) alertas.push('Dura mas de ' + config.maxClipSeconds + ' s');
  if (resultado && palabras === 0) alertas.push('Sin voz detectada: el clip no lleva subtitulos');
  if (resultado && resultado.logoOmitido) alertas.push('Sin marca de agua: no se encontro el logo');
  return {
    formato: '9:16',
    resolucion: '1080x1920',
    estado: resultado ? (alertas.length ? 'con-alertas' : 'verificado') : 'pendiente',
    cumpleFormato,
    medido,
    duracionSeg: duracion,
    modo,
    encuadre: resumirEncuadre(analisis, modo),
    subtitulos: palabras === null ? null : palabras > 0,
    logo: resultado ? Boolean(resultado.conLogo) : null,
    cpu,
    alertas,
  };
}

// ---------------------------------------------------------------------------
// 5) Curaduria del video completo: candidatos -> seleccion sin solapes -> fichas
// ---------------------------------------------------------------------------

function solapa(a, b, margen) {
  return a.inicio < b.fin + margen && b.inicio < a.fin + margen;
}

function cantidadObjetivo(duracion, cantidad, minSeg, minClips, maxClips) {
  const cabe = Math.max(1, Math.floor(duracion / minSeg));
  const pedido = Number.isInteger(cantidad)
    ? Math.min(maxClips, Math.max(1, cantidad))
    : duracion >= 5 * minSeg * 2 ? maxClips : minClips;
  return Math.min(pedido, cabe);
}

/**
 * @param {object} p
 * @param {Array<{texto:string,inicio:number,fin:number}>} p.palabras  transcripcion COMPLETA (segundos absolutos del video)
 * @param {number} p.duracionVideo
 * @param {Array<{inicio:number,fin:number}>} [p.historial]  rangos ya usados (anti-duplicados)
 * @param {number} [p.cantidad]  1-5; por defecto 4 o 5 segun la duracion
 * @returns {{ clips: Array<{inicio:number,duracion:number,fin:number,puntaje:number,ficha:object}>, objetivo:number, frases:number, candidatos:number }}
 */
export function curarVideo({
  palabras,
  duracionVideo,
  tituloVideo = '',
  historial = [],
  cantidad,
  semilla = '',
  minSeg = config.segmentMinSeconds,
  maxSeg = config.segmentMaxSeconds,
  minClips = config.segmentsMin,
  maxClips = config.segmentsMax,
  separacion = 3,
  instruccion = null,
  momentos = true,
} = {}) {
  const consulta = parsearInstruccion(instruccion);
  const ctx = prepararContexto(palabras);
  const F = ctx.frases;
  const ultimo = ctx.palabras.length ? ctx.palabras[ctx.palabras.length - 1].fin : 0;
  const duracion = Number(duracionVideo) > 0 ? Number(duracionVideo) : ultimo;
  const vacio = { clips: [], objetivo: 0, frases: F.length, candidatos: 0 };
  if (ctx.palabras.length < 20 || duracion < minSeg) return vacio;

  const objetivo = cantidadObjetivo(duracion, cantidad, minSeg, minClips, maxClips);
  const usados = (Array.isArray(historial) ? historial : [])
    .map((r) => ({ inicio: Number(r.inicio), fin: Number(r.fin) }))
    .filter((r) => Number.isFinite(r.inicio) && Number.isFinite(r.fin) && r.fin > r.inicio);

  // Candidatos: por cada frase de arranque, la mejor frase de cierre que deje el clip entre minSeg y maxSeg.
  const candidatos = [];
  for (let a = 0; a < F.length; a++) {
    if (F[a].inicio >= duracion) break;
    const inicio = Math.max(0, F[a].inicio - Math.min(LEAD, Math.max(0.03, F[a].pausaPrevia - 0.05)));
    let mejor = null;
    for (let b = a; b < F.length; b++) {
      const hueco = F[b + 1] ? F[b + 1].inicio - F[b].fin : COLA;
      const fin = Math.min(duracion, F[b].fin + Math.min(COLA, Math.max(0.05, hueco - 0.05)));
      const dur = fin - inicio;
      if (dur > maxSeg) break;
      if (dur < minSeg) continue;
      const ev = evaluar(ctx, a, b);
      if (ev && (!mejor || ev.puntaje > mejor.ev.puntaje)) mejor = { a, b, inicio, fin, ev };
    }
    if (mejor) candidatos.push(mejor);
  }

  // "Que buscar": la instruccion solo sube la prioridad de los candidatos que coinciden (el puntaje de la ficha no cambia).
  if (consulta) {
    for (const c of candidatos) {
      const r = puntuarTexto(ctx.palabras.slice(F[c.a].i0, F[c.b].i1 + 1).map((p) => p.texto).join(' '), consulta);
      c.bonus = bonusInstruccion(r);
      c.coincidencias = r.hits;
    }
  }
  // Picos de reality (tension) y chismes/confidencias: suben la prioridad del candidato (hasta +15) sin tocar el puntaje de la
  // ficha. Solo actua si el texto trae senales claras; la cantidad de clips sigue siendo la pedida.
  if (momentos) {
    for (const c of candidatos) {
      const m = puntuarIntensidad(ctx.palabras.slice(F[c.a].i0, F[c.b].i1 + 1).map((p) => p.texto).join(' '));
      if (m.tipo) { c.momento = { tipo: m.tipo, intensidad: m.intensidad }; c.bonusMomento = Math.round(m.intensidad * 0.15); }
    }
  }
  const rangoDe = (c) => c.ev.puntaje + (c.bonus || 0) + (c.bonusMomento || 0);

  // Seleccion voraz por puntaje (desempate por posicion): sin solapes entre si ni con el historial.
  const orden = [...candidatos].sort((x, y) => rangoDe(y) - rangoDe(x) || y.ev.puntaje - x.ev.puntaje || x.inicio - y.inicio);
  const elegidos = [];
  for (const c of orden) {
    if (elegidos.length >= objetivo) break;
    if (usados.some((u) => solapa(c, u, 1)) || elegidos.some((e) => solapa(c, e, separacion))) continue;
    elegidos.push(c);
  }

  const ranking = new Map(elegidos.map((c, i) => [c, i + 1]));
  const cronologicos = [...elegidos].sort((x, y) => x.inicio - y.inicio);
  const clips = cronologicos.map((c, i) => {
    const ficha = construirFicha(ctx, c.a, c.b, {
      tituloVideo,
      semilla: semilla + '|' + Math.round(c.inicio),
      indice: i + 1,
      total: cronologicos.length,
      ranking: ranking.get(c),
    });
    if (c.momento) ficha.momento = c.momento;
    if (consulta) ficha.instruccion = { texto: consulta.texto, coincide: (c.bonus || 0) > 0, coincidencias: c.coincidencias || [] };
    return { inicio: r2(c.inicio), duracion: r2(c.fin - c.inicio), fin: r2(c.fin), puntaje: c.ev.puntaje, ficha };
  });
  return { clips, objetivo, frases: F.length, candidatos: candidatos.length };
}
