import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.LOG_LEVEL = 'error';
const { publicarClip, decidirFacebook } = await import('../src/engine/publicador.js');
const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-pubfb-'));
const video = path.join(raiz, 'clip.mp4');
await fs.writeFile(video, 'x');
test.after(() => fs.rm(raiz, { recursive: true, force: true }));

function entorno({ crosspost = false, fbConfig = false, forzado = false, yaEnIg = false, igConfig = true, igFalla = null, fbFalla = null } = {}) {
  const cuenta = { ig: 0, fb: 0, cookies: 0 };
  const clip = { instagram: yaEnIg ? { mediaId: 'previo' } : undefined };
  const anotaciones = [];
  return {
    cuenta, anotaciones,
    opciones: {
      modo: 'real',
      reloj: () => '2026-01-01T00:00:00.000Z',
      almacen: { buscar: () => clip, actualizar: (id, p) => anotaciones.push([id, p]) },
      instagramOficial: {
        instagramConfigurado: () => igConfig,
        crosspostFacebookActivo: () => crosspost,
        urlPublicaDeClip: (r) => 'https://cliplab.example.com/clips/' + path.basename(r),
        publishInstagramReel: async () => { cuenta.ig += 1; if (igFalla) throw igFalla; return { mediaId: 'ig1', permalink: 'https://instagram.com/reel/1' }; },
      },
      facebookOficial: {
        facebookConfigurado: () => fbConfig,
        facebookDirectoForzado: () => forzado,
        publishFacebookReel: async () => { cuenta.fb += 1; if (fbFalla) throw fbFalla; return { videoId: 'fb1', permalink: 'https://facebook.com/r/1', confirmado: true }; },
      },
      leerCookies: async () => { cuenta.cookies += 1; throw new Error('sin cookies'); },
      obligatorias: { facebook: [], instagram: [], tiktok: [] },
    },
  };
}
const pedir = (plataformas, e) => publicarClip({ clipId: 'c1', rutaVideo: video, plataformas, descripcion: 'Texto', etiquetas: ['uno'] }, e.opciones);
const fallaDe = (codigo, transitorio) => Object.assign(new Error(codigo + ' simulado'), { codigo, transitorio });

test('crosspost + Instagram en la misma llamada: Facebook se resuelve con el Reel (sin Chromium ni publicacion aparte)', async () => {
  const e = entorno({ crosspost: true });
  const r = await pedir(['instagram', 'facebook'], e);
  assert.equal(r.ok, true);
  assert.equal(r.resultados.facebook.codigo, 'CROSSPOST');
  assert.deepEqual(e.cuenta, { ig: 1, fb: 0, cookies: 0 });
  assert.ok(e.anotaciones.some(([id, p]) => id === 'c1' && p.instagram && p.instagram.mediaId === 'ig1'), 'el clip queda anotado como publicado en Instagram');
});

test('Facebook SOLO + reenvio activo + sin credenciales de Pagina: espera a Instagram (transitorio) y NUNCA va a cookies', async () => {
  const e = entorno({ crosspost: true });
  const r = await pedir(['facebook'], e);
  assert.equal(r.ok, false);
  assert.equal(r.resultados.facebook.codigo, 'ESPERANDO_INSTAGRAM');
  assert.equal(r.resultados.facebook.transitorio, true);
  assert.equal(e.cuenta.cookies, 0);
  const despues = entorno({ crosspost: true, yaEnIg: true });
  const ok = await pedir(['facebook'], despues);
  assert.equal(ok.resultados.facebook.codigo, 'CROSSPOST');
  assert.equal(ok.ok, true);
});

test('Facebook SOLO con FB_PAGE_*: publica directo por Graph API y no toca cookies', async () => {
  const e = entorno({ fbConfig: true });
  const r = await pedir(['facebook'], e);
  assert.equal(r.ok, true);
  assert.equal(r.resultados.facebook.codigo, 'OK');
  assert.equal(r.resultados.facebook.videoId, 'fb1');
  assert.deepEqual(e.cuenta, { ig: 0, fb: 1, cookies: 0 });
  assert.ok(e.anotaciones.some(([, p]) => p.facebook && p.facebook.videoId === 'fb1'));
});

