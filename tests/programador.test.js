import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-prog-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.CLIPS_DIR = path.join(raiz, 'clips');
process.env.LOG_LEVEL = 'error';
delete process.env.MONGODB_URI;

const { crearProgramador, leerConfigProgramador, normalizar, VENTANA_MS, TOPE_DURO_POR_VENTANA } = await import('../src/engine/programador.js');
const { publicarClip, crearDriverSeco } = await import('../src/engine/publicador.js');
const { store } = await import('../src/storage/store.js');

const MIN = 60000;
const HORA = 3600000;
const LUNES_8AM_RD = Date.UTC(2026, 10, 16, 12, 0, 0); // lunes 16-nov-2026, 08:00 en UTC-4

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let n = 0;
const ruta = () => path.join(raiz, 'prog-' + ++n + '.json');
const okPublicador = (plataformas) => ({
  ok: true,
  resultados: Object.fromEntries(plataformas.map((p) => [p, { ok: true, error: null, detalle: 'ok', timestamp: new Date().toISOString(), transitorio: false }])),
});
const falla = (codigo, transitorio) => ({ ok: false, error: 'fallo ' + codigo, codigo, detalle: 'd', timestamp: new Date().toISOString(), transitorio });

/** Programador con reloj simulado y publicador falso que anota cada llamada. */
async function crear(extra = {}) {
  const reloj = { ms: extra.t0 ?? LUNES_8AM_RD };
  const llamadas = [];
  const publicar = extra.publicar || (async (spec) => {
    llamadas.push({ ms: reloj.ms, ...spec });
    return okPublicador(spec.plataformas);
  });
  const prog = crearProgramador({
    ahora: () => reloj.ms,
    azar: mulberry32(extra.seed ?? 1),
    publicar,
    rutaJson: extra.rutaJson || ruta(),
    mongoUri: extra.mongoUri ?? '',
    cargarMongo: extra.cargarMongo,
    config: extra.config || {},
  });
  await prog.cargar();
  return { prog, reloj, llamadas };
}

async function avanzar(prog, reloj, hasta, paso = MIN) {
  while (reloj.ms < hasta) {
    reloj.ms += paso;
    await prog.tick();
  }
}

const encolarN = async (prog, cantidad, plataformas = ['tiktok']) => {
  for (let i = 0; i < cantidad; i++) await prog.encolar({ rutaVideo: '/tmp/v' + i + '.mp4', descripcion: 'clip ' + i, platforms: plataformas });
};

function mongoFalso({ fallarConexion = false } = {}) {
  const colecciones = new Map();
  const estado = { fallarEscrituras: false };
  const col = (nombre) => {
    if (!colecciones.has(nombre)) colecciones.set(nombre, new Map());
    return colecciones.get(nombre);
  };
  const coincide = (doc, filtro) => Object.entries(filtro).every(([k, v]) => (v && v.$in ? v.$in.includes(doc[k]) : doc[k] === v));
  class Cursor {
    constructor(docs) { this.docs = docs; }
    sort(o) { const [k, d] = Object.entries(o)[0]; this.docs.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * d); return this; }
    limit(c) { this.docs = this.docs.slice(0, c); return this; }
    async toArray() { return structuredClone(this.docs); }
  }
  const coleccion = (nombre) => ({
    createIndex: async () => {},
    find: (f) => new Cursor([...col(nombre).values()].filter((d) => coincide(d, f))),
    findOne: async (f) => { const d = [...col(nombre).values()].find((x) => coincide(x, f)); return d ? structuredClone(d) : null; },
    replaceOne: async (f, doc) => { if (estado.fallarEscrituras) throw new Error('mongo caido'); col(nombre).set(f._id, structuredClone(doc)); },
    insertOne: async (doc) => { if (estado.fallarEscrituras) throw new Error('mongo caido'); col(nombre).set(doc._id, structuredClone(doc)); },
  });
  class MongoClient {
    constructor(uri) { this.uri = uri; }
    async connect() { if (fallarConexion) throw new Error('ECONNREFUSED 127.0.0.1:27017'); }
    db() { return { command: async () => ({ ok: 1 }), collection: coleccion }; }
    async close() {}
  }
  return { modulo: { MongoClient }, colecciones, estado };
}

