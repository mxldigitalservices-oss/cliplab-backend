import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-etapa1-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.CLIPS_DIR = path.join(raiz, 'clips');
process.env.SESSION_DIR = path.join(raiz, 'sesion');
process.env.STORE_FILE = path.join(raiz, 'store.json');
process.env.STORE_PERSISTENCIA = 'on';
process.env.MASTER_KEY = 'llave-de-prueba';
process.env.LOG_LEVEL = 'error';
delete process.env.MONGODB_URI;

const { crearProgramador } = await import('../src/engine/programador.js');
const { store } = await import('../src/storage/store.js');
const { envelope } = await import('../src/middleware/envelope.js');
const { createApp } = await import('../src/app.js');
const { generarMarketing } = await import('../src/engine/marketing.js');
const { fichaDeVentana } = await import('../src/engine/curador.js');
const { puntajeDe, descripcionDe, ganchoDe } = await import('../public/js/proyectos.js');

const AUTH = { 'x-master-key': 'llave-de-prueba' };
const JSON_H = { ...AUTH, 'content-type': 'application/json' };

const servidor = createApp().listen(0, '127.0.0.1');
await new Promise((ok) => servidor.once('listening', ok));
const base = 'http://127.0.0.1:' + servidor.address().port;
test.after(() => servidor.close());

const pedir = async (ruta, opciones = {}) => {
  const r = await fetch(base + ruta, opciones);
  return { status: r.status, cuerpo: await r.json() };
};
const post = (ruta, cuerpo, headers = JSON_H) => pedir(ruta, { method: 'POST', headers, body: JSON.stringify(cuerpo ?? {}) });

function clipListo(extra = {}) {
  const c = store.encolar('https://youtu.be/xyz');
  store.completar(c.id, {
    url: '/clips/' + c.id + '.mp4',
    duracion: 42,
    transcripcion: 'Mira, el error más grande que cometen los emprendedores es nunca hablar con sus clientes. Yo perdí un millón de pesos por no preguntar. Los clientes te dicen exactamente qué comprar.',
    ficha: { titulo: 'El error que cuesta un millón', descripcion: 'desc ficha', gancho: { frase: 'El error más grande de los emprendedores', puntaje: 80 }, puntaje: 77 },
    copy: 'copy generico',
    ...extra,
  });
  return c.id;
}

// ---------------------------------------------------------------- 1) null en 'tipo'
test("regresion: encolar sin cargar() antes ya no revienta con \"Cannot read properties of null (reading 'tipo')\"", async () => {
  const id = clipListo();
  const prog = crearProgramador({ rutaJson: path.join(raiz, 'prog-a.json'), mongoUri: '', config: {} });
  // Sin prog.cargar() ni prog.iniciar(): antes persistir() hacia almacen.tipo con almacen === null.
  const job = await prog.encolar({ clipId: id, platforms: ['tiktok'] });
  assert.equal(job.status, 'queued');
  assert.equal(prog.estado().backend, 'json');
  const c = await prog.cancelar(job.id);
  assert.equal(c.status, 'cancelled');
});

// ---------------------------------------------------------------- 2) envelope 207
function appEnvelope(status, cuerpo) {
  const app = express();
  app.use('/api', envelope);
  app.get('/api/x', (req, res) => res.status(status).json(cuerpo));
  return app;
}
async function conApp(app, fn) {
  const s = app.listen(0, '127.0.0.1');
  await new Promise((ok) => s.once('listening', ok));
  try { return await fn('http://127.0.0.1:' + s.address().port); } finally { s.close(); }
}

test('envelope 207: exito parcial con detalle real por red (no "Error 207")', async () => {
  const resultados = [
    { red: 'tiktok', etiqueta: 'TikTok', ok: true },
    { red: 'facebook', etiqueta: 'Facebook', ok: false, error: 'COOKIES_AUSENTES: sin sesion de Facebook' },
  ];
  await conApp(appEnvelope(207, { ok: false, clipId: 'c1', resultados }), async (b) => {
    const r = await (await fetch(b + '/api/x')).json();
    assert.equal(r.success, true);
    assert.equal(r.data.parcial, true);
    assert.deepEqual(r.data.resultados, resultados);
    assert.match(r.error, /Facebook: COOKIES_AUSENTES/);
    assert.doesNotMatch(r.error, /^Error 207$/);
  });
});

