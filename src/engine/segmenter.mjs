const END_PUNCT = /[.!?…]["')\]]*$/;

function makeSentence(ws, id) {
  const text = ws.map((w) => w.text).join(' ');
  return {
    id,
    start: ws[0].start,
    end: ws[ws.length - 1].end,
    text,
    words: ws,
    clean: END_PUNCT.test(ws[ws.length - 1].text),
    question: /\?/.test(text),
  };
}

export function buildSentences(words, { maxGap = 0.8, maxWords = 40 } = {}) {
  const out = [];
  let cur = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    cur.push(w);
    const next = words[i + 1];
    const gap = next ? next.start - w.end : Infinity;
    if (END_PUNCT.test(w.text) || gap >= maxGap || cur.length >= maxWords) {
      out.push(makeSentence(cur, out.length));
      cur = [];
    }
  }
  return out;
}