// ------------------------------ configuracion --------------------------------

test('el tope de 2 ejecuciones por hora no se puede subir por configuracion', () => {
  assert.equal(TOPE_DURO_POR_VENTANA, 2);
  assert.equal(VENTANA_MS, HORA);
  assert.equal(leerConfigProgramador({ PROG_MAX_POR_HORA: '10' }).maxPorVentana, 2);
  assert.equal(leerConfigProgramador({}).maxPorVentana, 2);
  assert.equal(leerConfigProgramador({ PROG_MAX_POR_HORA: '1' }).maxPorVentana, 1);
  const c = normalizar({ ...leerConfigProgramador({}), maxPorVentana: 99, enviosDiaMin: 0, enviosDiaMax: -3, gapMinMs: 10, gapMaxMs: 5, horaDesde: 20, horaHasta: 3 });
  assert.equal(c.maxPorVentana, 2);
  assert.equal(c.enviosDiaMin, 1);
  assert.ok(c.enviosDiaMax >= c.enviosDiaMin);
  assert.ok(c.gapMaxMs >= c.gapMinMs);
  assert.ok(c.horaHasta > c.horaDesde);
});

// ------------------------------- persistencia --------------------------------

test('sin MONGODB_URI usa el respaldo JSON local y la cola sobrevive a un reinicio', async () => {
  const rutaJson = ruta();
  const a = await crear({ rutaJson, mongoUri: '' });
  assert.equal(a.prog.estado().backend, 'json');
  const job = await a.prog.encolar({ rutaVideo: '/tmp/a.mp4', descripcion: 'hola', etiquetas: ['x'], platforms: ['tiktok', 'instagram'] });
  assert.equal(job.status, 'queued');
  assert.equal(job.attempts, 0);
  assert.equal(job.lastError, null);
  assert.deepEqual(job.platforms, ['tiktok', 'instagram']);
  assert.ok(!Number.isNaN(Date.parse(job.scheduledAt)));
  const enDisco = JSON.parse(await fs.readFile(rutaJson, 'utf8'));
  assert.equal(enDisco.jobs.length, 1);
  assert.equal(enDisco.jobs[0].id, job.id);
  const b = await crear({ rutaJson });
  assert.equal(b.prog.obtener(job.id).descripcion, 'hola');
});

test('con MONGODB_URI pero sin el modulo mongodb instalado (caso real de este repo): respaldo JSON', async () => {
  const { prog } = await crear({ mongoUri: 'mongodb://127.0.0.1:27017/x' }); // cargarMongo por defecto = import('mongodb')
  assert.equal(prog.estado().backend, 'json');
  await encolarN(prog, 1);
  assert.equal(prog.listar().length, 1);
});

test('si la conexion a MongoDB falla: respaldo JSON automatico', async () => {
  const m = mongoFalso({ fallarConexion: true });
  const { prog } = await crear({ mongoUri: 'mongodb://x', cargarMongo: async () => m.modulo });
  assert.equal(prog.estado().backend, 'json');
  assert.equal(m.colecciones.size, 0);
});

test('con MongoDB disponible: cola, historial y estado van a sus colecciones y se recuperan en otra instancia', async () => {
  const m = mongoFalso();
  const cargarMongo = async () => m.modulo;
  const a = await crear({ mongoUri: 'mongodb://x', cargarMongo, config: { gapMinMs: 0, gapMaxMs: 0, probPausaLarga: 0, probDiaInactivo: 0, maxDiasInactivosSemana: 0, arranqueMaxMs: 0 } });
  assert.equal(a.prog.estado().backend, 'mongo');
  const job = await a.prog.encolar({ rutaVideo: '/tmp/m.mp4', platforms: ['facebook'] });
  await avanzar(a.prog, a.reloj, a.reloj.ms + 5 * MIN);
  assert.equal(a.prog.obtener(job.id).status, 'published');
  assert.equal(m.colecciones.get('cliplab_cola').get(job.id).status, 'published');
  assert.equal(m.colecciones.get('cliplab_historial').size, 1);
  assert.ok(m.colecciones.get('cliplab_programador').get('estado').ejecuciones.length === 1);
  const b = await crear({ mongoUri: 'mongodb://x', cargarMongo, t0: a.reloj.ms });
  assert.equal(b.prog.obtener(job.id).status, 'published');
  assert.equal(b.prog.historial().length, 1);
  assert.equal(b.prog.historial()[0].resultados.facebook.ok, true);
});

