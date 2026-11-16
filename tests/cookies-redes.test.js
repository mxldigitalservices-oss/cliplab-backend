import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-cred-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.SESSION_DIR = path.join(raiz, 'sesion');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.MASTER_KEY = 'llave-de-prueba';
delete process.env.SESSION_KEY;
process.env.LOG_LEVEL = 'error';

const { createApp } = await import('../src/app.js');
const { store } = await import('../src/storage/store.js');
const { sincronizarCookiesRedes } = await import('../src/sesion/cookiesRedes.js');

const FUTURO = 4102444800;
const tiktok = (valor = 'SECRETO_TT') => JSON.stringify([
  { name: 'sessionid', value: valor, domain: '.tiktok.com', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: FUTURO },
  { name: 'ajena', value: 'X', domain: '.example.com', path: '/' },
]);
const estadoDe = (r) => store.snapshot().conexiones.find((c) => c.plataforma === r);

const servidor = createApp().listen(0, '127.0.0.1');
await new Promise((ok) => servidor.once('listening', ok));
const base = 'http://127.0.0.1:' + servidor.address().port + '/api/panel/cookies-redes';
const H = { 'x-master-key': process.env.MASTER_KEY, 'content-type': 'application/json' };
test.after(() => servidor.close());

test('exige la llave maestra', async () => {
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base + '/tiktok', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 401);
});

test('pegar el JSON guarda cifrado, no expone valores y pone la tarjeta en activa', async () => {
  const r = await fetch(base + '/tiktok', { method: 'POST', headers: H, body: JSON.stringify({ cookies: tiktok() }) });
  assert.equal(r.status, 201);
  const cuerpo = await r.text();
  assert.ok(!cuerpo.includes('SECRETO_TT'));
  const datos = JSON.parse(cuerpo);
  assert.equal(datos.success, true);
  assert.equal(datos.total, 1);
  assert.equal(estadoDe('tiktok').estado, 'activa');

  const archivo = path.join(process.env.SESSION_DIR, 'cookies-tiktok.enc');
  assert.ok(!(await fs.readFile(archivo, 'utf8')).includes('SECRETO_TT'));
  assert.equal((await fs.stat(archivo)).mode & 0o777, 0o600);

  const lista = await (await fetch(base, { headers: H })).json();
  assert.equal(lista.redes.find((x) => x.red === 'tiktok').guardada, true);
  assert.ok(!JSON.stringify(lista).includes('SECRETO_TT'));
});

test('tras reiniciar, la tarjeta se restaura desde disco', async () => {
  store.actualizarConexion('tiktok', { estado: 'sin_sesion' });
  await sincronizarCookiesRedes();
  assert.equal(estadoDe('tiktok').estado, 'activa');
});

test('acepta el JSON ya como arreglo y rechaza entradas invalidas', async () => {
  const ig = [{ name: 'sessionid', value: 'abc', domain: '.instagram.com', expirationDate: FUTURO }];
  assert.equal((await fetch(base + '/instagram', { method: 'POST', headers: H, body: JSON.stringify({ cookies: ig }) })).status, 201);
  const malos = [
    ['tiktok', '{}'],
    ['tiktok', JSON.stringify({ cookies: 'no es json' })],
    ['facebook', JSON.stringify({ cookies: tiktok() })],
    ['facebook', JSON.stringify({ cookies: [{ name: 'c_user', value: '1', domain: '.facebook.com', expirationDate: FUTURO }] })],
    ['tiktok', JSON.stringify({ cookies: [{ name: 'sessionid', value: 'x', domain: '.tiktok.com', expirationDate: 1000 }] })],
  ];
  for (const [red, cuerpo] of malos) {
    const r = await fetch(base + '/' + red, { method: 'POST', headers: H, body: cuerpo });
    assert.equal(r.status, 400, red + ' ' + cuerpo);
  }
  assert.equal((await fetch(base + '/twitter', { method: 'POST', headers: H, body: JSON.stringify({ cookies: tiktok() }) })).status, 404);
});

test('quitar borra la sesion y deja Sin sesion', async () => {
  assert.equal((await fetch(base + '/tiktok', { method: 'DELETE', headers: H })).status, 200);
  assert.equal(estadoDe('tiktok').estado, 'sin_sesion');
  await assert.rejects(fs.access(path.join(process.env.SESSION_DIR, 'cookies-tiktok.enc')));
});
