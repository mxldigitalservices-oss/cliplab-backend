import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-envivo-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.SESSION_DIR = path.join(raiz, 'datos');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.LOG_LEVEL = 'error';
test.after(() => fs.rm(raiz, { recursive: true, force: true }));

const E = await import('../src/engine/envivo.js');
const { crearGestorEnVivo, detectarPico, elegirSegmentos, parsearMeanVolume, parsearManifiesto, ocultarUrls, momentoPublico, ErrorEnVivo } = E;

const URL_VIVO = 'https://www.youtube.com/watch?v=abc123DEF45';
const MEDIA = 'https://manifest.googlevideo.com/api/manifest/hls_playlist/secreto123/index.m3u8';

/* ---------- Funciones puras ---------- */

test('parsearMeanVolume lee dB de la salida de volumedetect', () => {
  assert.equal(parsearMeanVolume('[Parsed_volumedetect_0] mean_volume: -23.4 dB\nmax_volume: -3.0 dB'), -23.4);
  assert.equal(parsearMeanVolume('sin datos'), null);
});

test('detectarPico: exige muestras, supera la mediana y descarta silencio', () => {
  const calma = [-30, -31, -29, -30, -32, -30, -31];
  assert.equal(detectarPico([-30, -31], -10), false);        // muy pocas muestras
  assert.equal(detectarPico(calma, -22), true);              // +8 dB sobre la mediana
  assert.equal(detectarPico(calma, -27), false);             // solo +3 dB
  assert.equal(detectarPico(calma, -80), false);             // silencio
  assert.equal(detectarPico(calma, NaN), false);
});

test('elegirSegmentos toma los mas recientes que cubren los segundos pedidos', () => {
  const lista = ['seg_000001.ts', 'seg_000002.ts', 'seg_000003.ts', 'seg_000004.ts'];
  assert.deepEqual(elegirSegmentos(lista, 30, 20), ['seg_000003.ts', 'seg_000004.ts']);
  assert.deepEqual(elegirSegmentos(lista, 500, 20, 3), ['seg_000002.ts', 'seg_000003.ts', 'seg_000004.ts']);
  assert.deepEqual(elegirSegmentos(['seg_000001.ts'], 90, 20), ['seg_000001.ts']);
});

test('parsearManifiesto y ocultarUrls', () => {
  const i = parsearManifiesto('True\nabc123\nMi directo\n' + MEDIA + '\n');
  assert.deepEqual(i, { envivo: true, id: 'abc123', titulo: 'Mi directo', urlMedia: MEDIA });
  assert.equal(parsearManifiesto('False\nabc\nx\n' + MEDIA).envivo, false);
  assert.equal(parsearManifiesto('True\nabc\nx\nno-es-url').urlMedia, '');
  assert.ok(!ocultarUrls('fallo abriendo ' + MEDIA + ' tiempo agotado').includes('secreto123'));
});

test('momentoPublico: titulo y descripcion con la misma precedencia del panel', () => {
  const base = { id: 'c1', titulo: 'En vivo · X', estado: 'listo', url: '/clips/a.mp4', creadoEn: 'ya', envivo: { origen: 'auto' } };
  assert.equal(momentoPublico(base).titulo, 'En vivo · X');
  assert.equal(momentoPublico(base).origenMomento, 'auto');
  const m = momentoPublico({ ...base, marketing: { titulo: 'Gancho', descripcion: 'Desc', cta: 'Sigue', hashtags: ['#a', '#b'] } });
  assert.equal(m.titulo, 'Gancho');
  assert.equal(m.descripcion, 'Desc\n\nSigue\n\n#a #b');
  const f = momentoPublico({ ...base, ficha: { titulo: 'Ficha', descripcion: 'DF' }, copy: 'copy' });
  assert.deepEqual([f.titulo, f.descripcion], ['Ficha', 'DF']);
});

/* ---------- Gestor con dobles ---------- */

