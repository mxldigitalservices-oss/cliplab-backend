// Subida de video local (multipart/form-data) → disco por streaming → validación real del contenido → req.archivoLocal.
// Requiere:  npm i multer
//
// Uso en la ruta:
//   router.post("/panel/encolar", subidaOpcional(), h(async (req, res) => {
//     const origen = origenDeEncolar(req);        // { tipo: "archivo", ruta, duracion, ... } | { tipo: "url", url }
//     ...                                         // el pipeline usa origen.ruta y se salta yt-dlp
//   }));
// Si la petición no es multipart (JSON con url), el middleware no hace nada y el flujo de siempre sigue igual.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import os from "node:os";
import multer from "multer";
import { logger } from "./utils/logger.js";

const num = (k, d) => { const r = process.env[k]; const v = Number(r); return r === undefined || r === "" || !Number.isFinite(v) ? d : v; };

export const EXTENSIONES = Object.freeze([".mp4", ".mov", ".mkv", ".webm"]);
// Fuera de DATA_DIR/clips: el janitor borra a los 30 min cualquier archivo "temporal" de la carpeta de clips, y un video
// subido puede esperar en cola mucho más que eso.
// Carpeta de subidas con respaldo. Orden: UPLOADS_DIR (o DATA_DIR/uploads) → TMP_DIR/uploads → <tmp del sistema>/cliplab-uploads.
// Un candidato solo vale si se puede crear Y escribir en él (en Railway /data puede llegar sin permisos o sin montar: EACCES/EROFS/ENOENT).
// Nunca lanza: si falla el principal se usa el siguiente con una advertencia; el arranque del servidor no depende de esto.
const candidatosUploads = () => {
  const principal = path.resolve(process.env.UPLOADS_DIR || path.join(process.env.DATA_DIR || path.join(os.tmpdir(), "cliplab-data"), "uploads"));
  const lista = [principal];
  if (process.env.TMP_DIR) lista.push(path.resolve(process.env.TMP_DIR, "uploads"));
  lista.push(path.resolve(os.tmpdir(), "cliplab-uploads"));
  return [...new Set(lista)];
};

