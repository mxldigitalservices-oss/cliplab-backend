// YouTube bloquea a yt-dlp desde IPs de servidor ("Sign in to confirm you're not a bot").
// Usar cookies de sesión de YouTube suele resolverse. La variable YT_COOKIES_B64 trae el cookie en Base64.
// Aquí se decodifica y se escribe a un archivo privado que lee yt-dlp.
import fs from "node:fs";
import { cfg } from "./config.js";

export function prepararCookiesYoutube() {
  const b64 = (process.env.YT_COOKIES_B64 || "").trim();
  if (!b64) {
    console.log("YouTube: YT_COOKIES_B64 no está configurada.");
    return false;
  }
  
  try {
    const texto = Buffer.from(b64, "base64").toString("utf8");
    const ruta = process.env.YT_COOKIES_ARCHIVO || "/tmp/yt-cookies.txt";
    fs.writeFileSync(ruta, texto, { mode: 0o600 });
    cfg.ytCookies = ruta;
    console.log("YouTube: cookies decodificadas y cargadas correctamente desde YT_COOKIES_B64.");
    return true;
  } catch (err) {
    console.error("YouTube: Error al procesar YT_COOKIES_B64:", err.message);
    return false;
  }
}
