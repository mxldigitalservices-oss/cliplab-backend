const num = (k, d) => {
  const raw = process.env[k];
  if (raw === undefined || raw === "") return d;
  const v = Number(raw);
  return Number.isFinite(v) ? v : d;
};
const lista = s => String(s || "").split(",").map(x => x.trim()).filter(Boolean);

export const cfg = {
  port: num("PORT", 3000),
  dbUrl: process.env.DATABASE_URL,
  masterKey: process.env.MASTER_KEY || process.env.API_KEY || "",
  sessionKey: process.env.SESSION_KEY || "",
  geminiKeys: lista(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY),
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  clipsDir: process.env.CLIPS_DIR || "/tmp/clips",
  dataDir: process.env.DATA_DIR || "/tmp/cliplab-data",
  ttlHoras: num("TTL_HORAS", 48),
  maxDiscoMb: num("MAX_DISK_MB", 1500),
  maxClips: num("MAX_CLIPS", 8),
  clipMin: num("CLIP_MIN_SEG", 15),
  clipMax: num("CLIP_MAX_SEG", 90),
  reencuadre: process.env.REENCUADRE === "crop" ? "crop" : "blur",
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
