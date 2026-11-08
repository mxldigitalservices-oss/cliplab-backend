import pg from "pg";
import fs from "node:fs";
import { cfg } from "./config.js";

// SSL solo si PGSSL=1 (URL pública de Railway). La red interna de Railway no lo necesita.
export const db = new pg.Pool({
  connectionString: cfg.dbUrl,
  max: cfg.dbPoolMax,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  ...(cfg.dbSsl ? { ssl: { rejectUnauthorized: false } } : {})
});
db.on("error", e => console.error("pg:", e.message));
export const q = (texto, params) => db.query(texto, params);

// Transacción: BEGIN/COMMIT con ROLLBACK ante cualquier error. fn recibe el cliente (client.query).
export async function tx(fn) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function pingDb() {
  await db.query("SELECT 1");
  return true;
}

export async function iniciarDb() {
  if (!cfg.dbUrl) throw new Error("Falta DATABASE_URL: referencia el Postgres de Railway (${{Postgres.DATABASE_URL}}).");
  await db.query(fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
}
