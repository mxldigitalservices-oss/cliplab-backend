import crypto from 'node:crypto';

// Generador de metadatos de marketing por clip. Determinista y sin red: no depende de ninguna API de IA,
// por lo que nunca bloquea ni hace fallar un render. Misma entrada + mismo clip => mismo resultado.

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const semilla = (txt) => parseInt(crypto.createHash('md5').update(String(txt)).digest('hex').slice(0, 8), 16);
const pick = (lista, h, desfase = 0) => lista[(h + desfase) % lista.length];

const STOP = new Set(norm(
  'de la que el en y a los se del las un por con no una su para es al lo como mas pero sus le ya o este si porque esta ' +
  'entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese ' +
  'eso ante ellos esto antes algunos unos yo otro otras otra tanto esa estos mucho nada muchos cual poco ella estar ' +
  'estas algo nosotros mis te ti tu tus ser son fue era pues bueno entonces tipo asi aqui alli vez cosa cosas puede ' +
  'pueden hacer hace tiene tienen the and that this with for are was you your have not but from they will what about ' +
  'there their when which would just like then than very really yeah okay'
).split(/\s+/));

// Palabras que suelen enganchar: si una frase de la transcripcion las contiene, es buena candidata a gancho.
const SENALES = ['nunca', 'siempre', 'error', 'secreto', 'verdad', 'mentira', 'nadie', 'todos', 'millon', 'dinero', 'gratis',
  'problema', 'miedo', 'increible', 'cambio', 'aprend', 'descubr', 'never', 'always', 'secret', 'truth', 'mistake', 'nobody'];

const NICHOS = {
  negocios: {
    etiqueta: 'negocios', emojis: ['💰', '📈', '🚀'], tags: ['negocios', 'emprendimiento', 'finanzas'],
    claves: ['negocio', 'empresa', 'venta', 'dinero', 'ingreso', 'cliente', 'startup', 'emprend', 'marketing', 'inversion', 'business', 'money', 'revenue', 'sales', 'profit'],
    ganchos: [(t) => `Lo que nadie te cuenta sobre ${t}`, (t) => `El error con ${t} que te cuesta dinero`, (t) => `Así se gana dinero con ${t}`, (t) => `${t}: la lección que lo cambió todo`],
  },
  tecnologia: {
    etiqueta: 'tecnología', emojis: ['🤖', '💻', '⚡'], tags: ['tecnologia', 'ia', 'innovacion'],
    claves: ['tecnolog', 'software', 'codigo', 'program', 'inteligencia', 'artificial', 'datos', 'robot', 'digital', 'tech', 'modelo', 'algorit', 'chip'],
    ganchos: [(t) => `${t} está cambiando las reglas del juego`, (t) => `Lo que viene con ${t} te va a sorprender`, (t) => `Pocos entienden esto sobre ${t}`, (t) => `${t}: lo que las big tech no dicen`],
  },
  debate: {
    etiqueta: 'debate', emojis: ['🔥', '🗣️', '⚖️'], tags: ['debate', 'opinion', 'actualidad'],
    claves: ['debate', 'opinion', 'politica', 'sociedad', 'argument', 'polemic', 'discusion', 'verdad', 'mentira', 'cultura', 'gobierno', 'ley'],
    ganchos: [(t) => `¿Tienen razón con ${t}? Esto abrió el debate`, (t) => `La opinión más polémica sobre ${t}`, (t) => `Nadie quiere hablar de ${t}, pero aquí está`, (t) => `${t}: ¿estás de acuerdo?`],
  },
  entretenimiento: {
    etiqueta: 'entretenimiento', emojis: ['🎬', '😂', '🔥'], tags: ['entretenimiento', 'viral', 'podcast'],
    claves: ['pelicula', 'serie', 'musica', 'famos', 'chiste', 'historia', 'podcast', 'show', 'juego', 'humor', 'celebr', 'anecdota'],
    ganchos: [(t) => `No vas a creer lo que pasó con ${t}`, (t) => `El momento más épico sobre ${t}`, (t) => `Esto sobre ${t} se hizo viral por algo`, (t) => `La historia de ${t} que nadie esperaba`],
  },
  general: {
    etiqueta: 'contenido como este', emojis: ['✨', '👀', '🎯'], tags: ['viral', 'aprende', 'contenido'],
    claves: [],
    ganchos: [(t) => `Lo que tienes que saber sobre ${t}`, (t) => `Mira esto antes de opinar sobre ${t}`, (t) => `${t}: lo que casi nadie te explica`, (t) => `Esto cambia cómo ves ${t}`],
  },
};

const CTAS = [
  (n) => `👇 Sígueme para más contenido de ${n}`,
  () => '💬 ¿Qué opinas? Cuéntame en los comentarios',
  () => '🔔 Guárdalo y compártelo con quien lo necesite',
  () => '➡️ Sígueme y no te pierdas la siguiente parte',
];