test('anti-duplicado: con reenvio activo y el clip YA en Instagram, Facebook directo no vuelve a publicar', async () => {
  const e = entorno({ crosspost: true, fbConfig: true, yaEnIg: true });
  const r = await pedir(['facebook'], e);
  assert.equal(r.resultados.facebook.codigo, 'CROSSPOST');
  assert.equal(e.cuenta.fb, 0);
  // pero si el clip aun no salio en Instagram, la peticion explicita a Facebook se atiende directo
  const e2 = entorno({ crosspost: true, fbConfig: true, yaEnIg: false });
  const r2 = await pedir(['facebook'], e2);
  assert.equal(r2.resultados.facebook.codigo, 'OK');
  assert.equal(e2.cuenta.fb, 1);
});

test('Instagram + Facebook con credenciales de Pagina: reenvio activo -> un solo Reel; FB_PUBLICAR_DIRECTO=on -> directo tambien', async () => {
  const a = entorno({ crosspost: true, fbConfig: true });
  const ra = await pedir(['instagram', 'facebook'], a);
  assert.deepEqual(a.cuenta, { ig: 1, fb: 0, cookies: 0 });
  assert.equal(ra.resultados.facebook.codigo, 'CROSSPOST');
  const b = entorno({ crosspost: true, fbConfig: true, forzado: true });
  const rb = await pedir(['instagram', 'facebook'], b);
  assert.deepEqual(b.cuenta, { ig: 1, fb: 1, cookies: 0 });
  assert.equal(rb.resultados.facebook.codigo, 'OK');
});

test('sin ninguna API para Facebook: flujo de cookies de siempre', async () => {
  const e = entorno({});
  const r = await pedir(['facebook'], e);
  assert.equal(e.cuenta.cookies, 1);
  assert.equal(r.resultados.facebook.codigo, 'SESION_ILEGIBLE');
});

test('fallos de la API: Instagram caido arrastra a Facebook (mismo transitorio); fallo directo de Facebook conserva su clasificacion', async () => {
  const a = entorno({ crosspost: true, igFalla: fallaDe('LIMITE_API', true) });
  const ra = await pedir(['instagram', 'facebook'], a);
  assert.equal(ra.resultados.instagram.codigo, 'LIMITE_API');
  assert.equal(ra.resultados.facebook.ok, false);
  assert.equal(ra.resultados.facebook.transitorio, true);
  const b = entorno({ fbConfig: true, fbFalla: fallaDe('TOKEN_INVALIDO', false) });
  const rb = await pedir(['facebook'], b);
  assert.equal(rb.resultados.facebook.codigo, 'TOKEN_INVALIDO');
  assert.equal(rb.resultados.facebook.transitorio, false);
  assert.equal(b.cuenta.cookies, 0, 'con credenciales de Pagina un fallo NUNCA cae a Chromium');
});

test('modo seco: no llama a ninguna API', async () => {
  const e = entorno({ crosspost: true, fbConfig: true });
  e.opciones.modo = 'seco';
  await pedir(['instagram', 'facebook'], e);
  assert.deepEqual([e.cuenta.ig, e.cuenta.fb], [0, 0]);
});

test('decidirFacebook: matriz de decisiones', () => {
  const mk = (crosspost, fbConfig, forzado) => ({ crosspostFacebookActivo: () => crosspost, facebookConfigurado: () => fbConfig, facebookDirectoForzado: () => forzado });
  const d = ({ crosspost = false, fbConfig = false, forzado = false, igOficial = false, yaEnIg = false }) => {
    const m = mk(crosspost, fbConfig, forzado);
    return decidirFacebook({ ig: m, fb: m, plataformas: ['facebook'], igOficial, clip: { clipId: 'c' }, almacen: { buscar: () => ({ instagram: yaEnIg ? { mediaId: 'x' } : undefined }) } });
  };
  assert.equal(d({ crosspost: true, igOficial: true }), 'crosspost');
  assert.equal(d({ crosspost: true, igOficial: true, forzado: true, fbConfig: true }), 'directo');
  assert.equal(d({ fbConfig: true }), 'directo');
  assert.equal(d({ crosspost: true, fbConfig: true, yaEnIg: true }), 'crosspost_previo');
  assert.equal(d({ crosspost: true }), 'esperar_instagram');
  assert.equal(d({ crosspost: true, yaEnIg: true }), 'crosspost_previo');
  assert.equal(d({}), 'cookies');
});
