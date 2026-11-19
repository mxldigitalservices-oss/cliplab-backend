import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-rot-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.LOG_LEVEL = 'error';

const { AUTO, estadoInicial, normalizarOpciones, sanearEstado, resumenCiclo, siguiente, tanda } = await import('../src/engine/rotacion.js');
const { crearRotador, rutaPorDefecto, rotador } = await import('../src/engine/rotacion-estado.js');

test.after(() => fs.rm(raiz, { recursive: true, force: true }));

const ESTILOS = ['dinamico', 'clasico', 'minimal'];

// Generador pseudoaleatorio con semilla (mulberry32): las pruebas son reproducibles.
const semilla = (s) => () => {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Avanza n elecciones con la rotacion pura y devuelve la lista de valores.
function correr(n, opciones = ESTILOS, azar = semilla(7), estado = estadoInicial()) {
  const valores = [];
  for (let i = 0; i < n; i++) {
    const r = siguiente(estado, opciones, { azar });
    valores.push(r.valor);
    estado = r.estado;
  }
  return { valores, estado };
}

// ---------------- Rotacion pura ----------------

test('cada opcion sale una vez antes de que alguna se repita', () => {
  const { valores } = correr(3);
  assert.deepEqual([...valores].sort(), [...ESTILOS].sort());
});

test('al agotar la tanda el ciclo se reinicia solo y vuelve a repartir todas', () => {
  const { valores, estado } = correr(6);
  assert.deepEqual([...valores.slice(0, 3)].sort(), [...ESTILOS].sort());
  assert.deepEqual([...valores.slice(3)].sort(), [...ESTILOS].sort());
  assert.equal(estado.total, 6);
  assert.equal(sanearEstado(estado, ESTILOS).ciclo, 2, 'dos ciclos completados');
});

test('nunca repite seguido, tampoco en el cruce entre ciclos (200 elecciones, varias semillas)', () => {
  for (const s of [1, 2, 3, 99, 12345]) {
    const { valores } = correr(200, ESTILOS, semilla(s));
    for (let i = 1; i < valores.length; i++) assert.notEqual(valores[i], valores[i - 1], `semilla ${s}, posicion ${i}`);
  }
  const dos = correr(100, ['a', 'b'], semilla(5)).valores;
  for (let i = 1; i < dos.length; i++) assert.notEqual(dos[i], dos[i - 1], 'con 2 opciones alterna siempre');
});

test('reparto justo: tras ciclos completos cada opcion se uso exactamente lo mismo', () => {
  const { valores } = correr(300, ESTILOS, semilla(42));
  const cuenta = Object.fromEntries(ESTILOS.map((e) => [e, valores.filter((v) => v === e).length]));
  assert.deepEqual(cuenta, { dinamico: 100, clasico: 100, minimal: 100 });
});

test('el orden dentro del ciclo varia (no es siempre la misma secuencia)', () => {
  const ordenes = new Set();
  for (let s = 1; s <= 30; s++) ordenes.add(correr(3, ESTILOS, semilla(s)).valores.join('>'));
  assert.ok(ordenes.size >= 3, 'esperaba varios ordenes distintos, hubo ' + ordenes.size);
});

test('es determinista con el mismo azar y no muta el estado de entrada', () => {
  assert.deepEqual(correr(10, ESTILOS, semilla(3)), correr(10, ESTILOS, semilla(3)));
  const entrada = Object.freeze({ usadas: Object.freeze(['clasico']), ultima: 'clasico', ciclo: 1, total: 4 });
  const r = siguiente(entrada, ESTILOS, { azar: () => 0 });
  assert.deepEqual(entrada.usadas, ['clasico']);
  assert.deepEqual(r.estado.usadas, ['clasico', r.valor]);
  assert.equal(r.estado.total, 5);
});

test('una sola opcion: siempre la misma, sin romperse al reiniciar', () => {
  const { valores } = correr(5, ['unica']);
  assert.deepEqual(valores, ['unica', 'unica', 'unica', 'unica', 'unica']);
});

test('azar fuera de rango (0, 1, NaN, negativo) nunca da una opcion inexistente', () => {
  for (const v of [0, 0.999999, 1, 7, NaN, -3]) {
    const r = siguiente(estadoInicial(), ESTILOS, { azar: () => v });
    assert.ok(ESTILOS.includes(r.valor), 'azar=' + v);
  }
});

test('valor manual: se respeta, no consume el ciclo y "auto"/vacio rotan', () => {
  const base = correr(1, ESTILOS, semilla(1));
  const m = siguiente(base.estado, ESTILOS, { manual: 'minimal' });
  assert.equal(m.valor, 'minimal');
  assert.equal(m.origen, 'manual');
  assert.deepEqual(m.estado, sanearEstado(base.estado, ESTILOS), 'el ciclo no cambia');
  for (const v of [undefined, null, '', '  ', AUTO, 'AUTO']) {
    assert.equal(siguiente(base.estado, ESTILOS, { manual: v, azar: () => 0 }).origen, 'rotacion', JSON.stringify(v));
  }
  assert.throws(() => siguiente(base.estado, ESTILOS, { manual: 'neon' }), /Opcion invalida: "neon"/);
});

test('estado corrupto o viejo se sanea: desconocidos, duplicados, contadores locos', () => {
  const s = sanearEstado({ usadas: ['clasico', 'clasico', 'borrado', 7, null], ultima: 'borrado', ciclo: -5, total: 'x' }, ESTILOS);
  assert.deepEqual(s, { usadas: ['clasico'], ultima: null, ciclo: 0, total: 0 });
  for (const malo of [null, undefined, 42, 'texto', [], { usadas: 'dinamico' }]) {
    assert.deepEqual(sanearEstado(malo, ESTILOS), estadoInicial(), JSON.stringify(malo));
  }
});

test('si todas las opciones ya estaban usadas, se reinicia el ciclo al sanear', () => {
  const s = sanearEstado({ usadas: [...ESTILOS], ultima: 'minimal', ciclo: 2, total: 6 }, ESTILOS);
  assert.deepEqual(s, { usadas: [], ultima: 'minimal', ciclo: 3, total: 6 });
});

test('cambiar la lista de opciones: la nueva entra al ciclo y la quitada deja de contar', () => {
  const { estado } = correr(2, ESTILOS, semilla(11));
  const ampliada = [...ESTILOS, 'neon'];
  const r = resumenCiclo(estado, ampliada);
  assert.ok(r.restantes.includes('neon'), 'neon aun no se uso en este ciclo');
  const restantes = resumenCiclo(estado, ESTILOS.filter((e) => e !== estado.usadas[0]));
  assert.ok(!restantes.usadas.includes(estado.usadas[0]));
});

test('resumenCiclo informa usadas, restantes, ultima y contadores', () => {
  const { estado } = correr(4, ESTILOS, semilla(2));
  const r = resumenCiclo(estado, ESTILOS);
  assert.equal(r.usadas.length, 1);
  assert.equal(r.restantes.length, 2);
  assert.equal(r.ciclo, 1);
  assert.equal(r.total, 4);
  assert.equal(r.ultima, estado.ultima);
});

test('el reinicio se avisa solo cuando de verdad abre un ciclo nuevo', () => {
  let estado = estadoInicial();
  const avisos = [];
  for (let i = 0; i < 7; i++) { const r = siguiente(estado, ESTILOS, { azar: semilla(i + 1) }); avisos.push(r.reinicio); estado = r.estado; }
  assert.deepEqual(avisos, [false, false, false, true, false, false, true]);
});

test('tanda: n elecciones seguidas, distintas hasta agotar y cruzando el reinicio sin repetir seguido', () => {
  const t = tanda(estadoInicial(), ESTILOS, 5, { azar: semilla(8) });
  assert.equal(t.valores.length, 5);
  assert.deepEqual([...t.valores.slice(0, 3)].sort(), [...ESTILOS].sort());
  assert.notEqual(t.valores[3], t.valores[2]);
  assert.notEqual(t.valores[4], t.valores[3]);
  assert.equal(t.reinicios, 1);
  for (const n of [0, 101, 1.5, 'x']) assert.throws(() => tanda(estadoInicial(), ESTILOS, n), /entero entre 1 y 100/);
  assert.deepEqual(tanda(estadoInicial(), ESTILOS, 3, { manual: 'clasico' }).valores, ['clasico', 'clasico', 'clasico']);
});

test('normalizarOpciones: limpia, deduplica y exige al menos una', () => {
  assert.deepEqual(normalizarOpciones([' a ', 'b', 'a', '', null, 'c']), ['a', 'b', 'c']);
  for (const malo of [[], [''], null, undefined, 'a']) assert.throws(() => normalizarOpciones(malo), /al menos una opcion/);
  assert.throws(() => siguiente(estadoInicial(), []), /al menos una opcion/);
});

// ---------------- Persistencia ligera ----------------

const nuevaRuta = async (nombre) => path.join(await fs.mkdtemp(path.join(raiz, nombre + '-')), 'datos', 'rotacion.json');

test('la ruta por defecto vive dentro de DATA_DIR', () => {
  assert.equal(rutaPorDefecto(), path.join(process.env.DATA_DIR, 'rotacion.json'));
});

test('persiste en un JSON diminuto y el ciclo sobrevive a un reinicio de la app', async () => {
  const ruta = await nuevaRuta('persiste');
  const a = crearRotador({ ruta, azar: semilla(4) });
  const dos = [(await a.elegir('estilo', ESTILOS)).valor, (await a.elegir('estilo', ESTILOS)).valor];

  const bruto = await fs.readFile(ruta, 'utf8');
  assert.ok(bruto.length < 400, 'el archivo debe ser diminuto, pesa ' + bruto.length);
  const json = JSON.parse(bruto);
  assert.equal(json.version, 1);
  assert.deepEqual(json.canales.estilo.usadas, dos);

  const b = crearRotador({ ruta, azar: semilla(9) }); // "reinicio": instancia nueva leyendo el mismo archivo
  const tercero = (await b.elegir('estilo', ESTILOS)).valor;
  assert.deepEqual([...dos, tercero].sort(), [...ESTILOS].sort(), 'continua el ciclo sin repetir');
  const cuarto = await b.elegir('estilo', ESTILOS);
  assert.equal(cuarto.reinicio, true);
  assert.notEqual(cuarto.valor, tercero);
});

test('un archivo corrupto no tumba nada: se empieza limpio y se reescribe valido', async () => {
  const ruta = await nuevaRuta('corrupto');
  await fs.mkdir(path.dirname(ruta), { recursive: true });
  for (const basura of ['{no es json', '', '[]', 'null', '{"canales": 5}', '{"canales": {"estilo": "x"}}']) {
    await fs.writeFile(ruta, basura);
    const r = crearRotador({ ruta, azar: () => 0 });
    const e = await r.elegir('estilo', ESTILOS);
    assert.ok(ESTILOS.includes(e.valor), JSON.stringify(basura));
    assert.ok(JSON.parse(await fs.readFile(ruta, 'utf8')).canales.estilo.usadas.length === 1);
  }
});

test('50 llamadas simultaneas no se pisan: reparto exacto y archivo coherente', async () => {
  const ruta = await nuevaRuta('concurrente');
  const r = crearRotador({ ruta, azar: semilla(21) });
  const res = await Promise.all(Array.from({ length: 51 }, () => r.elegir('estilo', ESTILOS)));
  const cuenta = Object.fromEntries(ESTILOS.map((e) => [e, res.filter((x) => x.valor === e).length]));
  assert.deepEqual(cuenta, { dinamico: 17, clasico: 17, minimal: 17 });
  const enDisco = JSON.parse(await fs.readFile(ruta, 'utf8')).canales.estilo;
  assert.equal(enDisco.total, 51);
  assert.equal(enDisco.ciclo, 16, '16 ciclos cerrados; el 17 quedo completo y se reinicia al siguiente uso');
  assert.equal(enDisco.usadas.length, 3);
  assert.deepEqual((await fs.readdir(path.dirname(ruta))).sort(), ['rotacion.json'], 'sin temporales sobrantes');
});

test('un valor manual no escribe a disco ni toca el ciclo', async () => {
  const ruta = await nuevaRuta('manual');
  const r = crearRotador({ ruta, azar: () => 0 });
  const m = await r.elegir('estilo', ESTILOS, { manual: 'clasico' });
  assert.deepEqual([m.valor, m.origen], ['clasico', 'manual']);
  assert.equal(r.escrituras, 0);
  await assert.rejects(() => fs.access(ruta), 'ni siquiera se crea el archivo');
  await r.elegir('estilo', ESTILOS);
  assert.equal(r.escrituras, 1);
  await r.elegir('estilo', ESTILOS, { manual: 'minimal' });
  assert.equal(r.escrituras, 1);
  await assert.rejects(() => r.elegir('estilo', ESTILOS, { manual: 'neon' }), /Opcion invalida/);
});

test('canales independientes: estilo y modo rotan cada uno por su lado', async () => {
  const ruta = await nuevaRuta('canales');
  const r = crearRotador({ ruta, azar: semilla(6) });
  const estilos = [], modos = [];
  for (let i = 0; i < 3; i++) { estilos.push((await r.elegir('estilo', ESTILOS)).valor); modos.push((await r.elegir('modo', ['recorte', 'blur'])).valor); }
  assert.deepEqual([...estilos].sort(), [...ESTILOS].sort());
  assert.notEqual(modos[0], modos[1]);
  assert.notEqual(modos[1], modos[2]);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(ruta, 'utf8')).canales).sort(), ['estilo', 'modo']);
});

