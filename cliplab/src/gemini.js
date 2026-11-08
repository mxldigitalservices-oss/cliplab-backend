// Gestor multillave de Gemini: cada rol usa su propia llave, con enfriamiento independiente
// y relevo automático hacia la llave de respaldo (GEMINI_API_KEY_4).
import { cfg } from "./config.js";
import { q } from "./db.js";

export const ROL = Object.freeze({
  COPY: "copy",            // GEMINI_API_KEY_1
  AUDITORIA: "auditoria",  // GEMINI_API_KEY_2
  ANALISIS: "analisis",    // GEMINI_API_KEY_3
  RESPALDO: "respaldo"     // GEMINI_API_KEY_4
});
const VARIABLE = { copy: "GEMINI_API_KEY_1", auditoria: "GEMINI_API_KEY_2", analisis: "GEMINI_API_KEY_3", respaldo: "GEMINI_API_KEY_4" };

const dormir = ms => new Promise(r => setTimeout(r, ms));
const estado = Object.fromEntries(Object.values(ROL).map(r => [r, { frioHasta: 0, usos: 0, fallos: 0 }]));
const llaveDe = rol => cfg.geminiKeys[rol] || "";

// Orden de intento: la llave propia del rol y, si falla o está en enfriamiento, la de respaldo.
export const cadena = rol => {
  if (!estado[rol]) throw new Error(`Rol Gemini desconocido: ${rol}`);
  return [...new Set([rol, ROL.RESPALDO])].filter(r => llaveDe(r));
};

// Diagnóstico seguro: nunca expone el valor de las llaves.
export const estadoLlaves = () => Object.values(ROL).map(rol => ({
  rol, variable: VARIABLE[rol], configurada: !!llaveDe(rol), modelo: cfg.geminiModel,
  enfriamientoSeg: Math.max(0, Math.ceil((estado[rol].frioHasta - Date.now()) / 1000)),
  usos: estado[rol].usos, fallos: estado[rol].fallos
}));

// Registro de uso en PostgreSQL (mejor esfuerzo: si la base falla, no se interrumpe la IA).
let registrar = (rol, http, ms, error) =>
  q("INSERT INTO gemini_uso(rol, modelo, http, ms, error) VALUES($1,$2,$3,$4,$5)", [rol, cfg.geminiModel, http, ms, error ? String(error).slice(0, 300) : null])
    .catch(e => console.error("gemini_uso:", e.message));
export const _test = { fijarRegistro: fn => { registrar = fn; }, reiniciar: () => { for (const e of Object.values(estado)) Object.assign(e, { frioHasta: 0, usos: 0, fallos: 0 }); } };

// Gemini 3.8: los parámetros de muestreo están obsoletos. Se quitan aquí, en un solo punto, para que ningún
// llamador (gemini.js, transcripcion.js, vivo.js…) los envíe aunque los declare.
const SIN_MUESTREO = ["temperature", "topP", "topK", "candidateCount"];
const limpiarCuerpo = c => {
  if (!c?.generationConfig) return c;
  const g = { ...c.generationConfig };
  for (const k of SIN_MUESTREO) delete g[k];
  return { ...c, generationConfig: g };
};

const enfriar = (rol, ms) => { estado[rol].frioHasta = Date.now() + ms; estado[rol].fallos++; };
const retryAfterMs = (r, porDefecto) => {
  const v = Number(r.headers?.get?.("retry-after"));
  return Number.isFinite(v) && v > 0 ? Math.min(v * 1000, 600000) : porDefecto;
};

// Llama a Gemini con la llave del rol. Devuelve { data, rol } (rol = llave que respondió).
export async function generar(rol, cuerpo, { timeoutMs = 300000 } = {}) {
  const orden = cadena(rol);
  if (!orden.length) throw new Error(`Falta ${VARIABLE[rol]} (y GEMINI_API_KEY_4 de respaldo) en las variables del servidor.`);
  let ultimo = "";
  for (let intento = 0; intento < orden.length * 3 + 2; intento++) {
    const ahora = Date.now();
    const usable = orden.find(r => estado[r].frioHasta <= ahora);
    if (!usable) {
      const libre = Math.min(...orden.map(r => estado[r].frioHasta)) - ahora;
      await dormir(Math.min(20000, Math.max(1000, libre)));
      continue;
    }
    const t0 = Date.now();
    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiModel}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": llaveDe(usable) },
        body: JSON.stringify(limpiarCuerpo(cuerpo)),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {   // red caída o tiempo agotado: se enfría esa llave un momento y se relevan
      ultimo = `Gemini sin respuesta (${e.name}): ${e.message}`;
      enfriar(usable, 10000);
      registrar(usable, null, Date.now() - t0, ultimo);
      continue;
    }
    const ms = Date.now() - t0;
    if (r.ok) {
      estado[usable].usos++;
      registrar(usable, r.status, ms, null);
      return { data: await r.json(), rol: usable };
    }
    ultimo = `Gemini ${r.status} [${usable}]: ${(await r.text().catch(() => "")).slice(0, 200)}`;
    registrar(usable, r.status, ms, ultimo);
    if (r.status === 429) { enfriar(usable, retryAfterMs(r, 60000)); continue; }
    if (r.status >= 500) { enfriar(usable, 15000); continue; }
    if (r.status === 401 || r.status === 403) { enfriar(usable, 3600000); continue; }
    if (r.status === 404) throw new Error(`Modelo "${cfg.geminiModel}" no encontrado (404). Revisa GEMINI_MODEL. ${ultimo}`);
    throw new Error(ultimo);   // 400 y demás: error de la petición, otra llave no lo arregla
  }
  throw new Error(ultimo || "Gemini no respondió.");
}

// Atajo: texto o JSON a partir de un prompt simple (para copywriting, auditoría, etc.).
export async function generarTexto(rol, prompt, { json = false, schema, temperature = 0.4 } = {}) {
  const { data, rol: usado } = await generar(rol, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature, ...(json ? { responseMimeType: "application/json", ...(schema ? { responseSchema: schema } : {}) } : {}) }
  });
  const texto = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  if (!texto) throw new Error("Gemini no devolvió contenido.");
  return { texto, rol: usado };
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
export const tags = h => [...new Set((Array.isArray(h) ? h : []).map(limpiarTag).filter(t => t.length > 1))].slice(0, 6);

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
  const { data: j } = await generar(ROL.ANALISIS, {
    contents: [{ parts: [{ fileData: { fileUri: url } }, { text: prompt() }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.4 }
  });
  const txt = j.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!txt) throw new Error("Gemini no devolvió contenido (¿video privado o no disponible?).");
  const clips = validar(JSON.parse(txt));
  if (!clips.length) throw new Error("La IA no devolvió clips válidos. Prueba con otro video.");
  return clips;
}