// run falso: yt-dlp -> manifiesto; ffmpeg segment -> larga duracion (termina al abortar); volumedetect -> dB; concat -> crea el mp4.
function crearEntorno({ vivo = 'True', dbPorSegmento = [], concatFalla = false } = {}) {
  const llamadas = [];
  const trabajos = [];
  const clips = [];
  const borrados = [];
  let medidas = 0;
  const run = (comando, args, opciones = {}) => {
    llamadas.push({ comando, args });
    if (args.includes('--print')) return Promise.resolve({ stdout: vivo + '\nabc123DEF45\nMi directo\n' + MEDIA + '\n', stderr: '' });
    if (args.includes('segment')) {
      return new Promise((ok, no) => {
        opciones.signal?.addEventListener('abort', () => no(new Error('Proceso cancelado')), { once: true });
      });
    }
    if (args.includes('volumedetect')) {
      const db = dbPorSegmento[medidas] ?? -30;
      medidas += 1;
      return Promise.resolve({ stdout: '', stderr: 'mean_volume: ' + db + ' dB' });
    }
    if (args.includes('concat')) {
      if (concatFalla) return Promise.reject(new Error('concat roto'));
      return fs.writeFile(args[args.length - 1], 'mp4').then(() => ({ stdout: '', stderr: '' }));
    }
    return Promise.reject(new Error('comando inesperado'));
  };
  const store = {
    encolar: (fuente, extra) => { const c = { id: 'clip_' + (clips.length + 1), fuente, ...extra }; clips.push(c); return c; },
    actualizar: (id, parche) => Object.assign(clips.find((c) => c.id === id), parche),
    fallar: () => {},
  };
  return { llamadas, trabajos, clips, borrados, run, store };
}

