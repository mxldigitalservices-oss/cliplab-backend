const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const PROMPT = `Eres director de contenido para formatos verticales (Shorts, Reels, TikTok).
Analiza el video completo y extrae entre 6 y 9 clips de 20 a 90 segundos, repartidos en tres ángulos:
- "Polémica": debates, opiniones fuertes, contradicciones.
- "Valor": aprendizaje práctico, pasos, datos útiles.
- "Emoción": historias humanas y momentos emotivos.
Reglas:
1. Cada clip es una idea completa y ningún clip se solapa con otro.
2. "gancho" es la frase más fuerte o reveladora del clip y debe sonar dentro de sus primeros 3 segundos; si no, mueve timestamp_inicio hasta ese punto.
3. Usa tiempos reales del video en formato M:SS o H:MM:SS. No inventes tiempos.
4. puntaje_viral (1-100) es tu estimación de retención y emoción.
5. Si una idea queda abierta o deja una duda fuerte antes de cerrarse, divídela en dos clips: el primero con es_parte=1 y el segundo con es_parte=2, ambos con el mismo valor en "serie". Los demás llevan es_parte=0 y serie vacía.
Responde solo con el arreglo JSON.`;

const S = { type: "STRING" }, I = { type: "INTEGER" };
const schema = { type: "ARRAY", items: { type: "OBJECT",
  properties: { clip_titulo: S, gancho: S, timestamp_inicio: S, timestamp_fin: S, puntaje_viral: I, categoria: S,
    angulo: { type: "STRING", enum: ["Polémica", "Valor", "Emoción"] }, es_parte: I, serie: S },
  required: ["clip_titulo", "gancho", "timestamp_inicio", "timestamp_fin", "puntaje_viral", "categoria", "angulo", "es_parte", "serie"] } };

export const toSec = t => {
  const p = String(t).trim().split(":").map(Number);
  return p.length < 2 || p.length > 3 || p.some(n => !Number.isFinite(n) || n < 0) ? NaN : p.reduce((a, v) => a * 60 + v, 0);
};

export function validar(raw) {
  const L = (Array.isArray(raw) ? raw : []).map(c => ({ ...c, i: toSec(c.timestamp_inicio), f: toSec(c.timestamp_fin) }))
    .filter(c => c.clip_titulo && Number.isFinite(c.i) && Number.isFinite(c.f) && c.f - c.i >= 10 && c.f - c.i <= 120);
  const series = {};
  L.forEach(c => { if (c.serie && [1, 2].includes(c.es_parte)) (series[c.serie] ||= {})[c.es_parte] = c; });
  L.forEach(c => {
    const s = series[c.serie];
    if (!(c.serie && s?.[1] && s?.[2] && s[2].i >= s[1].f - 1)) { c.es_parte = 0; c.serie = ""; }
  });
  return L.map(c => ({
    clip_titulo: String(c.clip_titulo).slice(0, 120), gancho: String(c.gancho || "").slice(0, 300),
    timestamp_inicio: c.timestamp_inicio, timestamp_fin: c.timestamp_fin,
    puntaje_viral: Math.min(100, Math.max(1, Math.round(c.puntaje_viral) || 1)),
    categoria: c.categoria || "", angulo: c.angulo || "", es_parte: c.es_parte || 0, serie: c.serie || ""
  })).sort((a, b) => b.puntaje_viral - a.puntaje_viral);
}

export async function analizar(url) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ fileData: { fileUri: url } }, { text: PROMPT }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.4 }
    })
  });
  if (!r.ok) throw new Error("Gemini " + r.status + ": " + (await r.text()).slice(0, 300));
  const j = await r.json();
  return validar(JSON.parse(j.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]"));
}