function probarEscritura(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const marca = path.join(dir, `.prueba-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    fs.writeFileSync(marca, "ok", { flag: "wx" });
    fs.unlinkSync(marca);
    return null;
  } catch (e) { return e; }
}

let memoUploads = null;   // { clave, dir, avisado } — se resuelve una vez para que todas las rutas (guardar, borrar, purgar) coincidan
function resolverUploads() {
  const lista = candidatosUploads();
  if (memoUploads?.dir && memoUploads.clave === lista[0]) return memoUploads.dir;
  const yaAvisado = memoUploads?.clave === lista[0] && memoUploads.avisado;
  for (const dir of lista) {
    const error = probarEscritura(dir);
    if (!error) {
      memoUploads = { clave: lista[0], dir, avisado: true };
      if (dir !== lista[0]) logger.warn("Carpeta de subidas no disponible: se usa una carpeta temporal de respaldo (los videos subidos pendientes se pierden al reiniciar)", { configurada: lista[0], respaldo: dir });
      return dir;
    }
    if (!yaAvisado) logger.warn("No se puede escribir en la carpeta de subidas", { dir, codigo: error.code, mensaje: error.message });
  }
  memoUploads = { clave: lista[0], dir: null, avisado: true };
  if (!yaAvisado) logger.error("Ninguna carpeta de subidas es escribible: las subidas de archivo responderan 503 (los enlaces siguen funcionando)", { candidatos: lista });
  return null;
}

export const dirUploads = () => resolverUploads() ?? candidatosUploads()[0];
export const uploadsDisponible = () => resolverUploads() !== null;
const maxBytes = () => Math.round(num("MAX_UPLOAD_MB", 1024) * 1048576);
const maxMinutos = () => num("MAX_UPLOAD_MIN", 240);

export class ErrorSubida extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; }   // el manejador de errores de Express ya respeta e.status
}

const dentroDeUploads = ruta => { const r = path.resolve(String(ruta || "")); return candidatosUploads().some(d => r.startsWith(d + path.sep)) ? r : null; };
export const borrarUpload = async ruta => { const r = dentroDeUploads(ruta); if (r) await fsp.unlink(r).catch(() => {}); };   // nunca borra fuera de uploads/

// ---------- Validación real del contenido (no se confía en extensión ni en Content-Type) ----------

// Bytes mágicos: Matroska/WebM = 1A 45 DF A3; MP4/MOV = "ftyp" (u otros átomos clásicos) en los bytes 4-8.
async function tipoPorMagia(ruta) {
  const fh = await fsp.open(ruta, "r");
  try {
    const b = Buffer.alloc(16);
    await fh.read(b, 0, 16, 0);
    if (b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "matroska";
    if (["ftyp", "moov", "mdat", "free", "wide", "skip", "pnot"].includes(b.subarray(4, 8).toString("latin1"))) return "mov";
    return null;
  } finally { await fh.close(); }
}

const ffprobe = (ruta, demuxer) => new Promise((ok, no) =>
  // -f fuerza el demultiplexor (un texto con forma de playlist HLS/concat no se interpreta) y solo se permite el protocolo file.
  execFile("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-f", demuxer, "-print_format", "json", "-show_format", "-show_streams", ruta],
    { timeout: 30000, maxBuffer: 5 * 1048576 }, (e, out) => (e ? no(e) : ok(JSON.parse(out)))));

export async function validarVideo(ruta, nombreOriginal = "") {
  const demuxer = await tipoPorMagia(ruta);
  if (!demuxer) throw new ErrorSubida(400, "El archivo no es un video MP4/MOV/MKV/WebM válido.");
  let info;
  try { info = await ffprobe(ruta, demuxer); }
  catch { throw new ErrorSubida(400, "No pude leer el video: está dañado o incompleto."); }
  const v = (info.streams || []).find(s => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!v) throw new ErrorSubida(400, "El archivo no tiene pista de video.");
  const duracion = Number(info.format?.duration) || Number(v.duration) || 0;
  if (!(duracion > 0)) throw new ErrorSubida(400, "No pude leer la duración del video.");
  if (duracion > maxMinutos() * 60) throw new ErrorSubida(400, `El video dura más de ${maxMinutos()} minutos.`);
  if (!(v.width > 0 && v.height > 0)) throw new ErrorSubida(400, "No pude leer las dimensiones del video.");
  const st = await fsp.stat(ruta);
  return {
    ruta, bytes: st.size, duracion, ancho: v.width, alto: v.height,
    conAudio: (info.streams || []).some(s => s.codec_type === "audio"),
    contenedor: demuxer,
    nombreOriginal: path.basename(String(nombreOriginal)).replace(/[^\w.\- áéíóúñÁÉÍÓÚÑ()]/g, "_").slice(0, 120)   // solo informativo: nunca se usa como ruta
  };
}

// ---------- Middleware ----------

function traducir(err) {
  if (err instanceof ErrorSubida) return err;
  if (err?.code === "LIMIT_FILE_SIZE") return new ErrorSubida(413, `El archivo supera el máximo de ${Math.round(maxBytes() / 1048576)} MB.`);
  if (err?.code === "LIMIT_UNEXPECTED_FILE") return new ErrorSubida(400, 'Campo de archivo inesperado: envía un solo archivo en el campo "archivo".');
  if (err?.code === "LIMIT_FILE_COUNT" || err?.code === "LIMIT_PART_COUNT" || err?.code === "LIMIT_FIELD_COUNT" || err?.code === "LIMIT_FIELD_VALUE") return new ErrorSubida(400, "Formulario demasiado grande o con demasiados campos.");
  if (/unexpected end of form|premature close|aborted/i.test(String(err?.message))) return new ErrorSubida(400, "La subida se interrumpió.");
  return new ErrorSubida(400, "No pude procesar el formulario de subida.");
}

export function subidaOpcional({ campo = "archivo" } = {}) {
  resolverUploads();   // resuelve y avisa en el arranque, pero NUNCA lanza: un permiso en /data no debe tumbar el servidor
  const up = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, dirUploads()),
      filename: (req, file, cb) => cb(null, `up-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)   // el nombre del cliente nunca toca el disco
    }),
    limits: { fileSize: maxBytes(), files: 1, fields: 20, fieldSize: 20 * 1024, parts: 30 },
    fileFilter: (req, file, cb) => EXTENSIONES.includes(path.extname(file.originalname).toLowerCase())
      ? cb(null, true) : cb(new ErrorSubida(400, "Formato no permitido: usa mp4, mov, mkv o webm."))
  }).single(campo);

  return (req, res, next) => {
    if (!req.is("multipart/form-data")) return next();
    if (!uploadsDisponible()) return next(new ErrorSubida(503, "El almacenamiento para subir archivos no está disponible ahora: usa un enlace de YouTube o inténtalo más tarde."));      // JSON con url: el flujo de siempre
    up(req, res, async err => {
      if (err) { await borrarUpload(req.file?.path); return next(traducir(err)); }
      if (!req.file) return next();                          // multipart solo con campos (p. ej. url): lo decide el handler
      try { req.archivoLocal = await validarVideo(req.file.path, req.file.originalname); next(); }
      catch (e) { await borrarUpload(req.file.path); next(e); }
    });
  };
}

// Descarta el archivo subido (úsalo si el handler rechaza la petición después de recibirlo).
export const descartarSubida = req => borrarUpload(req.archivoLocal?.ruta || req.file?.path);

// Decide el origen del trabajo: URL o archivo, nunca ambos ni ninguno.
export function origenDeEncolar(req) {
  const url = String(req.body?.url ?? "").trim();
  const f = req.archivoLocal;
  if (f && url) { descartarSubida(req); throw new ErrorSubida(400, "Envía una URL o un archivo, no ambos."); }
  if (f) return { tipo: "archivo", ...f };
  if (url) return { tipo: "url", url };
  throw new ErrorSubida(400, "Falta la URL o el archivo de video.");
}

// Limpieza de uploads olvidados (por defecto > 48 h). El pipeline debe llamar a borrarUpload() al terminar el trabajo.
export async function purgarUploads({ ttlMs = num("UPLOAD_TTL_H", 48) * 3600e3 } = {}) {
  let n = 0;
  for (const f of await fsp.readdir(dirUploads()).catch(() => [])) {
    const p = path.join(dirUploads(), f);
    const st = await fsp.stat(p).catch(() => null);
    if (st?.isFile() && /^up-[0-9a-f-]{36}\./.test(f) && Date.now() - st.mtimeMs > ttlMs) { await fsp.unlink(p).catch(() => {}); n++; }
  }
  return n;
}
export const iniciarPurgaUploads = () => { const t = setInterval(() => purgarUploads().catch(() => {}), 3600e3); t.unref(); return () => clearInterval(t); };
