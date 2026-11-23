import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-envivo-rutas-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.SESSION_DIR = path.join(raiz, 'datos');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.MASTER_KEY = 'llave-de-prueba';
process.env.LOG_LEVEL = 'error';

const { crearRouterEnVivo } = await import('../src/routes/envivo.js');
const { crearRouterLimpieza } = await import('../src/routes/limpieza.js');
const { ErrorEnVivo } = await import('../src/engine/envivo.js');
const { store } = await import('../src/storage/store.js');
const { createApp } = await import('../src/app.js');

const AUTH = { 'x-master-key': 'llave-de-prueba', 'content-type': 'application/json' };

// Gestor falso: registra las llamadas y simula errores del motor.
function gestorFalso() {
  const g = { llamadas: [], sesion: { activa: false, estado: 'inactivo' } };
  g.iniciar = async (url, o) => { g.llamadas.push(['iniciar', url, o]); if (!/youtube/.test(url)) throw new ErrorEnVivo('Solo se aceptan enlaces válidos de YouTube', 400); g.sesion = { activa: true, estado: 'iniciando' }; return g.sesion; };
  g.detener = async () => { g.llamadas.push(['detener']); g.sesion = { activa: false, estado: 'detenido' }; return g.sesion; };
  g.marcar = async (o) => { g.llamadas.push(['marcar', o]); return { clipId: 'x', duracion: 45, origen: 'manual' }; };
  g.configurarAuto = (a) => { g.llamadas.push(['auto', a]); return { ...g.sesion, auto: a }; };
  g.estado = () => g.sesion;
  return g;
}

