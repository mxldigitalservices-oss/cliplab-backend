// Motor local de ganchos y palabras clave. Sin APIs externas, sin cuotas.

const STOP = new Set((
  'de la que el en y a los del se las por un para con no una su al lo como más pero sus le ya o este sí porque esta entre ' +
  'cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ' +
  'ellos e esto antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar ' +
  'estas algunas algo nosotros mi mis tú te ti tu tus ellas es son fue ser está están así bien aquí entonces pues va vamos ' +
  'voy tiene tienen hacer hace puede pueden cada solo ahora ' +
  'the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will ' +
  'my one all would there their what so up out if about who get which go me when make can like time no just him know take ' +
  'people into year your good some could them see other than then now look only come its over think also back after use two ' +
  'how our work first well way even new want because any these give day most us is are was were been has had did does very ' +
  'really going gonna thing things yeah okay right'
).split(/\s+/));

const HOOK_RE = new RegExp(
  [
    'nunca', 'nadie', 'jam[áa]s', 'error', 'c[óo]mo', 'por qu[ée]', 'incre[íi]ble', 'truco', 'verdad', 'mentira',
    'peligro', 'gratis', 'secreto', 'ojo', 'cuidado', 'nobody', 'never', 'secret', 'mistake', 'truth', 'lie',
    'why', 'how to', 'imagine', 'stop', 'warning', 'free', 'insane', 'crazy', 'worst', 'best', 'mejor', 'peor',
  ].join('|'),
  'gi'
);

const tokenize = (t) => (t.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []);
const esClave = (w) => w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w);

function toSec(ts) {
  const p = ts.trim().replace(',', '.').split(':').map(Number);
  if (p.some(Number.isNaN)) return 0;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
}

function parseVtt(raw) {
  const cues = [];
  let prev = '';
  const blocks = raw.replace(/\r/g, '').split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx === -1) continue;
    const [a, bEnd] = lines[idx].split('-->');
    const start = toSec(a);
    const end = toSec(bEnd.trim().split(/\s+/)[0]);
    const textLines = lines
      .slice(idx + 1)
      .map((l) => l.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim())
      .filter(Boolean);
    if (!textLines.length) continue;
    const text = textLines[textLines.length - 1];
    if (text === prev) continue;
    prev = text;
    cues.push({ start, end, text });
  }
  return cues;
}

function extraerClaves(texto, titulo) {
  const freq = new Map();
  for (const w of tokenize(texto)) if (esClave(w)) freq.set(w, (freq.get(w) || 0) + 1);
  for (const w of tokenize(titulo || '')) if (esClave(w)) freq.set(w, (freq.get(w) || 0) + 3);

  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const pesos = new Map(top);

  const toks = tokenize(texto);
  const bi = new Map();
  for (let i = 0; i < toks.length - 1; i++) {
    if (esClave(toks[i]) && esClave(toks[i + 1])) {
      const k = `${toks[i]} ${toks[i + 1]}`;
      bi.set(k, (bi.get(k) || 0) + 1);
    }
  }
  const bigramas = [...bi.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k);

  return { lista: [...bigramas, ...top.slice(0, 10).map(([k]) => k)], pesos };
}

function puntajeGancho(texto) {
  let s = 0;
  if (/[?¿]/.test(texto)) s += 3;
  if (/\d/.test(texto)) s += 2;
  if (/!/.test(texto)) s += 1;
  const m = texto.match(HOOK_RE);
  if (m) s += Math.min(3, m.length * 1.5);
  const n = texto.split(/\s+/).length;
  if (n >= 5 && n <= 20) s += 2;
  return s;
}

const limpiarTitulo = (t) => {
  const s = t.replace(/\s+/g, ' ').trim().slice(0, 90);
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function desdeCues(cues, pesos, dur, max, duracionVideo) {
  const totalPesos = [...pesos.values()].reduce((a, b) => a + b, 0) || 1;
  const cand = [];
  for (let i = 0; i < cues.length; i++) {
    const inicio = cues[i].start;
    if (duracionVideo && inicio + 8 > duracionVideo) continue;
    const limite = inicio + dur;
    let j = i;
    let clave = 0;
    const vistos = new Set();
    const textos = [];
    while (j < cues.length && cues[j].start < limite) {
      textos.push(cues[j].text);
      for (const t of tokenize(cues[j].text)) {
        if (pesos.has(t) && !vistos.has(t)) { vistos.add(t); clave += pesos.get(t); }
      }
      j++;
    }
    if (textos.length < 2) continue;
    cand.push({
      inicio: Math.max(0, inicio - 0.3),
      fin: duracionVideo ? Math.min(duracionVideo, limite) : limite,
      texto: cues[i].text,
      resumen: textos.join(' ').slice(0, 280),
      puntaje: puntajeGancho(cues[i].text) * 2 + (clave / totalPesos) * 10,
    });
  }
  cand.sort((a, b) => b.puntaje - a.puntaje);
  const elegidos = [];
  for (const c of cand) {
    if (elegidos.every((e) => Math.abs(e.inicio - c.inicio) >= dur)) elegidos.push(c);
    if (elegidos.length >= max) break;
  }
  return elegidos.sort((a, b) => a.inicio - b.inicio);
}

function desdeMetadatos(input, dur, max) {
  const d = input.duracion || dur * max * 2;
  const res = [];
  const caps = (input.capitulos || []).filter((c) => Number.isFinite(c.start_time));
  if (caps.length) {
    for (const c of caps.slice(0, max)) {
      res.push({
        inicio: c.start_time,
        fin: Math.min(d, c.start_time + dur),
        texto: c.title || input.titulo,
        resumen: (input.descripcion || '').slice(0, 280),
        puntaje: 1,
      });
    }
    return res;
  }
  const posiciones = [0.15, 0.45, 0.7, 0.3, 0.85].slice(0, max);
  posiciones.forEach((p, i) => {
    const inicio = Math.max(0, Math.min(d - dur, d * p));
    res.push({
      inicio,
      fin: Math.min(d, inicio + dur),
      texto: `${input.titulo} (parte ${i + 1})`,
      resumen: (input.descripcion || '').slice(0, 280),
      puntaje: 0.5,
    });
  });
  return res.sort((a, b) => a.inicio - b.inicio);
}

function analizar(input, { maxClips, duracionClip }) {
  const cues = input.vtt ? parseVtt(input.vtt) : [];
  const base = cues.length
    ? cues.map((c) => c.text).join(' ')
    : [input.titulo, input.descripcion, (input.tags || []).join(' ')].join(' ');

  const { lista, pesos } = extraerClaves(base, input.titulo);
  const ganchos = cues.length
    ? desdeCues(cues, pesos, duracionClip, maxClips, input.duracion)
    : desdeMetadatos(input, duracionClip, maxClips);

  const resumen = `${(input.descripcion || '').replace(/\s+/g, ' ').slice(0, 300)}${
    lista.length ? ` | Temas: ${lista.slice(0, 8).join(', ')}` : ''
  }`.trim();

  return {
    palabrasClave: lista,
    resumen,
    fuente: cues.length ? 'transcripcion' : 'metadatos',
    ganchos: ganchos.map((g) => ({ ...g, titulo: limpiarTitulo(g.texto) })),
  };
}

module.exports = { analizar, parseVtt };
