import pg from "pg";
import fs from "node:fs";
import { cfg } from "./config.js";

// SSL solo si PGSSL=1 (URL pública de Railway). La red interna de Railway no lo necesita.
export const db = new pg.Pool({
  connectionString: cfg.dbUrl,
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  ...(cfg.dbSsl ? { ssl: { rejectUnauthorized: false } } : {})
});
db.on("error", e => console.error("pg:", e.message));
export const q = (texto, params) => db.query(texto, params);

export async function pingDb() {
  await db.query("SELECT 1");
  return true;
}

export async function iniciarDb() {
  if (!cfg.dbUrl) throw new Error("Falta DATABASE_URL: referencia el Postgres de Railway (${{Postgres.DATABASE_URL}}).");
  await db.query(fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
}
