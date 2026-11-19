import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import express from "express";

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "up-test-"));
process.env.UPLOADS_DIR = path.join(raiz, "uploads");
const { subidaOpcional, origenDeEncolar, borrarUpload, purgarUploads, validarVideo, dirUploads } = await import("../src/upload.js");

const app = (opts) => {
  const a = express();
  a.post("/encolar", express.json(), subidaOpcional(opts), (req, res, next) => { try { res.json({ origen: origenDeEncolar(req), campos: req.body }); } catch (e) { next(e); } });
  a.use((e, req, res, next) => res.status(e.status || 500).json({ error: e.message }));
  return new Promise(ok => { const s = a.listen(0, () => ok({ s, url: `http://127.0.0.1:${s.address().port}/encolar` })); });
};
const mk = (nombre, args) => { const p = path.join(raiz, nombre); execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2", "-f", "lavfi", "-i", "sine=duration=2", ...args, p]); return p; };
const subir = async (url, ruta, nombre, campos = {}, tipo = "application/octet-stream") => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.append(k, v);
  if (ruta) fd.append("archivo", new Blob([fs.readFileSync(ruta)], { type: tipo }), nombre);
  const r = await fetch(url, { method: "POST", body: fd });
  return { status: r.status, json: await r.json() };
};
const archivosSubidos = () => fs.existsSync(dirUploads()) ? fs.readdirSync(dirUploads()) : [];
let A, mp4, mkv, mov, webm;
before(async () => {
  A = await app();
  mp4 = mk("v.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  mkv = mk("v.mkv", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  mov = mk("v.mov", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  try { webm = mk("v.webm", ["-c:v", "libvpx", "-c:a", "libvorbis"]); } catch { webm = mk("v2.webm", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "matroska"]); }
});
after(() => { A.s.close(); fs.rmSync(raiz, { recursive: true, force: true }); });

for (const [nombre, get] of [["mp4", () => mp4], ["mkv", () => mkv], ["mov", () => mov], ["webm", () => webm]]) {
  test(`acepta ${nombre} real: valida con ffprobe y devuelve metadatos`, async () => {
    const r = await subir(A.url, get(), `mi video.${nombre}`, { instruccion: "ahorro", estiloSubtitulos: "clasico" });
    assert.equal(r.status, 200);
    assert.equal(r.json.origen.tipo, "archivo");
    assert.ok(Math.abs(r.json.origen.duracion - 2) < 0.6 && r.json.origen.ancho === 320 && r.json.origen.alto === 240 && r.json.origen.conAudio);
    assert.ok(fs.existsSync(r.json.origen.ruta) && path.basename(r.json.origen.ruta).startsWith("up-") && !r.json.origen.ruta.includes("mi video"));
    assert.equal(r.json.campos.instruccion, "ahorro"); assert.equal(r.json.campos.estiloSubtitulos, "clasico");
    await borrarUpload(r.json.origen.ruta);
  });
}
test("rechaza una extensión no permitida", async () => {
  const r = await subir(A.url, mp4, "malware.exe"); assert.equal(r.status, 400); assert.match(r.json.error, /Formato no permitido/);
});
test("rechaza un texto disfrazado de .mp4 y no deja rastro en disco", async () => {
  const falso = path.join(raiz, "falso.txt"); fs.writeFileSync(falso, "esto no es un video");
  const antes = archivosSubidos().length;
  const r = await subir(A.url, falso, "falso.mp4"); assert.equal(r.status, 400); assert.match(r.json.error, /no es un video/);
  assert.equal(archivosSubidos().length, antes);
});
test("SEGURIDAD: una playlist HLS/concat disfrazada de .mp4 se rechaza antes de que ffmpeg la interprete", async () => {
  const lista = path.join(raiz, "lista.txt"); fs.writeFileSync(lista, "#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n");
  const antes = archivosSubidos().length;
  const r = await subir(A.url, lista, "lista.mp4"); assert.equal(r.status, 400);
  const concat = path.join(raiz, "c.txt"); fs.writeFileSync(concat, "ffconcat version 1.0\nfile '/etc/passwd'\n");
  assert.equal((await subir(A.url, concat, "c.mkv")).status, 400);
  assert.equal(archivosSubidos().length, antes);
});
test("rechaza un contenedor válido sin pista de video (solo audio)", async () => {
  const audio = path.join(raiz, "a.mkv"); execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "aac", audio]);
  const r = await subir(A.url, audio, "a.mkv"); assert.equal(r.status, 400); assert.match(r.json.error, /pista de video/);
});
test("un nombre con ../ nunca sale de la carpeta de subidas", async () => {
  const r = await subir(A.url, mp4, "../../etc/pasaporte.mp4"); assert.equal(r.status, 200);
  assert.ok(path.resolve(r.json.origen.ruta).startsWith(dirUploads() + path.sep)); assert.ok(!r.json.origen.nombreOriginal.includes("/"));
  await borrarUpload(r.json.origen.ruta);
});
test("JSON con url sigue funcionando sin tocar nada; sin url ni archivo → 400", async () => {
  const r = await fetch(A.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://youtu.be/abcdefghijk", instruccion: "x" }) });
  assert.equal((await r.json()).origen.tipo, "url");
  const v = await fetch(A.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(v.status, 400);
});
test("url y archivo a la vez → 400 y el archivo recibido se descarta", async () => {
  const antes = archivosSubidos().length;
  const r = await subir(A.url, mp4, "v.mp4", { url: "https://youtu.be/abcdefghijk" }); assert.equal(r.status, 400); assert.match(r.json.error, /no ambos/);
  await new Promise(r => setTimeout(r, 100)); assert.equal(archivosSubidos().length, antes);
});
test("supera el tamaño máximo → 413 y no queda archivo parcial", async () => {
  process.env.MAX_UPLOAD_MB = "0.01";
  const B = await app();
  const antes = archivosSubidos().length;
  const r = await subir(B.url, mp4, "v.mp4"); B.s.close(); delete process.env.MAX_UPLOAD_MB;
  assert.equal(r.status, 413); assert.equal(archivosSubidos().length, antes);
});
test("dos archivos en el mismo formulario → 400", async () => {
  const fd = new FormData(); fd.append("archivo", new Blob([fs.readFileSync(mp4)]), "a.mp4"); fd.append("archivo", new Blob([fs.readFileSync(mp4)]), "b.mp4");
  const r = await fetch(A.url, { method: "POST", body: fd }); assert.equal(r.status, 400);
});
test("borrarUpload no borra nada fuera de la carpeta de subidas", async () => {
  const fuera = path.join(raiz, "importante.txt"); fs.writeFileSync(fuera, "x");
  await borrarUpload(fuera); assert.ok(fs.existsSync(fuera));
});
test("purgarUploads borra solo uploads viejos con el nombre esperado", async () => {
  const dir = dirUploads(); fs.mkdirSync(dir, { recursive: true });
  const viejo = path.join(dir, "up-12345678-1234-1234-1234-123456789012.mp4"), otro = path.join(dir, "notas.txt");
  fs.writeFileSync(viejo, "x"); fs.writeFileSync(otro, "x");
  const hace = new Date(Date.now() - 100 * 3600e3); fs.utimesSync(viejo, hace, hace); fs.utimesSync(otro, hace, hace);
  assert.equal(await purgarUploads({ ttlMs: 48 * 3600e3 }), 1);
  assert.ok(!fs.existsSync(viejo) && fs.existsSync(otro));
});
