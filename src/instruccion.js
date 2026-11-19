// "Qué buscar": instrucción opcional en texto libre → bonus de puntaje para los segmentos que coinciden.
// 100 % local y sin dependencias: normalización (minúsculas, sin tildes), palabras vacías ES/EN, raíz por prefijo
// ("invertir" ≈ "inversión") y frases exactas entre comillas. Módulo puro: fácil de probar y barato en CPU.
//
//   const consulta = parsear("momentos donde hablen de inversión y \"fondo de emergencia\"");
//   const r = puntuarTexto(segmento.texto, consulta);   // { coincidencias, cobertura, densidad, frases, hits }
//   priorizar(segmentos, instruccion)                    // → segmentos con puntaje subido y marcados como `coincide`

const PARADAS = new Set((
  "de la que el en y a los del se las por un para con no una su al lo como mas pero sus le ya o este si porque esta entre " +
  "cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante " +
  "ellos e esto mi antes algunos unos yo otro otras otra tanto esa estos mucho quienes nada muchos cual poco ella estar " +
  "estas algunas algo nosotros mis tu te ti tus ellas es son fue era ser hacer hace haya " +
  "busca buscar busco quiero quisiera necesito encuentra encontrar dame dime muestra mostrar prioriza priorizar " +
  "segmento segmentos fragmento fragmentos parte partes momento momentos clip clips video videos escena escenas " +
  "hablen hablan hable habla hablando mencionan menciona mencione trate traten trata tratan relacionado relacionados " +
  "the an and or of to in on at for with from by is are was were be been it this that these those i you he she we they " +
  "my your his her our their not so as but if then than about into out up down over under what which who whom find look " +
  "show where when talk talks talking mention mentions"
).split(/\s+/));

export const normalizar = t => String(t ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

// Texto libre del usuario → texto seguro de longitud acotada (null si queda vacío).
export function sanear(instruccion, max = 300) {
  const t = String(instruccion ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return t || null;
}

// → { texto, tokens: [...], frases: [...] } o null si no hay nada utilizable.
export function parsear(instruccion) {
  const texto = sanear(instruccion);
  if (!texto) return null;
  const frases = [];
  const resto = texto.replace(/["“”«»]([^"“”«»]{3,80})["“”«»]/g, (_, f) => {
    const n = normalizar(f);
    if (n.split(" ").length >= 2) frases.push(n);
    return ` ${f} `;                       // las palabras de la frase también cuentan como tokens sueltos
  });
  const tokens = [...new Set(normalizar(resto).split(" ").filter(t => t.length >= 3 && !PARADAS.has(t)))].slice(0, 12);
  if (!tokens.length && !frases.length) return null;
  return { texto, tokens, frases: [...new Set(frases)].slice(0, 4) };
}

// Misma palabra, o raíz común (≥ 5 letras y ≥ 60 % de la más corta): dinero≈dineros, invertir≈inversión; policía≠política.
const coincide = (w, t) => {
  if (w === t) return true;
  const m = Math.min(w.length, t.length);
  if (m < 5) return false;
  let i = 0;
  while (i < m && w[i] === t[i]) i++;
  return i >= Math.max(5, Math.floor(m * 0.6));
};

export function puntuarTexto(texto, consulta) {
  const vacio = { coincidencias: 0, cobertura: 0, densidad: 0, frases: 0, hits: [] };
  if (!consulta) return vacio;
  const norm = normalizar(texto);
  const palabras = norm ? norm.split(" ") : [];
  if (!palabras.length) return vacio;
  const hits = new Set();
  let total = 0;
  for (const w of palabras) {
    const t = consulta.tokens.find(t => coincide(w, t));
    if (t) { hits.add(t); total++; }
  }
  const padded = ` ${norm} `;
  const frases = consulta.frases.filter(f => padded.includes(` ${f} `)).length;
  return {
    coincidencias: total,
    cobertura: consulta.tokens.length ? hits.size / consulta.tokens.length : 0,   // qué parte de lo pedido aparece
    densidad: (total / palabras.length) * 100,                                    // coincidencias por cada 100 palabras
    frases, hits: [...hits]
  };
}

// Bonus 0..(maxBonus + 2·bonusFrase) en la escala 0-100. Más cobertura y densidad suben más; una frase exacta suma extra.
export function bonus(r, { maxBonus = 30, bonusFrase = 8 } = {}) {
  if (!r.coincidencias && !r.frases) return 0;
  const b = maxBonus * (0.7 * r.cobertura + 0.3 * Math.min(1, r.densidad / 6)) + Math.min(2, r.frases) * bonusFrase;
  return Math.round(Math.min(maxBonus + 2 * bonusFrase, b));
}

// Aplica la instrucción a una lista de segmentos SIN cambiar su forma: solo sube `puntaje` (y añade campos informativos).
// Sin instrucción devuelve copias idénticas. Los accesores permiten adaptarlo al formato de curador.js;
// `tope` es el máximo de la escala de puntaje (100 por defecto; usa 1 si tu puntaje va de 0 a 1).
export function priorizar(segmentos, instruccion, {
  texto = s => s.texto ?? s.transcripcion ?? s.text ?? "",
  puntaje = s => s.puntaje ?? s.score ?? 0,
  tope = 100, maxBonus, bonusFrase, ordenar = false
} = {}) {
  const consulta = typeof instruccion === "string" ? parsear(instruccion) : instruccion;
  const lista = Array.isArray(segmentos) ? segmentos : [];
  if (!consulta) return lista.map(s => ({ ...s }));
  const escala = tope / 100;
  const out = lista.map(s => {
    const base = Number(puntaje(s)) || 0;
    const r = puntuarTexto(texto(s), consulta);
    const b = bonus(r, { maxBonus, bonusFrase }) * escala;
    return { ...s, puntaje_base: base, puntaje: Math.min(tope, base + b), bonus_instruccion: b, coincide: b > 0, coincidencias: r.hits };
  });
  return ordenar ? out.sort((a, b) => b.puntaje - a.puntaje) : out;
}