test('elegirTanda hace una sola escritura y respeta manual', async () => {
  const ruta = await nuevaRuta('tanda');
  const r = crearRotador({ ruta, azar: semilla(13) });
  const t = await r.elegirTanda('estilo', ESTILOS, 5);
  assert.equal(t.valores.length, 5);
  assert.equal(t.reinicios, 1);
  assert.equal(r.escrituras, 1);
  const m = await r.elegirTanda('estilo', ESTILOS, 4, { manual: 'minimal' });
  assert.deepEqual(m.valores, ['minimal', 'minimal', 'minimal', 'minimal']);
  assert.equal(r.escrituras, 1, 'manual no escribe');
});

test('estado() solo lee; reiniciar() borra un canal o todos', async () => {
  const ruta = await nuevaRuta('reinicio');
  const r = crearRotador({ ruta, azar: () => 0 });
  await r.elegir('estilo', ESTILOS); await r.elegir('modo', ['recorte', 'blur']);
  const antes = r.escrituras;
  const e = await r.estado('estilo', ESTILOS);
  assert.equal(e.usadas.length, 1);
  assert.equal(r.escrituras, antes);
  await r.reiniciar('estilo');
  assert.equal((await r.estado('estilo', ESTILOS)).usadas.length, 0);
  assert.equal((await r.estado('modo', ['recorte', 'blur'])).usadas.length, 1, 'el otro canal sigue');
  await r.reiniciar();
  assert.equal((await r.estado('modo', ['recorte', 'blur'])).usadas.length, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(ruta, 'utf8')).canales, {});
});

