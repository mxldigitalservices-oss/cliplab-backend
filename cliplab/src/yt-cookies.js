// YouTube bloquea a yt-dlp desde IPs de servidor ("Sign in to confirm you're not a bot"). Con cookies de una
// sesión de YouTube suele resolverse. La variable YT_COOKIES_B64 trae el cookies.txt (formato Netscape) en base64;
// aquí se escribe a un archivo privado y se apunta cfg.ytCookies, que ya leen video.js y transcripcion.js
// en cada llamada. Los valores nunca se registran.
import fs from "node:fs";
import { cfg } from "./config.js";

export function prepararCookiesYoutube() {
  const b64 = (process.env.YT_COOKIES_B64 || "").trim();
  if (!b64) return false;
  const texto = Buffer.from(b64, "base64").toString("utf8");
  const lineas = texto.split("\n").filter(l => l && !l.startsWith("#"));
  if (!lineas.length || !lineas.some(l => l.includes("\t") && /youtube\.com|google\.com/.test(l))) {
    console.error("YouTube: YT_COOKIES_B64 no parece un cookies.txt válido (formato Netscape, con cookies de youtube.com).");
    return false;
  }
  const ruta = process.env.YT_COOKIES_ARCHIVO || "/tmp/yt-cookies.txt";
  fs.writeFileSync(ruta, texto, { mode: 0o600 });   // yt-dlp reescribe este archivo al renovar cookies: debe ser escribible
  cfg.ytCookies = ruta;
  console.log(`YouTube: cookies cargadas (${lineas.length} entradas)`);
  return true;
}
