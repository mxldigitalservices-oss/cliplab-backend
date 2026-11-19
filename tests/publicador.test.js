import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-pub-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.LOG_LEVEL = 'error';
delete process.env.PUBLICADOR_MODO;

const { publicarClip, publicarEnRed, crearRitmoHumano, armarTexto, crearDriverSeco, crearDriverPlaywright, construirPasos, SELECTORES } =
  await import('../src/engine/publicador.js');

const video = path.join(raiz, 'clip.mp4');
await fs.writeFile(video, 'x');

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUTURO = Math.floor(Date.now() / 1000) + 86400;
const OBLIGATORIAS = { tiktok: [['sessionid']], instagram: [['sessionid']], facebook: [['c_user'], ['xs']] };
const cookiesOk = {
  tiktok: [{ name: 'sessionid', value: 'a', domain: '.tiktok.com', path: '/', expires: FUTURO }],
  instagram: [{ name: 'sessionid', value: 'b', domain: '.instagram.com', path: '/', expires: FUTURO }],
  facebook: [
    { name: 'c_user', value: 'c', domain: '.facebook.com', path: '/', expires: FUTURO },
    { name: 'xs', value: 'd', domain: '.facebook.com', path: '/', expires: -1 },
  ],
};
const lector = (mapa) => async (red) => (red in mapa ? mapa[red] : null);

function opciones(extra = {}) {
  const dormidos = [];
  const driver = crearDriverSeco();
  return {
    dormidos,
    driver,
    o: {
      driver,
      azar: mulberry32(7),
      dormir: async (ms) => void dormidos.push(ms),
      leerCookies: lector(cookiesOk),
      obligatorias: OBLIGATORIAS,
      ...extra,
    },
  };
}

test('armarTexto: etiquetas limpias, sin repetir las que ya estan en el texto, con tope de longitud', () => {
  const t = armarTexto('Mira esto #Viral', ['viral', '#negocios', 'ia!', '', 'ñandú tips']);
  assert.equal(t, 'Mira esto #Viral\n\n#negocios #ia #ñandútips');
  assert.equal(armarTexto('', ['a']), '#a');
  assert.ok(armarTexto('x'.repeat(5000), []).length <= 2200);
});

test('planearTecleo: reconstruye el texto exacto (emojis y saltos incluidos) con esperas variables y acotadas', () => {
  const texto = 'Hola mundo 🚀 esto es una prueba, con puntuacion. ¿Funciona?\n\n#uno #dos #tres ' + 'palabra '.repeat(40);
  const h = crearRitmoHumano({ azar: mulberry32(1) });
  const plan = h.planearTecleo(texto);
  assert.equal(plan.map((p) => p.texto).join(''), texto);
  assert.ok(!plan.some((p) => /[\ud800-\udfff]/.test(p.texto) && Array.from(p.texto).length === 0));
  assert.ok(plan.every((p) => Array.from(p.texto).length >= 1 && Array.from(p.texto).length <= 5));
  const esperas = plan.map((p) => p.espera);
  assert.ok(new Set(esperas).size > 20, 'las esperas deben variar');
  assert.ok(esperas.every((e) => e >= 40 && e <= 2800));
  assert.ok(esperas.some((e) => e >= 800), 'debe haber pausas de pensar');
  const otro = crearRitmoHumano({ azar: mulberry32(2) }).planearTecleo(texto).map((p) => p.espera);
  assert.notDeepEqual(esperas, otro);
  assert.deepEqual(crearRitmoHumano({ azar: mulberry32(1) }).planearTecleo(texto), plan, 'mismo azar => mismo plan');
});

test('publicarClip: resultado estructurado por canal, cookies leidas por red, tecleo humano y archivo adjunto', async () => {
  const { o, driver, dormidos } = opciones();
  const r = await publicarClip({ rutaVideo: video, descripcion: 'Un clip genial', etiquetas: ['viral', 'ia'], plataformas: ['tiktok', 'instagram', 'facebook'] }, o);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.resultados), ['tiktok', 'instagram', 'facebook']);
  for (const red of Object.keys(r.resultados)) {
    const c = r.resultados[red];
    assert.equal(c.ok, true);
    assert.equal(c.error, null);
    assert.match(c.detalle, /Publicado en/);
    assert.ok(!Number.isNaN(Date.parse(c.timestamp)));
  }
  const abrir = driver.registro.filter((x) => x.accion === 'abrir');
  assert.deepEqual(abrir.map((x) => x.red), ['tiktok', 'instagram', 'facebook']);
  assert.equal(abrir[2].cookies, 2); // facebook entrego sus 2 cookies
  assert.equal(driver.registro.filter((x) => x.accion === 'adjuntar').every((x) => x.ruta === video), true);
  assert.equal(driver.registro.filter((x) => x.accion === 'adjuntar').length, 3);
  // Lo tecleado por red, unido, es la descripcion completa.
  const tecleado = driver.registro.filter((x) => ['abrir', 'teclear'].includes(x.accion));
  let actual = null;
  const porRed = {};
  for (const x of tecleado) {
    if (x.accion === 'abrir') {
      actual = x.red;
      porRed[actual] = '';
    } else porRed[actual] += x.texto;
  }
  for (const red of ['tiktok', 'instagram', 'facebook']) assert.equal(porRed[red], 'Un clip genial\n\n#viral #ia');
  assert.ok(driver.registro.filter((x) => x.accion === 'tecla').length >= 2, 'TikTok limpia el texto previo');
  assert.ok(new Set(dormidos).size > 50, 'pausas y esperas variables');
  assert.equal(driver.registro.filter((x) => x.accion === 'cerrar').length, 3);
});