test('nombres de canal peligrosos o invalidos se rechazan', async () => {
  const r = crearRotador({ ruta: await nuevaRuta('nombres'), azar: () => 0 });
  for (const malo of ['__proto__', '_oculto', '1estilo', '../x', 'a b', '', 'x'.repeat(40), null, 5, 'constructor ']) {
    await assert.rejects(() => r.elegir(malo, ESTILOS), /Nombre de canal invalido|invalido/, String(malo));
  }
  assert.equal(({}).polluted, undefined);
  assert.ok((await r.elegir('constructor', ESTILOS)).valor, 'constructor es un nombre valido y no ensucia nada');
});

test('si cambian las opciones entre ejecuciones, el estado guardado se adapta sin errores', async () => {
  const ruta = await nuevaRuta('cambio');
  const a = crearRotador({ ruta, azar: () => 0 });
  await a.elegir('estilo', ESTILOS); await a.elegir('estilo', ESTILOS);
  const b = crearRotador({ ruta, azar: () => 0 });
  const r = await b.elegir('estilo', ['clasico', 'minimal', 'neon']);
  assert.ok(['clasico', 'minimal', 'neon'].includes(r.valor));
});

test('el singleton de la app escribe en DATA_DIR/rotacion.json', async () => {
  const r = await rotador.elegir('estilo', ESTILOS);
  assert.ok(ESTILOS.includes(r.valor));
  const json = JSON.parse(await fs.readFile(path.join(process.env.DATA_DIR, 'rotacion.json'), 'utf8'));
  assert.equal(json.canales.estilo.total, 1);
  await rotador.reiniciar();
});