test('si MongoDB se cae a mitad de camino, pasa al JSON local sin perder la cola', async () => {
  const m = mongoFalso();
  const rutaJson = ruta();
  const { prog } = await crear({ rutaJson, mongoUri: 'mongodb://x', cargarMongo: async () => m.modulo });
  assert.equal(prog.estado().backend, 'mongo');
  await encolarN(prog, 1);
  m.estado.fallarEscrituras = true;
  await encolarN(prog, 1);
  assert.equal(prog.estado().backend, 'json');
  const disco = JSON.parse(await fs.readFile(rutaJson, 'utf8'));
  assert.equal(disco.jobs.length, 2);
});

test('un trabajo que quedo en running tras un reinicio NO se reintenta solo (evita duplicar el post)', async () => {
  const rutaJson = ruta();
  const { prog, reloj } = await crear({ rutaJson });
  const job = await prog.encolar({ rutaVideo: '/tmp/r.mp4', platforms: ['tiktok'] });
  const disco = JSON.parse(await fs.readFile(rutaJson, 'utf8'));
  disco.jobs[0].status = 'running';
  await fs.writeFile(rutaJson, JSON.stringify(disco));
  const otra = await crear({ rutaJson, t0: reloj.ms });
  const recuperado = otra.prog.obtener(job.id);
  assert.equal(recuperado.status, 'failed');
  assert.match(recuperado.lastError, /Interrumpido/);
  const re = await otra.prog.reintentar(job.id);
  assert.equal(re.status, 'queued');
});

// ----------------------------------- ritmo -----------------------------------

const CONFIG_SATURADO = { gapMinMs: 0, gapMaxMs: 0, probPausaLarga: 0, probDiaInactivo: 0, maxDiasInactivosSemana: 0, arranqueMaxMs: 0, enviosDiaMin: 50, enviosDiaMax: 50, maxPorVentana: 99 };

test('tope duro: nunca mas de 2 ejecuciones en 60 min, aunque la config lo permita y haya cola de sobra', async () => {
  const { prog, reloj, llamadas } = await crear({ config: CONFIG_SATURADO });
  assert.equal(prog.config.maxPorVentana, 2);
  await encolarN(prog, 30);
  await avanzar(prog, reloj, LUNES_8AM_RD + 6 * HORA);
  const t = llamadas.map((l) => l.ms);
  assert.ok(t.length >= 10, 'debe aprovechar el cupo: ' + t.length);
  assert.ok(t.length <= 12 + 2, 'no puede pasar de 2 por hora: ' + t.length);
  for (let i = 0; i + 2 < t.length; i++) assert.ok(t[i + 2] - t[i] > HORA, 'tres ejecuciones dentro de una hora en ' + i);
  assert.equal(prog.estado().cupoHorario.maximo, 2);
});

test('tope duro con 25 semillas y la config por defecto, 7 dias de cola abundante', async () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { prog, reloj, llamadas } = await crear({ seed });
    await encolarN(prog, 60, ['tiktok', 'instagram']);
    await avanzar(prog, reloj, LUNES_8AM_RD + 7 * 24 * HORA, 2 * MIN);
    const t = llamadas.map((l) => l.ms);
    for (let i = 0; i + 2 < t.length; i++) assert.ok(t[i + 2] - t[i] > HORA, 'semilla ' + seed + ': 3 ejecuciones en <=60 min');
  }
});

