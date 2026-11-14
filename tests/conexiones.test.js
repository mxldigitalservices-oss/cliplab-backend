import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-conx-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.SESSION_DIR = path.join(raiz, 'sesion');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.MASTER_KEY = 'llave-de-prueba';
process.env.LOG_LEVEL = 'error';
delete process.env.RAILWAY_ENVIRONMENT;
delete process.env.RAILWAY_PROJECT_ID;

const { validarEstado, esperarLogin } = await import('../src/sesion/plataformas.js');
const { guardarSesionRed, leerSesionRed, restaurarEstadosRedes } = await import('../src/sesion/redes.js');
const { iniciarLoginEnServidor, puedeAbrirVentana } = await import('../src/sesion/login-servidor.js');
const { store } = await import('../src/storage/store.js');
const { createApp } = await import('../src/app.js');

test.after(() => fs.rm(raiz, { recursive: true, force: true }));

const MAS_TARDE = Math.floor(Date.now() / 1000) + 86400 * 30;
const cookie = (name, value, domain, extra = {}) => ({ name, value, domain, path: '/', expires: MAS_TARDE, httpOnly: true, secure: true, sameSite: 'None', ...extra });
const estadoFacebook = () => ({
  cookies: [cookie('c_user', '100012345', '.facebook.com'), cookie('xs', 'xs-secreto-no-debe-verse', '.facebook.com'), cookie('ajena', 'x', '.google.com')],
  origins: [{ origin: 'https://www.facebook.com', localStorage: [] }, { origin: 'https://evil.example', localStorage: [] }],
});
const conexion = (p) => store.snapshot().conexiones.find((c) => c.plataforma === p);

/* ---------- validacion ---------- */

test('valida cookies de acceso por plataforma y descarta lo ajeno', () => {
  const fb = validarEstado('facebook', estadoFacebook());
  assert.equal(fb.ok, true);
  assert.equal(fb.cuenta, 'ID 100012345');
  assert.ok(fb.estado.cookies.every((c) => /facebook\.com$/.test(c.domain)), 'sin cookies de otros dominios');
  assert.deepEqual(fb.estado.origins.map((o) => o.origin), ['https://www.facebook.com']);

  assert.equal(validarEstado('instagram', { cookies: [cookie('sessionid', 'abc', '.instagram.com'), cookie('ds_user_id', '77', '.instagram.com')] }).ok, true);
  assert.equal(validarEstado('tiktok', { cookies: [cookie('sid_tt', 'abc', '.tiktok.com')] }).ok, true);
});

test('rechaza sesiones sin iniciar, vencidas, vacias o de otra red', () => {
  assert.match(validarEstado('facebook', { cookies: [cookie('c_user', '1', '.facebook.com')] }).error, /no esta iniciada/);
  assert.equal(validarEstado('facebook', { cookies: [cookie('c_user', '1', '.facebook.com', { expires: 5 }), cookie('xs', 'a', '.facebook.com', { expires: 5 })] }).ok, false);
  assert.equal(validarEstado('instagram', { cookies: [cookie('sessionid', 'abc', '.tiktok.com')] }).ok, false);
  assert.equal(validarEstado('facebook', {}).ok, false);
  assert.equal(validarEstado('myspace', estadoFacebook()).ok, false);
  // cookie de sesion (expires -1) cuenta como vigente
  assert.equal(validarEstado('instagram', { cookies: [cookie('sessionid', 'abc', '.instagram.com', { expires: -1 })] }).ok, true);
});

/* ---------- espera del login manual ---------- */

function contextoFalso(secuencia) {
  let i = 0;
  return {
    async cookies() {
      const paso = secuencia[Math.min(i++, secuencia.length - 1)];
      if (paso === 'cerrado') throw new Error('Target closed');
      return paso;
    },
    async storageState() { return { cookies: secuencia.at(-1), origins: [] }; },
  };
}
const rapido = { intervaloMs: 1, asentarMs: 1 };

test('esperarLogin: devuelve el estado cuando la persona termina de iniciar sesion', async () => {
  const final = estadoFacebook().cookies;
  const estado = await esperarLogin(contextoFalso([[], [cookie('datr', 'x', '.facebook.com')], final]), 'facebook', rapido);
  assert.ok(estado.cookies.some((c) => c.name === 'xs'));
});

test('esperarLogin: avisa si cierran la ventana o se agota el tiempo', async () => {
  await assert.rejects(esperarLogin(contextoFalso([[], 'cerrado']), 'facebook', rapido), /cerro la ventana/);
  await assert.rejects(esperarLogin(contextoFalso([[]]), 'facebook', { ...rapido, timeoutMs: 30 }), /Se agoto el tiempo/);
});

/* ---------- guardado cifrado + API ---------- */

