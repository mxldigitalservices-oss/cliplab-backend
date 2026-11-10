import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cliplab-v-"));
process.env.CLIPS_DIR = tmp;
const { validarMarca, construirFiltro, construirArgs, cortarClip, ZONAS } = await import("../src/video.js");
const { construirAss } = await import("../src/subtitulos.js");

test("marca: coordenadas de fábrica válidas y zonas prohibidas rechazadas", () => {
  assert.equal(validarMarca({ x: 36, y: 150, w: 130, h: 40 }).ok, true);
  assert.match(validarMarca({ x: 36, y: 60, w: 130, h: 40 }).motivo, /barra superior/);
  assert.match(validarMarca({ x: 36, y: 1000, w: 130, h: 40 }).motivo, /descripción/);
  assert.match(validarMarca({ x: 600, y: 600, w: 90, h: 40 }).motivo, /botones/);
  assert.match(validarMarca({ x: 650, y: 150, w: 130, h: 40 }).motivo, /laterales/);
  assert.equal(validarMarca({ x: 600, y: 150, w: 90, h: 40 }).ok, true);   // arriba a la derecha, sobre el riel
  assert.equal(ZONAS.abajo, 340);
});

test("filtro: 9:16 estricto, alfa rgba, overlay fijo y subtítulos al final", () => {
  const f = construirFiltro({ modo: "blur", marca: { idx: 1, x: 36, y: 150, w: 130, opacidad: 0.9 }, ass: { archivo: "/tmp/x/sub-a.ass", fontsDir: "/usr/share/fonts/truetype/dejavu" } });
  assert.match(f, /scale=720:1280/);
  assert.match(f, /\[1:v\]format=rgba,scale=130:-1:flags=lanczos,colorchannelmixer=aa=0\.9\[lg\]/);
  assert.match(f, /overlay=36:150:format=auto\[v1\]/);
  assert.match(f, /\[v1\]ass=filename='\/tmp\/x\/sub-a\.ass':fontsdir='[^']+'\[v2\]/);
  assert.match(f, /\[v2\]format=yuv420p\[v\]$/);
  const sin = construirFiltro({ modo: "crop", marca: null, ass: null });
  assert.match(sin, /crop=720:1280/); assert.match(sin, /\[v0\]format=yuv420p\[v\]$/);
});

test("args: sin logo no agrega entrada extra; con logo va después de los videos", () => {
  const a = construirArgs({ urls: ["a.mp4"], inicio: 5, dur: 20, out: "o.mp4", marca: null, ass: null });
  assert.equal(a.filter(x => x === "-i").length, 1);
  const b = construirArgs({ urls: ["a.mp4", "b.m4a"], inicio: 5, dur: 20, out: "o.mp4", marca: { archivo: "l.png", x: 36, y: 150, w: 130, opacidad: 1 }, ass: null });
  assert.equal(b.filter(x => x === "-i").length, 3);
  assert.match(b[b.indexOf("-filter_complex") + 1], /\[2:v\]format=rgba/);
  assert.equal(b[b.indexOf("-map") + 3], "1:a:0");
});

// Prueba real con FFmpeg (se omite si el equipo no tiene ffmpeg con libass).
let hayFfmpeg = true;
try { execFileSync("ffmpeg", ["-hide_banner", "-filters"]).toString().includes(" ass ") || (hayFfmpeg = false); } catch { hayFfmpeg = false; }

test("FFmpeg real: 16:9 → 720x1280 con logo semitransparente y subtítulos", { skip: !hayFfmpeg }, async () => {
  const src = path.join(tmp, "fuente.mp4"), logo = path.join(tmp, "logo.png"), ass = path.join(tmp, "s.ass");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red@0.6:s=200x80,format=rgba", "-frames:v", "1", logo]);
  fs.writeFileSync(ass, construirAss([{ t: "hola", i: 0.2, f: 0.8 }, { t: "mundo", i: 0.9, f: 1.6 }, { t: "feliz", i: 1.7, f: 2.5 }]));
  const out = path.join(tmp, "salida.mp4");
  const args = construirArgs({ urls: [src], inicio: 0, dur: 3, out, marca: { archivo: logo, x: 36, y: 150, w: 130, opacidad: 0.9 }, ass: { archivo: ass, fontsDir: fs.existsSync("/usr/share/fonts/truetype/dejavu") ? "/usr/share/fonts/truetype/dejavu" : null } });
  execFileSync("ffmpeg", args);
  const info = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,pix_fmt:format=duration", "-of", "json", out]).toString();
  const j = JSON.parse(info);
  assert.equal(j.streams[0].width, 720); assert.equal(j.streams[0].height, 1280);
  assert.equal(j.streams[0].pix_fmt, "yuv420p");
  assert.ok(Math.abs(Number(j.format.duration) - 3) < 0.3);
  // El logo debe verse en (36,150) y los subtítulos en la franja inferior: se comparan fotogramas con y sin ellos.
  const sin = path.join(tmp, "sin.mp4");
  execFileSync("ffmpeg", construirArgs({ urls: [src], inicio: 0, dur: 3, out: sin, marca: null, ass: null }));
  const frame = (f, x, y, w, h) => execFileSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", f, "-frames:v", "1", "-vf", `crop=${w}:${h}:${x}:${y},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  assert.notDeepEqual(frame(out, 36, 150, 130, 40), frame(sin, 36, 150, 130, 40), "logo visible");
  assert.notDeepEqual(frame(out, 60, 850, 600, 120), frame(sin, 60, 850, 600, 120), "subtítulo visible");
  assert.deepEqual(frame(out, 300, 700, 100, 30).length, 3);
});

test("cortarClip: si falla, no deja archivos temporales", { skip: !hayFfmpeg }, async () => {
  const c = { token: "11111111-2222-3333-4444-555555555555", inicio_seg: 0, fin_seg: 5, video_id: "xxxxxxxxxxx" };
  await assert.rejects(cortarClip(c, "https://localhost.invalid/video", { palabras: [{ t: "hola", i: 0, f: 1 }] }));
  const sobras = fs.readdirSync(tmp).filter(n => n.includes(c.token));
  assert.deepEqual(sobras, []);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