test('cadencia irregular: las esperas entre ejecuciones varian y respetan el minimo configurado', async () => {
  const gaps = [];
  for (const seed of [3, 11, 42]) {
    const { prog, reloj, llamadas } = await crear({ seed });
    await encolarN(prog, 80);
    await avanzar(prog, reloj, LUNES_8AM_RD + 21 * 24 * HORA, 30000);
    const t = llamadas.map((l) => l.ms);
    for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
  }
  assert.ok(gaps.length > 40);
  const minutos = gaps.map((g) => Math.round(g / 1000));
  assert.ok(gaps.every((g) => g >= 15 * MIN), 'nunca menos del gap minimo (15 min)');
  assert.ok(new Set(minutos).size > gaps.length * 0.8, 'casi todas las esperas distintas');
  const media = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const desv = Math.sqrt(gaps.reduce((a, b) => a + (b - media) ** 2, 0) / gaps.length);
  assert.ok(desv > 5 * MIN, 'desviacion tipica alta: ' + Math.round(desv / MIN) + ' min');
});

test('plan diario/semanal: 1 a 3 envios por dia activo, dias inactivos aleatorios, solo en horario', async () => {
  const { prog, reloj, llamadas } = await crear({ seed: 5 });
  await encolarN(prog, 200);
  await avanzar(prog, reloj, LUNES_8AM_RD + 28 * 24 * HORA, 60000);
  const porDia = {};
  for (const l of llamadas) {
    const local = new Date(l.ms - 4 * HORA);
    const dia = local.toISOString().slice(0, 10);
    porDia[dia] = (porDia[dia] || 0) + 1;
    const h = local.getUTCHours() + local.getUTCMinutes() / 60;
    assert.ok(h >= 8 && h < 23, 'fuera de horario: ' + h);
  }
  const conteos = Object.values(porDia);
  assert.ok(conteos.every((c) => c >= 1 && c <= 3), 'dias activos con 1..3 envios: ' + JSON.stringify(porDia));
  const diasConEnvio = Object.keys(porDia).length;
  assert.ok(diasConEnvio < 28, 'debe haber dias inactivos (hubo envios en ' + diasConEnvio + ' de 28)');
  assert.ok(diasConEnvio >= 14, 'pero no quedarse casi sin actividad: ' + diasConEnvio);
  assert.ok(new Set(conteos).size >= 2, 'el numero de envios por dia debe variar');
  const semanas = {};
  for (const dia of Object.keys(porDia)) {
    const d = new Date(dia + 'T00:00:00Z');
    const lunes = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 24 * HORA).toISOString().slice(0, 10);
    semanas[lunes] = (semanas[lunes] || 0) + porDia[dia];
  }
  assert.ok(new Set(Object.values(semanas)).size >= 2, 'el total semanal tambien varia');
});

test('el plan del dia queda guardado: reiniciar el proceso no regenera cupos ni permite una rafaga', async () => {
  const rutaJson = ruta();
  const a = await crear({ rutaJson, seed: 8, config: { ...CONFIG_SATURADO, enviosDiaMin: 2, enviosDiaMax: 2 } });
  await encolarN(a.prog, 10);
  await avanzar(a.prog, a.reloj, LUNES_8AM_RD + 3 * HORA);
  assert.equal(a.llamadas.length, 2);
  const b = await crear({ rutaJson, seed: 99, t0: a.reloj.ms, config: { ...CONFIG_SATURADO, enviosDiaMin: 2, enviosDiaMax: 2 }, publicar: async (s) => okPublicador(s.plataformas) });
  const ya = b.prog.estado();
  assert.equal(ya.hoy.ejecutados, 2);
  assert.equal(ya.cupoHorario.usados > 0 || ya.hoy.ejecutados === 2, true);
  const r = await b.prog.tick();
  assert.equal(r.ejecutado, false);
});

test('ejecucion estrictamente secuencial: tick simultaneos no se solapan', async () => {
  let activos = 0;
  let maximo = 0;
  let total = 0;
  const publicar = async (spec) => {
    activos++;
    total++;
    maximo = Math.max(maximo, activos);
    await new Promise((r) => setTimeout(r, 25));
    activos--;
    return okPublicador(spec.plataformas);
  };
  const { prog, reloj } = await crear({ publicar, config: CONFIG_SATURADO });
  await encolarN(prog, 5);
  reloj.ms += MIN;
  const resultados = await Promise.all([prog.tick(), prog.tick(), prog.tick(), prog.tick()]);
  assert.equal(resultados.filter((r) => r.ejecutado).length, 1);
  assert.equal(resultados.filter((r) => r.motivo === 'ocupado').length, 3);
  for (let i = 0; i < 6; i++) {
    reloj.ms += 2 * MIN;
    await Promise.all([prog.tick(), prog.tick()]);
  }
  assert.equal(maximo, 1);
  assert.ok(total >= 2);
});

