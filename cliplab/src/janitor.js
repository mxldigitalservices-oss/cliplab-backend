// Purga: TTL + tope de disco. Nunca toca clips que se están cortando o publicando.
import fs from "node:fs/promises";
import { q } from "./db.js";
import { cfg } from "./config.js";

async function archivos() {
  const out = [];
  for (const n of await fs.readdir(cfg.clipsDir).catch(() => [])) {
    const p = `${cfg.clipsDir}/${n}`;
    const st = await fs.stat(p).catch(() => null);
    if (st?.isFile()) out.push({ n, p, st });
  }
  return out;
}

export async function usoDiscoMb() {
  return Math.round((await archivos()).reduce((a, f) => a + f.st.size, 0) / 1048576);
}

export async function borrarArchivoClip(id, estadoFinal = "expirado") {
  const { rows: [c] } = await q("SELECT archivo FROM clips WHERE id=$1", [id]);
  if (c?.archivo) await fs.unlink(c.archivo).catch(() => {});
  await q("UPDATE clips SET archivo = NULL, estado = CASE WHEN estado IN ('publicado') THEN estado ELSE $2 END WHERE id = $1", [id, estadoFinal]);
}

export async function limpiar() {
  const lista = await archivos();
  const { rows } = await q("SELECT token FROM clips WHERE estado IN ('cortando', 'publicando')");
  const ocupados = rows.map(r => r.token);
  const ahora = Date.now(), ttl = cfg.ttlHoras * 3600e3;
  let total = lista.reduce((a, f) => a + f.st.size, 0);
  lista.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
  for (const f of lista) {
    if (ocupados.some(t => f.n.includes(t))) continue;
    const viejo = ahora - f.st.mtimeMs > ttl;
    const resto = f.n.startsWith("raw-") && ahora - f.st.mtimeMs > 3600e3;
    const lleno = total > cfg.maxDiscoMb * 1048576;
    if (!(viejo || resto || lleno)) continue;
    await fs.unlink(f.p).catch(() => {});
    total -= f.st.size;
    await q("UPDATE clips SET archivo = NULL, estado = 'expirado' WHERE archivo = $1 AND estado IN ('listo', 'error')", [f.p]);
  }
}