test('un canal sin sesion o con sesion vencida falla solo, sin tumbar a los demas', async () => {
  const vencidas = { ...cookiesOk, instagram: [{ name: 'sessionid', value: 'b', domain: '.instagram.com', path: '/', expires: 1000 }] };
  const { o } = opciones({ leerCookies: lector({ tiktok: cookiesOk.tiktok, instagram: vencidas.instagram }) });
  const r = await publicarClip({ rutaVideo: video, plataformas: ['tiktok', 'instagram', 'facebook'], descripcion: 'x' }, o);
  assert.equal(r.ok, false);
  assert.equal(r.resultados.tiktok.ok, true);
  assert.equal(r.resultados.instagram.ok, false);
  assert.equal(r.resultados.instagram.codigo, 'SESION_EXPIRADA');
  assert.equal(r.resultados.instagram.transitorio, false);
  assert.equal(r.resultados.facebook.codigo, 'SIN_SESION');
  assert.equal(r.resultados.facebook.transitorio, false);
  assert.match(r.resultados.facebook.error, /Conexiones/);
});

test('cookies ilegibles (cambio de llave) y red no soportada son errores definitivos', async () => {
  const { o } = opciones({
    leerCookies: async (red) => {
      if (red === 'tiktok') throw new Error('No se pudo descifrar la sesion');
      return cookiesOk[red] || null;
    },
  });
  const r = await publicarClip({ rutaVideo: video, plataformas: ['tiktok', 'youtube'], descripcion: 'x' }, o);
  assert.equal(r.resultados.tiktok.codigo, 'SESION_ILEGIBLE');
  assert.equal(r.resultados.tiktok.transitorio, false);
  assert.equal(r.resultados.youtube.codigo, 'RED_NO_SOPORTADA');
  assert.equal(r.resultados.youtube.transitorio, false);
});

test('video inexistente o sin plataformas: error estructurado en cada canal, sin abrir navegador', async () => {
  const { o, driver } = opciones();
  const r = await publicarClip({ rutaVideo: path.join(raiz, 'no-existe.mp4'), plataformas: ['tiktok', 'facebook'] }, o);
  assert.equal(r.ok, false);
  assert.equal(r.resultados.tiktok.codigo, 'ARCHIVO_NO_ENCONTRADO');
  assert.equal(r.resultados.facebook.codigo, 'ARCHIVO_NO_ENCONTRADO');
  assert.equal(driver.registro.length, 0);
  const vacio = await publicarClip({ rutaVideo: video, plataformas: [] }, o);
  assert.equal(vacio.ok, false);
  assert.equal(vacio.resultados && Object.keys(vacio.resultados).length, 0);
});

test('un fallo del navegador es transitorio, cierra la sesion y deja seguir con la siguiente red', async () => {
  let cerradas = 0;
  const driver = {
    tipo: 'falso',
    async abrir({ red }) {
      const lanzar = red === 'tiktok';
      return {
        ir: async () => {},
        adjuntar: async () => {},
        esperar: async () => {
          if (lanzar) throw Object.assign(new Error('Timeout 30000ms esperando el boton'), { name: 'TimeoutError' });
        },
        esperarUrl: async () => {},
        clic: async () => {},
        enfocar: async () => {},
        tecla: async () => {},
        teclear: async () => {},
        cerrar: async () => void cerradas++,
      };
    },
    async cerrar() {},
  };
  const { o } = opciones({ driver });
  const r = await publicarClip({ rutaVideo: video, plataformas: ['tiktok', 'facebook'], descripcion: 'x' }, o);
  assert.equal(r.resultados.tiktok.ok, false);
  assert.equal(r.resultados.tiktok.codigo, 'TIMEOUT');
  assert.equal(r.resultados.tiktok.transitorio, true);
  assert.equal(r.resultados.facebook.ok, true);
  assert.equal(cerradas, 2);
});

