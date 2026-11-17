import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { personasDe, seguirPersonas, elegirActivo, objetivosInterlocutor, INT } from '../src/engine/interlocutor.js';
import { simularCamara, CAM } from '../src/engine/trayectoria.js';
import { resumirMuestras, marcarSplit, analizarCortes } from '../src/engine/sujeto.js';

const W = 0.06;
const cara = (x, act = 0.001) => ({ x, w: W, act });
const mu = (t, caras) => ({
  t, n: caras.length, x: caras[0]?.x, l: Math.min(...caras.map((c) => c.x - c.w / 2)), r: Math.max(...caras.map((c) => c.x + c.w / 2)), rostros: caras,
});
const rep = (k, f) => Array.from({ length: k }, (_, i) => f(i));

test('personasDe: una persona que Haar ve solo en la mitad de los cuadros SIGUE contando', () => {
  const m = rep(20, (i) => mu(i / 4, i % 2 ? [cara(0.25), cara(0.75)] : [cara(0.25)]));
  const p = personasDe(m);
  assert.equal(p.length, 2);
  assert.ok(Math.abs(p[1].presencia - 0.5) < 0.01);
});

test('personasDe: un falso positivo suelto (10% de los cuadros) no es una persona', () => {
  const m = rep(20, (i) => mu(i / 4, i < 2 ? [cara(0.25), cara(0.8)] : [cara(0.25)]));
  assert.equal(personasDe(m).length, 1);
});

test('personasDe: el temblor de una misma persona (+-0.03) no la parte en dos', () => {
  const m = rep(20, (i) => mu(i / 4, [cara(0.5 + 0.03 * Math.sin(i * 1.7))]));
  assert.equal(personasDe(m).length, 1);
});

test('mesa redonda (3 personas persistentes): no hay split aunque se vean 2 a veces', () => {
  const m = rep(20, (i) => mu(i / 4, [cara(0.15), cara(0.5), ...(i % 3 ? [cara(0.85)] : [])]));
  const r = resumirMuestras(m);
  assert.equal(r.personas, 3);
  assert.equal(r.estable2, false);
});

test('resumirMuestras: segundo rostro intermitente (45% de los cuadros) activa estable2 por personas', () => {
  const con = rep(20, (i) => (i % 20 < 9 ? mu(i / 4, [cara(0.25), cara(0.75)]) : mu(i / 4, [cara(0.25)])));
  const r = resumirMuestras(con);
  assert.equal(r.personas, 2);
  assert.equal(r.estable2, true);
  assert.ok(r.r - r.l > 0.4);
  // sin la lista de rostros (formato antiguo) la regla vieja lo rechaza: la mejora viene de las personas
  const sin = con.map(({ rostros, ...resto }) => (resto.n === 2 ? resto : resto));
  assert.equal(resumirMuestras(sin).estable2, false);
});

// ---------------- elegirActivo: histéresis de cambio ----------------
const serie = (n, f) => rep(n, f);

test('elegirActivo: dos personas igual de quietas -> no hay cambios; arranca en la de mayor presencia', () => {
  const act = [serie(24, () => 0.001), serie(24, () => 0.0012)];
  const { activos, cambios } = elegirActivo(act, [0.6, 0.9]);
  assert.equal(cambios, 0);
  assert.ok(activos.every((a) => a === 1));
});

test('elegirActivo: cambia cuando el otro se mueve de forma sostenida', () => {
  const act = [serie(24, (i) => (i < 10 ? 0.02 : 0.001)), serie(24, (i) => (i < 10 ? 0.001 : 0.02))];
  const { activos, cambios } = elegirActivo(act, [0.9, 0.9]);
  assert.equal(cambios, 1);
  assert.equal(activos[0], 0);
  assert.equal(activos[23], 1);
});

test('elegirActivo: un pico de 1-2 muestras NO cambia el foco', () => {
  const act = [serie(24, () => 0.02), serie(24, (i) => (i === 10 || i === 11 ? 0.05 : 0.001))];
  assert.equal(elegirActivo(act, [0.9, 0.9]).cambios, 0);
});

test('elegirActivo: alternancia rapida no hace ping-pong; alternancia lenta (cada ~2 s) si sigue', () => {
  const rapido = [serie(32, (i) => (Math.floor(i / 2) % 2 ? 0.001 : 0.03)), serie(32, (i) => (Math.floor(i / 2) % 2 ? 0.03 : 0.001))];
  assert.equal(elegirActivo(rapido, [0.9, 0.9]).cambios, 0);
  const lento = [serie(40, (i) => (Math.floor(i / 8) % 2 ? 0.001 : 0.03)), serie(40, (i) => (Math.floor(i / 8) % 2 ? 0.03 : 0.001))];
  assert.ok(elegirActivo(lento, [0.9, 0.9]).cambios >= 3);
});

test('seguirPersonas: la posicion se mantiene cuando una persona no se detecta', () => {
  const m = rep(8, (i) => (i >= 3 && i <= 5 ? mu(i / 4, [cara(0.25)]) : mu(i / 4, [cara(0.25), cara(0.75)])));
  const p = personasDe(m);
  const { pos } = seguirPersonas(m, p);
  assert.ok(pos[1].every((x) => Math.abs(x - 0.75) < 1e-9));
});