async function conGestor(opciones, fn) {
  const dir = await fs.mkdtemp(path.join(raiz, 'g-'));
  const subidas = path.join(dir, 'subidas');
  const env = crearEntorno(opciones);
  const gestor = crearGestorEnVivo({
    run: env.run,
    conSesion: (f) => f(null),
    esBloqueoAntiBot: () => false,
    store: env.store,
    agregarTrabajo: (t) => env.trabajos.push(t),
    cargaActual: () => 0,
    validarVideo: async (ruta) => ({ ruta, duracion: 60, nombreOriginal: 'x' }),
    dirUploads: () => subidas,
    borrarUpload: async (ruta) => { env.borrados.push(ruta); await fs.rm(ruta, { force: true }); },
    dirBase: path.join(dir, 'envivo'),
    config: { tmpDir: dir, ffmpegPath: 'ffmpeg', ytdlpPath: 'yt-dlp', maxClipSeconds: 90, maxQueue: 20 },
    opciones: { segmentoSeg: 20, ventanaSeg: 100, tickMs: 3600000, cooldownSeg: 0, maxMin: 0 },
  });
  try {
    await fn({ gestor, env, dir, subidas, dirSesion: path.join(dir, 'envivo', 'sesion') });
  } finally {
    await gestor.detener();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function sembrarSegmentos(dirSesion, n, desde = 1) {
  await fs.mkdir(dirSesion, { recursive: true });
  for (let i = 0; i < n; i += 1) await fs.writeFile(path.join(dirSesion, 'seg_' + String(desde + i).padStart(6, '0') + '.ts'), 'x');
}

test('iniciar rechaza enlaces que no son de YouTube', async () => {
  await conGestor({}, async ({ gestor }) => {
    await assert.rejects(() => gestor.iniciar('https://ejemplo.com/vivo'), (e) => e instanceof ErrorEnVivo && e.status === 400);
    assert.equal(gestor.estado().estado, 'inactivo');
  });
});

test('iniciar rechaza un enlace que no esta en vivo', async () => {
  await conGestor({ vivo: 'False' }, async ({ gestor }) => {
    await gestor.iniciar(URL_VIVO);
    await gestor.listo();
    const s = gestor.estado();
    assert.equal(s.estado, 'error');
    assert.match(s.error, /no es una transmisión en vivo/);
  });
});

test('iniciar: graba, no filtra el enlace firmado y rechaza una segunda captura', async () => {
  await conGestor({}, async ({ gestor, env }) => {
    const respuesta = await gestor.iniciar(URL_VIVO);
    assert.equal(respuesta.estado, 'iniciando');
    await gestor.listo();
    const s = gestor.estado();
    assert.equal(s.estado, 'grabando');
    assert.equal(s.videoId, 'abc123DEF45');
    assert.ok(!JSON.stringify(s).includes('secreto123'), 'el estado publico no lleva el enlace firmado');
    const grabador = env.llamadas.find((c) => c.args.includes('segment'));
    assert.ok(grabador.args.includes('-c') && grabador.args.includes('copy'), 'copia sin recodificar');
    await assert.rejects(() => gestor.iniciar(URL_VIVO), (e) => e.status === 409);
  });
});

test('las cookies solo se entregan a yt-dlp (nunca a ffmpeg)', async () => {
  await conGestor({}, async ({ gestor, env }) => {
    // reemplazo local de conSesion que entrega una ruta de cookies
    const g2 = crearGestorEnVivo({
      run: env.run, conSesion: (f) => f('/tmp/cookies-falsas.txt'), esBloqueoAntiBot: () => false, store: env.store,
      agregarTrabajo: () => {}, cargaActual: () => 0, dirBase: path.join(raiz, 'g2'), config: { tmpDir: raiz, ffmpegPath: 'ffmpeg', ytdlpPath: 'yt-dlp', maxClipSeconds: 90, maxQueue: 20 },
      opciones: { tickMs: 3600000, maxMin: 0 },
    });
    try {
      await g2.iniciar(URL_VIVO);
      await g2.listo();
      const ytdlp = env.llamadas.find((c) => c.args.includes('--print'));
      const ffmpeg = env.llamadas.find((c) => c.args.includes('segment'));
      assert.ok(ytdlp.args.includes('--cookies'));
      assert.ok(!ffmpeg.args.includes('--cookies') && !ffmpeg.args.join(' ').includes('cookies'));
    } finally {
      await g2.detener();
      await fs.rm(path.join(raiz, 'g2'), { recursive: true, force: true });
    }
  });
});

test('marcar sin captura o sin segmentos responde 409', async () => {
  await conGestor({}, async ({ gestor }) => {
    await assert.rejects(() => gestor.marcar({ segundosAtras: 30 }), (e) => e.status === 409);
    await gestor.iniciar(URL_VIVO);
    await gestor.listo();
    await assert.rejects(() => gestor.marcar({ segundosAtras: 30 }), (e) => e.status === 409);
  });
});

test('marcar une los ultimos segmentos, encola un corte manual y no deja temporales', async () => {
  await conGestor({}, async ({ gestor, env, subidas, dirSesion }) => {
    await gestor.iniciar(URL_VIVO);
    await gestor.listo();
    await sembrarSegmentos(dirSesion, 5);   // seg 1..5: el ultimo (5) se considera en escritura
    const r = await gestor.marcar({ segundosAtras: 45 });
    assert.equal(r.origen, 'manual');
    assert.equal(env.trabajos.length, 1);
    const t = env.trabajos[0];
    assert.equal(t.auto, false);
    assert.equal(t.url, null);
    assert.equal(t.duracion, 45);
    assert.equal(t.inicio, 15);                       // dur real 60 -> los ultimos 45 s
    assert.equal(t.archivo.ruta.startsWith(subidas), true);
    assert.equal(env.clips[0].origen, 'archivo');
    assert.equal(env.clips[0].envivo.origen, 'manual');
    const concat = env.llamadas.find((c) => c.args.includes('concat'));
    const lista = concat.args[concat.args.indexOf('-i') + 1];
    await assert.rejects(() => fs.access(lista), 'la lista temporal se borra');
    assert.equal(gestor.estado().momentos, 1);
  });
});

test('marcar respeta MAX_CLIP_SECONDS', async () => {
  await conGestor({}, async ({ gestor, env, dirSesion }) => {
    await gestor.iniciar(URL_VIVO);
    await gestor.listo();
    await sembrarSegmentos(dirSesion, 5);
    await assert.rejects(() => gestor.marcar({ segundosAtras: 3 }), (e) => e.status === 400);
    const r = await gestor.marcar({ segundosAtras: 600 });
    assert.ok(r.duracion <= 60);
    assert.equal(env.trabajos[0].duracion <= 90, true);
  });
});

test('si la union falla no se encola nada y se borra el mp4 parcial (try/finally)', async () => {
  await conGestor({ concatFalla: true }, async ({ gestor, env, dirSesion }) => {
    await gestor.iniciar(URL_VIVO);
    await gestor.listo();
    await sembrarSegmentos(dirSesion, 4);
    await assert.rejects(() => gestor.marcar({ segundosAtras: 30 }), /concat roto/);
    assert.equal(env.trabajos.length, 0);
    assert.equal(env.clips.length, 0);
    assert.equal(env.borrados.length, 1);
    assert.equal(gestor.estado().marcando, false, 'el candado de marcado se libera');
  });
});

test('deteccion automatica (integracion): tick mide, detecta el pico y encola', async () => {
  const dir = await fs.mkdtemp(path.join(raiz, 'auto-'));
  const env = crearEntorno({ dbPorSegmento: [-30, -30, -30, -30, -30, -30, -30, -15] });
  const gestor = crearGestorEnVivo({
    run: env.run, conSesion: (f) => f(null), esBloqueoAntiBot: () => false, store: env.store,
    agregarTrabajo: (t) => env.trabajos.push(t), cargaActual: () => 0,
    validarVideo: async (ruta) => ({ ruta, duracion: 60 }), dirUploads: () => path.join(dir, 'subidas'),
    borrarUpload: async () => {}, dirBase: path.join(dir, 'envivo'),
    config: { tmpDir: dir, ffmpegPath: 'ffmpeg', ytdlpPath: 'yt-dlp', maxClipSeconds: 90, maxQueue: 20 },
    opciones: { segmentoSeg: 20, ventanaSeg: 600, tickMs: 25, cooldownSeg: 0, maxMin: 0, umbralDb: 6 },
  });
  try {
    await gestor.iniciar(URL_VIVO, { auto: true });
    await gestor.listo();
    const dirSesion = path.join(dir, 'envivo', 'sesion');
    for (let i = 1; i <= 10; i += 1) {   // un segmento nuevo por paso: el vigilante mide los recien completados
      await sembrarSegmentos(dirSesion, 1, i);
      await new Promise((ok) => setTimeout(ok, 80));
    }
    const fin = Date.now() + 3000;
    while (!env.trabajos.length && Date.now() < fin) await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(env.trabajos.length >= 1, true, 'el pico genero un momento automatico');
    assert.equal(env.clips[0].envivo.origen, 'auto');
    assert.ok(gestor.estado().ultimoPico);
  } finally {
    await gestor.detener();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('la poda mantiene solo la ventana configurada', async () => {
  const dir = await fs.mkdtemp(path.join(raiz, 'poda-'));
  const env = crearEntorno();
  const gestor = crearGestorEnVivo({
    run: env.run, conSesion: (f) => f(null), esBloqueoAntiBot: () => false, store: env.store,
    agregarTrabajo: () => {}, cargaActual: () => 0, dirBase: path.join(dir, 'envivo'),
    config: { tmpDir: dir, ffmpegPath: 'ffmpeg', ytdlpPath: 'yt-dlp', maxClipSeconds: 90, maxQueue: 20 },
    opciones: { segmentoSeg: 20, ventanaSeg: 100, tickMs: 25, maxMin: 0 },   // ventana = 5 segmentos
  });
  try {
    await gestor.iniciar(URL_VIVO);
    await gestor.listo();
    const dirSesion = path.join(dir, 'envivo', 'sesion');
    await sembrarSegmentos(dirSesion, 12);
    const fin = Date.now() + 3000;
    let restantes = 12;
    while (restantes > 6 && Date.now() < fin) {
      await new Promise((ok) => setTimeout(ok, 60));
      restantes = (await fs.readdir(dirSesion)).filter((n) => n.endsWith('.ts')).length;
    }
    assert.ok(restantes <= 6, 'ventana de 5 completos + el que se escribe; quedaron ' + restantes);
    assert.ok((await fs.readdir(dirSesion)).includes('seg_000012.ts'), 'conserva los mas recientes');
  } finally {
    await gestor.detener();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('detener aborta la captura y borra los segmentos', async () => {
  await conGestor({}, async ({ gestor, dirSesion }) => {
    await gestor.iniciar(URL_VIVO);
    await gestor.listo();
    await sembrarSegmentos(dirSesion, 3);
    const s = await gestor.detener();
    assert.equal(s.estado, 'detenido');
    await assert.rejects(() => fs.access(dirSesion), 'la carpeta de segmentos desaparece');
    await assert.rejects(() => gestor.marcar({ segundosAtras: 30 }), (e) => e.status === 409);
  });
});

test('marcar con la cola llena responde 429 y no deja archivos', async () => {
  const dir = await fs.mkdtemp(path.join(raiz, 'cola-'));
  const env = crearEntorno();
  const gestor = crearGestorEnVivo({
    run: env.run, conSesion: (f) => f(null), esBloqueoAntiBot: () => false, store: env.store,
    agregarTrabajo: (t) => env.trabajos.push(t), cargaActual: () => 20, dirUploads: () => path.join(dir, 'subidas'),
    dirBase: path.join(dir, 'envivo'),
    config: { tmpDir: dir, ffmpegPath: 'ffmpeg', ytdlpPath: 'yt-dlp', maxClipSeconds: 90, maxQueue: 20 },
    opciones: { tickMs: 3600000, maxMin: 0 },
  });
  try {
    await gestor.iniciar(URL_VIVO);
    await gestor.listo();
    await sembrarSegmentos(path.join(dir, 'envivo', 'sesion'), 3);
    await assert.rejects(() => gestor.marcar({ segundosAtras: 30 }), (e) => e.status === 429);
    assert.equal(env.trabajos.length, 0);
    await assert.rejects(() => fs.access(path.join(dir, 'subidas')));
  } finally {
    await gestor.detener();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
