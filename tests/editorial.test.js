import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-edit-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.LOG_LEVEL = 'error';
process.env.LOGO_ENABLED = 'false';

const { ajustarAFrases, cortesEnCaliente, planDePlanos, duracionDePlan, puntuarGancho } = await import('../src/engine/editorial.js');
const { renderizarClip } = await import('../src/engine/render.js');

test.after(() => fs.rm(raiz, { recursive: true, force: true }));

function hablar(texto, t0, ritmo = 0.35) {
  let t = t0;
  return texto.split(' ').map((w) => {
    const p = { texto: w, inicio: t, fin: t + ritmo - 0.05 };
    t += ritmo;
    return p;
  });
}

test('ajustarAFrases arranca y cierra en limites de frase, no a mitad', () => {
  const palabras = [
    ...hablar('esto viene de antes y no importa mucho.', 0),
    ...hablar('Por que nadie te cuenta este error?', 4),
    ...hablar('Porque cuesta dinero y tiempo siempre.', 8),
    ...hablar('Asi que corta aqui y sigue despues de esto.', 12),
  ];
  const r = ajustarAFrases(palabras, { objetivoInicio: 5.2, objetivoFin: 11.1, minSeg: 5, maxSeg: 20 });
  assert.equal(r.ajustado, true);
  assert.ok(Math.abs(r.inicio - (4 - 0.12)) < 0.01, 'arranca en la pregunta, fue ' + r.inicio);
  const finFrase = palabras.find((p) => p.texto === 'siempre.').fin;
  assert.ok(Math.abs(r.fin - (finFrase + 0.3)) < 0.01, 'cierra al terminar la frase, fue ' + r.fin);
});

test('el gancho (pregunta, cifra, palabra clave) puntua mas que una frase plana', () => {
  const p = [...hablar('mas o menos esto pasa asi.', 0), ...hablar('Sabes cuanto dinero pierdes?', 3)];
  assert.ok(puntuarGancho(p, 6) > puntuarGancho(p, 0));
});

test('cortesEnCaliente elimina pausas largas y remapea las palabras', () => {
  const palabras = [...hablar('uno dos tres', 0), ...hablar('cuatro cinco', 4)];
  const r = cortesEnCaliente(palabras, { umbral: 0.45, colchon: 0.1 });
  assert.equal(r.tramos.length, 2);
  assert.ok(r.eliminado > 2.5, 'quita casi toda la pausa, fue ' + r.eliminado);
  assert.ok(r.palabras[3].inicio < 1.5, 'cuatro queda pegada a tres: ' + r.palabras[3].inicio);
  for (let i = 1; i < r.palabras.length; i++) assert.ok(r.palabras[i].inicio >= r.palabras[i - 1].inicio);
});

test('planDePlanos alterna medio y cerrado y no pierde duracion', () => {
  const palabras = hablar('uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince', 0);
  const caliente = cortesEnCaliente(palabras, {});
  const plan = planDePlanos(caliente.tramos, palabras, { beatObjetivo: 3, beatMin: 1.5 });
  assert.ok(plan.length >= 2);
  plan.forEach((b, i) => assert.equal(b.plano, i % 2 === 0 ? 'medio' : 'cerrado'));
  const tramos = caliente.tramos.reduce((s, t) => s + t.hasta - t.desde, 0);
  assert.ok(Math.abs(duracionDePlan(plan) - tramos) < 0.01);
});

test('renderizarClip con cortes produce 1080x1920 y es mas corto que la ventana', async () => {
  const fuente = path.join(raiz, 'fuente.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', fuente]);
  const salida = path.join(raiz, 'salida.mp4');
  const cortes = [
    { desde: 0.5, hasta: 3.5, plano: 'medio' },
    { desde: 3.5, hasta: 5.5, plano: 'cerrado' },
    { desde: 7, hasta: 9, plano: 'medio' },
  ];
  const r = await renderizarClip({ entrada: fuente, salida, inicio: 0, duracion: 10, cortes, modo: 'recorte' });
  assert.equal(r.ancho, 1080);
  assert.equal(r.alto, 1920);
  assert.ok(Math.abs(r.duracion - 7) < 0.4, 'duracion ~7 s, fue ' + r.duracion);
  const blur = await renderizarClip({ entrada: fuente, salida: path.join(raiz, 'blur.mp4'), inicio: 0, duracion: 10, cortes, modo: 'blur' });
  assert.equal(blur.alto, 1920);
});
