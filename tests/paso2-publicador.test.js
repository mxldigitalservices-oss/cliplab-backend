import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-paso2-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.SESSION_DIR = path.join(raiz, 'sesion');
process.env.MASTER_KEY = 'llave-de-prueba';
process.env.LOG_LEVEL = 'error';
delete process.env.PUBLICADOR_MODO;
for (const v of ['MONGODB_URI', 'MONGODB_URL', 'MONGO_URL', 'MONGO_PUBLIC_URL', 'MONGOHOST', 'MONGOUSER', 'MONGOPASSWORD', 'MONGOPORT', 'MONGODB_DB', 'MONGO_DB']) delete process.env[v];
process.once('exit', () => rmSync(raiz, { recursive: true, force: true })); // test.after a nivel raiz corre antes de tiempo

const { resolverMongo, mascararUri } = await import('../src/config/mongo.js');
const { ARGS_CHROMIUM, opcionesLanzamiento, diagnosticarChromium } = await import('../src/engine/chromium.js');
const { publicarClip, crearDriverPlaywright, crearDriverSeco, ErrorPublicador } = await import('../src/engine/publicador.js');
const { crearProgramador } = await import('../src/engine/programador.js');
const { createApp } = await import('../src/app.js');

const aqui = path.dirname(fileURLToPath(import.meta.url));

// ================================ MongoDB: variables de Railway ================================
test('mongo: MONGO_URL (Railway) se usa aunque no exista MONGODB_URI, y trae base por defecto', () => {
  const r = resolverMongo({ MONGO_URL: 'mongodb://mongo:clave@mongodb.railway.internal:27017' });
  assert.equal(r.fuente, 'MONGO_URL');
  assert.equal(r.nombreBd, 'cliplab', 'la URL de Railway no trae base: sin esto el driver usaria "test"');
});

test('mongo: prioridad MONGODB_URI > MONGO_URL > MONGO_PUBLIC_URL, y MONGODB_DB / base de la URI mandan', () => {
  const todo = { MONGODB_URI: 'mongodb://a/uno', MONGO_URL: 'mongodb://b', MONGO_PUBLIC_URL: 'mongodb://c' };
  assert.equal(resolverMongo(todo).fuente, 'MONGODB_URI');
  assert.equal(resolverMongo(todo).nombreBd, 'uno');
  assert.equal(resolverMongo({ ...todo, MONGODB_DB: 'otra' }).nombreBd, 'otra');
  assert.equal(resolverMongo({ MONGO_PUBLIC_URL: 'mongodb://c' }).fuente, 'MONGO_PUBLIC_URL');
});

test('mongo: se arma desde MONGOHOST/MONGOUSER/MONGOPASSWORD escapando caracteres raros', () => {
  const r = resolverMongo({ MONGOHOST: 'h', MONGOPORT: '1234', MONGOUSER: 'u', MONGOPASSWORD: 'p@ss/w:rd' });
  assert.equal(r.uri, 'mongodb://u:p%40ss%2Fw%3Ard@h:1234');
});

