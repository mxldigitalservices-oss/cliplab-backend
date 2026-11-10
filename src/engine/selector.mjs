import { STOPWORDS, norm } from './stopwords.mjs';

export const DEFAULTS = {
  minDur: 20,
  maxDur: 55,
  targetDur: 35,
  maxClips: 8,
  minScore: 35,
  maxInnerGap: 1.5,
  topKeywords: 25,
  padStart: 0.25,
  padEnd: 0.35,
};

const HOOKS = new Set((
  'secreto secretos error errores nunca siempre increible verdad mentira problema peligro ' +
  'cuidado atencion urgente gratis rapido facil truco trucos clave razon porque como cuanto ' +
  'secret secrets mistake mistakes never always truth lie problem danger warning free fast easy ' +
  'trick tricks key reason why how stop'
).split(/\s+/));

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function keywordSet(words, n) {
  const tf = new Map();
  for (const w of words) {
    const k = norm(w.text);
    if (k.length < 4 || STOPWORDS.has(k)) continue;
    tf.set(k, (tf.get(k) || 0) + 1);
  }
  return new Set(
    [...tf.entries()]
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, n)
      .map(([k]) => k),
  );
}

function scoreWindow(sents, kw, cfg) {
  const first = sents[0];
  const last = sents[sents.length - 1];
  const start = first.start;
  const end = last.end;
  const dur = end - start;
  const words = sents.flatMap((s) => s.words);
  const n = words.length;
  if (n === 0) return null;

  const firstNorm = first.words.map((w) => norm(w.text));
  const hasHook = firstNorm.some((k) => HOOKS.has(k));
  const hasDigit = /\d/.test(first.text);
  const hook = clamp01((hasHook ? 0.5 : 0) + (first.question ? 0.25 : 0) + (hasDigit ? 0.25 : 0));

  const found = new Set();
  let hits = 0;
  for (const w of words) {
    const k = norm(w.text);
    if (kw.has(k)) { hits++; found.add(k); }
  }
  const keywords = clamp01(hits / n / 0.1);

  const wps = n / dur;
  let pace = 1;
  if (wps < 1.8) pace = clamp01(wps / 1.8);
  else if (wps > 4.2) pace = clamp01(1 - (wps - 4.2) / 2);

  const duration = clamp01(1 - Math.abs(dur - cfg.targetDur) / (cfg.maxDur - cfg.minDur));
  const closure = last.clean ? 1 : 0;

  let maxGap = 0;
  for (let i = 1; i < words.length; i++) {
    maxGap = Math.max(maxGap, words[i].start - words[i - 1].end);
  }
  const continuity = maxGap > cfg.maxInnerGap ? 0 : 1 - maxGap / cfg.maxInnerGap;

  const total = 100 * (
    0.30 * hook + 0.25 * keywords + 0.15 * pace +
    0.15 * duration + 0.10 * closure + 0.05 * continuity
  );

  return {
    start, end, dur, total,
    parts: { hook, keywords, pace, duration, closure, continuity },
    keywords: [...found].sort(),
    wps,
    first, sents,
  };
}

export function selectClips(sentences, allWords, userCfg = {}) {
  const cfg = { ...DEFAULTS, ...userCfg };
  const kw = keywordSet(allWords, cfg.topKeywords);
  const cands = [];

  for (let i = 0; i < sentences.length; i++) {
    for (let j = i; j < sentences.length; j++) {
      const dur = sentences[j].end - sentences[i].start;
      if (dur > cfg.maxDur) break;
      if (dur < cfg.minDur) continue;
      const c = scoreWindow(sentences.slice(i, j + 1), kw, cfg);
      if (c && c.total >= cfg.minScore) cands.push(c);
    }
  }

  cands.sort((a, b) => b.total - a.total || a.start - b.start || a.end - b.end);

  const chosen = [];
  for (const c of cands) {
    if (chosen.length >= cfg.maxClips) break;
    if (chosen.some((x) => c.start < x.end && c.end > x.start)) continue;
    chosen.push(c);
  }
  chosen.sort((a, b) => a.start - b.start);

  const round = (x) => Math.round(x * 100) / 100;
  return chosen.map((c, idx) => ({
    id: idx + 1,
    start: round(Math.max(0, c.start - cfg.padStart)),
    end: round(c.end + cfg.padEnd),
    duration: round(c.dur),
    score: round(c.total),
    title: c.first.text.replace(/[.,;:!?¿¡…\s]+$/g, '').slice(0, 70),
    keywords: c.keywords,
    reasons: Object.fromEntries(Object.entries(c.parts).map(([k, v]) => [k, round(v)])),
    text: c.sents.map((s) => s.text).join(' '),
  }));
}