test('envelope 502 con resultados: success:false, error real y detalle por red en data', async () => {
  const resultados = [{ red: 'tiktok', etiqueta: 'TikTok', ok: false, error: 'Falta rutaVideo' }];
  await conApp(appEnvelope(502, { ok: false, clipId: 'c1', resultados }), async (b) => {
    const r = await (await fetch(b + '/api/x')).json();
    assert.equal(r.success, false);
    assert.equal(r.error, 'TikTok: Falta rutaVideo');
    assert.equal(r.data.resultados.length, 1);
  });
});

test('envelope: errores sin detalle siguen igual (data null, "Error N")', async () => {
  await conApp(appEnvelope(500, { ok: false }), async (b) => {
    const r = await (await fetch(b + '/api/x')).json();
    assert.deepEqual([r.success, r.data, r.error], [false, null, 'Error 500']);
  });
});

// ---------------------------------------------------------------- 3) rutas del programador (red explicita)
test('las rutas de publicacion exigen la llave maestra', async () => {
  for (const [ruta, m] of [['/api/programador/cola', 'GET'], ['/api/programador/activar', 'POST'], ['/api/clips/x/publicar-ahora', 'POST'], ['/api/clips/x/programar', 'POST']]) {
    const r = await pedir(ruta, { method: m, headers: { 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined });
    assert.equal(r.status, 401, ruta);
  }
});

test('sin red explicita -> 400 (nunca se adivina); red invalida -> 400', async () => {
  const id = clipListo();
  for (const ruta of ['programar', 'publicar-ahora']) {
    const sin = await post(`/api/clips/${id}/${ruta}`, {});
    assert.equal(sin.status, 400);
    assert.match(sin.cuerpo.error, /explícitamente/);
    const mala = await post(`/api/clips/${id}/${ruta}`, { redes: ['youtube'] });
    assert.equal(mala.status, 400);
    assert.match(mala.cuerpo.error, /no válida/);
  }
});

test('clip inexistente -> 404; clip sin terminar -> 409', async () => {
  assert.equal((await post('/api/clips/clip_nada/programar', { redes: ['tiktok'] })).status, 404);
  const pendiente = store.encolar('https://youtu.be/pend');
  assert.equal((await post(`/api/clips/${pendiente.id}/programar`, { redes: ['tiktok'] })).status, 409);
});

test('programar en 2 redes: un trabajo por red con SU copy; luego cancelar (200) y volver a cancelar (409)', async () => {
  const id = clipListo();
  const futuro = new Date(Date.now() + 3600_000).toISOString();
  const r = await post(`/api/clips/${id}/programar`, { redes: ['tiktok', 'facebook'], fecha: futuro });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.success, true);
  const [tt, fb] = r.cuerpo.data.resultados;
  assert.deepEqual([tt.ok, fb.ok], [true, true]);
  assert.notEqual(tt.item.descripcion, fb.item.descripcion, 'cada red lleva su propio copy');
  assert.equal(tt.item.descripcion, tt.copy.descripcion);
  assert.deepEqual(tt.item.platforms, ['tiktok']);
  assert.deepEqual(fb.item.platforms, ['facebook']);

  // Misma red otra vez -> DUPLICADO real, reportado por red (207 con la otra red vacia no aplica: aqui falla solo 1)
  const dup = await post(`/api/clips/${id}/programar`, { redes: ['tiktok', 'instagram'], fecha: futuro });
  assert.equal(dup.status, 200 + 7, 'parcial');
  assert.equal(dup.cuerpo.success, true);
  assert.equal(dup.cuerpo.data.parcial, true);
  assert.match(dup.cuerpo.error, /TikTok: .*cola/i);

  const cola = await pedir('/api/programador/cola', { headers: AUTH });
  assert.equal(cola.cuerpo.success, true);
  assert.ok(cola.cuerpo.data.cola.length >= 3);
  assert.deepEqual(Object.keys(cola.cuerpo.data.cookiesRedes).sort(), ['facebook', 'instagram', 'tiktok']);
  assert.equal(typeof cola.cuerpo.data.activo, 'boolean');

  const c1 = await post(`/api/programador/${tt.item.id}/cancelar`, {});
  assert.equal(c1.status, 200);
  const c2 = await post(`/api/programador/${tt.item.id}/cancelar`, {});
  assert.equal(c2.status, 409);
  assert.equal((await post('/api/programador/job_nada/cancelar', {})).status, 404);

  const re = await post(`/api/programador/${tt.item.id}/reintentar`, {});
  assert.equal(re.status, 200);
});