test('mongo: comillas y espacios pegados en Railway se limpian; un valor que no es mongodb:// se explica', () => {
  assert.equal(resolverMongo({ MONGODB_URI: '  "mongodb+srv://a:b@c.mongodb.net/x"  ' }).uri, 'mongodb+srv://a:b@c.mongodb.net/x');
  const mala = resolverMongo({ MONGO_URL: 'http://no-es-mongo' });
  assert.equal(mala.uri, '');
  assert.match(mala.problema, /mongodb:\/\//);
  assert.equal(resolverMongo({}).uri, '');
});

test('mongo: las credenciales nunca salen en claro', () => {
  assert.equal(mascararUri('mongodb://mongo:secreto@h:27017'), 'mongodb://***@h:27017');
  assert.equal(mascararUri('mongodb+srv://u:p@c.net/x'), 'mongodb+srv://***@c.net/x');
});

// ================================ Chromium ================================
test('chromium: los argumentos incluyen --no-sandbox y --disable-dev-shm-usage, y coinciden con check-chromium.mjs (el del build)', async () => {
  assert.deepEqual([...ARGS_CHROMIUM], ['--no-sandbox', '--disable-dev-shm-usage']);
  assert.deepEqual(opcionesLanzamiento({}).args, ['--no-sandbox', '--disable-dev-shm-usage']);
  const build = await fs.readFile(path.join(aqui, '../scripts/check-chromium.mjs'), 'utf8');
  for (const a of ARGS_CHROMIUM) assert.ok(build.includes(a), 'check-chromium.mjs no usa ' + a);
});

test('chromium: el publicador lanza Chromium con esos argumentos', async () => {
  let opts = null;
  const falso = { chromium: { launch: async (o) => { opts = o; return { close: async () => {} }; } } };
  const driver = await crearDriverPlaywright({ importar: async () => falso });
  assert.equal(opts.headless, true);
  assert.ok(opts.args.includes('--no-sandbox') && opts.args.includes('--disable-dev-shm-usage'));
  await driver.cerrar();
});

test('chromium: si no arranca, el error es DRIVER_NO_DISPONIBLE con pista de donde mirar (no tumba nada)', async () => {
  const falso = { chromium: { launch: async () => { throw new Error('Executable doesn\'t exist at /ms-playwright/x'); } } };
  await assert.rejects(crearDriverPlaywright({ importar: async () => falso }), (e) => {
    assert.equal(e.codigo, 'DRIVER_NO_DISPONIBLE');
    assert.match(e.message, /PLAYWRIGHT_BROWSERS_PATH/);
    assert.match(e.message, /diagnostico/);
    return true;
  });
});

test('diagnosticarChromium: lanza de verdad, abre about:blank y cierra; sin lanzar solo mira el ejecutable', async () => {
  const exe = path.join(raiz, 'chrome-falso');
  await fs.writeFile(exe, '');
  let cerrado = false;
  let lanzados = 0;
  const modulo = {
    chromium: {
      executablePath: () => exe,
      launch: async (o) => { lanzados++; assert.deepEqual(o.args, ARGS_CHROMIUM.slice()); return { version: () => '131.0', newPage: async () => ({ goto: async () => {} }), close: async () => { cerrado = true; } }; },
    },
  };
  const completo = await diagnosticarChromium({ importar: async () => modulo });
  assert.equal(completo.ok, true);
  assert.equal(completo.version, '131.0');
  assert.equal(cerrado, true);
  const ligero = await diagnosticarChromium({ importar: async () => modulo, lanzar: false });
  assert.equal(ligero.ok, true);
  assert.equal(lanzados, 1, 'sin lanzar no abre el navegador');
});

test('diagnosticarChromium: reporta (sin lanzar excepcion) cuando falta el ejecutable o Chromium se cae', async () => {
  const sinExe = await diagnosticarChromium({ importar: async () => ({ chromium: { executablePath: () => '/no/existe/chrome' } }) });
  assert.equal(sinExe.ok, false);
  assert.equal(sinExe.paquete, true);
  assert.match(sinExe.error, /PLAYWRIGHT_BROWSERS_PATH/);
  const sinPaquete = await diagnosticarChromium({ importar: async () => { throw new Error('Cannot find package playwright-core'); } });
  assert.equal(sinPaquete.ok, false);
  assert.match(sinPaquete.error, /playwright-core/);
  const exe = path.join(raiz, 'chrome-falso');
  const cae = await diagnosticarChromium({ importar: async () => ({ chromium: { executablePath: () => exe, launch: async () => { throw new Error('Target closed'); } } }) });
  assert.equal(cae.ok, false);
  assert.match(cae.error, /Target closed/);
});

// ================================ publicador blindado ================================
const video = path.join(raiz, 'clip.mp4');
await fs.writeFile(video, 'x');
const FUTURO = Math.floor(Date.now() / 1000) + 86400;
const OBLIGATORIAS = { tiktok: [['sessionid']], instagram: [['sessionid']], facebook: [['c_user'], ['xs']] };
const cookie = (name) => [{ name, value: 'v', domain: '.x.com', path: '/', expires: FUTURO }];
const lector = (mapa) => async (red) => (red in mapa ? mapa[red] : null);
const base = (extra = {}) => ({ obligatorias: OBLIGATORIAS, dormir: async () => {}, azar: () => 0.5, modo: 'real', ...extra });

test('publicador: sin sesion en NINGUNA red devuelve un mensaje claro por red y NO lanza Chromium', async () => {
  let lanzados = 0;
  const r = await publicarClip(
    { rutaVideo: video, descripcion: 'hola', plataformas: ['tiktok', 'instagram', 'facebook'] },
    base({ leerCookies: lector({}), crearDriver: async () => { lanzados++; return crearDriverSeco(); } })
  );
  assert.equal(r.ok, false);
  assert.equal(lanzados, 0, 'no se abre el navegador si no hay sesion en ninguna red');
  for (const red of ['tiktok', 'instagram', 'facebook']) {
    assert.equal(r.resultados[red].codigo, 'SIN_SESION');
    assert.match(r.resultados[red].error, /Conexiones/);
  }
});

test('publicador: con sesion solo en TikTok publica ahi, Instagram queda con su mensaje y Chromium se abre una vez', async () => {
  let lanzados = 0;
  const r = await publicarClip(
    { rutaVideo: video, descripcion: 'hola', plataformas: ['tiktok', 'instagram'] },
    base({ leerCookies: lector({ tiktok: cookie('sessionid') }), crearDriver: async () => { lanzados++; return crearDriverSeco(); } })
  );
  assert.equal(lanzados, 1);
  assert.equal(r.resultados.tiktok.ok, true);
  assert.equal(r.resultados.instagram.codigo, 'SIN_SESION');
  assert.equal(r.ok, false);
});

test('publicador: sesion vencida da SESION_EXPIRADA y tampoco abre el navegador', async () => {
  let lanzados = 0;
  const vencida = [{ name: 'sessionid', value: 'v', domain: '.x.com', path: '/', expires: 1000 }];
  const r = await publicarClip({ rutaVideo: video, descripcion: 'x', plataformas: ['tiktok'] }, base({ leerCookies: lector({ tiktok: vencida }), crearDriver: async () => { lanzados++; return crearDriverSeco(); } }));
  assert.equal(r.resultados.tiktok.codigo, 'SESION_EXPIRADA');
  assert.equal(lanzados, 0);
});

test('publicador: si Chromium no arranca, las redes con sesion quedan con DRIVER_NO_DISPONIBLE y el proceso sigue en pie', async () => {
  const r = await publicarClip(
    { rutaVideo: video, descripcion: 'x', plataformas: ['tiktok', 'instagram'] },
    base({ leerCookies: lector({ tiktok: cookie('sessionid') }), crearDriver: async () => { throw new ErrorPublicador('DRIVER_NO_DISPONIBLE', 'Chromium no arranco', false); } })
  );
  assert.equal(r.ok, false);
  assert.equal(r.resultados.tiktok.codigo, 'DRIVER_NO_DISPONIBLE');
  assert.equal(r.resultados.instagram.codigo, 'SIN_SESION');
});

test('publicador: una descripcion vacia no cuenta (usa la siguiente con texto) y nunca lanza ante un lector de cookies roto', async () => {
  const rota = await publicarClip({ rutaVideo: video, descripcion: '', titulo: 'Titulo real', plataformas: ['tiktok'] }, base({ leerCookies: async () => { throw new Error('disco ilegible'); }, crearDriver: async () => crearDriverSeco() }));
  assert.equal(rota.resultados.tiktok.codigo, 'SESION_ILEGIBLE');
});

// ================================ programador: MongoDB y cola ================================
function mongoFalso({ fallar = false } = {}) {
  const colecciones = new Map();
  const col = (n) => (colecciones.has(n) ? colecciones.get(n) : colecciones.set(n, new Map()).get(n));
  const coincide = (d, f) => Object.entries(f).every(([k, v]) => (v && v.$in ? v.$in.includes(d[k]) : d[k] === v));
  class Cursor {
    constructor(d) { this.d = d; }
    sort(o) { const [k, dir] = Object.entries(o)[0]; this.d.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir); return this; }
    limit(c) { this.d = this.d.slice(0, c); return this; }
    async toArray() { return structuredClone(this.d); }
  }
  const coleccion = (n) => ({
    createIndex: async () => {},
    find: (f) => new Cursor([...col(n).values()].filter((d) => coincide(d, f))),
    findOne: async (f) => { const d = [...col(n).values()].find((x) => coincide(x, f)); return d ? structuredClone(d) : null; },
    replaceOne: async (f, doc) => { col(n).set(f._id, structuredClone(doc)); },
    insertOne: async (doc) => { col(n).set(doc._id, structuredClone(doc)); },
    deleteOne: async (f) => { col(n).delete(f._id); },
    countDocuments: async (f) => [...col(n).values()].filter((d) => coincide(d, f)).length,
  });
  class MongoClient {
    async connect() { if (fallar.valueOf()) throw new Error(typeof fallar === 'string' ? fallar : 'ECONNREFUSED'); }
    db(nombre) { return { databaseName: nombre, command: async () => ({ ok: 1 }), collection: coleccion }; }
    async close() {}
  }
  return { modulo: { MongoClient }, colecciones };
}
let n = 0;
const crear = async (extra = {}) => {
  const prog = crearProgramador({ publicar: async () => ({ ok: true, resultados: {} }), rutaJson: path.join(raiz, 'p' + ++n + '.json'), mongoUri: '', ...extra });
  await prog.cargar();
  return prog;
};

