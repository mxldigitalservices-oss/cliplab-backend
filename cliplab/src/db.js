import pg from "pg";
import fs from "node:fs";
import { cfg } from "./config.js";

export const db = new pg.Pool({ connectionString: cfg.dbUrl, max: 5 });
db.on("error", e => console.error("pg:", e.message));
export const q = (texto, params) => db.query(texto, params);

export async function iniciarDb() {
  await db.query(fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
}