test('publicar-ahora sin sesion en la red: 502 con el error real por red (no "Error 207")', async () => {
  const id = clipListo();
  await fs.mkdir(process.env.CLIPS_DIR, { recursive: true });
  await fs.writeFile(path.join(process.env.CLIPS_DIR, id + '.mp4'), 'video');
  const r = await post(`/api/clips/${id}/publicar-ahora`, { redes: ['tiktok'], modo: 'seco' });
  assert.ok([502, 207].includes(r.status), String(r.status));
  assert.equal(r.cuerpo.data.resultados[0].red ?? 'tiktok', 'tiktok');
  assert.ok(r.cuerpo.error && !/^Error \d+$/.test(r.cuerpo.error), r.cuerpo.error);
});

test('activar / pausar devuelven el estado', async () => {
  const a = await post('/api/programador/activar', {});
  assert.equal(a.status, 200);
  assert.equal(a.cuerpo.data.activo, true);
  const p = await post('/api/programador/pausar', {});
  assert.equal(p.status, 200);
  assert.equal(p.cuerpo.data.activo, false);
});

// ---------------------------------------------------------------- 4) persistencia del store
test('el store persiste clips con ficha y copy, y los recupera tras un reinicio', async () => {
  const id = clipListo();
  const pendiente = store.encolar('https://youtu.be/medio');   // quedara 'procesando'
  assert.equal(store.guardarYa(), true);

  store.actualizar(id, { ficha: null, copy: '' });             // simula perder el estado en memoria
  assert.equal(store.buscar(id).ficha, null);

  assert.equal(store.recargar(), true);                          // = arranque del proceso
  const c = store.buscar(id);
  assert.equal(c.ficha.titulo, 'El error que cuesta un millón');
  assert.equal(c.ficha.puntaje, 77);
  assert.equal(c.copy, 'copy generico');
  assert.equal(c.estado, 'listo');
  const p = store.buscar(pendiente.id);
  assert.equal(p.estado, 'error', 'un clip a medias por el reinicio no queda "procesando" para siempre');
  assert.match(p.etapa, /reinicio/i);
  assert.ok(store.snapshot().incidencias.some((i) => /reinicio/.test(i.mensaje)));
});

test('un store.json corrupto no tumba el arranque y se conserva como .corrupto', async () => {
  await fs.writeFile(process.env.STORE_FILE, '{ esto no es json');
  assert.equal(store.recargar(), false);
  await fs.access(process.env.STORE_FILE + '.corrupto');
  assert.ok(Array.isArray(store.snapshot().clips));
});

// ---------------------------------------------------------------- 5) ficha y marketing
test('generarMarketing (paquete base del curador) funciona sin red; con { clip } exige red', () => {
  const m = generarMarketing({ tituloVideo: 'Cómo escalar tu negocio', transcripcion: '', semilla: 's' });
  assert.ok(m.titulo && m.descripcion && m.cta && m.hashtags.length >= 5);
  assert.throws(() => generarMarketing({ clip: { titulo: 'x' } }), (e) => e.status === 400);
  assert.equal(generarMarketing({ clip: { titulo: 'x', transcripcion: 'Una frase de prueba larga para el clip.' }, red: 'tiktok' }).red, 'tiktok');
});

test('fichaDeVentana nunca vuelve a salir vacia por marketing (origen de "Sin puntaje / Sin descripcion")', () => {
  const f = fichaDeVentana({ palabras: [], tituloVideo: 'Como escalar tu negocio', semilla: 'x' });
  assert.ok(f.titulo && f.descripcion.length > 20 && f.hashtags.length >= 5);
});

test('frontend: puntaje, descripcion y gancho con respaldos cuando la ficha viene incompleta', () => {
  assert.equal(puntajeDe({ ficha: { puntaje: 70 } }), 70);
  assert.equal(puntajeDe({ ficha: { puntaje: null, gancho: { puntaje: 60 }, flujo: { puntaje: 80 } } }), 70);
  assert.equal(puntajeDe({}), null);
  assert.equal(descripcionDe({ marketing: { descripcion: 'D', cta: 'C', hashtags: ['#a'] } }), 'D\n\nC\n\n#a');
  assert.equal(descripcionDe({ copy: 'copy' }), 'copy');
  assert.equal(ganchoDe({ ficha: { gancho: 'texto' } }), 'texto');
  assert.equal(ganchoDe({ ficha: { gancho: { frase: 'frase' } } }), 'frase');
});
