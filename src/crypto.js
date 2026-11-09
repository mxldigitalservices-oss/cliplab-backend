import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { cfg } from "./config.js";

let K = null;
const clave = () => (K ||= scryptSync(cfg.sessionKey || cfg.masterKey, "cliplab/sesiones/v2", 32));

export function cifrar(texto) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", clave(), iv);
  const d = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), d]).toString("base64");
}

export function descifrar(b64) {
  const b = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-256-gcm", clave(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}
