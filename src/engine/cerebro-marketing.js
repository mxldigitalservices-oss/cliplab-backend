// Cerebro de marketing para bloques de 45-60 s. 100 % local y sin costo:
//  - Motor heuristico determinista (siempre disponible).
//  - Ollama local opcional (OLLAMA_MODEL / OLLAMA_URL); si no responde, se cae solo al heuristico, sin lanzar error.
import { generarCandidatosTitulo, puntuarTitulo, cortarLimpio, limpiarTextoBase } from './titulos.js';

export const ANGULOS = ['error_comun', 'cifra_dato', 'contraste', 'pregunta_abierta', 'beneficio_directo', 'autoridad', 'tension_reality', 'chisme_confidencia'];
export const VEREDICTOS = ['publicar', 'ajustar_inicio', 'descartar'];

const MULETILLAS_INICIO = new Set(['eh', 'ehh', 'ehhh', 'este', 'bueno', 'osea', 'mmm', 'mm', 'mmmm', 'um', 'umm', 'aja', 'pues', 'entonces', 'mira', 'oye', 'ok', 'okay', 'so', 'y']);
const MULETILLAS_DENSIDAD = new Set(['eh', 'ehh', 'este', 'osea', 'mmm', 'mm', 'um', 'umm', 'aja']);
const VACIAS = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'y', 'e', 'o', 'u', 'en', 'por', 'para', 'con', 'sin', 'que', 'es', 'son', 'fue', 'era', 'se', 'su', 'sus', 'mi', 'mis', 'tu', 'tus', 'lo', 'le', 'les', 'me', 'te', 'nos', 'como', 'pero', 'mas', 'muy', 'ya', 'si', 'no', 'hay', 'esto', 'esta', 'este', 'eso', 'esa', 'ese', 'todo', 'todos', 'pues', 'bueno', 'cuando', 'porque', 'tiene', 'tienen', 'hacer', 'cada', 'solo', 'sobre', 'entre', 'tambien', 'ser', 'esta', 'estan', 'hoy', 'aqui', 'algo', 'cosa', 'cosas', 'puede', 'pueden', 'tengo', 'quiero', 'vamos', 'esos', 'estos', 'otra', 'otro', 'nadie', 'alguien', 'ella', 'ellos', 'ellas', 'empezaron', 'empezo', 'dijo', 'dije', 'dijeron', 'conto', 'decir', 'estaba', 'estaban', 'despues', 'quien', 'quiere', 'dicen', 'digas', 'horas', 'semana', 'veces']);

const SENALES = {
  error_comun: /\b(error(es)?|equivoc\w*|mitos?|nunca|deja(r)? de|no hagas|evita\w*|cuidado|fallos?|fracas\w*|peor)\b/g,
  cifra_dato: /(\d+|\b(mil|millon(es)?|por ciento|porcentaje|docena|centenas?)\b)/g,
  contraste: /\b(pero|sin embargo|en cambio|aunque|en vez de|mientras que|al contrario|no es\b[^.?!]{0,40}\bsino)\b/g,
  pregunta_abierta: /(\?|\b(por que|sabias que|sabes|te has preguntado|que pasa si|que pasaria)\b)/g,
  beneficio_directo: /\b(como|ganar|gana|ahorra\w*|logra\w*|consigue\w*|aument\w+|mejora\w*|pasos?|trucos?|tips?|forma de|manera de|resultados?)\b/g,
  autoridad: /\b(anos|experiencia|estudios?|investigacion|segun|comprobado|aprendi|perdi|gane|he trabajado|mi empresa|expert\w+|profesional)\b/g,
  // Reality: choque, discusion, tension, nominaciones, faltas de respeto.
  tension_reality: /\b(pele[ao]\w*|pelea(r|n|ron)?|pleito|bronca|discusion(es)?|discut\w+|grit[ao]\w*|gritando|insult\w+|se paso|me falt\w+|falta de respeto|faltar(me|te|le)? el respeto|respeta(me)?|callate|cierra la boca|mentiros[ao]|hipocrita|falso|falsa|traicion\w*|traicionaste|confront\w+|enfrent\w+|se calento|exploto|explotaron|furios[ao]|nominad[ao]s?|nominacion(es)?|eliminad[ao]s?|expulsad[ao]|expulsion|que te pasa|a mi no me|ahora si|se solto|se fue encima|tension)\b/g,
  // Chisme / confidencia (tambien a media voz): rumores, secretos, comentarios a espaldas.
  chisme_confidencia: /\b(a (mis |sus |tus |tu |mi )?espaldas|me conto|nos conto|te conto|me dijo en secreto|no le digas|no se lo digas|no se lo cuentes|no digas nada|ni se te ocurra decir|dijo de ti|dijo de mi|dicen de ti|hablan de ti|hablando mal|hablo mal|habla mal|hablaron mal|secretos?|rumor(es)?|se armo|chismes?|chismoso|chismosa|cuentan que|dicen que|se dice que|entre nosotros|entre tu y yo|confidencias?|confidenciar|te lo cuento|en confianza|susurr\w+|en voz baja|a media voz|bajito|al oido|cotilleo|trapitos|le dijo a todos|me enteré|me entere)\b/g,
};

