// Janitor: el video pesado vive en disco solo mientras hace falta. En PostgreSQL quedan únicamente
// los metadatos ligeros (títulos, tiempos, publicaciones, tamaño, duración, banderas).
import fs from "node:fs/promises";
import { q } from "./db.js";
import { cfg } from "./config.js";

const OCUPADOS = ["cortando", "publicando"];
const GRACIA_CLIP_MS = 10 * 60e3;   // un clip sin registro en la base puede estar naciendo: se espera antes de tocarlo
const TEMPORAL_MS = 30 * 60e3;
const TOKEN = /(?:clip|raw|sub)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

async function listar() {
  const archivos = [], dirs = [];
  for (const n of await fs.readdir(cfg.clipsDir).catch(() => [])) {
    const p = `${cfg.clipsDir}/${n}`;
    const st = await fs.stat(p).catch(() => null);
    if (st?.isFile()) archivos.push({ n, p, st });
    else if (st?.isDirectory() && n.startsWith("tr-")) dirs.push({ n, p, st });
  }
  return { archivos, dirs };
}

export async function usoDiscoMb() {
  return Math.round((await listar()).archivos.reduce((a, f) => a + f.st.size, 0) / 1048576);
}

// Borra el archivo del clip y deja constancia. Devuelve false (sin tocar nada) si el clip está en uso.
export async function borrarArchivoClip(id, estadoFinal = "expirado", { consulta = q } = {}) {
  const { rows: [c] } = await consulta("SELECT archivo, estado FROM clips WHERE id=$1", [id]);
  if (!c) return false;
  if (OCUPADOS.includes(c.estado)) return false;
  if (c.archivo) await fs.unlink(c.archivo).catch(() => {});
  await consulta(
    `UPDATE clips SET archivo = NULL, archivo_borrado_en = now(),
       estado = CASE WHEN estado = 'publicado' THEN estado ELSE $2 END WHERE id = $1`, [id, estadoFinal]);
  return true;
}

// Función pura: ¿por qué hay que borrar este archivo? (null = conservarlo)
export function decidir(f, { ahora, ttlMs, ocupados, refs, lleno }) {
  const edad = ahora - f.st.mtimeMs;
  const token = TOKEN.exec(f.n)?.[1];
  if (token && ocupados.has(token)) return null;
  if (!/^clip-.*\.mp4$/.test(f.n)) return edad > TEMPORAL_MS ? "temporal" : null;   // raw-*, sub-*.ass, restos
  const estado = refs.get(f.p);
  if (estado === undefined) return edad > GRACIA_CLIP_MS ? "huérfano" : null;      // sin registro en la base
  if (estado === "publicado") return "publicado";                                  // ya salió: el disco no lo necesita
  if (edad > ttlMs) return "ttl";
  if (lleno) return "disco";
  return null;
}

export async function limpiar({ consulta = q } = {}) {
  const { archivos, dirs } = await listar();
  const { rows } = await consulta("SELECT token::text AS token, archivo, estado FROM clips WHERE archivo IS NOT NULL OR estado IN ('cortando','publicando')");
  const ocupados = new Set(rows.filter(r => OCUPADOS.includes(r.estado)).map(r => r.token));
  const refs = new Map(rows.filter(r => r.archivo).map(r => [r.archivo, r.estado]));
  const ahora = Date.now(), ttlMs = cfg.ttlHoras * 3600e3;
  let total = archivos.reduce((a, f) => a + f.st.size, 0);
  let borrados = 0, liberado = 0;

  for (const f of archivos.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs)) {
    const razon = decidir(f, { ahora, ttlMs, ocupados, refs, lleno: total > cfg.maxDiscoMb * 1048576 });
    if (!razon) continue;
    await fs.unlink(f.p).catch(() => {});
    total -= f.st.size; liberado += f.st.size; borrados++;
    if (refs.has(f.p)) {
      await consulta(
        `UPDATE clips SET archivo = NULL, archivo_borrado_en = now(), estado = CASE WHEN estado = 'publicado' THEN estado ELSE 'expirado' END
         WHERE archivo = $1 AND estado NOT IN ('cortando','publicando')`, [f.p]);
    }
  }
  for (const d of dirs) {   // carpetas temporales de transcripción que quedaron por un cierre brusco
    if (ahora - d.st.mtimeMs > TEMPORAL_MS) { await fs.rm(d.p, { recursive: true, force: true }).catch(() => {}); borrados++; }
  }
  return { borrados, liberadoMb: Math.round(liberado / 1048576) };
}