test('guardado cifrado en SESSION_DIR; el panel pasa a "activa" al instante', async () => {
  assert.equal(conexion('facebook').estado, 'sin_sesion');
  const r = await guardarSesionRed('facebook', estadoFacebook());
  assert.equal(r.cuenta, 'ID 100012345');

  const c = conexion('facebook');
  assert.equal(c.estado, 'activa');
  assert.equal(c.conectando, false);
  assert.equal(c.cuenta, 'ID 100012345');
  assert.ok(c.ultimaVerificacion);

  const bruto = await fs.readFile(path.join(process.env.SESSION_DIR, 'red-facebook.enc'), 'utf8');
  assert.ok(!bruto.includes('xs-secreto-no-debe-verse') && !bruto.includes('100012345'), 'el archivo esta cifrado');
  assert.equal(JSON.parse(bruto).v, 1);
  const modo = (await fs.stat(path.join(process.env.SESSION_DIR, 'red-facebook.enc'))).mode & 0o777;
  assert.equal(modo, 0o600);

  const leida = await leerSesionRed('facebook');
  assert.ok(leida.cookies.some((x) => x.name === 'xs' && x.value === 'xs-secreto-no-debe-verse'));
  assert.equal(await leerSesionRed('tiktok'), null);
});

test('tras reiniciar el servidor las tarjetas recuperan su estado', async () => {
  store.actualizarConexion('facebook', { estado: 'sin_sesion', cuenta: null, ultimaVerificacion: null }); // simula arranque en frio
  await restaurarEstadosRedes();
  assert.equal(conexion('facebook').estado, 'activa');
  assert.equal(conexion('instagram').estado, 'sin_sesion');
});

test('API: PUT guarda, POST login responde segun el entorno, errores con envelope', async () => {
  const servidor = createApp().listen(0, '127.0.0.1');
  await new Promise((ok) => servidor.once('listening', ok));
  const base = 'http://127.0.0.1:' + servidor.address().port;
  const H = { 'x-master-key': 'llave-de-prueba', 'content-type': 'application/json' };
  const pedir = async (ruta, opciones = {}) => {
    const r = await fetch(base + ruta, opciones);
    return { status: r.status, cuerpo: await r.json() };
  };

  try {
    // Sin llave: 401 con envelope
    const sinLlave = await pedir('/api/panel/conexiones/tiktok/login', { method: 'POST' });
    assert.equal(sinLlave.status, 401);
    assert.deepEqual([sinLlave.cuerpo.success, sinLlave.cuerpo.data], [false, null]);

    // PUT valido (formato del script local: { estado })
    const tiktok = { cookies: [cookie('sessionid', 'tt-secreto', '.tiktok.com')], origins: [] };
    const ok = await pedir('/api/panel/conexiones/tiktok', { method: 'PUT', headers: H, body: JSON.stringify({ estado: tiktok }) });
    assert.equal(ok.status, 200);
    assert.equal(ok.cuerpo.success, true);
    assert.equal(ok.cuerpo.error, null);

    // El panel lo ve activo y el sondeo NO trae cookies
    const estado = await pedir('/api/panel/estado', { headers: H });
    assert.equal(estado.cuerpo.data.conexiones.find((c) => c.plataforma === 'tiktok').estado, 'activa');
    assert.ok(!JSON.stringify(estado.cuerpo).includes('tt-secreto'));

    // PUT invalido / plataforma desconocida
    const malo = await pedir('/api/panel/conexiones/instagram', { method: 'PUT', headers: H, body: JSON.stringify({ estado: { cookies: [] } }) });
    assert.equal(malo.status, 400);
    assert.deepEqual([malo.cuerpo.success, malo.cuerpo.data], [false, null]);
    assert.equal((await pedir('/api/panel/conexiones/myspace', { method: 'PUT', headers: H, body: '{}' })).status, 404);
    assert.equal((await pedir('/api/panel/conexiones/myspace/login', { method: 'POST', headers: H })).status, 404);

    // Servidor remoto sin pantalla (Railway): modo "local" con el comando listo
    process.env.RAILWAY_ENVIRONMENT = 'production';
    const local = await pedir('/api/panel/conexiones/instagram/login', { method: 'POST', headers: H });
    delete process.env.RAILWAY_ENVIRONMENT;
    assert.equal(local.status, 200);
    assert.equal(local.cuerpo.success, true);
    assert.equal(local.cuerpo.data.modo, 'local');
    assert.match(local.cuerpo.data.comando, /CLIPLAB_URL=http:\/\/127\.0\.0\.1:\d+ MASTER_KEY=<tu llave> npm run login -- instagram/);
    assert.equal(conexion('instagram').estado, 'sin_sesion', 'el modo local no cambia nada hasta recibir la sesion');
  } finally {
    servidor.close();
  }
});

/* ---------- navegador controlado en el servidor (con pantalla) ---------- */