// ---------------- objetivos del crop ----------------
test('si no caben los dos en el crop 9:16, el objetivo es el activo con un sesgo corto hacia el otro', () => {
  const m = rep(24, (i) => mu(i / 4, [cara(0.25, i < 12 ? 0.03 : 0.001), cara(0.75, i < 12 ? 0.001 : 0.03)]));
  const p = personasDe(m);
  const { objetivos, caben, cambios } = objetivosInterlocutor(m, p, CAM.grupoMax);
  assert.equal(caben, false);
  assert.equal(cambios, 1);
  assert.ok(Math.abs(objetivos[0] - (0.25 + INT.sesgoMax)) < 1e-9, 'activo izquierda: ' + objetivos[0]);
  assert.ok(Math.abs(objetivos[23] - (0.75 - INT.sesgoMax)) < 1e-9, 'activo derecha: ' + objetivos[23]);
});

test('si caben los dos, el objetivo es el centro del par, sin importar quien habla', () => {
  const m = rep(24, (i) => mu(i / 4, [cara(0.45, i < 12 ? 0.03 : 0.001), cara(0.56, i < 12 ? 0.001 : 0.03)]));
  const { objetivos, caben } = objetivosInterlocutor(m, personasDe(m), CAM.grupoMax);
  assert.equal(caben, true);
  assert.ok(objetivos.every((o) => Math.abs(o - 0.505) < 0.01));
});

// ---------------- aceleracion adaptativa ----------------
const alcanza = (cam, meta, tol) => cam.findIndex((v) => Math.abs(v - meta) <= tol);
const escalon = (de, a) => rep(40, (i) => (i < 4 ? de : a));
const tiempos = rep(40, (i) => i * 0.25);

test('aceleracion: un salto grande (> 15% del frame) llega antes que sin aceleracion', () => {
  const sin = simularCamara(escalon(0.25, 0.75), tiempos, { ...CAM, urgenteFactor: 1 });
  const con = simularCamara(escalon(0.25, 0.75), tiempos, CAM);
  const a = alcanza(sin, 0.75, 0.05);
  const b = alcanza(con, 0.75, 0.05);
  assert.ok(b > 0 && b < a, `con aceleracion ${b} muestras vs sin ${a}`);
  assert.ok((a - 4) / (b - 4) >= 1.2, 'al menos ~20-30% mas rapido');
});

test('aceleracion: un ajuste pequeno (< 15%) no cambia nada', () => {
  const sin = simularCamara(escalon(0.5, 0.62), tiempos, { ...CAM, urgenteFactor: 1 });
  const con = simularCamara(escalon(0.5, 0.62), tiempos, CAM);
  assert.deepEqual(con, sin);
});

// ---------------- split como red de seguridad ----------------
const corteConPersonas = (sep, cambios, dur = 5) => {
  const l = 0.5 - sep / 2;
  const m = rep(20, (i) => mu(i / 4, [cara(l + W / 2), cara(l + sep - W / 2)]));
  return { ...resumirMuestras(m), cambios, dur };
};

test('split: pareja que interactua (>=2 cambios) entra a separacion media (0.18); una que no, no', () => {
  const inter = corteConPersonas(0.18, 2);
  const quieta = corteConPersonas(0.18, 0);
  assert.equal(marcarSplit([inter], true)[0].split, true);
  assert.equal(marcarSplit([quieta], true)[0].split, false);
});

test('split: la interaccion no baja del umbral minimo (0.16) ni salta la duracion minima', () => {
  assert.equal(marcarSplit([corteConPersonas(0.13, 3)], true)[0].split, false);
  assert.equal(marcarSplit([corteConPersonas(0.3, 3, 1.0)], true)[0].split, false);
});

// ---------------- e2e con el detector real ----------------
const PYTHON = process.env.PYTHON_BIN || 'python3';
const raizRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let detector = false;
try {
  execFileSync(PYTHON, [path.join(raizRepo, 'scripts/sujeto.py'), '--check'], { stdio: 'pipe', timeout: 20000 });
  detector = true;
} catch { /* sin OpenCV 4.x: se omite */ }
const rostroImg = path.join(raizRepo, 'tests/fixtures/rostro.jpg');
const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-int-'));
test.after(() => fs.rm(raiz, { recursive: true, force: true }));

test('e2e: invitado de la derecha gesticula y luego el de la izquierda -> la camara cambia de persona', { skip: !detector }, async () => {
  const v = path.join(raiz, 'entrevista.mp4');
  const osc = (gate) => "'100+30*sin(2*PI*1.3*t)*" + gate + "'";
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x3c3c3c:s=1280x720:r=30', '-loop', '1', '-i', rostroImg, '-filter_complex',
    '[1:v]scale=400:400,split[a][b];' +
    '[0:v][a]overlay=x=120:y=' + osc('gte(t,3)') + ':shortest=1[t];' +
    '[t][b]overlay=x=760:y=' + osc('lt(t,3)') + ':shortest=1',
    '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v]);
  const [c] = await analizarCortes(v, [{ desde: 0, hasta: 6, plano: 'medio' }], 0);
  const s = c.sujeto;
  assert.equal(s.personas, 2);
  assert.equal(s.estable2, true);
  assert.ok(s.cambios >= 1, 'debe detectar el cambio de interlocutor: ' + s.cambios);
  const primera = s.kf[0].cx;
  const ultima = s.kf[s.kf.length - 1].cx;
  assert.ok(primera > 0.55, 'arranca sobre la persona de la derecha: ' + primera);
  assert.ok(ultima < 0.45, 'termina sobre la persona de la izquierda: ' + ultima);
});