test('scheduledAt en el futuro no se ejecuta hasta su hora', async () => {
  const { prog, reloj, llamadas } = await crear({ config: CONFIG_SATURADO });
  const luego = new Date(LUNES_8AM_RD + 3 * HORA).toISOString();
  await prog.encolar({ rutaVideo: '/tmp/f.mp4', platforms: ['tiktok'], scheduledAt: luego });
  await avanzar(prog, reloj, LUNES_8AM_RD + 2 * HORA);
  assert.equal(llamadas.length, 0);
  await avanzar(prog, reloj, LUNES_8AM_RD + 4 * HORA);
  assert.equal(llamadas.length, 1);
  assert.ok(llamadas[0].ms >= Date.parse(luego));
});

// ----------------------------- reintentos / backoff ---------------------------

test('fallo transitorio: backoff con jitter, no bloquea a otros clips, y luego se publica', async () => {
  const intentos = {};
  const publicar = async (spec) => {
    intentos[spec.rutaVideo] = (intentos[spec.rutaVideo] || 0) + 1;
    if (spec.rutaVideo === '/tmp/A.mp4' && intentos[spec.rutaVideo] === 1) {
      return { ok: false, resultados: { tiktok: falla('TIMEOUT', true) } };
    }
    return okPublicador(spec.plataformas);
  };
  const { prog, reloj } = await crear({ publicar, config: CONFIG_SATURADO });
  const a = await prog.encolar({ rutaVideo: '/tmp/A.mp4', platforms: ['tiktok'], scheduledAt: new Date(LUNES_8AM_RD).toISOString() });
  const b = await prog.encolar({ rutaVideo: '/tmp/B.mp4', platforms: ['tiktok'], scheduledAt: new Date(LUNES_8AM_RD + 1000).toISOString() });
  reloj.ms += MIN;
  await prog.tick();
  const trasPrimero = prog.obtener(a.id);
  assert.equal(trasPrimero.status, 'queued');
  assert.equal(trasPrimero.attempts, 1);
  assert.match(trasPrimero.lastError, /tiktok: fallo TIMEOUT/);
  const espera = Date.parse(trasPrimero.scheduledAt) - reloj.ms;
  assert.ok(espera >= 90000 && espera <= 150000, 'backoff base 120 s +-25%: ' + espera);
  for (let i = 0; i < 4; i++) { reloj.ms += MIN; await prog.tick(); }
  assert.equal(prog.obtener(b.id).status, 'published', 'B no queda bloqueado por A');
  // A y B ya gastaron el cupo de la hora: el reintento de A espera aunque su backoff (~2 min) ya vencio.
  await avanzar(prog, reloj, reloj.ms + 30 * MIN);
  assert.equal(prog.obtener(a.id).status, 'queued', 'el tope de 2/hora manda sobre el backoff');
  await avanzar(prog, reloj, reloj.ms + 45 * MIN);
  const fin = prog.obtener(a.id);
  assert.equal(fin.status, 'published');
  assert.equal(fin.attempts, 2);
  assert.equal(fin.lastError, null);
});

test('reintento parcial: solo se vuelve a publicar donde falto (sin duplicar donde ya salio)', async () => {
  const peticiones = [];
  const publicar = async (spec) => {
    peticiones.push(spec.plataformas.slice());
    if (peticiones.length === 1) {
      return { ok: false, resultados: { tiktok: okPublicador(['tiktok']).resultados.tiktok, instagram: falla('TIMEOUT', true) } };
    }
    return okPublicador(spec.plataformas);
  };
  const { prog, reloj } = await crear({ publicar, config: CONFIG_SATURADO });
  const job = await prog.encolar({ rutaVideo: '/tmp/p.mp4', platforms: ['tiktok', 'instagram'] });
  await avanzar(prog, reloj, reloj.ms + 30 * MIN);
  assert.deepEqual(peticiones, [['tiktok', 'instagram'], ['instagram']]);
  const fin = prog.obtener(job.id);
  assert.equal(fin.status, 'published');
  assert.equal(fin.resultados.tiktok.ok, true);
  assert.equal(fin.resultados.instagram.ok, true);
  assert.equal(prog.historial().length, 2);
});