test('programador sin URI: el estado lo dice claro (para el aviso de la barra) y la cola guarda en el JSON local', async () => {
  const prog = await crear();
  const m = prog.estado().mongo;
  assert.equal(m.configurado, false);
  assert.equal(m.conectado, false);
  assert.equal(prog.estado().backend, 'json');
});

test('programador con Mongo disponible: conectado, usa la base resuelta y la prueba de ida y vuelta pasa', async () => {
  const f = mongoFalso();
  const prog = await crear({ mongoUri: 'mongodb://x', cargarMongo: async () => f.modulo });
  await prog.encolar({ rutaVideo: '/tmp/a.mp4', descripcion: 'd', platforms: ['tiktok'] });
  assert.equal(prog.estado().mongo.conectado, true);
  assert.equal(prog.estado().backend, 'mongo');
  const s = await prog.sonda();
  assert.equal(s.backend, 'mongo');
  assert.equal(s.ok, true);
  assert.equal(s.enAlmacen, 1, 'lo encolado esta de verdad en la coleccion');
  assert.equal(s.enMemoria, 1);
  assert.equal(f.colecciones.get('cliplab_cola').size, 1);
  assert.equal(f.colecciones.get('cliplab_sonda').size, 0, 'la sonda limpia lo que escribe');
});

