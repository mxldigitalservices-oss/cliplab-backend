import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-seg-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.LOG_LEVEL = 'error';

const { planificarSegmentos, leerHistorial, registrarPasada, _reiniciarCache } = await import('../src/engine/segmentos.js');

test.after(() => fs.rm(raiz, { recursive: true, force: true }));

const rangos = (plan) => plan.segmentos.map((s) => ({ inicio: s.inicio, fin: s.inicio + s.duracion }));
const solapan = (a, b) => a.inicio < b.fin && b.inicio < a.fin;

function verificarValidez(plan, duracion) {
  const r = rangos(plan);
  for (const s of plan.segmentos) {
    assert.ok(s.duracion >= 30 && s.duracion <= 60, 'duracion 30-60, fue ' + s.duracion);
    assert.ok(s.inicio >= 0 && s.inicio + s.duracion <= duracion, 'dentro del video');
  }
  for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
    assert.ok(!solapan(r[i], r[j]), 'los clips de una misma pasada no se solapan');
  }
}

test('video largo: 4 o 5 clips de 30 a 60 s, sin solaparse y repartidos por el video', () => {
  for (const duracion of [300, 900, 3600]) {
    const plan = planificarSegmentos({ duracionVideo: duracion, semilla: 'v' + duracion });
    assert.ok(plan.segmentos.length === 4 || plan.segmentos.length === 5, 'cantidad ' + plan.segmentos.length);
    verificarValidez(plan, duracion);
  }
  const largo = planificarSegmentos({ duracionVideo: 3600, semilla: 'x' });
  const ultimo = largo.segmentos.at(-1);
  assert.ok(ultimo.inicio > 1800, 'los cortes llegan a la segunda mitad del video');
});

test('es determinista: misma semilla y pasada, mismo plan', () => {
  const a = planificarSegmentos({ duracionVideo: 1200, semilla: 'abc', pasada: 2 });
  const b = planificarSegmentos({ duracionVideo: 1200, semilla: 'abc', pasada: 2 });
  assert.deepEqual(a, b);
});

test('anti-duplicados: cada re-proceso usa rangos que no tocan ninguno anterior', () => {
  let historial = [];
  const todas = [];
  for (let pasada = 0; pasada < 3; pasada++) {
    const plan = planificarSegmentos({ duracionVideo: 1800, historial, pasada, semilla: 'mismo-video' });
    assert.equal(plan.reiniciado, false);
    verificarValidez(plan, 1800);
    for (const nuevo of rangos(plan)) {
      for (const previo of todas) assert.ok(!solapan(nuevo, previo), 'pasada ' + pasada + ' repite un momento ya usado');
    }
    todas.push(...rangos(plan));
    historial = historial.concat(rangos(plan));
  }
  assert.ok(todas.length >= 12);
});

test('video agotado: abre un ciclo nuevo y lo indica', () => {
  const historial = [{ inicio: 0, fin: 130 }];
  const plan = planificarSegmentos({ duracionVideo: 130, historial, pasada: 1, semilla: 's' });
  assert.equal(plan.reiniciado, true);
  assert.ok(plan.segmentos.length >= 1);
});

test('videos cortos: se acota para que quepan; menos de 30 s es un solo clip', () => {
  const justo = planificarSegmentos({ duracionVideo: 130, semilla: 'j' });
  assert.equal(justo.segmentos.length, 4);
  verificarValidez(justo, 130);

  const corto = planificarSegmentos({ duracionVideo: 20, semilla: 'c' });
  assert.deepEqual(corto.segmentos, [{ inicio: 0, duracion: 20 }]);

  assert.throws(() => planificarSegmentos({ duracionVideo: 0 }), /invalida/);
});

test('cantidad explicita se respeta (1-5)', () => {
  assert.equal(planificarSegmentos({ duracionVideo: 3600, semilla: 'q', cantidad: 2 }).segmentos.length, 2);
  assert.equal(planificarSegmentos({ duracionVideo: 3600, semilla: 'q', cantidad: 9 }).segmentos.length, 5);
});

test('el historial persiste en disco entre reinicios', async () => {
  await registrarPasada('vid-A', [{ inicio: 10, fin: 55 }, { inicio: 100, fin: 140 }]);
  await registrarPasada('vid-A', [{ inicio: 300, fin: 340 }]);
  _reiniciarCache(); // simula reinicio del proceso: la cache en memoria se pierde
  const h = await leerHistorial('vid-A');
  assert.equal(h.pasadas, 2);
  assert.equal(h.rangos.length, 3);
  assert.deepEqual(await leerHistorial('desconocido'), { pasadas: 0, rangos: [] });
  await registrarPasada('vid-A', [{ inicio: 1, fin: 2 }], { reiniciar: true });
  assert.equal((await leerHistorial('vid-A')).rangos.length, 1);
});