const CTAS = {
  error_comun: ['Guarda este clip para no cometer este error.', 'Compártelo con quien todavía comete este error.'],
  cifra_dato: ['Guarda este dato y compártelo con quien lo necesite.', 'Comenta qué cifra te sorprendió más.'],
  contraste: ['Cuéntame en los comentarios de qué lado estás.', '¿Estás de acuerdo? Escríbelo abajo.'],
  pregunta_abierta: ['Responde en los comentarios: ¿qué opinas?', 'Déjame tu respuesta abajo y comparte el clip.'],
  beneficio_directo: ['Guárdalo para aplicarlo hoy y sígueme para más.', 'Si te sirvió, deja tu like y compártelo.'],
  autoridad: ['Sígueme para más lecciones como esta.', 'Activa las notificaciones para no perderte la siguiente parte.'],
  tension_reality: ['¿Quién tenía la razón? Cuéntame en los comentarios.', 'Comenta de qué lado estás y comparte el clip.'],
  chisme_confidencia: ['No le digas a nadie… pero compártelo y cuéntame qué opinas.', 'Cuéntame en los comentarios: ¿lo sabías?'],
};

const ETIQUETAS_ANGULO = {
  error_comun: ['errores', 'tips'], cifra_dato: ['datos', 'cifras'], contraste: ['debate', 'opinion'],
  pregunta_abierta: ['reflexion', 'pregunta'], beneficio_directo: ['consejos', 'aprende'], autoridad: ['experiencia', 'lecciones'],
  tension_reality: ['reality', 'drama'], chisme_confidencia: ['chisme', 'confidencias'],
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const plano = (t) => String(t ?? '').toLowerCase().replace(/ñ/g, 'n').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const acotar = (n, min, max) => Math.min(max, Math.max(min, n));
const r1 = (n) => Math.round(n * 10) / 10;
const mayus = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

function hash(texto) {
  let h = 2166136261;
  for (const c of String(texto)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

function tokensPlanos(texto) {
  return plano(texto).replace(/[^a-z0-9\s%]/g, ' ').split(/\s+/).filter(Boolean);
}

/** Cuenta las muletillas con las que arranca el texto ("eh bueno o sea este ..." -> 5) y devuelve el resto. */
export function muletillasIniciales(texto) {
  const original = limpiarTextoBase(texto).split(/\s+/).filter(Boolean);
  let i = 0;
  let cuenta = 0;
  while (i < original.length) {
    const t = plano(original[i]).replace(/[^a-z0-9]/g, '');
    const siguiente = plano(original[i + 1] || '').replace(/[^a-z0-9]/g, '');
    if (t === 'o' && siguiente === 'sea') { i += 2; cuenta += 2; continue; }
    if (t && MULETILLAS_INICIO.has(t)) { i += 1; cuenta += 1; continue; }
    break;
  }
  return { cuenta, resto: original.slice(i).join(' ').replace(/^[,;:.\s-]+/, '') };
}

function dividirFrases(texto) {
  const limpio = String(texto ?? '').replace(/\s+/g, ' ').trim();
  if (!limpio) return [];
  let frases = limpio.split(/(?<=[.!?…])\s+/).map((f) => f.trim()).filter(Boolean);
  // Whisper a veces entrega texto sin puntuacion: se parte en trozos de ~14 palabras.
  if (frases.length === 1) {
    const palabras = frases[0].split(/\s+/);
    if (palabras.length > 26) {
      frases = [];
      for (let i = 0; i < palabras.length; i += 14) frases.push(palabras.slice(i, i + 14).join(' '));
    }
  }
  return frases;
}

const COLA_DEBIL = new Set(['con', 'de', 'del', 'a', 'al', 'en', 'y', 'o', 'u', 'e', 'que', 'los', 'las', 'el', 'la', 'un', 'una', 'su', 'sus', 'por', 'para', 'es', 'son', 'se', 'lo', 'mas', 'pero', 'como', 'si', 'ni', 'sin', 'muy', 'tus', 'tu', 'mi', 'nunca', 'no', 'casi', 'cada', 'hace', 'esta', 'estan', 'tiene', 'tienen', 'hay', 'va', 'van', 'puede', 'pueden', 'debe', 'hacen', 'ser', 'fue', 'era', 'han', 'ha', 'he', 'sobre', 'entre', 'hasta', 'desde', 'cuando', 'porque', 'aunque', 'mientras', 'donde', 'sino', 'tan', 'tambien', 'ya', 'le', 'les', 'me', 'te', 'nos', 'este', 'ese', 'esa', 'esto', 'eso', 'dije', 'dijo', 'dijeron', 'dice', 'dicen', 'digo', 'creo', 'pienso', 'sabe', 'vio']);
const ARTICULOS_NUM = new Set(['un', 'una', 'el', 'la', 'de', 'por', 'al', 'a', 'hasta', 'en', 'unos', 'unas', 'los', 'las', 'del', 'casi', 'solo', 'mas', 'menos']);
const ANTES_INFINITIVO = new Set(['no', 'nunca', 'para', 'a', 'al', 'por', 'sin', 'ni', 'puedes', 'puede', 'debes', 'quiero', 'vas', 'va', 'voy', 'vamos']);
// Conectores donde se puede partir una frase larga sin romper la idea (la parte izquierda debe quedar completa).
const CONECTORES = new Set(['que', 'porque', 'cuando', 'pero', 'aunque', 'mientras', 'donde', 'sino', 'y', 'o', 'si', 'pues']);

const palabraPlana = (w) => plano(w).replace(/[^a-z0-9]/g, '');

/** Una frase "cuelga" si termina en una palabra que pide continuacion ("...hablar con", "...suben un 30", "...es no hablar"). */
export function terminaColgado(texto) {
  const w = limpiarTextoBase(texto).replace(/[.!?…]+$/, '').split(/\s+/).filter(Boolean);
  if (w.length === 0) return true;
  const ult = palabraPlana(w[w.length - 1]);
  const pen = w.length > 1 ? palabraPlana(w[w.length - 2]) : '';
  if (COLA_DEBIL.has(ult)) return true;
  if (/^\d+$/.test(ult) && ARTICULOS_NUM.has(pen)) return true; // "un 30"
  if (/(ar|er|ir)$/.test(ult) && ANTES_INFINITIVO.has(pen) && w.length > 3) return true; // "es no hablar", "para ganar"
  return false;
}

function sinColaDebil(texto) {
  const palabras = limpiarTextoBase(texto).split(/\s+/);
  while (palabras.length > 3 && terminaColgado(palabras.join(' '))) palabras.pop();
  return limpiarTextoBase(palabras.join(' ')).replace(/[,;:]+$/, '');
}

/**
 * Corta a `max` caracteres dejando una idea completa: se queda con el texto entero si cabe y no cuelga; si no, usa la
 * clausula mas larga que quepa (coma, punto y coma, dos puntos), luego un conector (que, porque, pero...) y, como ultimo
 * recurso, el prefijo mas largo sin colas debiles ni numeros/infinitivos colgados.
 */
export function cortarSemantico(texto, max = 70, { minimo = 18 } = {}) {
  const t = limpiarTextoBase(texto).replace(/[.!?…]+$/, '');
  if (t.length <= max && !terminaColgado(t)) return t;

  const valido = (c) => c.length >= minimo && c.length <= max && c.split(/\s+/).length >= 3 && !terminaColgado(c);

  const clausulas = t.split(/\s*[,;:—]\s+/);
  let acumulado = '';
  let mejorClausula = '';
  for (const c of clausulas) {
    acumulado = acumulado ? acumulado + ', ' + c : c;
    if (valido(acumulado) && acumulado.length > mejorClausula.length) mejorClausula = acumulado;
  }
  if (mejorClausula) return limpiarTextoBase(mejorClausula);

  const palabras = t.split(/\s+/);
  let mejorConector = '';
  for (let i = 3; i < palabras.length; i++) {
    if (!CONECTORES.has(palabraPlana(palabras[i]))) continue;
    const izquierda = limpiarTextoBase(palabras.slice(0, i).join(' ')).replace(/[,;:]+$/, '');
    if (valido(izquierda) && izquierda.length > mejorConector.length) mejorConector = izquierda;
  }
  if (mejorConector) return mejorConector;

  return sinColaDebil(cortarLimpio(t, max));
}

const ACOTACION = /[\[(][^\])]{1,30}[\])]/g;

function limpiarFrase(f) {
  const { resto } = muletillasIniciales(String(f ?? '').replace(ACOTACION, ' '));
  return limpiarTextoBase(resto).replace(/[.,;:]+$/, '');
}

function contar(regex, texto) {
  const m = texto.match(regex);
  return m ? m.length : 0;
}

function palabrasClave(texto, max = 4) {
  const cuenta = new Map();
  for (const t of tokensPlanos(texto)) {
    if (t.length < 4 || t.length > 16 || VACIAS.has(t) || /^\d+$/.test(t) || /mente$/.test(t)) continue;
    cuenta.set(t, (cuenta.get(t) || 0) + 1);
  }
  return [...cuenta.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1))
    .slice(0, max).map(([t]) => t);
}

