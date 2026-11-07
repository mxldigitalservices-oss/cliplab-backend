const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const PROMPT = `Eres director de contenido para formatos verticales. Analiza el video y extrae clips. Responde solo con JSON.`;
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