test('puedeAbrirVentana: Railway no; local o con pantalla si', () => {
  assert.equal(puedeAbrirVentana({ RAILWAY_ENVIRONMENT: 'production', DISPLAY: ':0' }, 'linux'), false);
  assert.equal(puedeAbrirVentana({}, 'linux'), false);
  assert.equal(puedeAbrirVentana({ DISPLAY: ':0' }, 'linux'), true);
  assert.equal(puedeAbrirVentana({}, 'win32'), true);
  assert.equal(puedeAbrirVentana({ LOGIN_HEADFUL: 'true', RAILWAY_ENVIRONMENT: 'x' }, 'linux'), true);
});

function lanzadorFalso(secuencia, registro = {}) {
  return async (opciones) => {
    registro.opciones = opciones;
    return {
      async newContext(perfil) {
        registro.perfil = perfil;
        const ctx = contextoFalso(secuencia);
        ctx.newPage = async () => ({ goto: async (url) => { registro.url = url; } });
        return ctx;
      },
      async close() { registro.cerrado = true; },
    };
  };
}

test('login en servidor: abre la pagina oficial, captura cookies y deja la tarjeta activa', async () => {
  const registro = {};
  const igCookies = [cookie('sessionid', 'ig-secreto', '.instagram.com'), cookie('ds_user_id', '555', '.instagram.com')];
  const { modo, tarea } = await iniciarLoginEnServidor('instagram', { launch: lanzadorFalso([[], igCookies], registro), opciones: rapido });
  assert.equal(modo, 'servidor');
  assert.equal(conexion('instagram').conectando, true);
  await assert.rejects(iniciarLoginEnServidor('tiktok', { launch: lanzadorFalso([[]]) }), (e) => e.status === 409, 'solo un login a la vez');
  await tarea;

  assert.equal(registro.url, 'https://www.instagram.com/accounts/login/');
  assert.equal(registro.opciones.headless, false, 'ventana visible para escribir las credenciales a mano');
  assert.equal(registro.cerrado, true);
  const c = conexion('instagram');
  assert.deepEqual([c.estado, c.conectando, c.cuenta], ['activa', false, 'ID 555']);
  assert.ok(await leerSesionRed('instagram'));
});

test('login en servidor: si cierran la ventana queda incidencia y la tarjeta se libera', async () => {
  store.actualizarConexion('tiktok', { estado: 'sin_sesion', cuenta: null });
  const { tarea } = await iniciarLoginEnServidor('tiktok', { launch: lanzadorFalso([[], 'cerrado']), opciones: rapido });
  await tarea;
  assert.equal(conexion('tiktok').conectando, false);
  assert.equal(conexion('tiktok').estado, 'sin_sesion');
  const inc = store.snapshot().incidencias.find((i) => i.origen === 'conexiones');
  assert.ok(inc && /TikTok/.test(inc.mensaje) && /cerro la ventana/.test(inc.mensaje));
});

test('login en servidor sin Playwright instalado: error claro 501', async () => {
  await assert.rejects(iniciarLoginEnServidor('facebook'), (e) => e.status === 501 && /Playwright/.test(e.message));
  assert.equal(conexion('facebook').conectando ?? false, false);
});

/* ---------- logo de Klikap en el render ---------- */

const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('el logo oficial existe, es PNG transparente y sale arriba a la derecha del clip 1080x1920', { skip: !hayFfmpeg && 'ffmpeg no disponible' }, async () => {
  const { config } = await import('../src/config/index.js');
  assert.equal(path.basename(config.logoPath), 'klikap-logo.png');
  const png = await fs.readFile(config.logoPath);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png[25], 6, 'PNG RGBA (con canal alfa)');

  const { renderizarClip } = await import('../src/engine/render.js');
  const fuente = path.join(raiz, 'fuente.mp4');
  const ff = (args) => assert.equal(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]).status, 0);
  ff(['-f', 'lavfi', '-i', 'color=c=0x1d4d2b:s=640x360:d=3:r=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', fuente]);

  const salida = path.join(raiz, 'clip.mp4');
  const r = await renderizarClip({ entrada: fuente, salida, inicio: 0, duracion: 2, subtitulos: null, modo: 'recorte' });
  assert.equal(r.conLogo, true);
  assert.deepEqual([r.ancho, r.alto], [1080, 1920]);

  const brillo = (filtro) => {
    const p = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', salida, '-frames:v', '1', '-vf', filtro + ',format=gray', '-f', 'rawvideo', '-']);
    return p.stdout.reduce((max, v) => (v > max ? v : max), 0);
  };
  const esquinaSuperiorDerecha = brillo('crop=300:140:760:30');
  const esquinaSuperiorIzquierda = brillo('crop=300:140:20:30');
  const zonaSubtitulos = brillo('crop=900:300:90:1300');
  assert.ok(esquinaSuperiorDerecha > 200, 'hay blanco del logo arriba a la derecha (' + esquinaSuperiorDerecha + ')');
  assert.ok(esquinaSuperiorIzquierda < 120, 'arriba a la izquierda no hay logo');
  assert.ok(zonaSubtitulos < 120, 'la zona de subtitulos queda libre');
});
