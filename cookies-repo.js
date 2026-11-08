import fs from "node:fs";
import path from "node:path";

export function cargarCookiesPlataforma(plataforma) {
  const envVarMap = {
    tiktok: "TIKTOK_COOKIES_B64",
    instagram: "INSTAGRAM_COOKIES_B64",
    facebook: "FACEBOOK_COOKIES_B64",
    cliplab: "YT_COOKIES_B64"
  };

  const envKey = envVarMap[plataforma];
  const b64 = envKey ? (process.env[envKey] || "").trim() : "";

  const rutaTmp = path.resolve(`/tmp/${plataforma}-cookies.txt`);

  if (b64) {
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      fs.writeFileSync(rutaTmp, decoded, { mode: 0o600 });
      return { valida: true, ruta: rutaTmp };
    } catch (err) {
      console.error(`Error decodificando cookies para ${plataforma}:`, err.message);
    }
  }

  // Fallback si existe el archivo local en JSON o texto
  const rutaJson = path.resolve(`cookies/${plataforma}.json`);
  if (fs.existsSync(rutaJson)) {
    return { valida: true, ruta: rutaJson };
  }

  return { valida: false, ruta: null };
}

export function verificarTodasLasCookies() {
  const plataformas = ["tiktok", "instagram", "facebook"];
  let estados = {};
  for (const p of plataformas) {
    const res = cargarCookiesPlataforma(p);
    estados[p] = res.valida ? "valida" : "invalida";
  }
  console.log(`Cookies: tiktok=${estados.tiktok} instagram=${estados.instagram} facebook=${estados.facebook}`);
  return estados;
}