test('programador: la sonda del respaldo JSON tambien escribe, lee y cuenta lo pendiente en disco', async () => {
  const prog = await crear();
  await prog.encolar({ rutaVideo: '/tmp/a.mp4', descripcion: 'd', platforms: ['tiktok'] });
  const s = await prog.sonda();
  assert.equal(s.backend, 'json');
  assert.equal(s.ok, true);
  assert.equal(s.enAlmacen, 1);
});

test('programador: Mongo caido al arrancar -> JSON con el motivo (sin credenciales); luego reconecta y migra la cola', async () => {
  const uri = 'mongodb://usuario:claveSecreta@mongodb.railway.internal:27017';
  let disponible = false;
  const f = mongoFalso();
  const prog = await crear({
    mongoUri: uri,
    cargarMongo: async () => { if (!disponible) throw new Error('getaddrinfo ENOTFOUND mongodb.railway.internal (' + uri + ')'); return f.modulo; },
  });
  await prog.encolar({ rutaVideo: '/tmp/a.mp4', descripcion: 'uno', platforms: ['tiktok'] });
  await prog.encolar({ rutaVideo: '/tmp/b.mp4', descripcion: 'dos', platforms: ['instagram'] });
  const antes = prog.estado();
  assert.equal(antes.backend, 'json');
  assert.equal(antes.mongo.configurado, true);
  assert.equal(antes.mongo.conectado, false);
  assert.match(antes.mongo.error, /ENOTFOUND/);
  assert.ok(!JSON.stringify(antes.mongo).includes('claveSecreta'), 'el estado no filtra la clave');

  await assert.rejects(prog.reconectarMongo(), { codigo: 'MONGO_NO_DISPONIBLE' });
  disponible = true;
  const r = await prog.reconectarMongo();
  assert.equal(r.backend, 'mongo');
  assert.equal(r.migrados, 2);
  assert.equal(prog.estado().mongo.conectado, true);
  assert.equal(prog.estado().mongo.error, null);
  assert.equal(f.colecciones.get('cliplab_cola').size, 2, 'la cola que estaba en JSON ahora esta en Mongo');
  assert.equal((await prog.reconectarMongo()).yaConectado, true);
});