async function conServidor(montar, fn) {
  const app = express();
  app.use(express.json());
  montar(app);
  const servidor = app.listen(0, '127.0.0.1');
  await new Promise((ok) => servidor.once('listening', ok));
  const base = 'http://127.0.0.1:' + servidor.address().port;
  try {
    await fn(async (ruta, metodo = 'GET', cuerpo, cabeceras = AUTH) => {
      const r = await fetch(base + ruta, { method: metodo, headers: cabeceras, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
      return { status: r.status, cuerpo: await r.json() };
    });
  } finally {
    await new Promise((ok) => servidor.close(ok));
  }
}

function sembrarClip(extra = {}) {
  const c = store.encolar('En vivo · prueba', { origen: 'archivo' });
  store.actualizar(c.id, { envivo: { origen: 'manual', sesionId: 's1' }, ...extra });
  return c.id;
}

test.after(() => fs.rm(raiz, { recursive: true, force: true }));

test('En Vivo: exige llave maestra', async () => {
  await conServidor((app) => app.use('/api/panel/envivo', crearRouterEnVivo({ gestor: gestorFalso() })), async (pedir) => {
    assert.equal((await pedir('/api/panel/envivo/estado', 'GET', undefined, {})).status, 401);
    assert.equal((await pedir('/api/panel/envivo/estado')).status, 200);
  });
});

test('En Vivo: iniciar valida la URL y devuelve 202; marcar, auto y detener delegan en el gestor', async () => {
  const g = gestorFalso();
  await conServidor((app) => app.use('/api/panel/envivo', crearRouterEnVivo({ gestor: g })), async (pedir) => {
    assert.equal((await pedir('/api/panel/envivo/iniciar', 'POST', { url: 'https://ejemplo.com/x' })).status, 400);
    const ok = await pedir('/api/panel/envivo/iniciar', 'POST', { url: 'https://www.youtube.com/watch?v=abc', auto: true });
    assert.equal(ok.status, 202);
    assert.equal(ok.cuerpo.sesion.estado, 'iniciando');
    assert.deepEqual(g.llamadas.at(-1), ['iniciar', 'https://www.youtube.com/watch?v=abc', { auto: true }]);
    assert.equal((await pedir('/api/panel/envivo/marcar', 'POST', { segundos: 60 })).status, 201);
    assert.deepEqual(g.llamadas.at(-1), ['marcar', { segundosAtras: 60, origen: 'manual' }]);
    assert.equal((await pedir('/api/panel/envivo/auto', 'POST', { activo: true })).cuerpo.sesion.auto, true);
    assert.equal((await pedir('/api/panel/envivo/detener', 'POST', {})).cuerpo.sesion.estado, 'detenido');
  });
});

test('En Vivo: la lista trae titulo y descripcion, y oculta los archivados', async () => {
  const visible = sembrarClip({ estado: 'listo', url: '/clips/a.mp4', marketing: { titulo: 'Gancho', descripcion: 'Texto', cta: 'Sigue', hashtags: ['#x'] } });
  const oculto = sembrarClip({ estado: 'listo', url: '/clips/b.mp4' });
  store.archivar([oculto]);
  await conServidor((app) => app.use('/api/panel/envivo', crearRouterEnVivo({ gestor: gestorFalso() })), async (pedir) => {
    const r = await pedir('/api/panel/envivo/estado');
    const ids = r.cuerpo.momentos.map((m) => m.id);
    assert.ok(ids.includes(visible) && !ids.includes(oculto));
    const m = r.cuerpo.momentos.find((x) => x.id === visible);
    assert.equal(m.titulo, 'Gancho');
    assert.match(m.descripcion, /Texto/);
    assert.equal(m.url, '/clips/a.mp4');
  });
});

test('En Vivo: la tanda envia como maximo N listos (los mas viejos primero) y no repite', async () => {
  const ids = [];
  for (let i = 0; i < 7; i += 1) ids.push(sembrarClip({ estado: 'listo', url: '/clips/t' + i + '.mp4', tandaPrueba: true }));
  const enProceso = sembrarClip({ estado: 'procesando' });
  await conServidor((app) => app.use('/api/panel/envivo', crearRouterEnVivo({ gestor: gestorFalso() })), async (pedir) => {
    const r1 = await pedir('/api/panel/envivo/tanda', 'POST', { cantidad: 5, ids });
    assert.equal(r1.cuerpo.enviados.length, 5);
    assert.deepEqual(r1.cuerpo.enviados, ids.slice(0, 5));
    const r2 = await pedir('/api/panel/envivo/tanda', 'POST', { cantidad: 5, ids });
    assert.deepEqual(r2.cuerpo.enviados, ids.slice(5));
    assert.equal(store.buscar(enProceso).enviadoEn, undefined, 'un clip en proceso nunca se envia');
  });
});

test('Limpieza: descargado marca, archiva solo si se pide y /estado deja de enviar el clip', async () => {
  const id = sembrarClip({ estado: 'listo', url: '/clips/z.mp4' });
  const app = createApp();
  const servidor = app.listen(0, '127.0.0.1');
  await new Promise((ok) => servidor.once('listening', ok));
  const base = 'http://127.0.0.1:' + servidor.address().port;
  const pedir = async (ruta, metodo = 'GET', cuerpo, cab = AUTH) => {
    const r = await fetch(base + ruta, { method: metodo, headers: cab, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    const j = await r.json();
    return { status: r.status, cuerpo: j.success !== undefined ? j.data || j : j };
  };
  try {
    assert.equal((await pedir('/api/panel/limpieza/resumen', 'GET', undefined, {})).status, 401);
    await pedir('/api/panel/limpieza/descargado/' + id, 'POST', {});
    assert.ok(store.buscar(id).descargadoEn && !store.buscar(id).archivadoEn);
    const enEstado = async () => (await pedir('/api/panel/estado')).cuerpo.clips.some((c) => c.id === id);
    assert.equal(await enEstado(), true);
    const r = await pedir('/api/panel/limpieza/descargado/' + id, 'POST', { archivar: true });
    assert.equal(r.cuerpo.archivados, 1);
    assert.equal(await enEstado(), false);
    assert.equal((await pedir('/api/panel/limpieza/descargado/clip_inexistente', 'POST', {})).status, 404);
    assert.equal((await pedir('/api/panel/limpieza/restaurar', 'POST', {})).cuerpo.restaurados >= 1, true);
    assert.equal(await enEstado(), true, 'restaurar lo devuelve a la bandeja');
  } finally {
    await new Promise((ok) => servidor.close(ok));
  }
});

test('Limpieza: procesados y descargados archivan lo correcto y NUNCA lo que esta en proceso', async () => {
  const desc = sembrarClip({ estado: 'listo', descargadoEn: 'ya' });
  const env = sembrarClip({ estado: 'listo', enviadoEn: 'ya' });
  const pub = sembrarClip({ estado: 'publicado' });
  const nuevo = sembrarClip({ estado: 'listo' });
  const proc = sembrarClip({ estado: 'procesando', descargadoEn: 'ya' });
  await conServidor((app) => app.use('/api/panel/limpieza', crearRouterLimpieza()), async (pedir) => {
    assert.equal((await pedir('/api/panel/limpieza', 'POST', { modo: 'otro' })).status, 400);
    const d = await pedir('/api/panel/limpieza', 'POST', { modo: 'descargados' });
    assert.equal(d.cuerpo.archivados >= 1, true);
    assert.ok(store.buscar(desc).archivadoEn);
    assert.ok(!store.buscar(env).archivadoEn, 'enviado sin descargar sigue en la bandeja con "descargados"');
    await pedir('/api/panel/limpieza', 'POST', { modo: 'procesados' });
    assert.ok(store.buscar(env).archivadoEn && store.buscar(pub).archivadoEn);
    assert.ok(!store.buscar(nuevo).archivadoEn, 'un clip listo sin descargar ni enviar se conserva');
    assert.ok(!store.buscar(proc).archivadoEn, 'un clip en proceso jamas se archiva');
  });
});