test('modo seco sin driver: recorre el flujo sin red y lo marca como simulado', async () => {
  const r = await publicarClip(
    { rutaVideo: video, plataformas: ['tiktok'], descripcion: 'x' },
    { modo: 'seco', azar: mulberry32(3), dormir: async () => {}, leerCookies: lector(cookiesOk), obligatorias: OBLIGATORIAS }
  );
  assert.equal(r.ok, true);
  assert.equal(r.modo, 'seco');
  assert.equal(r.resultados.tiktok.simulado, true);
  assert.match(r.resultados.tiktok.detalle, /^SIMULACION/);
});

test('modo real sin Playwright instalado: DRIVER_NO_DISPONIBLE, definitivo y nunca finge un exito', async () => {
  await assert.rejects(crearDriverPlaywright({ importar: async () => { throw new Error('Cannot find package'); } }), (e) => e.codigo === 'DRIVER_NO_DISPONIBLE' && e.transitorio === false);
  const r = await publicarClip(
    { rutaVideo: video, plataformas: ['tiktok', 'instagram'], descripcion: 'x' },
    { modo: 'real', dormir: async () => {}, leerCookies: lector(cookiesOk), obligatorias: OBLIGATORIAS }
  );
  assert.equal(r.ok, false);
  for (const red of ['tiktok', 'instagram']) {
    assert.equal(r.resultados[red].ok, false);
    assert.equal(r.resultados[red].codigo, 'DRIVER_NO_DISPONIBLE');
    assert.equal(r.resultados[red].transitorio, false);
  }
});

test('driver Playwright (con modulo falso): cookies al contexto, archivo, tecleo por bloques, clic con movimiento de raton', async () => {
  const log = [];
  const pagina = {
    goto: async (u) => log.push(['goto', u]),
    waitForURL: async () => log.push(['waitForURL']),
    locator: (sel) => ({
      first: () => ({
        waitFor: async () => log.push(['waitFor', sel]),
        boundingBox: async () => ({ x: 10, y: 10, width: 100, height: 40 }),
        click: async () => log.push(['click']),
        setInputFiles: async (ruta) => log.push(['setInputFiles', ruta]),
      }),
    }),
    mouse: { move: async (x, y, o) => log.push(['move', o.steps]), click: async () => log.push(['mclick']) },
    keyboard: { type: async (t) => log.push(['type', t]), press: async (k) => log.push(['press', k]) },
  };
  const contexto = { addCookies: async (c) => log.push(['addCookies', c.length]), newPage: async () => pagina, close: async () => log.push(['ctxClose']) };
  const navegador = { newContext: async () => contexto, close: async () => log.push(['navClose']) };
  const modulo = { chromium: { launch: async () => navegador } };
  const driver = await crearDriverPlaywright({ azar: mulberry32(9), importar: async () => modulo });
  const r = await publicarClip(
    { rutaVideo: video, plataformas: ['tiktok'], descripcion: 'Hola' },
    { driver, azar: mulberry32(4), dormir: async () => {}, leerCookies: lector(cookiesOk), obligatorias: OBLIGATORIAS, selectores: SELECTORES }
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(log.find((x) => x[0] === 'addCookies'), ['addCookies', 1]);
  assert.deepEqual(log.find((x) => x[0] === 'setInputFiles'), ['setInputFiles', video]);
  assert.equal(log.filter((x) => x[0] === 'type').map((x) => x[1]).join(''), 'Hola');
  assert.ok(log.some((x) => x[0] === 'move' && x[1] >= 8), 'el raton se mueve antes de hacer clic');
  assert.ok(log.some((x) => x[0] === 'ctxClose'));
  await driver.cerrar();
  assert.ok(log.some((x) => x[0] === 'navClose'));
});

test('pasos por red: cada flujo adjunta el video, escribe la descripcion y publica', () => {
  for (const red of ['tiktok', 'instagram', 'facebook']) {
    const acciones = construirPasos(red).map((p) => p.accion);
    for (const a of ['ir', 'adjuntar', 'escribir', 'clic']) assert.ok(acciones.includes(a), red + ' sin ' + a);
    assert.ok(acciones.indexOf('adjuntar') < acciones.indexOf('escribir'));
  }
  assert.throws(() => construirPasos('x'), /no soportada/);
});

test('publicarEnRed nunca lanza', async () => {
  const r = await publicarEnRed('tiktok', { rutaVideo: video, texto: 'x' }, {
    driver: { abrir: async () => { throw new Error('boom'); }, tipo: 'falso' },
    humano: crearRitmoHumano({ dormir: async () => {} }),
    leerCookies: lector(cookiesOk),
    obligatorias: OBLIGATORIAS,
    selectores: SELECTORES,
    timeouts: { pasoMs: 1, subidaMs: 1 },
    reloj: () => new Date().toISOString(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'boom');
  assert.equal(r.transitorio, true);
});
