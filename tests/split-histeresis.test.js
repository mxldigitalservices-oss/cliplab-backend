import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resumirMuestras, marcarSplit, analizarCortes, UMBRALES } from '../src/engine/sujeto.js';

const dos = (l = 0.2, r = 0.8) => ({ n: 2, x: (l + r) / 2, l, r });
const uno = { n: 1, x: 0.3, l: 0.3, r: 0.3 };
const tres = { n: 3, x: 0.5, l: 0.1, r: 0.9 };
const nada = { n: 0 };
const rep = (m, k) => Array.from({ length: k }, () => m);
// resumen de un corte con duracion
const corte = (muestras, dur = 5) => ({ ...resumirMuestras(muestras), dur });
const splits = (res) => marcarSplit(res, true).map((s) => s.split);

test('dense: cuadros sueltos sin rostro / con 1 rostro no rompen un corte de 2 personas', () => {
  const m = [...rep(dos(), 17), uno, uno, nada];
  const r = resumirMuestras(m);
  assert.equal(r.estable2, true);
  assert.ok(r.ratio2 > 0.85);
});

test('dense: un cuadro suelto con 3 rostros (falso positivo, 5%) se tolera; 25% no', () => {
  assert.equal(resumirMuestras([...rep(dos(), 19), tres]).estable2, true);
  assert.equal(resumirMuestras([...rep(dos(), 15), ...rep(tres, 5)]).estable2, false);
});

test('Schmitt: separacion intermedia (entre OFF y ON) NO entra, pero SI se mantiene si ya estaba en split', () => {
  const fuerte = corte(rep(dos(0.2, 0.8), 20)); // sep .6
  const media = corte(rep(dos(0.42, 0.42 + (UMBRALES.sepOn + UMBRALES.sepOff) / 2), 20)); // entre OFF y ON
  assert.deepEqual(splits([media]), [false], 'sola, no entra');
  assert.deepEqual(splits([fuerte, media]), [true, true], 'viniendo de split, se mantiene');
  assert.deepEqual(splits([media, fuerte]), [false, true]);
});

test('Schmitt: por debajo del umbral de permanencia se sale del split', () => {
  const fuerte = corte(rep(dos(0.2, 0.8), 20));
  const cerca = corte(rep(dos(0.45, 0.45 + UMBRALES.sepOff - 0.03), 20));
  assert.deepEqual(splits([fuerte, cerca]), [true, false]);
});

test('un corte de menos del minimo (1 s) no ENTRA en split aunque se vean dos rostros', () => {
  const brevisimo = corte(rep(dos(), 4), 1.0);
  assert.deepEqual(splits([brevisimo]), [false]);
});

test('un tramo de split breve y aislado (parpadeo de 1.2 s) se descarta; uno largo se conserva', () => {
  const una = corte(rep(uno, 20), 6);
  const parpadeo = corte(rep(dos(), 5), 1.8); // entra (>=1.5 s) pero el tramo dura < 2 s
  assert.deepEqual(splits([una, parpadeo, una]), [false, false, false]);
  const largo = corte(rep(dos(), 12), 3);
  assert.deepEqual(splits([una, largo, una]), [false, true, false]);
});

test('un tramo breve junto a un tramo largo de split se une a el (no se descarta)', () => {
  const largo = corte(rep(dos(), 20), 6);
  const breve = corte(rep(dos(), 5), 1.8);
  assert.deepEqual(splits([largo, breve]), [true, true]);
});

test('luz o postura: un corte en que Haar solo ve 1 persona entre dos de split se queda en split', () => {
  const a = corte(rep(dos(), 20), 4);
  const b = corte([...rep(uno, 18), ...rep(nada, 2)], 4);
  assert.deepEqual(splits([a, b, a]), [true, true, true]);
});

test('video vertical o SPLIT_SCREEN=off: nunca split', () => {
  const a = corte(rep(dos(), 20));
  assert.deepEqual(marcarSplit([a], false).map((s) => s.split), [false]);
  assert.deepEqual(marcarSplit([a], true, false).map((s) => s.split), [false]);
});

// ---------- punta a punta con el detector real (se omite si OpenCV 4.x no esta instalado) ----------
const PYTHON = process.env.PYTHON_BIN || 'python3';
const raizRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let detector = false;
try {
  execFileSync(PYTHON, [path.join(raizRepo, 'scripts/sujeto.py'), '--check'], { stdio: 'pipe', timeout: 20000 });
  detector = true;
} catch { /* sin OpenCV: se omiten las pruebas de integracion */ }

const rostro = path.join(raizRepo, 'tests/fixtures/rostro.jpg');
const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-e2e-'));
test.after(() => fs.rm(raiz, { recursive: true, force: true }));
const ffmpeg = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);

test('e2e: un rostro que camina de izquierda a derecha -> trayectoria suave que lo sigue, sin split', { skip: !detector }, async () => {
  const v = path.join(raiz, 'camina.mp4');
  ffmpeg('-f', 'lavfi', '-i', 'color=c=0x3c3c3c:s=640x360:r=30', '-loop', '1', '-i', rostro, '-filter_complex',
    '[1:v]scale=360:360[f];[0:v][f]overlay=x=\'280*t/3\':y=0:shortest=1', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v);
  const [c] = await analizarCortes(v, [{ desde: 0, hasta: 3, plano: 'medio' }], 0);
  assert.ok(c.sujeto, 'debe haber sujeto');
  assert.equal(c.sujeto.split, false);
  const kf = c.sujeto.kf;
  assert.ok(kf && kf.length >= 2, 'debe haber trayectoria');
  assert.ok(kf[kf.length - 1].cx > kf[0].cx + 0.1, 'la camara debe avanzar con el rostro: ' + JSON.stringify(kf));
  for (let i = 1; i < kf.length; i++) assert.ok(kf[i].cx >= kf[i - 1].cx - 1e-9, 'sin retrocesos');
});

test('e2e: dos personas sentadas -> split-screen estable', { skip: !detector }, async () => {
  const v = path.join(raiz, 'mesa.mp4');
  ffmpeg('-f', 'lavfi', '-i', 'color=c=0x3c3c3c:s=1280x720:r=30', '-loop', '1', '-i', rostro, '-filter_complex',
    '[1:v]scale=400:400,split[a][b];[0:v][a]overlay=x=120:y=100:shortest=1[t];[t][b]overlay=x=760:y=100:shortest=1',
    '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v);
  const [c] = await analizarCortes(v, [{ desde: 0, hasta: 4, plano: 'medio' }], 0);
  assert.ok(c.sujeto, 'debe haber sujeto');
  assert.equal(c.sujeto.n, 2);
  assert.equal(c.sujeto.estable2, true);
  assert.equal(c.sujeto.split, true);
  assert.ok(c.sujeto.l < 0.4 && c.sujeto.r > 0.6, 'l/r en cada mitad: ' + c.sujeto.l + ' ' + c.sujeto.r);
});
