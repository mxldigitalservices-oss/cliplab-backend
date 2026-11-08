// Director de contenido: Gemini con rotación de llaves y enfriamiento ante 429.
import { cfg } from "./config.js";

const frio = new Map();
let giro = 0;
const dormir = ms => new Promise(r => setTimeout(r, ms));

function elegir() {
  const ahora = Date.now(), n = cfg.geminiKeys.length;
  for (let i = 0; i < n; i++) {
    const k = cfg.geminiKeys[(giro + i) % n];
    if ((frio.get(k) || 0) <= ahora) { giro = (giro + i + 1) % n; return k; }
  }
  return null;
}

async function llamar(cuerpo) {
  if (!cfg.geminiKeys.length) throw new Error("Faltan GEMINI_API_KEYS (o GEMINI_API_KEY).");
  let ultimo = "";
  for (let intento = 0; intento < cfg.geminiKeys.length * 2 + 2; intento++) {
    const k = elegir();
    if (!k) {
      const libre = Math.min(...cfg.geminiKeys.map(x => frio.get(x) || 0)) - Date.now();
      await dormir(Math.min(20000, Math.max(1000, libre)));
      continue;
    }
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiModel}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": k },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(300000)
    });
    if (r.ok) return r.json();
    ultimo = `Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`;
    if (r.status === 429 || r.status >= 500) { frio.set(k, Date.now() + (r.status === 429 ? 60000 : 15000)); continue; }
    if (r.status === 401 || r.status === 403) { frio.set(k, Date.now() + 3600000); continue; }
    throw new Error(ultimo);
  }
  throw new Error(ultimo || "Gemini no respondió.");
}

const prompt = () => `Eres director de contenido para formatos verticales (TikTok, Reels, Shorts).
Analiza el video completo y devuelve los ${cfg.maxClips} mejores clips, de ${cfg.clipMin} a ${cfg.clipMax} segundos cada uno.
Reglas:
1. Cada clip es una idea completa, empieza justo en su gancho y no se solapa con otro.
2. Usa tiempos reales del video en formato M:SS o H:MM:SS. Nunca inventes tiempos.
3. "titulo": magnético, máximo 70 caracteres, sin emojis. "gancho": la frase más fuerte del clip. "descripcion": 1 o 2 frases (máx. 200 caracteres) para redes. "cta": una llamada a la acción corta. "hashtags": de 3 a 5, cada uno con #.
4. "angulo": Polémica, Valor o Emoción. "categoria": una o dos palabras. "puntaje_viral": de 1 a 100.
Responde solo con el arreglo JSON.`;

const S = { type: "STRING" };
const schema = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      titulo: S, gancho: S, descripcion: S, cta: S,
      hashtags: { type: "ARRAY", items: S },
      inicio: S, fin: S, categoria: S,
      angulo: { type: "STRING", enum: ["Polémica", "Valor", "Emoción"] },
      puntaje_viral: { type: "INTEGER" }
    },
    required: ["titulo", "gancho", "descripcion", "cta", "hashtags", "inicio", "fin", "categoria", "angulo", "puntaje_viral"]
  }
};

export const toSec = t => {
  const p = String(t).trim().split(":").map(Number);
  return p.length < 2 || p.length > 3 || p.some(n => !Number.isFinite(n) || n < 0) ? NaN : p.reduce((a, v) => a * 60 + v, 0);
};

const limpiarTag = t => "#" + String(t).replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
const tags = h => [...new Set((Array.isArray(h) ? h : []).map(limpiarTag).filter(t => t.length > 1))].slice(0, 6);

export function validar(raw) {
  const L = (Array.isArray(raw) ? raw : [])
    .map(c => ({ ...c, i: toSec(c.inicio), f: toSec(c.fin) }))
    .filter(c => c.titulo && Number.isFinite(c.i) && Number.isFinite(c.f) && c.f - c.i >= cfg.clipMin - 3 && c.f - c.i <= cfg.clipMax + 10)
    .sort((a, b) => (b.puntaje_viral || 0) - (a.puntaje_viral || 0));
  const out = [];
  for (const c of L) {
    if (out.some(o => c.i < o.f && c.f > o.i)) continue;
    out.push(c);
    if (out.length >= cfg.maxClips) break;
  }
  return out.map(c => ({
    titulo: String(c.titulo).slice(0, 100),
    gancho: String(c.gancho || "").slice(0, 300),
    descripcion: String(c.descripcion || "").slice(0, 400),
    cta: String(c.cta || "").slice(0, 150),
    hashtags: tags(c.hashtags),
    inicio_seg: c.i, fin_seg: c.f,
    categoria: String(c.categoria || "").slice(0, 40),
    angulo: c.angulo || "",
    puntaje: Math.min(100, Math.max(1, Math.round(c.puntaje_viral) || 1))
  }));
}

export async function analizar(url) {
  const j = await llamar({
    contents: [{ parts: [{ fileData: { fileUri: url } }, { text: prompt() }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.4 }
  });
  const txt = j.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!txt) throw new Error("Gemini no devolvió contenido (¿video privado o no disponible?).");
  const clips = validar(JSON.parse(txt));
  if (!clips.length) throw new Error("La IA no devolvió clips válidos. Prueba con otro video.");
  return clips;
}
