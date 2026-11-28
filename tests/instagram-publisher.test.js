import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL = 'error';
const { crearClienteInstagram, leerConfigInstagram, urlPublicaDeClip, prepararCaption, clasificarErrorGraph, ErrorInstagram } =
  await import('../src/services/instagramPublisher.js');

const TOKEN = 'EAAFAKETOKEN' + 'x'.repeat(50);
const SECRET = 'secreto-de-la-app-123';
const ENV = { IG_ACCESS_TOKEN: TOKEN, IG_USER_ID: '17841402295297534', META_APP_ID: '1335319935386808', META_APP_SECRET: SECRET, PUBLIC_BASE_URL: 'https://cliplab.example.com' };

// fetch simulado: responde segun un guion y guarda las llamadas
function falsoMeta(handler) {
  const llamadas = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const params = init.method === 'POST' ? Object.fromEntries(new URLSearchParams(init.body)) : Object.fromEntries(u.searchParams);
    const llamada = { metodo: init.method || 'GET', ruta: u.pathname, params, url };
    llamadas.push(llamada);
    const r = await handler(llamada, llamadas);
    return { ok: !r.error && (r.status ?? 200) < 400, status: r.status ?? (r.error ? 400 : 200), json: async () => r.cuerpo ?? (r.error ? { error: r.error } : {}) };
  };
  return { fetch, llamadas };
}
const sinEspera = { sleep: async () => {} };

test('config: version minima v21.0 y variables faltantes', () => {
  assert.deepEqual(leerConfigInstagram({}).faltan, ['IG_ACCESS_TOKEN', 'IG_USER_ID']);
  assert.equal(leerConfigInstagram({ ...ENV, IG_GRAPH_VERSION: 'v19.0' }).versionValida, false);
  assert.equal(leerConfigInstagram({ ...ENV, IG_GRAPH_VERSION: 'v22.0' }).version, 'v22.0');
  assert.equal(leerConfigInstagram(ENV).version, 'v21.0');
});

test('verifyInstagramConnection: consulta el perfil con los campos pedidos y NO publica nada', async () => {
  const meta = falsoMeta((l) => {
    if (l.ruta.endsWith('/debug_token')) return { cuerpo: { data: { is_valid: true, expires_at: Math.floor(Date.now() / 1000) + 86400 * 40, scopes: ['instagram_basic', 'instagram_content_publish'] } } };
    return { cuerpo: { id: '17841402295297534', username: 'farol_al_dia', profile_picture_url: 'https://x/y.jpg' } };
  });
  const api = crearClienteInstagram({ env: ENV, fetch: meta.fetch, ...sinEspera });
  const r = await api.verifyInstagramConnection();
  assert.equal(r.connected, true);
  assert.equal(r.username, 'farol_al_dia');
  assert.equal(r.token.puedePublicar, true);
  assert.ok(r.token.diasRestantes >= 39 && r.token.diasRestantes <= 40);
  const perfil = meta.llamadas[0];
  assert.equal(perfil.metodo, 'GET');
  assert.equal(perfil.ruta, '/v21.0/17841402295297534');
  assert.equal(perfil.params.fields, 'id,username,profile_picture_url');
  assert.ok(perfil.params.appsecret_proof, 'firma con appsecret_proof');
  assert.ok(!meta.llamadas.some((l) => l.metodo === 'POST'), 'verificar nunca hace POST');
});

