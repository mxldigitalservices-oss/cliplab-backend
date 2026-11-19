// Estilos de subtítulos ASS para FFmpeg/libass. Módulo puro (sin red ni disco).
//   dinamico → mayúsculas, 3 palabras por línea, resalte palabra por palabra (karaoke) y "pop" de entrada
//   clasico  → blanco con contorno negro y sombra suave, frases en hasta 2 líneas, sin animación (aparece/desaparece suave)
//   minimal  → texto pequeño en minúsculas sobre caja translúcida, discreto
// Entrada: palabras [{ t, i, f }] (segundos relativos al inicio del clip), igual que subtitulos.js.
// Todas las variantes respetan el margen inferior (margenV) para no quedar bajo la interfaz de TikTok/Reels/Shorts.

const REF = 64;   // tamaño de referencia (SUB_TAMANO): los demás estilos escalan en proporción

export const ESTILOS = Object.freeze({
  dinamico: Object.freeze({
    descripcion: "Mayúsculas, resalte palabra por palabra y entrada con pop",
    tamano: 64, negrita: true, mayusculas: true, karaoke: true, pop: true, palabras: 3, caracteres: 22, pausa: 0.7,
    primario: "&H0000E6FF", secundario: "&H00FFFFFF", contorno: "&H00000000", fondo: "&H96000000",
    borde: 1, grosor: 5, sombra: 2, espaciado: 1, ratio: 0.72, entrada: 40, salida: 0
  }),
  clasico: Object.freeze({
    descripcion: "Blanco con contorno negro, frases en 1–2 líneas, sin animación",
    tamano: 54, negrita: false, mayusculas: false, karaoke: false, pop: false, palabras: 8, caracteres: 34, pausa: 0.9,
    primario: "&H00FFFFFF", secundario: "&H00FFFFFF", contorno: "&H00000000", fondo: "&H80000000",
    borde: 1, grosor: 3, sombra: 1, espaciado: 0, ratio: 0.58, entrada: 90, salida: 90
  }),
  minimal: Object.freeze({
    descripcion: "Texto pequeño en minúsculas sobre caja translúcida",
    tamano: 42, negrita: false, mayusculas: false, karaoke: false, pop: false, palabras: 6, caracteres: 30, pausa: 0.9,
    primario: "&H00F2F2F2", secundario: "&H00F2F2F2", contorno: "&H78000000", fondo: "&H78000000",
    borde: 3, grosor: 8, sombra: 0, espaciado: 0, ratio: 0.56, entrada: 120, salida: 120
  })
});

export const nombresEstilos = () => Object.keys(ESTILOS);

// Valida el valor que llega del cliente. Vacío → defecto; desconocido → error claro (el endpoint responde 400).
export function normalizarEstilo(nombre, defecto = "dinamico") {
  const n = String(nombre ?? "").trim().toLowerCase();
  if (!n) return defecto;
  if (!Object.hasOwn(ESTILOS, n)) throw new Error(`Estilo de subtítulos inválido: "${String(nombre).slice(0, 30)}". Usa: ${nombresEstilos().join(", ")}.`);
  return n;
}

export function fmtT(seg) {
  const cs = Math.max(0, Math.round(seg * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

// Líneas de ≤ max palabras que también se parten ante una pausa larga o demasiado texto.
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

const limpio = t => String(t ?? "").replace(/[{}\\]/g, "").replace(/[\r\n]+/g, " ").trim();   // nada del texto puede inyectar etiquetas ASS

// Parte un texto en 2 líneas lo más parejas posible (\N). Si no cabe en una sola línea.
function dividir(palabras, caben) {
  const total = palabras.join(" ");
  if (total.length <= caben || palabras.length < 2) return [total];
  let mejor = 1, dif = Infinity;
  for (let k = 1; k < palabras.length; k++) {
    const d = Math.abs(palabras.slice(0, k).join(" ").length - palabras.slice(k).join(" ").length);
    if (d < dif) { dif = d; mejor = k; }
  }
  return [palabras.slice(0, mejor).join(" "), palabras.slice(mejor).join(" ")];
}

export function construirAssEstilo(palabras, { estilo = "dinamico", ancho = 720, alto = 1280, fuente = "DejaVu Sans", tamano, margenV = 360, max } = {}) {
  const e = ESTILOS[normalizarEstilo(estilo)];
  const tam = Math.round(e.tamano * (Number.isFinite(tamano) && tamano > 0 ? tamano / REF : 1));
  const util = ancho - 120;   // MarginL/R = 60
  const maxLinea = Math.floor(util / (tam * e.ratio));   // caracteres que caben en una línea con este tamaño
  const cab = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${ancho}`, `PlayResY: ${alto}`, "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Sub,${fuente},${tam},${e.primario},${e.secundario},${e.contorno},${e.fondo},${e.negrita ? -1 : 0},0,0,0,100,100,${e.espaciado},0,${e.borde},${e.grosor},${e.sombra},2,60,60,${margenV},1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];

  // Ningún renglón se sale de la pantalla: si el texto es más ancho que el espacio útil, se reduce el tamaño de esa línea.
  const ajuste = (nChars) => (nChars > maxLinea ? `{\\fs${Math.max(20, Math.floor(tam * maxLinea / nChars))}}` : "");
  const lineas = agrupar(palabras, { max: max ?? e.palabras, pausa: e.pausa, maxChars: e.caracteres });
  const eventos = lineas.map((l, n) => {
    const ini = l[0].i;
    const siguiente = lineas[n + 1]?.[0].i ?? Infinity;
    const fin = Math.max(ini + 0.1, Math.min(l.at(-1).f + (e.karaoke ? 0.15 : 0.3), siguiente));
    const forma = t => (e.mayusculas ? t.toLocaleUpperCase("es") : t.toLocaleLowerCase("es"));
    let efecto, texto;
    if (e.karaoke) {
      const chars = l.reduce((a, w) => a + limpio(w.t).length + 1, -1);
      texto = ajuste(chars) + l.map((w, k) => `{\\k${Math.max(1, Math.round(((k + 1 < l.length ? l[k + 1].i : fin) - w.i) * 100))}}${forma(limpio(w.t))}`).join(" ");
      efecto = `{\\fad(${e.entrada},${e.salida})${e.pop ? "\\fscx88\\fscy88\\t(0,110,\\fscx100\\fscy100)" : ""}}`;
    } else {
      const partes = dividir(l.map(w => forma(limpio(w.t))), maxLinea);
      texto = ajuste(Math.max(...partes.map(p => p.length))) + partes.join("\\N");
      efecto = `{\\fad(${e.entrada},${e.salida})}`;
    }
    return `Dialogue: 0,${fmtT(ini)},${fmtT(fin)},Sub,,0,0,0,,${efecto}${texto}`;
  });
  return [...cab, ...eventos, ""].join("\n");
}
