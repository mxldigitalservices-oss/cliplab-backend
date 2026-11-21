import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-escalera-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.SESSION_DIR = path.join(raiz, 'sesion');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.MASTER_KEY = 'llave-de-prueba';
process.env.LOG_LEVEL = 'error';
process.env.YTDLP_PATH = fileURLToPath(new URL('./fixtures/yt-dlp-escalera.sh', import.meta.url));
process.env.FAKE_LOG = path.join(raiz, 'llamadas.log');

const { descargarVideo, planDeEstrategias, pideOtraEstrategia } = await import('../src/engine/download.js');

test.after(() => fs.rm(raiz, { recursive: true, force: true }));
test.beforeEach(async () => {
  delete process.env.FAKE_REQUIERE;
  delete process.env.FAKE_ERROR;
  await fs.rm(process.env.FAKE_LOG, { force: true });
});

const URL_VIDEO = 'https://youtu.be/f7r3r9zAYxM';
const llamadas = async () => (await fs.readFile(process.env.FAKE_LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean);

test('plan con sesion: 5 estrategias de simple a especifica; las ultimas no usan cookies', () => {
  const plan = planDeEstrategias(true);
  assert.deepEqual(plan.map((e) => e.id), ['predeterminada', 'formato-libre', 'hls-seguro', 'sin-cookies', 'sin-cookies-android-vr']);
  assert.deepEqual(plan.map((e) => e.cookies), [true, true, true, false, false]);
  assert.equal(plan[0].clientes, null, 'por defecto NO se fuerzan clientes (forzarlos con cookies deja a yt-dlp sin formatos)');
  assert.match(plan[2].clientes, /web_safari/);
  assert.match(plan[4].clientes, /android_vr/);
});

test('plan sin sesion: se quitan las estrategias que quedarian repetidas', () => {
  const plan = planDeEstrategias(false);
  assert.ok(plan.length < 5);
  assert.equal(new Set(plan.map((e) => [e.formato, e.clientes, e.cookies].join('|'))).size, plan.length);
  assert.ok(plan.every((e) => e.cookies === false));
});

test('pideOtraEstrategia reconoce formatos ausentes y 403, pero no otros errores', () => {
  assert.equal(pideOtraEstrategia('ERROR: [youtube] x: Requested format is not available. Use --list-formats'), true);
  assert.equal(pideOtraEstrategia('ERROR: Only images are available for download'), true);
  assert.equal(pideOtraEstrategia('ERROR: unable to download video data: HTTP Error 403: Forbidden'), true);
  assert.equal(pideOtraEstrategia('ERROR: [youtube] x: Video unavailable'), false);
  assert.equal(pideOtraEstrategia('ERROR: [youtube] x: Private video'), false);
});

test('camino feliz: una sola llamada, con runtime de JS y SIN forzar clientes', async () => {
  const video = await descargarVideo(URL_VIDEO, path.join(raiz, 'd1'));
  assert.equal(video.id, 'vid123');
  assert.equal(video.duracion, 60);
  assert.equal(video.titulo, 'Titulo de prueba');
  const l = await llamadas();
  assert.equal(l.length, 1);
  assert.match(l[0], /--js-runtimes node/);
  assert.doesNotMatch(l[0], /player_client/, 'no se fuerza android,web,tv por defecto');
  assert.doesNotMatch(l[0], /--proxy/);
});

test('si YouTube no entrega formatos con la primera estrategia, la escalera prueba otra y termina bien', async () => {
  process.env.FAKE_REQUIERE = 'android_vr';
  const video = await descargarVideo(URL_VIDEO, path.join(raiz, 'd2'));
  assert.equal(video.id, 'vid123');
  const l = await llamadas();
  assert.ok(l.length >= 2 && l.length <= 5, String(l.length));
  assert.match(l[l.length - 1], /player_client=default,android_vr/);
  assert.ok(l.slice(0, -1).every((x) => !/android_vr/.test(x)));
});

test('si ninguna estrategia funciona: error claro + estrategias probadas + --list-formats en el detalle', async () => {
  process.env.FAKE_REQUIERE = 'nunca-aparece';
  await assert.rejects(descargarVideo(URL_VIDEO, path.join(raiz, 'd3')), (error) => {
    assert.match(error.message, /no entrego formatos descargables/);
    assert.match(error.message, /YTDLP_PROXY/);
    assert.match(error.detalle, /Estrategias probadas/);
    assert.match(error.detalle, /Requested format is not available/);
    assert.match(error.detalle, /storyboard/, 'incluye el listado real de formatos');
    return true;
  });
  const l = await llamadas();
  assert.equal(l.filter((x) => /--list-formats/.test(x)).length, 1);
});

test('un error que NO es de formatos (video privado) corta de inmediato, sin recorrer la escalera', async () => {
  process.env.FAKE_REQUIERE = 'nunca-aparece';
  process.env.FAKE_ERROR = 'ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access to this video';
  await assert.rejects(descargarVideo(URL_VIDEO, path.join(raiz, 'd4')), /Private video/);
  assert.equal((await llamadas()).length, 1);
});

test('URL invalida se rechaza antes de llamar a yt-dlp', async () => {
  await assert.rejects(descargarVideo('https://ejemplo.com/video', path.join(raiz, 'd5')), /invalida/);
  assert.equal((await llamadas()).length, 0);
});
