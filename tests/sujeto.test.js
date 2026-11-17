import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resumirMuestras, marcarSplit, xRostro, filtroSplit, analizarCortes } from '../src/engine/sujeto.js';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-sujeto-'));
test.after(() => fs.rm(raiz, { recursive: true, force: true }));

test('un rostro: cx sigue al rostro (mediana de las muestras)', () => {
  const r = resumirMuestras([{ n: 1, x: 0.3, l: 0.3, r: 0.3 }, { n: 1, x: 0.32, l: 0.32, r: 0.32 }, { n: 1, x: 0.9, l: 0.9, r: 0.9 }]);
  assert.equal(r.n, 1);
  assert.ok(Math.abs(r.cx - 0.32) < 1e-9, 'la mediana ignora el falso positivo, fue ' + r.cx);
});

test('muestras sin rostro se ignoran; sin ninguna devuelve null', () => {
  assert.equal(resumirMuestras([{ n: 0 }, { n: 0 }, { n: 0 }]), null);
  const r = resumirMuestras([{ n: 0 }, { n: 1, x: 0.6, l: 0.6, r: 0.6 }, { n: 0 }]);
  assert.ok(Math.abs(r.cx - 0.6) < 1e-9);
});

test('grupo estrecho se centra completo; grupo ancho cae al centro reportado', () => {
  const cerca = resumirMuestras([{ n: 2, x: 0.5, l: 0.4, r: 0.6 }]);
  assert.ok(Math.abs(cerca.cx - 0.5) < 1e-9);
  const lejos = resumirMuestras([{ n: 2, x: 0.45, l: 0.1, r: 0.9 }]);
  assert.ok(Math.abs(lejos.cx - 0.45) < 1e-9);
});

test('xRostro: sin rostro centra; con rostro genera clip acotado', () => {
  assert.equal(xRostro(null), '(in_w-out_w)/2');
  assert.equal(xRostro({ cx: NaN }), '(in_w-out_w)/2');
  assert.match(xRostro({ cx: 0.3 }), /clip\(0\.3000\*in_w-out_w\/2,0,in_w-out_w\)/);
  assert.match(xRostro({ cx: 7 }), /clip\(1\.0000\*/);
});

test('analizarCortes respeta cortes que ya traen sujeto y no toca el disco', async () => {
  const cortes = [{ desde: 0, hasta: 2, plano: 'medio', sujeto: { cx: 0.8 } }];
  assert.equal(await analizarCortes('/no/existe.mp4', cortes, 0), cortes);
});

test('la expresion de crop de FFmpeg sigue al rostro (izquierda=rojo, derecha=azul)', () => {
  const fuente = path.join(raiz, 'mitades.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=640x720:r=30', '-f', 'lavfi', '-i', 'color=c=blue:s=640x720:r=30',
    '-filter_complex', 'hstack', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fuente]);

  const pixel = (cx) => {
    const filtro = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:' + xRostro(cx == null ? null : { cx }) + ':(in_h-out_h)/2';
    return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', fuente, '-frames:v', '1',
      '-vf', filtro + ',crop=1:1:540:960', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  };
  const izq = pixel(0.1);
  const der = pixel(0.9);
  assert.ok(izq[0] > 200 && izq[2] < 60, 'cx=0.1 debe mostrar rojo: ' + [...izq]);
  assert.ok(der[2] > 200 && der[0] < 60, 'cx=0.9 debe mostrar azul: ' + [...der]);
});

// ---------------- Frente B: split-screen ----------------
const dos = { n: 2, x: 0.5, l: 0.2, r: 0.8 };
const uno = { n: 1, x: 0.3, l: 0.3, r: 0.3 };

test('dos rostros estables activan split en video horizontal', () => {
  const r = resumirMuestras([dos, dos, dos]);
  assert.equal(r.estable2, true);
  assert.equal(marcarSplit([r], true)[0].split, true);
});

test('en video vertical nunca hay split', () => {
  const r = resumirMuestras([dos, dos, dos]);
  assert.equal(marcarSplit([r], false)[0].split, false);
});

test('SPLIT_SCREEN desactivado (activo=false) no hace split', () => {
  const r = resumirMuestras([dos, dos, dos]);
  assert.equal(marcarSplit([r], true, false)[0].split, false);
});

test('un rostro: sin split', () => {
  const r = resumirMuestras([uno, uno, uno]);
  assert.equal(r.estable2, false);
  assert.equal(marcarSplit([r], true)[0].split, false);
});

test('conteo inestable (1,2,3) no cuenta como estable', () => {
  const r = resumirMuestras([uno, dos, { ...dos, n: 3 }]);
  assert.equal(r.estable2, false);
});

test('rostros demasiado juntos (< 0.2) no activan split', () => {
  const cerca = { n: 2, x: 0.5, l: 0.45, r: 0.58 };
  const r = resumirMuestras([cerca, cerca, cerca]);
  assert.equal(marcarSplit([r], true)[0].split, false);
});

test('histeresis: un beat flojo entre dos split se queda en split', () => {
  const a = resumirMuestras([dos, dos, dos]);
  const b = resumirMuestras([uno, uno, uno]);
  const out = marcarSplit([a, b, a], true);
  assert.deepEqual(out.map((s) => s.split), [true, true, true]);
});

test('histeresis: un beat flojo al borde (sin vecino split) no se promueve', () => {
  const a = resumirMuestras([dos, dos, dos]);
  const b = resumirMuestras([uno, uno, uno]);
  assert.deepEqual(marcarSplit([a, b], true).map((s) => s.split), [true, false]);
});

test('filtroSplit termina en la etiqueta [v<i>] y apila dos mitades', () => {
  const f = filtroSplit(2, { l: 0.2, r: 0.8 }, 1080, 1920);
  assert.ok(f.endsWith('vstack=inputs=2,setsar=1[v2]'));
  assert.ok(f.includes('scale=1080:960'));
});

test('filtroSplit en FFmpeg: arriba la persona izquierda (rojo), abajo la derecha (azul)', () => {
  for (const tam of ['1280x720', '1920x1080']) {
    const [w, h] = tam.split('x').map(Number);
    const fuente = path.join(raiz, 'split-' + tam + '.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=' + w / 2 + 'x' + h + ':r=30', '-f', 'lavfi', '-i', 'color=c=blue:s=' + w / 2 + 'x' + h + ':r=30',
      '-filter_complex', 'hstack', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fuente]);
    const filtro = '[0:v]' + filtroSplit(0, { l: 0.2, r: 0.8 }, 1080, 1920);
    const sal = (x, y) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', fuente, '-frames:v', '1',
      '-filter_complex', filtro + ';[v0]crop=1:1:' + x + ':' + y + '[o]', '-map', '[o]', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const arriba = sal(540, 240);
    const abajo = sal(540, 1440);
    assert.ok(arriba[0] > 200 && arriba[2] < 60, tam + ' arriba debe ser rojo: ' + [...arriba]);
    assert.ok(abajo[2] > 200 && abajo[0] < 60, tam + ' abajo debe ser azul: ' + [...abajo]);
  }
});