function recortar(texto, max) {
  const s = String(texto || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const corte = s.slice(0, max - 1);
  const i = corte.lastIndexOf(' ');
  return (i > max * 0.6 ? corte.slice(0, i) : corte).replace(/[\s,.;:]+$/, '') + '…';
}

const mayuscula = (s) => s.charAt(0).toLocaleUpperCase('es') + s.slice(1);

function frases(texto) {
  return (String(texto || '').replace(/\s+/g, ' ').match(/[^.!?¿¡]+[.!?]?/g) || []).map((f) => f.trim()).filter(Boolean);
}

function detectarNicho(texto) {
  const t = norm(texto);
  let mejor = 'general';
  let max = 0;
  for (const [nombre, def] of Object.entries(NICHOS)) {
    const puntos = def.claves.filter((k) => t.includes(k)).length;
    if (puntos > max) { max = puntos; mejor = nombre; }
  }
  return mejor;
}

function palabrasClave(texto, n) {
  const frecuencia = new Map();
  for (const w of String(texto || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    const k = norm(w);
    if (w.length >= 5 && !STOP.has(k) && !/^\d+$/.test(k)) {
      const e = frecuencia.get(k) || { w, k, c: 0 };
      e.c += 1;
      frecuencia.set(k, e);
    }
  }
  return [...frecuencia.values()].sort((a, b) => b.c - a.c || b.k.length - a.k.length).slice(0, n).map((e) => ({ texto: e.w, tag: e.k.replace(/[^a-z0-9]/g, '') }));
}

/** Frase de la transcripcion con mas "gancho" (6-16 palabras, senales de enganche, pregunta o cifra). */
function mejorFrase(texto) {
  let mejor = null;
  let puntos = 0;
  for (const f of frases(texto)) {
    const palabras = f.split(/\s+/).length;
    if (palabras < 6 || palabras > 16) continue;
    const n = norm(f);
    const p = SENALES.filter((s) => n.includes(s)).length * 2 + (/[?¿]/.test(f) ? 2 : 0) + (/\d/.test(f) ? 1 : 0);
    if (p > puntos) { puntos = p; mejor = f; }
  }
  return puntos >= 2 ? mejor.replace(/^(mira|oye|bueno|pues|entonces|ok|okay|so|look)[,\s]+/i, '').replace(/[.,;:]+$/, '') : null;
}

/**
 * @param {object} e
 * @param {string} e.tituloVideo   titulo del video fuente
 * @param {string} e.transcripcion texto hablado del clip (puede venir vacio)
 * @param {string} e.semilla       id del clip + inicio: varia plantillas entre clips del mismo video
 * @param {number} [e.indice]      posicion del clip (1..total)
 * @param {number} [e.total]
 * @returns {{titulo:string, descripcion:string, cta:string, hashtags:string[], nicho:string, version:number, generadoEn:string}}
 */
export function generarMarketing({ tituloVideo = '', transcripcion = '', semilla: sem = '', indice = 1, total = 1 } = {}) {
  const base = [tituloVideo, transcripcion].filter(Boolean).join(' ');
  const nicho = detectarNicho(base);
  const def = NICHOS[nicho];
  const palabras = palabrasClave(transcripcion || tituloVideo, 8);
  const h = semilla(sem + '|' + tituloVideo);

  const tema = (palabras[0] && palabras[0].texto) || recortar(tituloVideo, 40) || 'este tema';
  const frase = mejorFrase(transcripcion);
  const tituloBase = frase ? mayuscula(frase) : mayuscula(pick(def.ganchos, h)(tema));
  const titulo = recortar(tituloBase, 90);

  const resumen = frases(transcripcion).find(
    (f) => f.split(/\s+/).length >= 5 && !(frase && norm(f).includes(norm(frase).slice(0, 25)))
  );
  const detalle = resumen ? recortar(resumen, 160) : recortar(tituloVideo, 160);
  const parte = total > 1 ? ' (parte ' + indice + ' de ' + total + ')' : '';
  const descripcion = [
    pick(def.emojis, h) + ' ' + titulo,
    detalle ? pick(def.emojis, h, 1) + ' ' + detalle : '',
    '⏱️ Mira hasta el final' + parte + '.',
  ].filter(Boolean).join('\n');

  // En series, los clips intermedios invitan a seguir para ver la siguiente parte.
  const cta = total > 1 && indice < total ? CTAS[3](def.etiqueta) : pick(CTAS, h, 1)(def.etiqueta);

  const etiquetas = [...new Set([...def.tags, ...palabras.map((k) => k.tag).filter((t) => t.length >= 6).slice(0, 3), 'fyp', 'parati', 'reels', 'shorts'])]
    .slice(0, 10)
    .map((t) => '#' + t);

  return { titulo, descripcion, cta, hashtags: etiquetas, nicho, version: 1, generadoEn: new Date().toISOString() };
}
