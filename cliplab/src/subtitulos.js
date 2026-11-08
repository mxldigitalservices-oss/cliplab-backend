// Subtítulos dinámicos: palabras con tiempos → archivo ASS con resaltado palabra por palabra (karaoke).
// Módulo puro (sin red ni disco): todo lo que entra y sale son datos, por eso es fácil de probar.
const MAX_DUR_PALABRA = 1.2;   // una palabra nunca se queda resaltada más de esto (evita pausas largas)

// ---------- Entrada: transcripciones → palabras [{ t, i, f }] (segundos) ----------

// Parte frases de varias palabras en palabras sueltas, repartiendo el tiempo según su longitud.
export function aPalabras(items) {
  const out = [];
  for (const it of items) {
    const toks = String(it.t || "").replace(/[{}\\]/g, "").split(/\s+/).filter(Boolean);
    if (!toks.length || !Number.isFinite(it.i) || !Number.isFinite(it.f)) continue;
    const total = toks.reduce((a, w) => a + w.length + 1, 0);
    let cursor = it.i;
    for (const w of toks) {
      const fin = cursor + (it.f - it.i) * ((w.length + 1) / total);
      out.push({ t: w, i: cursor, f: fin });
      cursor = fin;
    }
  }
  return out;
}

// Formato json3 de YouTube (subtítulos manuales o automáticos, estos últimos con tiempo por palabra).
export function parseJson3(data) {
  const items = [];
  for (const e of Array.isArray(data?.events) ? data.events : []) {
    if (!Array.isArray(e.segs)) continue;
    const base = Number(e.tStartMs) || 0, finEv = base + (Number(e.dDurationMs) || 0);
    const segs = e.segs.map(s => ({ t: String(s.utf8 || "").replace(/\s+/g, " ").trim(), ms: base + (Number(s.tOffsetMs) || 0) }));
    segs.forEach((s, k) => {
      if (!s.t || /^\[.*\]$/.test(s.t)) return;   // "[Música]", "[Aplausos]"…
      const sig = segs.slice(k + 1).find(x => x.t)?.ms ?? finEv;
      items.push({ t: s.t, i: s.ms / 1000, f: Math.max(sig, s.ms + 150) / 1000 });
    });
  }
  return normalizar(aPalabras(items.sort((a, b) => a.i - b.i)));
}

// Sin solapes, sin duraciones absurdas, siempre en orden.
export function normalizar(pal) {
  const p = pal.filter(w => w.t && Number.isFinite(w.i) && Number.isFinite(w.f)).sort((a, b) => a.i - b.i).map(w => ({ ...w }));
  for (let k = 0; k < p.length; k++) {
    p[k].f = Math.min(p[k].f, p[k].i + MAX_DUR_PALABRA);
    const sig = p[k + 1];
    if (sig && p[k].f > sig.i) p[k].f = Math.max(p[k].i + 0.05, sig.i);
  }
  return p;
}

// Palabras del tramo [ini, fin] del video, con tiempos relativos al inicio del clip.
export function recortarPalabras(pal, ini, fin) {
  const dur = fin - ini;
  return pal
    .filter(w => w.f > ini && w.i < fin)
    .map(w => ({ t: w.t, i: Math.max(0, w.i - ini), f: Math.min(dur, w.f - ini) }))
    .filter(w => w.f - w.i >= 0.05);
}

// ---------- Salida: palabras → ASS ----------

export function fmtT(seg) {
  const cs = Math.max(0, Math.round(seg * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

// Líneas cortas (≤ max palabras) que se parten también ante una pausa larga o demasiado texto.
export function agrupar(pal, { max = 3, pausa = 0.7, maxChars = 22 } = {}) {
  const lineas = [];
  let l = [];
  for (const w of pal) {
    const chars = l.reduce((a, x) => a + x.t.length + 1, 0) + w.t.length;
    if (l.length && (l.length >= max || w.i - l.at(-1).f > pausa || chars > maxChars)) { lineas.push(l); l = []; }
    l.push(w);
  }
  if (l.length) lineas.push(l);
  return lineas;
}

const limpio = t => t.replace(/[{}\\]/g, "").replace(/[\r\n]+/g, " ").toLocaleUpperCase("es");

export function construirAss(palabras, { ancho = 720, alto = 1280, fuente = "DejaVu Sans", tamano = 64, margenV = 360, max = 3 } = {}) {
  const cab = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${ancho}`, `PlayResY: ${alto}`, "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Primario = amarillo (palabra ya dicha / en curso), secundario = blanco (palabra por decir)
    `Style: Sub,${fuente},${tamano},&H0000E6FF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,1,0,1,5,2,2,60,60,${margenV},1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];
  const lineas = agrupar(palabras, { max });
  const eventos = lineas.map((l, n) => {
    const ini = l[0].i;
    const fin = Math.max(ini + 0.1, Math.min(l.at(-1).f + 0.15, lineas[n + 1]?.[0].i ?? Infinity));
    const texto = l.map((w, k) => {
      const hasta = k + 1 < l.length ? l[k + 1].i : fin;
      return `{\\k${Math.max(1, Math.round((hasta - w.i) * 100))}}${limpio(w.t)}`;
    }).join(" ");
    return `Dialogue: 0,${fmtT(ini)},${fmtT(fin)},Sub,,0,0,0,,{\\fad(40,0)\\fscx88\\fscy88\\t(0,110,\\fscx100\\fscy100)}${texto}`;
  });
  return [...cab, ...eventos, ""].join("\n");
}