test('error definitivo => failed al primer intento; transitorio repetido => failed al agotar intentos', async () => {
  const { prog, reloj } = await crear({
    config: { ...CONFIG_SATURADO, maxIntentos: 3, backoffBaseMs: 1000, backoffMaxMs: 2000 },
    publicar: async (spec) => ({ ok: false, resultados: Object.fromEntries(spec.plataformas.map((p) => [p, p === 'tiktok' ? falla('SIN_SESION', false) : falla('TIMEOUT', true)])) }),
  });
  const definitivo = await prog.encolar({ rutaVideo: '/tmp/d.mp4', platforms: ['tiktok'] });
  const transitorio = await prog.encolar({ rutaVideo: '/tmp/t.mp4', platforms: ['facebook'] });
  await avanzar(prog, reloj, reloj.ms + 3 * HORA, 30000);
  const d = prog.obtener(definitivo.id);
  const t = prog.obtener(transitorio.id);
  assert.equal(d.status, 'failed');
  assert.equal(d.attempts, 1);
  assert.equal(t.status, 'failed');
  assert.equal(t.attempts, 3);
  assert.match(t.lastError, /facebook/);
});

test('si el publicador lanza una excepcion o se cuelga, el trabajo se reprograma y la cola sigue viva', async () => {
  let llamadas = 0;
  const { prog, reloj } = await crear({
    config: { ...CONFIG_SATURADO, timeoutMs: 1000 },
    publicar: (spec) => {
      llamadas++;
      if (llamadas === 1) return Promise.reject(new Error('explotó el navegador'));
      if (llamadas === 2) return new Promise(() => {}); // se cuelga para siempre
      return Promise.resolve(okPublicador(spec.plataformas));
    },
  });
  const job = await prog.encolar({ rutaVideo: '/tmp/x.mp4', platforms: ['tiktok'] });
  reloj.ms += MIN;
  await prog.tick();
  assert.equal(prog.obtener(job.id).status, 'queued');
  assert.match(prog.obtener(job.id).lastError, /explot/);
  reloj.ms += 10 * MIN;
  await prog.tick(); // se cuelga: debe liberarse por tiempo limite (1 s reales)
  assert.equal(prog.estado().ocupado, false);
  assert.match(prog.obtener(job.id).lastError, /Tiempo de publicacion agotado/);
  await avanzar(prog, reloj, reloj.ms + HORA);
  assert.equal(prog.obtener(job.id).status, 'published');
});

// ------------------------------ API de la cola --------------------------------

test('cancelar / reintentar / validaciones de encolar', async () => {
  const { prog } = await crear();
  const job = await prog.encolar({ rutaVideo: '/tmp/c.mp4', platforms: ['TikTok', 'tiktok', 'facebook'] });
  assert.deepEqual(job.platforms, ['tiktok', 'facebook']);
  assert.equal((await prog.cancelar(job.id)).status, 'cancelled');
  await assert.rejects(prog.cancelar(job.id), { codigo: 'NO_CANCELABLE' });
  await assert.rejects(prog.cancelar('nope'), { codigo: 'NO_ENCONTRADO' });
  assert.equal((await prog.reintentar(job.id)).status, 'queued');
  await assert.rejects(prog.reintentar(job.id), { codigo: 'NO_REINTENTABLE' });
  await assert.rejects(prog.encolar({ rutaVideo: '/tmp/c.mp4', platforms: [] }), { codigo: 'SIN_PLATAFORMAS' });
  await assert.rejects(prog.encolar({ rutaVideo: '/tmp/c.mp4', platforms: ['youtube'] }), { codigo: 'PLATAFORMA_INVALIDA' });
  await assert.rejects(prog.encolar({ rutaVideo: '/tmp/c.mp4', platforms: ['tiktok'], scheduledAt: 'ayer' }), { codigo: 'FECHA_INVALIDA' });
  await assert.rejects(prog.encolar({ platforms: ['tiktok'] }), { codigo: 'SIN_VIDEO' });
  assert.equal(prog.listar({ status: 'queued' }).length, 1);
});

