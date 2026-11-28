import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL = 'error';
const { crearClienteFacebook, leerConfigFacebook } = await import('../src/services/facebookPublisher.js');

const TOKEN = 'EAAPAGETOKEN' + 'p'.repeat(50);
const ENV = { FB_PAGE_ID: '1122334455', FB_PAGE_ACCESS_TOKEN: TOKEN, META_APP_SECRET: 'secreto-app-xyz' };
const UPLOAD = 'https://rupload.facebook.com/video-upload/v21.0/VID1';

function falso(handler) {
  const llamadas = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const params = init.method === 'POST' && typeof init.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : Object.fromEntries(u.searchParams);
    const l = { metodo: init.method || 'GET', host: u.host, ruta: u.pathname, params, cabeceras: init.headers || {}, url };
    llamadas.push(l);
    const r = await handler(l, llamadas);
    return { ok: !r.error && (r.status ?? 200) < 400, status: r.status ?? (r.error ? 400 : 200), json: async () => r.cuerpo ?? (r.error ? { error: r.error } : {}) };
  };
  return { fetch, llamadas };
}
const sinEspera = { sleep: async () => {} };

test('config: version minima, modo y variables faltantes', () => {
  assert.deepEqual(leerConfigFacebook({}).faltan, ['FB_PAGE_ACCESS_TOKEN', 'FB_PAGE_ID']);
  assert.equal(leerConfigFacebook({ ...ENV, FB_GRAPH_VERSION: 'v18.0' }).versionValida, false);
  assert.equal(leerConfigFacebook({ ...ENV, IG_GRAPH_VERSION: 'v22.0' }).version, 'v22.0');
  assert.equal(leerConfigFacebook(ENV).modo, 'reels');
  assert.equal(leerConfigFacebook({ ...ENV, FB_PUBLISH_MODE: 'videos' }).modo, 'videos');
});

test('verifyFacebookConnection: GET /{pagina}?fields=id,name,link y nunca publica', async () => {
  const m = falso(() => ({ cuerpo: { id: '1122334455', name: 'El Farol al Dia', link: 'https://facebook.com/farol' } }));
  const r = await crearClienteFacebook({ env: ENV, fetch: m.fetch }).verifyFacebookConnection();
  assert.equal(r.connected, true);
  assert.equal(r.name, 'El Farol al Dia');
  assert.equal(m.llamadas[0].ruta, '/v21.0/1122334455');
  assert.equal(m.llamadas[0].params.fields, 'id,name,link');
  assert.ok(m.llamadas[0].params.appsecret_proof);
  assert.ok(m.llamadas.every((l) => l.metodo === 'GET'));
});

test('verifyFacebookConnection: token invalido o sin config -> connected=false sin filtrar el token', async () => {
  const m = falso(() => ({ status: 400, error: { message: 'Invalid OAuth access token ' + TOKEN, code: 190 } }));
  const r = await crearClienteFacebook({ env: ENV, fetch: m.fetch }).verifyFacebookConnection();
  assert.equal(r.connected, false);
  assert.equal(r.error.codigo, 'TOKEN_INVALIDO');
  assert.ok(!JSON.stringify(r).includes(TOKEN));
  const sin = await crearClienteFacebook({ env: {}, fetch: m.fetch }).verifyFacebookConnection();
  assert.equal(sin.error.codigo, 'SIN_CONFIG');
});

test('Reel de Pagina: start -> subida por file_url -> finish PUBLISHED -> estado ready', async () => {
  let estados = 0;
  const m = falso((l) => {
    if (l.host === 'rupload.facebook.com') return { cuerpo: { success: true } };
    if (l.ruta.endsWith('/video_reels') && l.params.upload_phase === 'start') return { cuerpo: { video_id: 'VID1', upload_url: UPLOAD } };
    if (l.ruta.endsWith('/video_reels') && l.params.upload_phase === 'finish') return { cuerpo: { success: true } };
    if (l.ruta.endsWith('/VID1') && l.params.fields === 'status') { estados += 1; return { cuerpo: { status: { video_status: estados < 2 ? 'processing' : 'ready' } } }; }
    if (l.ruta.endsWith('/VID1') && l.params.fields === 'permalink_url') return { cuerpo: { permalink_url: '/reel/123' } };
    return { status: 404, error: { message: 'no existe ' + l.ruta, code: 100 } };
  });
  const api = crearClienteFacebook({ env: ENV, fetch: m.fetch, ...sinEspera });
  const r = await api.publishFacebookReel({ videoUrl: 'https://cliplab.example.com/clips/a.mp4', caption: 'Hola #mundo' });
  assert.deepEqual([r.ok, r.videoId, r.confirmado, r.modo], [true, 'VID1', true, 'reels']);
  assert.equal(r.permalink, 'https://www.facebook.com/reel/123');
  const subida = m.llamadas.find((l) => l.host === 'rupload.facebook.com');
  assert.equal(subida.cabeceras.file_url, 'https://cliplab.example.com/clips/a.mp4');
  assert.equal(subida.cabeceras.Authorization, 'OAuth ' + TOKEN);
  const start = m.llamadas.find((l) => l.params.upload_phase === 'start');
  assert.equal(start.ruta, '/v21.0/1122334455/video_reels');
  assert.ok(!start.url.includes('access_token'), 'el token va en el cuerpo, no en la URL');
  const fin = m.llamadas.find((l) => l.params.upload_phase === 'finish');
  assert.equal(fin.params.video_state, 'PUBLISHED');
  assert.equal(fin.params.video_id, 'VID1');
  assert.equal(fin.params.description, 'Hola #mundo');
  const orden = m.llamadas.map((l) => (l.host === 'rupload.facebook.com' ? 'subida' : l.params.upload_phase || 'consulta'));
  assert.deepEqual(orden.slice(0, 3), ['start', 'subida', 'finish']);
});