test('programador: reconectar sin URI da un mensaje que dice que variable definir', async () => {
  const prog = await crear();
  await assert.rejects(prog.reconectarMongo(), (e) => e.codigo === 'MONGO_NO_CONFIGURADO' && /MONGODB_URI o MONGO_URL/.test(e.message));
});

// ================================ rutas ================================
const servidor = createApp().listen(0, '127.0.0.1');
await new Promise((ok) => servidor.once('listening', ok));
servidor.unref();
const url = 'http://127.0.0.1:' + servidor.address().port;
const AUTH = { 'x-master-key': 'llave-de-prueba' };

test('/health sigue respondiendo 200 y ahora dice que commit esta desplegado', async () => {
  const r = await fetch(url + '/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok('commit' in j);
});

test('diagnostico: exige la llave maestra', async () => {
  assert.equal((await fetch(url + '/api/programador/diagnostico')).status, 401);
  assert.equal((await fetch(url + '/api/programador/mongo/reconectar', { method: 'POST' })).status, 401);
});

test('diagnostico: entrega despliegue, chromium, cola, mongo y sesiones; con ?almacen=1 prueba la cola', async () => {
  const r = await fetch(url + '/api/programador/diagnostico?almacen=1', { headers: AUTH });
  assert.equal(r.status, 200);
  const j = await r.json();
  const d = j.data;
  assert.ok(d.despliegue.node);
  assert.equal(typeof d.chromium.paquete, 'boolean');
  assert.equal(d.mongo.configurado, false);
  assert.equal(d.cola.backend, 'json');
  assert.equal(d.cola.sonda.ok, true);
  assert.ok(typeof d.sesiones === 'object');
  assert.ok(!JSON.stringify(d).includes('claveSecreta'));
});

test('reconectar Mongo sin URI responde 400 explicando la variable que falta', async () => {
  const r = await fetch(url + '/api/programador/mongo/reconectar', { method: 'POST', headers: AUTH });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.match(j.error, /MONGODB_URI o MONGO_URL/);
});

test('la barra de estado (/cola) reporta Mongo con motivo en vez de un "sin conexion" mudo', async () => {
  const r = await fetch(url + '/api/programador/cola', { headers: AUTH });
  const j = await r.json();
  assert.equal(j.data.mongo.conectado, false);
  assert.match(j.data.mongo.detalle, /MONGODB_URI o MONGO_URL/);
});
