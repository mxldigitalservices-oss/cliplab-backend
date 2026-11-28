import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.LOG_LEVEL = 'error';
const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-auto-'));
test.after(() => fs.rm(raiz, { recursive: true, force: true }));

const { redesAutoPublicar, planDeTrabajos, autoPublicarClip, _reiniciarAvisos } = await import('../src/engine/autopublicar.js');
const { crearProgramador, autoarranqueActivo } = await import('../src/engine/programador.js');

const clipListo = { id: 'c1', estado: 'listo', url: '/clips/abc.mp4', titulo: 'https://youtu.be/x', copy: 'copy base', ficha: { titulo: 'Titulo real', descripcion: 'Desc real' }, marketing: { hashtags: ['a'] } };
function doble({ clip = clipListo, falla = null, activo = true } = {}) {
  const jobs = [];
  const incidencias = [];
  const parches = [];
  return {
    jobs, incidencias, parches,
    almacen: { buscar: (id) => (id === 'c1' ? clip : null), actualizar: (id, p) => parches.push(p), registrarIncidencia: (...a) => incidencias.push(a) },
    programador: {
      cargar: async () => {},
      estado: () => ({ activo }),
      encolar: async (spec) => { if (falla && falla(spec)) { const e = new Error('cola caida'); e.codigo = 'SIN_PLATAFORMAS'; throw e; } jobs.push(spec); return { id: 'job_' + jobs.length }; },
    },
    adaptar: ({ clip: c, red }) => ({ descripcion: red + ':' + c.titulo, hashtags: ['#' + red] }),
  };
}

test('AUTO_PUBLICAR: apagado por defecto, lista de redes, "todas" y valores desconocidos', () => {
  _reiniciarAvisos();
  assert.deepEqual(redesAutoPublicar({}), []);
  assert.deepEqual(redesAutoPublicar({ AUTO_PUBLICAR: 'off' }), []);
  assert.deepEqual(redesAutoPublicar({ AUTO_PUBLICAR: 'instagram' }), ['instagram']);
  assert.deepEqual(redesAutoPublicar({ AUTO_PUBLICAR: ' Facebook, instagram ,instagram ' }), ['instagram', 'facebook']);
  assert.deepEqual(redesAutoPublicar({ AUTO_PUBLICAR: 'todas' }), ['tiktok', 'instagram', 'facebook']);
  assert.deepEqual(redesAutoPublicar({ AUTO_PUBLICAR: 'instagram,youtube' }), ['instagram'], 'lo desconocido se ignora');
  assert.deepEqual(redesAutoPublicar({ AUTO_PUBLICAR: 'on' }), [], '"on" no es una red: no se adivina');
});

test('plan: con reenvio activo instagram+facebook es UN trabajo; sin reenvio (o con directo forzado) uno por red', () => {
  assert.deepEqual(planDeTrabajos(['instagram', 'facebook'], { crosspost: true, directoForzado: false }), [{ platforms: ['instagram', 'facebook'], copyDe: 'instagram' }]);
  assert.deepEqual(planDeTrabajos(['instagram', 'facebook'], { crosspost: false, directoForzado: false }).map((x) => x.platforms), [['instagram'], ['facebook']]);
  assert.deepEqual(planDeTrabajos(['instagram', 'facebook'], { crosspost: true, directoForzado: true }).map((x) => x.platforms), [['instagram'], ['facebook']]);
  assert.deepEqual(planDeTrabajos(['tiktok', 'instagram', 'facebook'], { crosspost: true, directoForzado: false }).map((x) => x.platforms), [['instagram', 'facebook'], ['tiktok']]);
});

test('autoPublicarClip: apagado -> no toca la cola', async () => {
  const d = doble();
  assert.equal(await autoPublicarClip('c1', { env: {}, ...d }), null);
  assert.equal(d.jobs.length, 0);
});

test('autoPublicarClip: encola con la ficha real y marca el clip', async () => {
  const d = doble();
  const r = await autoPublicarClip('c1', { env: { AUTO_PUBLICAR: 'instagram' }, ...d });
  assert.equal(r.jobs.length, 1);
  assert.deepEqual(d.jobs[0].platforms, ['instagram']);
  assert.equal(d.jobs[0].clipId, 'c1');
  assert.equal(d.jobs[0].porRed, true);
  assert.equal(d.jobs[0].descripcion, 'instagram:Titulo real', 'usa el titulo de la ficha, no la URL de origen');
  assert.deepEqual(d.jobs[0].etiquetas, ['#instagram']);
  assert.ok(d.parches.some((p) => p.autoPublicar && p.autoPublicar.jobs[0] === 'job_1'));
});

