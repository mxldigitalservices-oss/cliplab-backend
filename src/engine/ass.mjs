const FONT = process.env.SUB_FONT || 'Montserrat';

export function fmtTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function esc(t) {
  return t.replace(/\\/g, '').replace(/[{}]/g, '').replace(/\r?\n/g, ' ');
}

export function clipWords(words, clip) {
  const dur = clip.end - clip.start;
  return words
    .filter((w) => w.start >= clip.start - 0.01 && w.start < clip.end)
    .map((w) => {
      const start = Math.max(0, w.start - clip.start);
      let end = Math.min(dur, w.end - clip.start);
      if (end <= start) end = Math.min(dur, start + 0.05);
      return { text: w.text, start, end };
    });
}

export function groupLines(words, { maxWords = 4, maxChars = 20, maxGap = 0.6 } = {}) {
  const lines = [];
  let cur = [];
  let chars = 0;
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const brk = prev && (
      w.start - prev.end >= maxGap ||
      cur.length >= maxWords ||
      chars + 1 + w.text.length > maxChars ||
      /[.!?…]$/.test(prev.text)
    );
    if (brk) { lines.push(cur); cur = []; chars = 0; }
    cur.push(w);
    chars += (chars ? 1 : 0) + w.text.length;
  }
  if (cur.length) lines.push(cur);
  return lines;
}

export function buildAss(words, clip, opts = {}) {
  const dur = clip.end - clip.start;
  const fontSize = opts.fontSize || 68;
  const marginV = opts.marginV || 520;
  const upper = !!opts.upper;
  const lines = groupLines(words, { maxWords: opts.maxWords || 4, maxChars: opts.maxChars || 20 });

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: None',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Karaoke,${FONT},${fontSize},&H0000D4FF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,70,70,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = lines.map((line, i) => {
    const l0 = line[0].start;
    const last = line[line.length - 1];
    const nextStart = lines[i + 1] ? lines[i + 1][0].start : dur;
    const lineEnd = Math.min(last.end + 0.2, nextStart, dur);
    const parts = line.map((w, k) => {
      const tStart = w.start;
      const tNext = k + 1 < line.length ? line[k + 1].start : last.end;
      const kd = Math.max(1, Math.round((tNext - l0) * 100) - Math.round((tStart - l0) * 100));
      let txt = esc(w.text);
      if (upper) txt = txt.toLocaleUpperCase('es');
      return `{\\kf${kd}}${txt}${k + 1 < line.length ? ' ' : ''}`;
    });
    return `Dialogue: 0,${fmtTime(l0)},${fmtTime(Math.max(lineEnd, l0 + 0.1))},Karaoke,,0,0,0,,{\\fad(60,40)}${parts.join('')}`;
  });

  return [...header, ...events, ''].join('\n');
}