// ---------------------------------------------------------------------------
// Analisis heuristico (determinista)
// ---------------------------------------------------------------------------
function detectarAngulo(frases, instruccion, textoCrudo = '') {
  const primera = plano(frases[0] || '');
  const resto = plano(frases.slice(1).join(' '));
  const puntos = {};
  for (const a of ANGULOS) {
    const regex = SENALES[a];
    // La frase de apertura manda (x3); el resto del bloque suma con tope para que no tape el angulo del gancho.
    puntos[a] = contar(new RegExp(regex.source, 'g'), primera) * 3 + Math.min(3, contar(new RegExp(regex.source, 'g'), resto));
  }
  // Reality y chisme son angulos muy especificos: con una sola senal en la apertura ya mandan sobre los genericos.
  puntos.tension_reality *= 1.5;
  puntos.chisme_confidencia *= 1.5;
  // Acotaciones de transcripcion ("[susurrando]", "(en voz baja)"): habla a media voz = confidencia.
  if (/[\[(]\s*(susurr|en voz baja|bajito|murmur)/i.test(String(textoCrudo))) puntos.chisme_confidencia += 3;
  // "como" es muy frecuente: pesa menos para no tapar angulos mas especificos.
  puntos.beneficio_directo = Math.max(0, puntos.beneficio_directo - 2);
  const pistas = plano(instruccion);
  if (pistas) for (const a of ANGULOS) puntos[a] += contar(new RegExp(SENALES[a].source, 'g'), pistas);
  let mejor = 'beneficio_directo';
  let max = 0;
  for (const a of ANGULOS) if (puntos[a] > max) { max = puntos[a]; mejor = a; }
  return { angulo: mejor, puntos };
}

function puntosGancho(frase) {
  const p = plano(frase);
  const palabras = frase.split(/\s+/).filter(Boolean).length;
  let n = 30;
  if (palabras >= 4 && palabras <= 14) n += 20; else if (palabras <= 20) n += 8; else n -= 10;
  if (/\d/.test(frase)) n += 12;
  if (/\?/.test(frase)) n += 12;
  if (contar(new RegExp(SENALES.error_comun.source, 'g'), p)) n += 14;
  if (contar(new RegExp(SENALES.contraste.source, 'g'), p)) n += 8;
  if (/\b(nadie|nunca|secreto|verdad|increible|jamas|siempre|cuidado)\b/.test(p)) n += 8;
  if (contar(new RegExp(SENALES.tension_reality.source, 'g'), p)) n += 12;
  if (contar(new RegExp(SENALES.chisme_confidencia.source, 'g'), p)) n += 12;
  if (palabras < 4) n -= 25;
  return acotar(n, 0, 100);
}

function elegirGancho(frases) {
  const candidatas = frases.slice(0, 3).map((f, i) => ({ texto: limpiarFrase(f), i }))
    .filter((c) => c.texto.split(/\s+/).length >= 3);
  if (!candidatas.length) return { texto: '', puntos: 0 };
  let mejor = null;
  for (const c of candidatas) {
    const puntos = puntosGancho(c.texto) - c.i * 4; // la apertura real pesa mas
    if (!mejor || puntos > mejor.puntos) mejor = { texto: c.texto, puntos };
  }
  // Gancho de 0-3 s: una idea completa. Una frase de hasta 14 palabras / 85 caracteres entra entera; si es mas larga se
  // parte en una clausula o conector que deje la idea cerrada (nunca "...hablar con" ni "...suben un 30").
  const palabras = mejor.texto.split(/\s+/);
  let texto = mejor.texto;
  if (palabras.length > 14 || texto.length > 85 || terminaColgado(texto)) {
    texto = cortarSemantico(texto, 85, { minimo: 14 });
    if (texto.split(/\s+/).length > 14) texto = sinColaDebil(texto.split(/\s+/).slice(0, 14).join(' '));
  }
  return { texto: mayus(texto), puntos: acotar(mejor.puntos, 0, 100) };
}

function construirVariantes({ frases, gancho, angulo, transcripcion, instruccion, tituloVideo }) {
  const limpias = frases.map(limpiarFrase).filter((f) => f.length >= 12);
  const con = (regex) => limpias.find((f) => regex.test(plano(f)));
  const extras = [
    { tipo: 'cifra', valor: limpias.find((f) => /\d/.test(f)) },
    { tipo: 'contraste', valor: con(new RegExp(SENALES.contraste.source)) },
    { tipo: 'error', valor: con(new RegExp(SENALES.error_comun.source)) },
    { tipo: 'beneficio', valor: con(new RegExp(SENALES.beneficio_directo.source)) },
    { tipo: 'tension', valor: con(new RegExp(SENALES.tension_reality.source)) },
    { tipo: 'chisme', valor: con(new RegExp(SENALES.chisme_confidencia.source)) },
  ].filter((e) => e.valor).map((e) => ({ tipo: e.tipo, titulo: cortarSemantico(mayus(e.valor), 70) }));

  const bonoAngulo = { error_comun: 'error', cifra_dato: 'cifra', contraste: 'contraste', pregunta_abierta: 'pregunta', beneficio_directo: 'beneficio', autoridad: 'gancho', tension_reality: 'tension', chisme_confidencia: 'chisme' }[angulo];
  const vistos = new Set();
  const salida = [];
  const base = generarCandidatosTitulo({
    transcripcion: limpias.join('. '),
    gancho,
    tituloFuente: tituloVideo,
    queBuscar: instruccion,
    respaldoActual: tituloVideo || '',
  });

  const agregar = (tipo, titulo) => {
    const t = mayus(limpiarTextoBase(titulo).replace(/[.,;:]+$/, ''));
    if (!t) return;
    const clave = plano(t).replace(/[^a-z0-9 ]/g, '').trim();
    if ([...vistos].some((v) => v.startsWith(clave) || clave.startsWith(v))) return;
    vistos.add(clave);
    const ev = puntuarTitulo(t, { transcripcion, queBuscar: instruccion });
    let puntaje = ev.puntaje;
    if (tipo === bonoAngulo) puntaje += 8;
    if (/\d/.test(t)) puntaje += 3;
    if (/[?]/.test(t) && angulo === 'pregunta_abierta') puntaje += 3;
    if (tipo === 'respaldo') puntaje -= 10;
    salida.push({ tipo, titulo: t, puntaje: Math.round(acotar((puntaje - 10) * 0.8, 0, 100)) });
  };
  // Sin choque entre duplicados: el titulo del angulo detectado entra primero y conserva su etiqueta (y su bono).
  for (const e of extras) if (e.tipo === bonoAngulo) agregar(e.tipo, e.titulo);
  for (const c of base.candidatos) {
    // titulos.js corta a 70 caracteres sin mirar la sintaxis: se vuelve a cortar desde la frase completa.
    const clave = plano(c.titulo).replace(/^[^a-z0-9]+/, '');
    const fuente = limpias.find((f) => f.length > c.titulo.length && plano(f).startsWith(clave));
    agregar(c.tipo, cortarSemantico(fuente || c.titulo, 70));
  }
  for (const e of extras) if (e.tipo !== bonoAngulo) agregar(e.tipo, e.titulo);
  salida.sort((a, b) => b.puntaje - a.puntaje || a.titulo.length - b.titulo.length || (a.titulo < b.titulo ? -1 : 1));
  return salida;
}

function construirCopy({ frases, gancho }) {
  const partes = [gancho];
  const clave = plano(gancho);
  for (const f of frases.slice(0, 6)) {
    const l = limpiarFrase(f);
    if (l.length < 20 || plano(l).startsWith(clave) || clave.startsWith(plano(l))) continue;
    partes.push(cortarSemantico(mayus(l), 110) + '.');
    if (partes.length >= 3) break;
  }
  let copy = partes.join('\n\n');
  if (copy.length > 320) copy = cortarLimpio(copy, 317) + '…';
  return copy;
}

function construirHashtags({ texto, angulo, instruccion, tituloVideo }) {
  const fuentes = [...palabrasClave(`${instruccion} ${tituloVideo}`, 2), ...palabrasClave(String(texto).replace(ACOTACION, ' '), 3), ...ETIQUETAS_ANGULO[angulo], 'clips', 'parati', 'viral'];
  const tags = [...new Set(fuentes.map((t) => plano(t).replace(/[^a-z0-9]/g, '')).filter((t) => t.length >= 3))];
  return tags.slice(0, 7).map((t) => '#' + t);
}

function evaluarBloque({ texto, frases, duracion, ganchoPuntos, muletillas, angulo, instruccion }) {
  const palabras = texto.split(/\s+/).filter(Boolean);
  const p = plano(texto);

  // Gancho (0-30)
  const sGancho = (ganchoPuntos / 100) * 30;

  // Claridad (0-20): frases de 6-22 palabras de media, poca repeticion.
  const medio = palabras.length / Math.max(1, frases.length);
  let sClaridad = medio >= 6 && medio <= 22 ? 14 : medio >= 4 && medio <= 30 ? 8 : 3;
  const tokens = tokensPlanos(texto).filter((t) => !VACIAS.has(t));
  const variedad = tokens.length ? new Set(tokens).size / tokens.length : 0;
  sClaridad += variedad >= 0.6 ? 6 : variedad >= 0.45 ? 3 : 0;

  // Ritmo y cierre (0-20)
  const ritmo = palabras.length / Math.max(1, duracion);
  let sRitmo = ritmo >= 2 && ritmo <= 3.6 ? 8 : ritmo >= 1.5 && ritmo <= 4.2 ? 4 : 0;
  sRitmo += duracion >= 45 && duracion <= 60 ? 6 : duracion >= 35 && duracion <= 75 ? 3 : 0;
  sRitmo += /[.!?…]["')»]?$/.test(texto.trim()) ? 6 : 1;

  // Senales (0-20): cifras, contrastes, preguntas, errores comunes.
  let sSenales = 0;
  if (/\d/.test(texto)) sSenales += 6;
  if (contar(new RegExp(SENALES.contraste.source, 'g'), p)) sSenales += 5;
  if (/\?/.test(texto)) sSenales += 4;
  if (contar(new RegExp(SENALES.error_comun.source, 'g'), p)) sSenales += 5;
  // Reality / chisme: el choque o la confidencia es el gancho de este tipo de bloque.
  if (contar(new RegExp(SENALES.tension_reality.source, 'g'), p) >= 2) sSenales += 7;
  if (contar(new RegExp(SENALES.chisme_confidencia.source, 'g'), p) >= 2) sSenales += 7;
  sSenales = Math.min(20, sSenales);

  // Penalizaciones por muletillas
  const densidad = tokensPlanos(texto).filter((t) => MULETILLAS_DENSIDAD.has(t)).length / Math.max(1, palabras.length);
  const penal = Math.min(18, muletillas * 5) + Math.min(10, densidad * 100);

  // Relevancia con lo pedido (0-8)
  let bono = 0;
  const pedidas = tokensPlanos(instruccion).filter((t) => t.length >= 4 && !VACIAS.has(t));
  if (pedidas.length) bono = Math.min(8, (pedidas.filter((t) => p.includes(t)).length / pedidas.length) * 8);

  const puntaje = acotar(Math.round(sGancho + sClaridad + sRitmo + sSenales + bono - penal), 0, 100);
  return { puntaje, detalle: { gancho: r1(sGancho), claridad: r1(sClaridad), ritmo: r1(sRitmo), senales: r1(sSenales), penalizacion: r1(penal), relevancia: r1(bono) } };
}

function decidirVeredicto({ puntaje, ganchoPuntos, muletillas, vacio }) {
  if (vacio) return 'descartar';
  // Las muletillas del arranque se arreglan recortando el inicio: se juzga el bloque sin esa penalizacion.
  const recuperable = puntaje + Math.min(18, muletillas * 5);
  if (muletillas > 0) return recuperable >= 55 ? 'ajustar_inicio' : 'descartar';
  if (puntaje < 38) return 'descartar';
  if (ganchoPuntos < 45) return puntaje >= 45 ? 'ajustar_inicio' : 'descartar';
  return puntaje >= 62 ? 'publicar' : 'ajustar_inicio';
}

/**
 * Analisis puro y determinista de un bloque (sin red, sin Ollama).
 * @param {object|string} entrada  texto o { texto|transcripcion, duracion, instruccion, tituloVideo }
 */
export function analizarBloqueLocal(entrada = {}) {
  const e = typeof entrada === 'string' ? { texto: entrada } : (entrada || {});
  const texto = String(e.texto ?? e.transcripcion ?? '').replace(/\s+/g, ' ').trim();
  const instruccion = limpiarTextoBase(e.instruccion ?? e.tema ?? '');
  const tituloVideo = limpiarTextoBase(e.tituloVideo ?? '');
  const nPalabras = texto ? texto.split(/\s+/).length : 0;
  const duracionDada = Number(e.duracion);
  const duracion = Number.isFinite(duracionDada) && duracionDada > 0 ? duracionDada : Math.max(1, Math.round(nPalabras / 2.6));

  if (!texto) {
    return {
      gancho: '', angulo: 'beneficio_directo', tituloPrincipal: tituloVideo || 'Clip destacado', variantesTitulo: [],
      copy: '', cta: CTAS.beneficio_directo[0], hashtags: ['#clips', '#parati', '#viral'], puntaje: 0, veredicto: 'descartar',
      motor: 'heuristico-local', detalle: { muletillasIniciales: 0, duracion, palabras: 0 },
    };
  }

  const frases = dividirFrases(texto);
  const { cuenta: muletillas } = muletillasIniciales(texto);
  const { angulo } = detectarAngulo(frases.map(limpiarFrase), instruccion, texto);
  const g = elegirGancho(frases);
  const gancho = g.texto || limpiarFrase(frases[0] || '');
  const variantes = construirVariantes({ frases, gancho, angulo, transcripcion: texto, instruccion, tituloVideo });
  const tituloPrincipal = variantes[0]?.titulo || tituloVideo || cortarLimpio(gancho, 70) || 'Clip destacado';
  const ev = evaluarBloque({ texto, frases, duracion, ganchoPuntos: g.puntos, muletillas, angulo, instruccion });
  const cta = CTAS[angulo][hash(texto + angulo) % CTAS[angulo].length];

  return {
    gancho,
    angulo,
    tituloPrincipal,
    variantesTitulo: variantes,
    copy: construirCopy({ frases, gancho }),
    cta,
    hashtags: construirHashtags({ texto, angulo, instruccion, tituloVideo }),
    puntaje: ev.puntaje,
    veredicto: decidirVeredicto({ puntaje: ev.puntaje, ganchoPuntos: g.puntos, muletillas, vacio: false }),
    motor: 'heuristico-local',
    detalle: { ...ev.detalle, muletillasIniciales: muletillas, duracion, palabras: nPalabras },
  };
}

// ---------------------------------------------------------------------------
// Ollama local (opcional, con respaldo silencioso)
// ---------------------------------------------------------------------------
function configOllama(opciones = {}) {
  const timeout = Number(opciones.timeoutMs ?? process.env.OLLAMA_TIMEOUT_MS);
  return {
    url: String(opciones.url || process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    modelo: String(opciones.modelo || process.env.OLLAMA_MODEL || 'qwen2.5:3b'),
    // Un modelo local en CPU (qwen2.5:3b) tarda mas de 4 s en cargar/responder mientras whisper y ffmpeg usan los hilos:
    // con el tope viejo SIEMPRE caia al heuristico. Ahora 25 s por defecto (OLLAMA_TIMEOUT_MS, maximo 120 s).
    timeoutMs: acotar(Number.isFinite(timeout) && timeout > 0 ? timeout : 25000, 500, 120000),
  };
}

function ollamaActivo(opciones = {}) {
  if (opciones.ollama === false) return false;
  if (opciones.ollama === true) return true;
  return !/^(1|true|si|on)$/i.test(String(process.env.OLLAMA_OFF || ''));
}

function promptOllama({ texto, duracion, instruccion, base }) {
  return [
    'Eres editor de marketing para videos cortos en español. Analiza este bloque de ~' + Math.round(duracion) + ' segundos.',
    instruccion ? 'Tema o instrucción del usuario: ' + instruccion : '',
    'Transcripción:\n"""\n' + texto.slice(0, 3500) + '\n"""',
    'Ángulo sugerido: ' + base.angulo + '. Responde SOLO con JSON con estas claves: ',
    '{"gancho": frase de apertura de máximo 12 palabras, "tituloPrincipal": título de 40 a 70 caracteres sin clickbait vacío ni muletillas, "copy": descripción de máximo 280 caracteres, "cta": llamado a la acción corto, "hashtags": [hasta 6 etiquetas sin #]}',
  ].filter(Boolean).join('\n');
}

function cadena(valor, max) {
  if (typeof valor !== 'string') return '';
  const t = limpiarTextoBase(valor).replace(/\s+/g, ' ');
  return t.length > max ? cortarLimpio(t, max) : t;
}

async function consultarOllama(entrada, base, opciones) {
  const cfg = configOllama(opciones);
  const llamar = opciones.fetch || globalThis.fetch;
  if (typeof llamar !== 'function') return null;
  try {
    const respuesta = await llamar(cfg.url + '/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.modelo, prompt: promptOllama({ ...entrada, base }), stream: false, format: 'json', keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m', options: { temperature: 0.4, num_predict: 400, num_ctx: 2048 } }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!respuesta || !respuesta.ok) return null;
    const cuerpo = await respuesta.json();
    const crudo = typeof cuerpo?.response === 'string' ? cuerpo.response : '';
    const inicio = crudo.indexOf('{');
    const fin = crudo.lastIndexOf('}');
    if (inicio < 0 || fin <= inicio) return null;
    const json = JSON.parse(crudo.slice(inicio, fin + 1));
    return {
      gancho: cadena(json.gancho, 100),
      titulo: cadena(json.tituloPrincipal ?? json.titulo, 90),
      copy: cadena(json.copy, 320),
      cta: cadena(json.cta, 120),
      hashtags: Array.isArray(json.hashtags) ? json.hashtags : [],
      modelo: cfg.modelo,
    };
  } catch {
    return null; // apagado, timeout, JSON roto...: se usa el motor local
  }
}

function mezclarOllama(base, ia, { texto, instruccion }) {
  if (!ia) return base;
  const salida = { ...base, variantesTitulo: base.variantesTitulo.map((v) => ({ ...v })) };
  let usado = false;

  if (ia.gancho && ia.gancho.split(/\s+/).length >= 3 && muletillasIniciales(ia.gancho).cuenta === 0) {
    salida.gancho = mayus(ia.gancho);
    usado = true;
  }
  if (ia.titulo && ia.titulo.length >= 12 && muletillasIniciales(ia.titulo).cuenta === 0) {
    const ev = puntuarTitulo(ia.titulo, { transcripcion: texto, queBuscar: instruccion });
    const clave = plano(ia.titulo);
    if (!salida.variantesTitulo.some((v) => plano(v.titulo) === clave)) {
      salida.variantesTitulo.push({ tipo: 'ollama', titulo: ia.titulo, puntaje: Math.round(acotar(ev.puntaje + 4, 0, 100)) });
      salida.variantesTitulo.sort((a, b) => b.puntaje - a.puntaje || a.titulo.length - b.titulo.length);
    }
    salida.tituloPrincipal = salida.variantesTitulo[0].titulo;
    usado = true;
  }
  if (ia.copy && ia.copy.length >= 20) { salida.copy = ia.copy; usado = true; }
  if (ia.cta && ia.cta.length >= 5) { salida.cta = ia.cta; usado = true; }
  const etiquetas = ia.hashtags.map((t) => plano(String(t)).replace(/[^a-z0-9]/g, '')).filter((t) => t.length >= 3);
  if (etiquetas.length >= 2) {
    salida.hashtags = [...new Set([...etiquetas, ...base.hashtags.map((h) => h.slice(1))])].slice(0, 7).map((t) => '#' + t);
    usado = true;
  }
  if (!usado) return base;
  salida.motor = 'ollama';
  salida.modelo = ia.modelo;
  return salida;
}

/**
 * Analisis de un bloque de 45-60 s. Intenta Ollama local y, si no responde, devuelve el analisis heuristico.
 * Nunca lanza error. El puntaje y el veredicto siempre salen del motor determinista.
 */
export async function analizarBloque(entrada = {}, opciones = {}) {
  const base = analizarBloqueLocal(entrada);
  if (!ollamaActivo(opciones) || base.puntaje === 0 || !base.gancho) return base;
  const e = typeof entrada === 'string' ? { texto: entrada } : (entrada || {});
  const texto = String(e.texto ?? e.transcripcion ?? '').replace(/\s+/g, ' ').trim();
  const ia = await consultarOllama({ texto, duracion: base.detalle.duracion, instruccion: limpiarTextoBase(e.instruccion ?? e.tema ?? '') }, base, opciones);
  return mezclarOllama(base, ia, { texto, instruccion: limpiarTextoBase(e.instruccion ?? e.tema ?? '') });
}

/**
 * Intensidad de un momento (0-100) segun las senales de reality y chisme/confidencia. Barata y sin estado: la usa el
 * curador para priorizar picos de tension y confidencias al elegir clips, y el pipeline para marcar la ficha.
 * @returns {{ tipo: 'tension_reality'|'chisme_confidencia'|null, intensidad: number, tension: number, chisme: number }}
 */
export function puntuarIntensidad(texto) {
  const crudo = String(texto ?? '');
  const p = plano(crudo.replace(ACOTACION, ' '));
  const palabras = p.split(/\s+/).filter(Boolean).length;
  if (!palabras) return { tipo: null, intensidad: 0, tension: 0, chisme: 0 };
  const tension = contar(new RegExp(SENALES.tension_reality.source, 'g'), p);
  let chisme = contar(new RegExp(SENALES.chisme_confidencia.source, 'g'), p);
  if (/[\[(]\s*(susurr|en voz baja|bajito|murmur)/i.test(crudo)) chisme += 2; // habla a media voz
  const mayor = Math.max(tension, chisme);
  const densidad = ((tension + chisme) / palabras) * 100;
  if (mayor === 0 || (mayor < 2 && densidad < 3)) return { tipo: null, intensidad: 0, tension, chisme };
  return {
    tipo: chisme > tension ? 'chisme_confidencia' : 'tension_reality',
    intensidad: Math.round(acotar(mayor * 16 + densidad * 6, 0, 100)),
    tension,
    chisme,
  };
}

/**
 * Enriquece un clip ya renderizado con el cerebro: agrega `ficha.cerebro` y `marketing.cerebro` (angulo, puntaje,
 * veredicto, motor, mejores titulos). Solo si Ollama responde se sustituyen titulo/descripcion/CTA/hashtags de marketing.
 * Nunca lanza: si algo falla devuelve ficha y marketing tal cual.
 */
export async function enriquecerClip({ ficha = null, marketing = null, transcripcion = '', duracion, instruccion = '', tituloVideo = '' } = {}, opciones = {}) {
  try {
    const a = await analizarBloque({ texto: transcripcion, duracion, instruccion, tituloVideo }, opciones);
    if (!a.puntaje) return { ficha, marketing, cerebro: null };
    const momento = puntuarIntensidad(transcripcion);
    const cerebro = {
      angulo: a.angulo, puntaje: a.puntaje, veredicto: a.veredicto, motor: a.motor, gancho: a.gancho,
      variantesTitulo: a.variantesTitulo.slice(0, 3), momento: momento.tipo ? { tipo: momento.tipo, intensidad: momento.intensidad } : null,
    };
    const ficha2 = ficha ? { ...ficha, cerebro } : ficha;
    let marketing2 = marketing ? { ...marketing, cerebro } : marketing;
    if (marketing2 && a.motor === 'ollama') {
      marketing2 = { ...marketing2, titulo: a.tituloPrincipal || marketing2.titulo, descripcion: a.copy || marketing2.descripcion, cta: a.cta || marketing2.cta, hashtags: a.hashtags.length >= 3 ? a.hashtags : marketing2.hashtags };
    }
    return { ficha: ficha2, marketing: marketing2, cerebro };
  } catch {
    return { ficha, marketing, cerebro: null };
  }
}

export default { ANGULOS, VEREDICTOS, analizarBloque, analizarBloqueLocal, muletillasIniciales, puntuarIntensidad, enriquecerClip };