test('autoPublicarClip: si una red falla en la cola NO lanza, avisa y sigue con las demas', async () => {
  const d = doble({ falla: (s) => s.platforms.includes('instagram') });
  const r = await autoPublicarClip('c1', { env: { AUTO_PUBLICAR: 'instagram,tiktok' }, ...d });
  assert.equal(r.errores.length, 1);
  assert.equal(r.jobs.length, 1);
  assert.deepEqual(d.jobs[0].platforms, ['tiktok']);
  assert.equal(d.incidencias.length, 1);
  assert.equal(d.incidencias[0][0], 'warn');
});

test('autoPublicarClip: clip inexistente, sin renderizar o programador caido -> nunca lanza', async () => {
  const d = doble({ clip: { ...clipListo, estado: 'procesando' } });
  assert.equal(await autoPublicarClip('c1', { env: { AUTO_PUBLICAR: 'instagram' }, ...d }), null);
  assert.equal(await autoPublicarClip('nope', { env: { AUTO_PUBLICAR: 'instagram' }, ...doble() }), null);
  const roto = doble();
  roto.programador.cargar = async () => { throw new Error('mongo caido'); };
  roto.programador.encolar = async () => { throw new Error('sin almacen'); };
  const r = await autoPublicarClip('c1', { env: { AUTO_PUBLICAR: 'instagram' }, ...roto });
  assert.equal(r.jobs.length, 0);
  assert.equal(r.errores.length, 1);
});

test('autoarranque: PROG_AUTOARRANQUE=on enciende el programador; sin la variable queda apagado', async () => {
  assert.equal(autoarranqueActivo({ PROG_AUTOARRANQUE: 'on' }), true);
  assert.equal(autoarranqueActivo({ PROG_AUTOARRANQUE: 'true' }), true);
  assert.equal(autoarranqueActivo({}), false);
  assert.equal(autoarranqueActivo({ PROG_AUTOARRANQUE: 'off' }), false);

  const prog = crearProgramador({ rutaJson: path.join(raiz, 'prog-on.json'), mongoUri: '' });
  assert.equal(prog.estado().activo, false);
  assert.equal(await prog.autoarrancar({ PROG_AUTOARRANQUE: 'on' }), true);
  assert.equal(prog.estado().activo, true);
  await prog.detener();
  assert.equal(prog.estado().activo, false);

  const apagado = crearProgramador({ rutaJson: path.join(raiz, 'prog-off.json'), mongoUri: '' });
  assert.equal(await apagado.autoarrancar({}), false);
  assert.equal(apagado.estado().activo, false);
  await apagado.detener();
});

test('contrato real: autoPublicarClip + programador + store (un trabajo por red, sin duplicar si se repite)', async () => {
  const { store } = await import('../src/storage/store.js');
  const clip = store.encolar('https://youtu.be/abc', { origen: 'url' });
  store.completar(clip.id, { url: '/clips/real123.mp4', duracion: 40, ficha: { titulo: 'Titulo X', descripcion: 'Desc X', hashtags: ['x'] }, marketing: { titulo: 'Titulo X', descripcion: 'Desc X', hashtags: ['x'], cta: 'Sigue' }, copy: 'Desc X', cta: 'Sigue' });
  const prog = crearProgramador({ rutaJson: path.join(raiz, 'prog-real.json'), mongoUri: '' });
  const env = { AUTO_PUBLICAR: 'instagram,tiktok' };
  const r = await autoPublicarClip(clip.id, { env, programador: prog });
  assert.equal(r.errores.length, 0);
  assert.equal(r.jobs.length, 2);
  const cola = prog.listar().filter((j) => j.clipId === clip.id);
  assert.deepEqual(cola.map((j) => j.platforms.join()).sort(), ['instagram', 'tiktok']);
  assert.ok(cola.every((j) => j.status === 'queued' && j.rutaVideo.endsWith('real123.mp4') && j.descripcion));
  assert.equal(store.buscar(clip.id).autoPublicar.jobs.length, 2);
  // repetir (p. ej. reintento del pipeline) no duplica: el programador rechaza el clip ya en cola y queda como aviso
  const otra = await autoPublicarClip(clip.id, { env, programador: prog });
  assert.equal(otra.jobs.length, 0);
  assert.equal(otra.errores.length, 2);
  assert.equal(prog.listar().filter((j) => j.clipId === clip.id).length, 2);
  await prog.detener();
});