test('encolar por clipId toma archivo, copy y hashtags del clip generado; exige que este listo; evita duplicados', async () => {
  const { prog } = await crear();
  const clip = store.encolar('https://youtu.be/xyz');
  await assert.rejects(prog.encolar({ clipId: clip.id, platforms: ['tiktok'] }), { codigo: 'CLIP_NO_LISTO' });
  await assert.rejects(prog.encolar({ clipId: 'clip_nada', platforms: ['tiktok'] }), { codigo: 'CLIP_NO_ENCONTRADO' });
  store.completar(clip.id, { url: '/clips/abc123.mp4', copy: 'Texto del clip', marketing: { hashtags: ['#viral', '#ia'] } });
  const job = await prog.encolar({ clipId: clip.id, platforms: ['tiktok', 'instagram'] });
  assert.equal(job.rutaVideo, path.join(process.env.CLIPS_DIR, 'abc123.mp4'));
  assert.equal(job.descripcion, 'Texto del clip');
  assert.deepEqual(job.etiquetas, ['#viral', '#ia']);
  await assert.rejects(prog.encolar({ clipId: clip.id, platforms: ['facebook'] }), { codigo: 'DUPLICADO' });
});

test('el ciclo periodico (iniciar/detener) ejecuta pendientes por si solo', async () => {
  const { prog } = await crear({ config: { ...CONFIG_SATURADO, cicloMs: 20, horaDesde: 0, horaHasta: 24 } });
  await prog.encolar({ rutaVideo: '/tmp/i.mp4', platforms: ['tiktok'] });
  await prog.iniciar();
  await new Promise((r) => setTimeout(r, 150));
  await prog.detener();
  assert.equal(prog.listar({ status: 'published' }).length, 1);
  assert.equal(prog.estado().activo, false);
});

// ------------------------------ integracion ----------------------------------

test('integracion programador + publicador (driver de ensayo): resultado por canal queda en el historial', async () => {
  const video = path.join(raiz, 'int.mp4');
  await fs.writeFile(video, 'x');
  const driver = crearDriverSeco();
  const FUTURO = Math.floor(Date.now() / 1000) + 86400;
  const cookies = { tiktok: [{ name: 'sessionid', value: 'a', domain: '.tiktok.com', expires: FUTURO }], instagram: [{ name: 'sessionid', value: 'b', domain: '.instagram.com', expires: FUTURO }] };
  const publicar = (spec) =>
    publicarClip(spec, {
      driver,
      azar: mulberry32(5),
      dormir: async () => {},
      leerCookies: async (red) => cookies[red] || null,
      obligatorias: { tiktok: [['sessionid']], instagram: [['sessionid']], facebook: [['c_user'], ['xs']] },
    });
  const { prog, reloj } = await crear({ publicar, config: { ...CONFIG_SATURADO, backoffBaseMs: 1000, backoffMaxMs: 1000 } });
  const job = await prog.encolar({ rutaVideo: video, descripcion: 'Integración', etiquetas: ['demo'], platforms: ['tiktok', 'instagram', 'facebook'] });
  await avanzar(prog, reloj, reloj.ms + 20 * MIN);
  const fin = prog.obtener(job.id);
  assert.equal(fin.resultados.tiktok.ok, true);
  assert.equal(fin.resultados.instagram.ok, true);
  assert.equal(fin.resultados.facebook.ok, false);
  assert.equal(fin.resultados.facebook.codigo, 'SIN_SESION');
  assert.equal(fin.status, 'failed', 'sin sesion de facebook es definitivo: no se reintenta en bucle');
  const h = prog.historial()[0];
  assert.equal(h.jobId, job.id);
  assert.equal(h.resultados.facebook.codigo, 'SIN_SESION');
  assert.ok(!Number.isNaN(Date.parse(h.resultados.tiktok.timestamp)));
});