test('anti-duplicados: si falla la consulta de estado DESPUES del finish, el resultado sigue siendo ok (sin confirmar)', async () => {
  const m = falso((l) => {
    if (l.host === 'rupload.facebook.com') return { cuerpo: { success: true } };
    if (l.params.upload_phase === 'start') return { cuerpo: { video_id: 'V2', upload_url: UPLOAD } };
    if (l.params.upload_phase === 'finish') return { cuerpo: { success: true } };
    return { status: 500, error: { message: 'boom', code: 2 } };
  });
  const r = await crearClienteFacebook({ env: ENV, fetch: m.fetch, ...sinEspera }).publishFacebookReel({ videoUrl: 'https://x.test/a.mp4', caption: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.confirmado, false);
  assert.equal(m.llamadas.filter((l) => l.params.upload_phase === 'finish').length, 1);
});

test('Reel: estado "error" tras el finish -> MEDIA_INVALIDA permanente; falla de la subida es transitoria', async () => {
  const base = (estado) => falso((l) => {
    if (l.host === 'rupload.facebook.com') return estado === 'subida' ? { status: 503, cuerpo: { error: { message: 'busy' } } } : { cuerpo: { success: true } };
    if (l.params.upload_phase === 'start') return { cuerpo: { video_id: 'V3', upload_url: UPLOAD } };
    if (l.params.upload_phase === 'finish') return { cuerpo: { success: true } };
    return { cuerpo: { status: { video_status: 'error' } } };
  });
  await assert.rejects(crearClienteFacebook({ env: ENV, fetch: base('estado').fetch, ...sinEspera }).publishFacebookReel({ videoUrl: 'https://x.test/a.mp4' }), (e) => e.codigo === 'MEDIA_INVALIDA' && e.transitorio === false);
  const m = base('subida');
  await assert.rejects(crearClienteFacebook({ env: ENV, fetch: m.fetch, ...sinEspera }).publishFacebookReel({ videoUrl: 'https://x.test/a.mp4' }), (e) => e.transitorio === true);
  assert.ok(!m.llamadas.some((l) => l.params.upload_phase === 'finish'), 'si la subida falla no se publica nada');
});

test('modo videos: una sola llamada a /{pagina}/videos con file_url', async () => {
  const m = falso((l) => {
    if (l.ruta.endsWith('/videos')) return { cuerpo: { id: 'VID9' } };
    if (l.params.fields === 'status') return { cuerpo: { status: { video_status: 'ready' } } };
    return { cuerpo: { permalink_url: 'https://facebook.com/v/9' } };
  });
  const r = await crearClienteFacebook({ env: { ...ENV, FB_PUBLISH_MODE: 'videos' }, fetch: m.fetch, ...sinEspera }).publishFacebookReel({ videoUrl: 'https://x.test/a.mp4', caption: 'c', titulo: 'T' });
  assert.deepEqual([r.ok, r.videoId, r.modo], [true, 'VID9', 'videos']);
  const post = m.llamadas.find((l) => l.ruta.endsWith('/videos'));
  assert.equal(post.params.file_url, 'https://x.test/a.mp4');
  assert.equal(post.params.published, 'true');
  assert.equal(post.ruta, '/v21.0/1122334455/videos');
});

test('validaciones: URL https obligatoria y configuracion presente', async () => {
  const m = falso(() => ({ cuerpo: {} }));
  await assert.rejects(crearClienteFacebook({ env: ENV, fetch: m.fetch }).publishFacebookReel({ videoUrl: 'http://x.test/a.mp4' }), (e) => e.codigo === 'URL_INVALIDA');
  await assert.rejects(crearClienteFacebook({ env: {}, fetch: m.fetch }).publishFacebookReel({ videoUrl: 'https://x.test/a.mp4' }), (e) => e.codigo === 'SIN_CONFIG');
  assert.equal(m.llamadas.length, 0);
});
