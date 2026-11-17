import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { construirTrayectoria, expresionLineal, medianaMovil, rellenarHuecos, simularCamara, CAM } from '../src/engine/trayectoria.js';
import { xRostro } from '../src/engine/sujeto.js';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-tray-'));
test.after(() => fs.rm(raiz, { recursive: true, force: true }));

// serie de muestras a 4 fps: f(t) -> posicion horizontal del rostro
const serie = (dur, f, n = 1) => Array.from({ length: Math.round(dur * 4) + 1 }, (_, i) => {
  const t = i / 4;
  const x = f(t);
  return x == null ? { t, n: 0 } : { t, n, x, l: x, r: x };
});
const rango = (kf) => Math.max(...kf.map((k) => k.cx)) - Math.min(...kf.map((k) => k.cx));

test('gesticular (+-0.03 alrededor de 0.5) NO mueve la camara', () => {
  const kf = construirTrayectoria(serie(8, (t) => 0.5 + 0.03 * Math.sin(t * 7)), 8);
  assert.ok(rango(kf) < 0.005, 'la camara debe quedarse quieta, rango=' + rango(kf));
});

test('un falso positivo suelto (salto a 0.9 por un cuadro) se ignora', () => {
  const kf = construirTrayectoria(serie(6, (t) => (Math.abs(t - 3) < 0.01 ? 0.9 : 0.4)), 6);
  assert.ok(rango(kf) < 0.005, 'rango=' + rango(kf));
});

test('un desplazamiento real SI se sigue, con inercia y sin pasar la velocidad maxima', () => {
  const kf = construirTrayectoria(serie(8, (t) => (t < 2 ? 0.3 : 0.65)), 8);
  assert.ok(Math.abs(kf[0].cx - 0.3) < 0.01, 'arranca en el sujeto');
  assert.ok(Math.abs(kf[kf.length - 1].cx - 0.65) < 0.06, 'termina cerca del nuevo sitio: ' + kf[kf.length - 1].cx);
  for (let i = 1; i < kf.length; i++) {
    const v = (kf[i].cx - kf[i - 1].cx) / (kf[i].t - kf[i - 1].t);
    assert.ok(Math.abs(v) <= CAM.vmax + 1e-6, 'velocidad ' + v + ' excede vmax');
    assert.ok(kf[i].cx >= kf[i - 1].cx - 1e-9, 'sin retrocesos');
  }
});

test('huecos sin deteccion mantienen la posicion (no se va al centro)', () => {
  const kf = construirTrayectoria(serie(6, (t) => (t >= 1.5 && t <= 4.5 ? null : 0.25)), 6);
  assert.ok(kf.every((k) => Math.abs(k.cx - 0.25) < 0.005), JSON.stringify(kf));
});

test('si el rostro aparece tarde, la camara arranca ya sobre el (sin paneo inicial)', () => {
  const kf = construirTrayectoria(serie(4, (t) => (t < 1 ? null : 0.7)), 4);
  assert.equal(kf[0].t, 0);
  assert.ok(Math.abs(kf[0].cx - 0.7) < 0.005);
});

test('sin ningun rostro no hay trayectoria', () => {
  assert.equal(construirTrayectoria(serie(3, () => null), 3), null);
  assert.equal(construirTrayectoria([], 3), null);
});

test('keyframes: extremos presentes, tiempos crecientes y tope respetado', () => {
  const kf = construirTrayectoria(serie(30, (t) => 0.5 + 0.35 * Math.sin(t / 2.2)), 30);
  assert.equal(kf[0].t, 0);
  assert.equal(kf[kf.length - 1].t, 30);
  assert.ok(kf.length <= CAM.maxKeyframes, 'demasiados keyframes: ' + kf.length);
  for (let i = 1; i < kf.length; i++) assert.ok(kf[i].t > kf[i - 1].t);
});

test('piezas: mediana movil, relleno de huecos y camara simulada', () => {
  assert.deepEqual(medianaMovil([0.5, 0.5, 0.9, 0.5, 0.5], 3), [0.5, 0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual(rellenarHuecos([null, 0.2, null, null, 0.4]), [0.2, 0.2, 0.2, 0.2, 0.4]);
  assert.equal(rellenarHuecos([null, null]), null);
  const cam = simularCamara([0.5, 0.52, 0.48, 0.5], [0, 0.25, 0.5, 0.75]);
  assert.deepEqual(cam, [0.5, 0.5, 0.5, 0.5]);
});

test('expresionLineal: constante, y tramos con if(lt(t,..))', () => {
  assert.equal(expresionLineal([{ t: 0, cx: 0.4 }, { t: 3, cx: 0.4 }]), '0.4000');
  const e = expresionLineal([{ t: 0, cx: 0.2 }, { t: 1, cx: 0.8 }, { t: 3, cx: 0.8 }]);
  assert.match(e, /^if\(lt\(t,1\.000\),0\.2000\+\(0\.600000\)\*\(t-0\.000\),0\.8000\)$/);
});

test('xRostro con keyframes genera crop dinamico; con kf constante cae al fijo', () => {
  assert.match(xRostro({ cx: 0.5, kf: [{ t: 0, cx: 0.2 }, { t: 2, cx: 0.4 }] }), /^'clip\(if\(lt\(t,2\.000\)/);
  assert.equal(xRostro({ cx: 0.5, kf: [{ t: 0, cx: 0.3 }, { t: 2, cx: 0.3 }] }), "'clip(0.3000*in_w-out_w/2,0,in_w-out_w)'");
});

test('FFmpeg: la camara se desliza de forma continua (un solo cruce, sin saltos) segun los keyframes', () => {
  const fuente = path.join(raiz, 'mitades.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=640x720:r=30', '-f', 'lavfi', '-i', 'color=c=blue:s=640x720:r=30',
    '-filter_complex', 'hstack', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fuente]);
  const kf = [{ t: 0, cx: 0.1 }, { t: 1, cx: 0.9 }];
  const filtro = 'trim=start=0:end=1,setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,' +
    'crop=1080:1920:' + xRostro({ kf }) + ':(in_h-out_h)/2,crop=1:1:540:960';
  const buf = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', fuente, '-vf', filtro, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
  const cuadros = [];
  for (let i = 0; i + 2 < buf.length; i += 3) cuadros.push(buf[i] > buf[i + 2] ? 'R' : 'B');
  assert.ok(cuadros.length >= 28, 'cuadros: ' + cuadros.length);
  assert.equal(cuadros[0], 'R');
  assert.equal(cuadros[cuadros.length - 1], 'B');
  const cruces = cuadros.filter((c, i) => i > 0 && c !== cuadros[i - 1]).length;
  assert.equal(cruces, 1, 'debe cruzar la frontera una sola vez: ' + cuadros.join(''));
  const cruce = cuadros.indexOf('B');
  assert.ok(cruce >= 12 && cruce <= 18, 'cruza hacia la mitad del corte (t=0.5): cuadro ' + cruce);
});
