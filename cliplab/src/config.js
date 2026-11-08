const num = (k, d) => {
  const raw = process.env[k];
  if (raw === undefined || raw === "") return d;
  const v = Number(raw);
  return Number.isFinite(v) ? v : d;
};
const llave = k => String(process.env[k] || "").trim();

export const cfg = {
  port: num("PORT", 3000),
  dbUrl: process.env.DATABASE_URL,
  dbSsl: process.env.PGSSL === "1",
  masterKey: process.env.MASTER_KEY || process.env.API_KEY || "",
  sessionKey: process.env.SESSION_KEY || "",
  // Cada rol tiene su propia llave y su propio enfriamiento (ver gemini.js).
  geminiKeys: {
    copy: llave("GEMINI_API_KEY_1"),       // Copywriting y títulos de alto impacto
    auditoria: llave("GEMINI_API_KEY_2"),  // Auditoría y validación ortográfica
    analisis: llave("GEMINI_API_KEY_3"),   // Análisis de transcripciones y extracción de fragmentos
    respaldo: llave("GEMINI_API_KEY_4")    // Respaldo y verificación cruzada
  },
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.5-flash",
  clipsDir: process.env.CLIPS_DIR || "/tmp/clips",
  dataDir: process.env.DATA_DIR || "/tmp/cliplab-data",
  ttlHoras: num("TTL_HORAS", 48),
  maxDiscoMb: num("MAX_DISK_MB", 1500),
  maxClips: num("MAX_CLIPS", 8),
  clipMin: num("CLIP_MIN_SEG", 15),
  clipMax: num("CLIP_MAX_SEG", 90),
  reencuadre: process.env.REENCUADRE === "crop" ? "crop" : "blur",
  crf: num("CRF", 23),
  // Marca de agua (coordenadas fijas sobre el lienzo 720x1280; se validan contra las zonas de la interfaz)
  logoPath: process.env.LOGO_PATH || "",
  logoAncho: num("LOGO_ANCHO", 130),
  logoX: num("LOGO_X", 36),
  logoY: num("LOGO_Y", 150),
  logoOpacidad: Math.min(1, Math.max(0.1, num("LOGO_OPACIDAD", 0.9))),
  // Subtítulos dinámicos (ASS)
  subtitulos: process.env.SUBTITULOS !== "0",
  subMaxPalabras: num("SUB_MAX_PALABRAS", 3),
  subMargenV: num("SUB_MARGEN_V", 360),
  subTamano: num("SUB_TAMANO", 64),
  subIdiomas: process.env.SUB_IDIOMAS || "es-orig,en-orig,es,en",
  fontsDir: process.env.FONTS_DIR || "/usr/share/fonts/truetype/dejavu",
  // Janitor
  borrarAlPublicar: process.env.BORRAR_AL_PUBLICAR !== "0",
  ffmpegThreads: num("FFMPEG_THREADS", 2),
  ffmpegTimeoutMs: num("FFMPEG_TIMEOUT_MS", 600000),
  ytCookies: process.env.YT_COOKIES || "",
  publicarReal: process.env.PUBLICAR_REAL === "1",
  headless: process.env.HEADLESS !== "0",
  proxy: process.env.PROXY_URL || "",
  uploadTimeoutMs: num("UPLOAD_TIMEOUT_MS", 600000),
  typeMin: num("TYPE_MIN_MS", 50),
  typeMax: num("TYPE_MAX_MS", 180),
  captionMax: num("CAPTION_MAX", 600),
  pausaPlataformasS: [num("PAUSA_MIN_S", 20), num("PAUSA_MAX_S", 60)],
  maxPubDia: num("MAX_PUB_DIA", 10),
  fbReelsUrl: process.env.FB_REELS_URL || "https://www.facebook.com/reels/create"
};
