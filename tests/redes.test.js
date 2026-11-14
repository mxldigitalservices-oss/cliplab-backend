import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-redes-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.SESSION_DIR = path.join(raiz, 'datos');
process.env.MASTER_KEY = 'llave-maestra-de-prueba';
delete process.env.SESSION_KEY;
process.env.LOG_LEVEL = 'error';

const redes = await import('../src/sesion/redes.js');
const { store } = await import('../src/storage/store.js');
const { createApp } = await import('../src/app.js');

const FUTURO = 4102444800;
const ig = (extra = []) => JSON.stringify([
  { name: 'sessionid', value: 'SECRETO_IG', domain: '.instagram.com', path: '/', secure: true, expirationDate: FUTURO },
  { name: 'ds_user_id', value: '12345', domain: '.instagram.com', path: '/', expirationDate: FUTURO },
  { name: 'otra', value: 'AJENA', domain: '.example.com', path: '/' },
  ...extra,
]);
const estadoDe = (p) => store.snapshot().conexiones.find((c) => c.plataforma === p);

test('importa, cifra en disco y marca Conectado sin exponer valores', async () => {
  const r = await redes.importar('instagram', ig());
  assert.equal(r.estado, 'activa');
  assert.equal(r.cuenta, 'ID 12345');
  assert.equal(r.descartadas, 1);
  assert.equal(estadoDe('instagram').estado, 'activa');

  const crudo = await fs.readFile(path.join(process.env.SESSION_DIR, 'red-instagram.enc'), 'utf8');
  assert.ok(!crudo.includes('SECRETO_IG'));
  assert.ok(!JSON.stringify(store.snapshot()).includes('SECRETO_IG'));
  const modo = (await fs.stat(path.join(process.env.SESSION_DIR, 'red-instagram.enc'))).mode & 0o777;
  assert.equal(modo, 0o600);
});

test('hidrata desde disco tras un reinicio', async () => {
  store.actualizarConexion('instagram', { estado: 'sin_sesion', cuenta: null });
  await redes.hidratar();
  assert.equal(estadoDe('instagram').estado, 'activa');
});

test('rechaza cookies sin login, de otra red o caducadas', async () => {
  await assert.rejects(redes.importar('tiktok', ig()), { status: 400 });
  await assert.rejects(
    redes.importar('facebook', JSON.stringify([{ name: 'c_user', value: '1', domain: '.facebook.com', expirationDate: FUTURO }])),
    { status: 400 }
  );
  await assert.rejects(
    redes.importar('tiktok', JSON.stringify([{ name: 'sessionid', value: 'x', domain: '.tiktok.com', expirationDate: 1000 }])),
    { status: 400 }
  );
  await assert.rejects(redes.importar('twitter', ig()), { status: 404 });
});

test('facebook exige c_user y xs; acepta formato Netscape', async () => {
  const netscape = [
    '.facebook.com\tTRUE\t/\tTRUE\t' + FUTURO + '\tc_user\t999',
    '#HttpOnly_.facebook.com\tTRUE\t/\tTRUE\t' + FUTURO + '\txs\tSECRETO_FB',
  ].join('\n');
  const r = await redes.importar('facebook', netscape);
  assert.equal(r.estado, 'activa');
  assert.equal(estadoDe('facebook').cuenta, 'ID 999');
});

test('rutas: exigen llave, importan, verifican y quitan', async () => {
  const servidor = createApp().listen(0, '127.0.0.1');
  await new Promise((ok) => servidor.once('listening', ok));
  const base = 'http://127.0.0.1:' + servidor.address().port + '/api/panel/redes';
  const H = { 'x-master-key': process.env.MASTER_KEY, 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base + '/tiktok', { method: 'POST', body: '{}' })).status, 401);

    const lista = await (await fetch(base, { headers: H })).json();
    assert.equal(lista.conexiones.length, 3);

    const malo = await fetch(base + '/tiktok', { method: 'POST', headers: H, body: JSON.stringify({ cookies: ig() }) });
    assert.equal(malo.status, 400);

    const tiktok = JSON.stringify([{ name: 'sessionid', value: 'SECRETO_TT', domain: '.tiktok.com', expirationDate: FUTURO }]);
    const bien = await fetch(base + '/tiktok', { method: 'POST', headers: H, body: JSON.stringify({ cookies: tiktok }) });
    assert.equal(bien.status, 201);
    assert.ok(!(await bien.text()).includes('SECRETO_TT'));

    const ver = await (await fetch(base + '/tiktok/verificar', { method: 'POST', headers: H })).json();
    assert.equal(ver.estado, 'activa');

    const del = await fetch(base + '/tiktok', { method: 'DELETE', headers: H });
    assert.equal(del.status, 200);
    assert.equal(estadoDe('tiktok').estado, 'sin_sesion');
    assert.equal((await fetch(base + '/nada/verificar', { method: 'POST', headers: H })).status, 404);
  } finally {
    servidor.close();
  }
});
