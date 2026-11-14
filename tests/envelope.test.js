import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-envelope-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.SESSION_DIR = path.join(raiz, 'datos');
process.env.MASTER_KEY = 'llave-de-prueba';
process.env.LOG_LEVEL = 'error';

const { createApp } = await import('../src/app.js');
const { store } = await import('../src/storage/store.js');

const servidor = createApp().listen(0, '127.0.0.1');
await new Promise((ok) => servidor.once('listening', ok));
const base = 'http://127.0.0.1:' + servidor.address().port;
const AUTH = { 'x-master-key': 'llave-de-prueba' };

test.after(() => servidor.close());

async function pedir(ruta, opciones = {}) {
  const r = await fetch(base + ruta, opciones);
  return { status: r.status, cuerpo: await r.json() };
}

test('exito: { success:true, data, error:null } con contadores reales', async () => {
  const { status, cuerpo } = await pedir('/api/panel/estado', { headers: AUTH });
  assert.equal(status, 200);
  assert.equal(cuerpo.success, true);
  assert.equal(cuerpo.error, null);
  assert.ok(cuerpo.data.resumen.kpis);
  assert.ok(Array.isArray(cuerpo.data.incidencias));
});

test('401 sin llave: misma estructura de error', async () => {
  const { status, cuerpo } = await pedir('/api/panel/estado');
  assert.equal(status, 401);
  assert.equal(cuerpo.success, false);
  assert.equal(cuerpo.data, null);
  assert.match(cuerpo.error, /llave/i);
});

test('400 al encolar una URL invalida', async () => {
  const { status, cuerpo } = await pedir('/api/panel/encolar', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/x' }),
  });
  assert.equal(status, 400);
  assert.equal(cuerpo.success, false);
  assert.match(cuerpo.error, /YouTube/);
});

test('404 de API devuelve JSON estandar', async () => {
  const { status, cuerpo } = await pedir('/api/no-existe');
  assert.equal(status, 404);
  assert.equal(cuerpo.success, false);
  assert.match(cuerpo.error, /no-existe/);
});

test('un clip fallido deja una incidencia con detalle tecnico (stderr) y cuenta en los KPIs', async () => {
  const clip = store.encolar('https://youtu.be/abc');
  store.fallar(clip.id, 'Fallo el render: boom', 'ffmpeg: Invalid data found');
  const { cuerpo } = await pedir('/api/panel/estado', { headers: AUTH });
  assert.equal(cuerpo.data.incidencias[0].detalle, 'ffmpeg: Invalid data found');
  assert.ok(cuerpo.data.resumen.kpis.incidenciasAbiertas >= 1);
  assert.equal(cuerpo.data.clips.find((c) => c.id === clip.id).estado, 'error');
});

test('/health conserva su formato (lo usa el healthcheck de Railway)', async () => {
  const r = await fetch(base + '/health');
  assert.equal(r.status, 200);
});