test('verifyInstagramConnection: token vencido (190) -> connected=false, sin filtrar el token', async () => {
  const meta = falsoMeta(() => ({ status: 400, error: { message: 'Error validating access token: ' + TOKEN, type: 'OAuthException', code: 190, fbtrace_id: 'abc' } }));
  const api = crearClienteInstagram({ env: ENV, fetch: meta.fetch, ...sinEspera });
  const r = await api.verifyInstagramConnection();
  assert.equal(r.connected, false);
  assert.equal(r.error.codigo, 'TOKEN_INVALIDO');
  assert.equal(r.error.transitorio, false);
  assert.ok(!JSON.stringify(r).includes(TOKEN), 'el token no aparece en la respuesta');
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('verifyInstagramConnection: sin configuracion no llama a Meta', async () => {
  const meta = falsoMeta(() => ({ cuerpo: {} }));
  const r = await crearClienteInstagram({ env: {}, fetch: meta.fetch }).verifyInstagramConnection();
  assert.equal(r.connected, false);
  assert.equal(r.error.codigo, 'SIN_CONFIG');
  assert.equal(meta.llamadas.length, 0);
});

test('verifyInstagramConnection: el token de OTRA cuenta se rechaza', async () => {
  const meta = falsoMeta(() => ({ cuerpo: { id: '999', username: 'otra' } }));
  const r = await crearClienteInstagram({ env: ENV, fetch: meta.fetch }).verifyInstagramConnection();
  assert.equal(r.connected, false);
  assert.equal(r.error.codigo, 'CUENTA_DISTINTA');
});

test('publishInstagramReel: 3 pasos oficiales con sondeo hasta FINISHED', async () => {
  let consultas = 0;
  const meta = falsoMeta((l) => {
    if (l.ruta.endsWith('/content_publishing_limit')) return { cuerpo: { data: [{ quota_usage: 3, config: { quota_total: 100, quota_duration: 86400 } }] } };
    if (l.ruta.endsWith('/media') && l.metodo === 'POST') return { cuerpo: { id: 'cont_1' } };
    if (l.ruta.endsWith('/cont_1')) { consultas += 1; return { cuerpo: { status_code: consultas < 3 ? 'IN_PROGRESS' : 'FINISHED' } }; }
    if (l.ruta.endsWith('/media_publish')) return { cuerpo: { id: 'reel_9' } };
    if (l.ruta.endsWith('/reel_9')) return { cuerpo: { permalink: 'https://instagram.com/reel/abc' } };
    return { status: 404, error: { message: 'no existe ' + l.ruta, code: 100 } };
  });
  const esperas = [];
  const api = crearClienteInstagram({ env: ENV, fetch: meta.fetch, sleep: async (ms) => { esperas.push(ms); } });
  const r = await api.publishInstagramReel({ videoUrl: 'https://cliplab.example.com/clips/a.mp4', caption: 'Parte 1/5 — Titulo | Sigue para la Parte 2' });
  assert.equal(r.ok, true);
  assert.equal(r.mediaId, 'reel_9');
  assert.equal(r.permalink, 'https://instagram.com/reel/abc');
  const crea = meta.llamadas.find((l) => l.metodo === 'POST' && l.ruta.endsWith('/media'));
  assert.equal(crea.ruta, '/v21.0/17841402295297534/media');
  assert.equal(crea.params.media_type, 'REELS');
  assert.equal(crea.params.share_to_feed, 'true');
  assert.equal(crea.params.video_url, 'https://cliplab.example.com/clips/a.mp4');
  assert.ok(!crea.url.includes('access_token'), 'el token viaja en el cuerpo del POST, no en la URL');
  const pub = meta.llamadas.find((l) => l.ruta.endsWith('/media_publish'));
  assert.equal(pub.params.creation_id, 'cont_1');
  assert.equal(consultas, 3);
  assert.deepEqual(esperas, [3000, 4500]);   // espera creciente 3 s -> 4.5 s
});

test('publishInstagramReel: ERROR de procesamiento -> MEDIA_INVALIDA (permanente) y no publica', async () => {
  const meta = falsoMeta((l) => {
    if (l.ruta.endsWith('/content_publishing_limit')) return { cuerpo: { data: [] } };
    if (l.metodo === 'POST') return { cuerpo: { id: 'c2' } };
    return { cuerpo: { status_code: 'ERROR', status: 'Error: formato no soportado (2207026)' } };
  });
  const api = crearClienteInstagram({ env: ENV, fetch: meta.fetch, ...sinEspera });
  await assert.rejects(api.publishInstagramReel({ videoUrl: 'https://x.test/a.mp4', caption: 'x' }), (e) => e.codigo === 'MEDIA_INVALIDA' && e.transitorio === false);
  assert.ok(!meta.llamadas.some((l) => l.ruta.endsWith('/media_publish')));
});

test('publishInstagramReel: timeout de procesamiento es transitorio', async () => {
  let t = 0;
  const meta = falsoMeta((l) => {
    if (l.ruta.endsWith('/content_publishing_limit')) return { cuerpo: { data: [] } };
    if (l.metodo === 'POST') return { cuerpo: { id: 'c3' } };
    return { cuerpo: { status_code: 'IN_PROGRESS' } };
  });
  const api = crearClienteInstagram({ env: { ...ENV, IG_PUBLISH_TIMEOUT_MIN: '1' }, fetch: meta.fetch, sleep: async (ms) => { t += ms; }, reloj: () => t });
  await assert.rejects(api.publishInstagramReel({ videoUrl: 'https://x.test/a.mp4', caption: 'x' }), (e) => e.codigo === 'TIMEOUT_PROCESAMIENTO' && e.transitorio === true);
});

test('publishInstagramReel: si media_publish pierde la respuesta pero el contenedor ya esta PUBLISHED, NO se duplica', async () => {
  const meta = falsoMeta((l) => {
    if (l.ruta.endsWith('/content_publishing_limit')) return { cuerpo: { data: [] } };
    if (l.ruta.endsWith('/media') && l.metodo === 'POST') return { cuerpo: { id: 'c4' } };
    if (l.ruta.endsWith('/media_publish')) return { status: 500, error: { message: 'boom', code: 2 } };
    if (l.ruta.endsWith('/c4')) return { cuerpo: { status_code: l.params.fields === 'status_code' && meta.llamadas.some((x) => x.ruta.endsWith('/media_publish')) ? 'PUBLISHED' : 'FINISHED' } };
    return { cuerpo: {} };
  });
  const api = crearClienteInstagram({ env: ENV, fetch: meta.fetch, ...sinEspera });
  const r = await api.publishInstagramReel({ videoUrl: 'https://x.test/a.mp4', caption: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.confirmadoPorEstado, true);
  assert.equal(meta.llamadas.filter((l) => l.ruta.endsWith('/media_publish')).length, 1);
});

test('publishInstagramReel: cuota agotada y validaciones previas', async () => {
  const meta = falsoMeta((l) => (l.ruta.endsWith('/content_publishing_limit') ? { cuerpo: { data: [{ quota_usage: 100, config: { quota_total: 100 } }] } } : { cuerpo: { id: 'x' } }));
  const api = crearClienteInstagram({ env: ENV, fetch: meta.fetch, ...sinEspera });
  await assert.rejects(api.publishInstagramReel({ videoUrl: 'https://x.test/a.mp4', caption: 'x' }), (e) => e.codigo === 'LIMITE_PUBLICACION' && e.transitorio);
  assert.ok(!meta.llamadas.some((l) => l.metodo === 'POST'));
  await assert.rejects(api.publishInstagramReel({ videoUrl: 'http://x.test/a.mp4' }), (e) => e.codigo === 'URL_INVALIDA');
  await assert.rejects(crearClienteInstagram({ env: {}, fetch: meta.fetch }).publishInstagramReel({ videoUrl: 'https://x.test/a.mp4' }), (e) => e.codigo === 'SIN_CONFIG');
});

test('clasificarErrorGraph: permanentes vs transitorios', () => {
  assert.equal(clasificarErrorGraph(400, { code: 190 }).transitorio, false);
  assert.equal(clasificarErrorGraph(400, { code: 4 }).codigo, 'LIMITE_API');
  assert.equal(clasificarErrorGraph(500, { code: 2 }).transitorio, true);
  assert.equal(clasificarErrorGraph(400, { code: 100, error_subcode: 2207026 }).codigo, 'MEDIA_INVALIDA');
  assert.equal(clasificarErrorGraph(403, {}).codigo, 'PERMISOS');
});

test('urlPublicaDeClip: solo sirve archivos dentro de /clips y exige https', () => {
  const base = { env: ENV, clipsDir: '/data/clips' };
  assert.equal(urlPublicaDeClip('/data/clips/abc.mp4', base), 'https://cliplab.example.com/clips/abc.mp4');
  assert.throws(() => urlPublicaDeClip('/etc/passwd', base), (e) => e.codigo === 'VIDEO_FUERA_DE_CLIPS');
  assert.throws(() => urlPublicaDeClip('/data/clips/abc.mp4', { env: {}, clipsDir: '/data/clips' }), (e) => e.codigo === 'SIN_URL_PUBLICA');
  assert.equal(urlPublicaDeClip('/data/clips/a.mp4', { env: { RAILWAY_PUBLIC_DOMAIN: 'app.up.railway.app' }, clipsDir: '/data/clips' }), 'https://app.up.railway.app/clips/a.mp4');
  assert.equal(urlPublicaDeClip('https://cdn.x/a.mp4', base), 'https://cdn.x/a.mp4');
  assert.ok(new ErrorInstagram('x') instanceof Error);
});

test('prepararCaption: tope de 2200 caracteres sin cortar palabras', () => {
  const largo = ('palabra '.repeat(400)).trim();
  const c = prepararCaption(largo);
  assert.ok(c.length <= 2200);
  assert.ok(c.endsWith('palabra'));
  assert.equal(prepararCaption('  hola \n\n\n\n mundo  '), 'hola\n\n mundo');
});
