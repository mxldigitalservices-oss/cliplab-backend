import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-envivo-bloques-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.SESSION_DIR = path.join(raiz, 'datos');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.LOG_LEVEL = 'error';
test.after(() => fs.rm(raiz, { recursive: true, force: true }));

const { crearGestorEnVivo } = await import('../src/engine/envivo.js');
const { analizarBloqueLocal } = await import('../src/engine/cerebro-marketing.js');

const URL_VIVO = 'https://www.youtube.com/watch?v=abc123DEF45';
const MEDIA = 'https://manifest.googlevideo.com/api/manifest/hls_playlist/secreto123/index.m3u8';
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

function crearEntorno() {
  const trabajos = [];
  const clips = [];
  const listas = [];
  const run = (comando, args, opciones = {}) => {
    if (args.includes('--print')) return Promise.resolve({ stdout: 'True\nabc123DEF45\nMi directo\n' + MEDIA + '\n', stderr: '' });
    if (args.includes('segment')) {
      return new Promise((ok, no) => { opciones.signal?.addEventListener('abort', () => no(new Error('Proceso cancelado')), { once: true }); });
    }
    if (args.includes('volumedetect')) return Promise.resolve({ stdout: '', stderr: 'mean_volume: -30 dB' });
    if (args.includes('concat')) {
      const lista = args[args.indexOf('-i') + 1];
      return fs.readFile(lista, 'utf8').then((t) => { listas.push(t); return fs.writeFile(args[args.length - 1], 'x'); }).then(() => ({ stdout: '', stderr: '' }));
    }
    return Promise.reject(new Error('comando inesperado: ' + comando));
  };
  const store = {
    encolar: (fuente, extra) => { const c = { id: 'clip_' + (clips.length + 1), fuente, ...extra }; clips.push(c); return c; },
    actualizar: (id, parche) => Object.assign(clips.find((c) => c.id === id), parche),
    fallar: () => {},
  };
  return { trabajos, clips, listas, run, store };
}

async function conBloques({ carga = 0 }, fn) {
  const dir = await fs.mkdtemp(path.join(raiz, 'b-'));
  const env = crearEntorno();
  const gestor = crearGestorEnVivo({
    run: env.run, conSesion: (f) => f(null), esBloqueoAntiBot: () => false, store: env.store,
    agregarTrabajo: (t) => env.trabajos.push(t), cargaActual: () => carga,
    validarVideo: async (ruta) => ({ ruta, duracion: 60 }), dirUploads: () => path.join(dir, 'subidas'),
    borrarUpload: async () => {}, dirBase: path.join(dir, 'envivo'),
    config: { tmpDir: dir, ffmpegPath: 'ffmpeg', ytdlpPath: 'yt-dlp', maxClipSeconds: 90, maxQueue: 20 },
    opciones: { segmentoSeg: 20, ventanaSeg: 600, tickMs: 25, maxMin: 0, bloqueSeg: 60, bloqueClips: 3, maxPendientes: 2 },
  });
  const dirSesion = path.join(dir, 'envivo', 'sesion');
  try {
    await gestor.iniciar(URL_VIVO, { bloques: true });
    await gestor.listo();
    await fn({ gestor, env, dirSesion });
  } finally {
    await gestor.detener();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function sembrar(dirSesion, desde, hasta, pausa = 80) {
  await fs.mkdir(dirSesion, { recursive: true });
  for (let i = desde; i <= hasta; i += 1) {
    await fs.writeFile(path.join(dirSesion, 'seg_' + String(i).padStart(6, '0') + '.ts'), 'x');
    await dormir(pausa);
  }
}

async function esperar(cond, ms = 4000) {
  const fin = Date.now() + ms;
  while (!cond() && Date.now() < fin) await dormir(40);
  return cond();
}

test('bloques: cada 3 segmentos nuevos (60 s) se encola un bloque en modo automatico, sin solaparse', async () => {
  await conBloques({}, async ({ gestor, env, dirSesion }) => {
    await sembrar(dirSesion, 1, 8);
    assert.ok(await esperar(() => env.trabajos.length >= 2), 'se encolaron 2 bloques');
    const [a, b] = env.trabajos;
    for (const t of [a, b]) {
      assert.equal(t.auto, true);
      assert.equal(t.cantidad, 3);
      assert.equal(t.descartarMalos, true);
      assert.equal(t.url, null);
    }
    assert.equal(env.clips[0].envivo.origen, 'bloque');
    assert.match(env.listas[0], /seg_000001\.ts[\s\S]*seg_000003\.ts/);
    assert.doesNotMatch(env.listas[0], /seg_000004\.ts/);
    assert.match(env.listas[1], /seg_000004\.ts/);
    assert.doesNotMatch(env.listas[1], /seg_000003\.ts/);
    const est = gestor.estado();
    assert.equal(est.bloques.activo, true);
    assert.ok(est.bloques.enviados >= 2);
  });
});

test('bloques: con la cola llena no se encola nada y los segmentos se conservan para despues', async () => {
  await conBloques({ carga: 2 }, async ({ env, dirSesion }) => {
    await sembrar(dirSesion, 1, 8);
    await dormir(300);
    assert.equal(env.trabajos.length, 0);
    const restantes = (await fs.readdir(dirSesion)).filter((n) => n.endsWith('.ts'));
    assert.ok(restantes.length >= 8, 'la poda no borra lo que aun no se proceso');
  });
});

test('puerta de calidad: un bloque sin voz o sin contenido se marca "descartar"', () => {
  assert.equal(analizarBloqueLocal({ texto: '', duracion: 55 }).veredicto, 'descartar');
});
