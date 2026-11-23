import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-envivo-auto-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.SESSION_DIR = path.join(raiz, 'datos');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.LOG_LEVEL = 'error';
test.after(() => fs.rm(raiz, { recursive: true, force: true }));

const { crearGestorEnVivo, detectarVozBaja, evaluarMomento, limpiarTextoVoz, rutaParaConcat, listaConcat, momentoPublico } =
  await import('../src/engine/envivo.js');
const { ComandoError } = await import('../src/utils/run.js');
const { rutaParaFiltro } = await import('../src/engine/render.js');

const URL_VIVO = 'https://www.youtube.com/watch?v=abc123DEF45';
const MEDIA = 'https://manifest.googlevideo.com/api/manifest/hls_playlist/secreto123/index.m3u8';

// Textos de ejemplo (~100 palabras en un directo real; aqui son cortos y se calibran con minPalabras = 6).
const TENSION = 'No me grites, me faltaste el respeto y eres un hipócrita, te voy a confrontar frente a todos, cállate ya';
const CHISME = 'Te cuento en secreto, no se lo digas a nadie, ella habla mal de ti a tus espaldas, es puro chisme entre nosotros';
const TENSION_SUAVE = 'Ayer hubo una discusión en la casa y la verdad nadie quiso hablar del tema porque estaban cansados de tanto estrés en el equipo hoy';
const CHISME_SUAVE = 'Ayer ella me contó que se mudó de ciudad y que ahora trabaja en una tienda de ropa cerca de su casa nueva con su hermana';
const NEUTRO = 'Hoy vamos a preparar una receta de arroz con pollo muy fácil y rápida para toda la familia en casa con ingredientes simples';

const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));
const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/* ---------- Funciones puras ---------- */

test('limpiarTextoVoz: quita ruido/silencio/musica y convierte los susurros en (susurrando)', () => {
  assert.equal(limpiarTextoVoz('[BLANK_AUDIO]'), '');
  assert.equal(limpiarTextoVoz(' [Música] ♪♪ hola   que tal [Applause] '), 'hola que tal');
  assert.match(limpiarTextoVoz('[whispering] ven acá'), /\(susurrando\) ven acá/);
  assert.match(limpiarTextoVoz('(en voz baja) ven acá'), /\(susurrando\)/);
  assert.equal(limpiarTextoVoz(null), '');
});

test('evaluarMomento: tension y chisme fuertes disparan solo con el texto', () => {
  const t = evaluarMomento(TENSION);
  assert.deepEqual([t.dispara, t.tipo, t.motivo], [true, 'tension_reality', 'texto']);
  assert.ok(t.intensidad >= 50);
  const c = evaluarMomento(CHISME);
  assert.deepEqual([c.dispara, c.tipo, c.motivo], [true, 'chisme_confidencia', 'texto']);
});

test('evaluarMomento: texto neutro o corto no dispara, ni con pico de volumen', () => {
  assert.equal(evaluarMomento(NEUTRO).dispara, false);
  assert.equal(evaluarMomento(NEUTRO, { pico: true }).dispara, false, 'un pico sin senales en el texto puede ser musica o aplausos');
  assert.equal(evaluarMomento('[BLANK_AUDIO]', { pico: true }).motivo, 'poco_texto');
  assert.equal(evaluarMomento('cállate ya', { pico: true }).dispara, false, 'muy poco texto');
});

test('evaluarMomento: una senal moderada necesita refuerzo de audio (pico o voz baja en chisme)', () => {
  const t = evaluarMomento(TENSION_SUAVE);
  assert.equal(t.dispara, false);
  assert.equal(t.motivo, 'intensidad_baja');
  assert.deepEqual([evaluarMomento(TENSION_SUAVE, { pico: true }).dispara, evaluarMomento(TENSION_SUAVE, { pico: true }).motivo], [true, 'texto+volumen']);
  assert.equal(evaluarMomento(TENSION_SUAVE, { vozBaja: true }).dispara, false, 'la voz baja solo refuerza chismes/confidencias');

  const c = evaluarMomento(CHISME_SUAVE);
  assert.equal(c.dispara, false);
  const baja = evaluarMomento(CHISME_SUAVE, { vozBaja: true });
  assert.deepEqual([baja.dispara, baja.tipo, baja.motivo], [true, 'chisme_confidencia', 'texto+voz_baja']);
});

test('evaluarMomento: la marca de susurro de whisper cuenta como habla a media voz', () => {
  const normal = evaluarMomento('[BLANK_AUDIO] ven acá que te cuento algo y mañana vemos qué hacemos con todo eso de la fiesta');
  const susurro = evaluarMomento('[whispering] ven acá que te cuento algo y mañana vemos qué hacemos con todo eso de la fiesta');
  assert.equal(normal.dispara, false);
  assert.ok(susurro.intensidad > normal.intensidad, 'el susurro suma intensidad');
});

test('detectarVozBaja: habla mas baja que la mediana, pero no silencio', () => {
  const normal = [-30, -31, -29, -30, -32, -30, -31];
  assert.equal(detectarVozBaja(normal, -38), true);
  assert.equal(detectarVozBaja(normal, -32), false);
  assert.equal(detectarVozBaja(normal, -70), false, 'silencio');
  assert.equal(detectarVozBaja([-30, -31], -40), false, 'pocas muestras');
  assert.equal(detectarVozBaja(normal, NaN), false);
});

/* ---------- Windows: rutas ---------- */

test('rutaParaConcat / listaConcat: rutas de Windows y comillas simples', () => {
  assert.equal(rutaParaConcat('C:\\Users\\Juan Perez\\AppData\\Temp\\seg_000001.ts'), 'C:/Users/Juan Perez/AppData/Temp/seg_000001.ts');
  assert.equal(rutaParaConcat("/tmp/it's here/seg_000001.ts"), "/tmp/it'\\''s here/seg_000001.ts");
  assert.equal(listaConcat(['/a/1.ts', '/a/2.ts']), "file '/a/1.ts'\nfile '/a/2.ts'\n");
});

test('listaConcat con una ruta con comilla y espacios la lee ffmpeg de verdad', { skip: !hayFfmpeg && 'ffmpeg no disponible' }, async () => {
  const dir = path.join(raiz, "it's a dir");
  await fs.mkdir(dir, { recursive: true });
  const seg = path.join(dir, 'seg_000001.ts');
  const gen = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:d=1', '-f', 'mpegts', seg]);
  assert.equal(gen.status, 0);
  const lista = path.join(dir, 'lista.txt');
  const wav = path.join(dir, 'out.wav');
  await fs.writeFile(lista, listaConcat([seg, seg]));
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', lista, '-vn', '-ac', '1', '-ar', '16000',
    '-af', 'highpass=f=70,dynaudnorm=f=200:g=15:m=30:p=0.9', '-c:a', 'pcm_s16le', '-threads', '1', wav]);
  assert.equal(r.status, 0, String(r.stderr));
  assert.ok((await fs.stat(wav)).size > 1000);
});

test('rutaParaFiltro: Linux queda igual; Windows se normaliza y se cita; lo peligroso se rechaza', () => {
  assert.equal(rutaParaFiltro('/tmp/cliplab/jobs/x/seg-1/subtitulos.ass'), '/tmp/cliplab/jobs/x/seg-1/subtitulos.ass');
  assert.equal(rutaParaFiltro('C:\\Users\\Juan Pérez\\AppData\\Local\\Temp\\cliplab\\s.ass'), "'C\\:/Users/Juan Pérez/AppData/Local/Temp/cliplab/s.ass'");
  assert.equal(rutaParaFiltro('/data/mis fuentes/a.ass'), "'/data/mis fuentes/a.ass'");
  for (const mala of ["C:\\a'b.ass", 'x,y.ass', 'a;b.ass', 'a[0].ass', 'a=b.ass', '/tmp/x:y/a.ass']) {
    assert.throws(() => rutaParaFiltro(mala), /Ruta no permitida/, mala);
  }
});

/* ---------- Gestor con dobles ---------- */

function crearEntorno({ dbPorSegmento = [], whisper = null, ffmpegAsrFalla = false } = {}) {
  const llamadas = [];
  const trabajos = [];
  const clips = [];
  let medidas = 0;
  const run = (comando, args, opciones = {}) => {
    llamadas.push({ comando, args });
    if (args.includes('--print')) return Promise.resolve({ stdout: 'True\nabc123DEF45\nMi directo\n' + MEDIA + '\n', stderr: '' });
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
      if (args.includes('-vn') && ffmpegAsrFalla) return Promise.reject(new Error('ffmpeg roto'));
      return fs.writeFile(args[args.length - 1], 'x').then(() => ({ stdout: '', stderr: '' }));
    }
    if (comando === 'whisper-falso') {
      if (!whisper) return Promise.reject(new Error('whisper inesperado'));
      return whisper(args);
    }
    return Promise.reject(new Error('comando inesperado: ' + comando));
  };
  const store = {
    encolar: (fuente, extra) => { const c = { id: 'clip_' + (clips.length + 1), fuente, ...extra }; clips.push(c); return c; },
    actualizar: (id, parche) => Object.assign(clips.find((c) => c.id === id), parche),
    fallar: () => {},
  };
  return { llamadas, trabajos, clips, run, store };
}

async function conAuto({ env: opcionesEnv, deps = {}, opciones = {}, config = {}, cantidad, auto = true }, fn) {
  const dir = await fs.mkdtemp(path.join(raiz, 'a-'));
  const env = crearEntorno(opcionesEnv);
  const gestor = crearGestorEnVivo({
    run: env.run, conSesion: (f) => f(null), esBloqueoAntiBot: () => false, store: env.store,
    agregarTrabajo: (t) => env.trabajos.push(t), cargaActual: () => 0,
    validarVideo: async (ruta) => ({ ruta, duracion: 60 }), dirUploads: () => path.join(dir, 'subidas'),
    borrarUpload: async () => {}, dirBase: path.join(dir, 'envivo'),
    config: { tmpDir: dir, ffmpegPath: 'ffmpeg', ytdlpPath: 'yt-dlp', maxClipSeconds: 90, maxQueue: 20, ...config },
    opciones: { segmentoSeg: 20, ventanaSeg: 600, tickMs: 25, cooldownSeg: 0, maxMin: 0, umbralDb: 6, ...opciones },
    ...deps,
  });
  const dirSesion = path.join(dir, 'envivo', 'sesion');
  try {
    await gestor.iniciar(URL_VIVO, { auto, ...(cantidad !== undefined ? { cantidad } : {}) });
    await gestor.listo();
    await fn({ gestor, env, dir, dirSesion });
  } finally {
    await gestor.detener();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Un segmento nuevo por paso: el vigilante analiza los recien completados (el ultimo se considera en escritura).
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

test('auto por contenido: una pelea transcrita dispara un corte sin pico de volumen', async () => {
  const textos = [];
  await conAuto({ deps: { transcribirReciente: async (rutas) => { textos.push(rutas.length); return TENSION; } } }, async ({ gestor, env, dirSesion }) => {
    await sembrar(dirSesion, 1, 4);
    assert.ok(await esperar(() => env.trabajos.length >= 1), 'se encolo un momento');
    const t = env.trabajos[0];
    assert.equal(t.auto, false);
    assert.equal(t.url, null);
    assert.ok(t.duracion >= 45 && t.duracion <= 60, 'duracion ' + t.duracion);
    const clip = env.clips[0];
    assert.equal(clip.envivo.origen, 'auto');
    assert.equal(clip.envivo.deteccion.metodo, 'contenido');
    assert.equal(clip.envivo.deteccion.tipo, 'tension_reality');
    assert.ok(clip.envivo.deteccion.intensidad >= 50);
    assert.ok(textos[0] >= 1 && textos[0] <= 4, 'la ventana de analisis es corta');
    assert.equal(gestor.estado().deteccion.ultimoAnalisis.tipo, 'tension_reality');
  });
});

test('auto por contenido: un chisme dicho en voz baja (una senal moderada) se detecta con el refuerzo de audio', async () => {
  // El audio cae ~10 dB bajo la mediana en el segmento 8: confidencia a media voz.
  const dbs = [-30, -30, -30, -30, -30, -30, -30, -41];
  await conAuto({ env: { dbPorSegmento: dbs }, deps: { transcribirReciente: async () => CHISME_SUAVE } }, async ({ env, dirSesion }) => {
    await sembrar(dirSesion, 1, 10);
    assert.ok(await esperar(() => env.trabajos.length >= 1), 'voz baja + chisme detectado');
    assert.equal(env.clips[0].envivo.deteccion.tipo, 'chisme_confidencia');
    assert.equal(env.clips[0].envivo.deteccion.motivo, 'texto+voz_baja');
  });
});

test('auto: texto neutro NO dispara aunque el volumen tenga un pico', async () => {
  const dbs = [-30, -30, -30, -30, -30, -30, -30, -12];
  await conAuto({ env: { dbPorSegmento: dbs }, deps: { transcribirReciente: async () => NEUTRO } }, async ({ gestor, env, dirSesion }) => {
    await sembrar(dirSesion, 1, 10);
    await dormir(300);
    assert.equal(env.trabajos.length, 0);
    assert.ok(gestor.estado().ultimoPico, 'el pico se registra igualmente');
    assert.equal(gestor.estado().deteccion.ultimoAnalisis.motivo, 'sin_senales');
  });
});

test('auto sin transcripcion (null): respaldo limpio por volumen', async () => {
  const dbs = [-30, -30, -30, -30, -30, -30, -30, -15];
  await conAuto({ env: { dbPorSegmento: dbs }, deps: { transcribirReciente: async () => null } }, async ({ env, dirSesion }) => {
    await sembrar(dirSesion, 1, 10);
    assert.ok(await esperar(() => env.trabajos.length >= 1), 'el pico genero el momento');
    assert.equal(env.clips[0].envivo.deteccion.metodo, 'volumen');
    assert.equal(env.clips[0].envivo.origen, 'auto');
  });
});

test('auto: si el transcriptor lanza, no se cae el vigilante y se usa el volumen', async () => {
  const dbs = [-30, -30, -30, -30, -30, -30, -30, -15];
  await conAuto({ env: { dbPorSegmento: dbs }, deps: { transcribirReciente: async () => { throw new Error('boom'); } } }, async ({ env, dirSesion }) => {
    await sembrar(dirSesion, 1, 10);
    assert.ok(await esperar(() => env.trabajos.length >= 1));
    assert.equal(env.clips[0].envivo.deteccion.metodo, 'volumen');
  });
});

test('auto respeta la cantidad configurada y deja de transcribir al llegar al tope', async () => {
  let llamadas = 0;
  await conAuto({ cantidad: 2, deps: { transcribirReciente: async () => { llamadas += 1; return TENSION; } } }, async ({ gestor, env, dirSesion }) => {
    await sembrar(dirSesion, 1, 14);
    await dormir(250);
    assert.equal(env.trabajos.length, 2, 'exactamente 2 cortes automaticos');
    assert.equal(gestor.estado().deteccion.restantes, 0);
    assert.equal(gestor.estado().deteccion.automaticos, 2);
    const antes = llamadas;
    await sembrar(dirSesion, 15, 18);
    await dormir(150);
    assert.equal(llamadas, antes, 'sin cupo no se gasta CPU en transcribir');
    assert.equal(env.trabajos.length, 2);
  });
});

test('configurarAuto con cantidad abre una tanda nueva', async () => {
  await conAuto({ auto: false, cantidad: 1, deps: { transcribirReciente: async () => TENSION } }, async ({ gestor, env, dirSesion }) => {
    await sembrar(dirSesion, 1, 5);
    await dormir(150);
    assert.equal(env.trabajos.length, 0, 'auto apagado: no corta solo');
    const e = gestor.configurarAuto(true, { cantidad: 3 });
    assert.equal(e.auto, true);
    assert.equal(e.deteccion.cantidad, 3);
    assert.equal(e.deteccion.restantes, 3);
    await sembrar(dirSesion, 6, 12);
    assert.ok(await esperar(() => env.trabajos.length >= 1));
  });
});

test('la cola saturada no encola ni transcribe (margen de RAM/CPU)', async () => {
  let transcripciones = 0;
  await conAuto({
    opciones: { maxPendientes: 2 },
    deps: { cargaActual: () => 2, transcribirReciente: async () => { transcripciones += 1; return TENSION; } },
  }, async ({ env, dirSesion }) => {
    await sembrar(dirSesion, 1, 8);
    await dormir(200);
    assert.equal(env.trabajos.length, 0);
    assert.equal(transcripciones, 0);
  });
});

test('solo hay UNA transcripcion a la vez aunque el vigilante vaya rapido', async () => {
  let activas = 0;
  let maxActivas = 0;
  await conAuto({
    cantidad: 0,
    deps: {
      transcribirReciente: async () => {
        activas += 1; maxActivas = Math.max(maxActivas, activas);
        await dormir(120);
        activas -= 1;
        return NEUTRO;
      },
    },
    opciones: { tickMs: 10 },
  }, async ({ dirSesion }) => {
    await sembrar(dirSesion, 1, 10, 40);
    await dormir(300);
    assert.equal(maxActivas, 1);
  });
});

test('transcriptor por defecto: une los segmentos, normaliza el audio, limita hilos y limpia temporales', async () => {
  let argsWhisper = null;
  await conAuto({
    env: { whisper: (args) => { argsWhisper = args; return Promise.resolve({ stdout: ' ' + TENSION + '\n', stderr: 'logs de whisper' }); } },
    config: { whisperPath: 'whisper-falso', whisperModel: 'C:\\modelos\\modelo.bin', whisperLang: 'es', cpuThreads: 4 },
    opciones: { asrHilos: 2 },
  }, async ({ gestor, env, dirSesion }) => {
    await sembrar(dirSesion, 1, 5);
    assert.ok(await esperar(() => env.trabajos.length >= 1), 'whisper (falso) detecto la pelea');
    assert.equal(env.clips[0].envivo.deteccion.metodo, 'contenido');

    const extraccion = env.llamadas.find((c) => c.args.includes('concat') && c.args.includes('-vn'));
    assert.ok(extraccion, 'extrae el audio de los segmentos recientes');
    const filtro = extraccion.args[extraccion.args.indexOf('-af') + 1];
    assert.match(filtro, /dynaudnorm/, 'normaliza para entender la voz baja');
    assert.ok(extraccion.args.includes('16000') && extraccion.args.includes('-ac'));

    assert.equal(argsWhisper[argsWhisper.indexOf('-m') + 1], 'C:\\modelos\\modelo.bin', 'ruta del modelo tal cual (Windows)');
    assert.equal(argsWhisper[argsWhisper.indexOf('-l') + 1], 'es');
    assert.equal(Number(argsWhisper[argsWhisper.indexOf('-t') + 1]), 2, 'maximo 2 hilos para dejar CPU al render');
    assert.ok(argsWhisper.includes('-nt') && argsWhisper.includes('-np'));
    assert.equal(gestor.estado().deteccion.asr, 'activo');

    const restos = (await fs.readdir(dirSesion)).filter((n) => n.startsWith('asr_'));
    assert.deepEqual(restos, [], 'no quedan listas ni wav temporales');
  });
});

test('whisper no instalado: asr = no_disponible, se registra una vez y se usa el volumen', async () => {
  const dbs = [-30, -30, -30, -30, -30, -30, -30, -15];
  let intentos = 0;
  await conAuto({
    env: {
      dbPorSegmento: dbs,
      whisper: () => { intentos += 1; return Promise.reject(new ComandoError('No se pudo ejecutar whisper-falso: spawn whisper-falso ENOENT')); },
    },
    config: { whisperPath: 'whisper-falso', whisperModel: '/no/existe.bin', cpuThreads: 4 },
  }, async ({ gestor, env, dirSesion }) => {
    await sembrar(dirSesion, 1, 10);
    assert.ok(await esperar(() => env.trabajos.length >= 1));
    assert.equal(env.clips[0].envivo.deteccion.metodo, 'volumen');
    assert.equal(gestor.estado().deteccion.asr, 'no_disponible');
    assert.equal(intentos, 1, 'no se reintenta whisper en cada tick');
  });
});

test('fallos repetidos del transcriptor lo desactivan para la sesion (sin tumbar nada)', async () => {
  let intentos = 0;
  await conAuto({
    env: { whisper: () => { intentos += 1; return Promise.reject(new Error('whisper roto')); } },
    config: { whisperPath: 'whisper-falso', whisperModel: 'm.bin', cpuThreads: 2 },
  }, async ({ gestor, dirSesion }) => {
    await sembrar(dirSesion, 1, 10);
    await dormir(200);
    assert.equal(gestor.estado().deteccion.asr, 'no_disponible');
    assert.equal(intentos, 3);
    assert.equal(gestor.estado().estado, 'grabando', 'la captura sigue');
  });
});

test('sin whisper configurado el gestor funciona solo por volumen (compatibilidad)', async () => {
  const dbs = [-30, -30, -30, -30, -30, -30, -30, -15];
  await conAuto({ env: { dbPorSegmento: dbs } }, async ({ gestor, env, dirSesion }) => {
    await sembrar(dirSesion, 1, 10);
    assert.ok(await esperar(() => env.trabajos.length >= 1));
    assert.equal(env.clips[0].envivo.deteccion.metodo, 'volumen');
    assert.equal(env.llamadas.some((c) => c.comando === 'whisper-falso'), false);
    assert.ok(gestor.estado().deteccion);
  });
});

test('ENVIVO_ASR=off equivale a desactivar la transcripcion', async () => {
  let llamadas = 0;
  await conAuto({ opciones: { asr: false }, deps: { transcribirReciente: async () => { llamadas += 1; return TENSION; } } }, async ({ gestor, env, dirSesion }) => {
    await sembrar(dirSesion, 1, 6);
    await dormir(150);
    assert.equal(llamadas, 0);
    assert.equal(env.trabajos.length, 0, 'sin pico y sin transcripcion no hay corte');
    assert.equal(gestor.estado().deteccion.asr, 'desactivado');
  });
});

test('momentoPublico expone como se detecto el momento (sin texto ni enlaces)', () => {
  const base = { id: 'c1', titulo: 'En vivo · X', estado: 'listo', creadoEn: 'ya', envivo: { origen: 'auto', deteccion: { metodo: 'contenido', tipo: 'chisme_confidencia', intensidad: 80, motivo: 'texto' } } };
  assert.deepEqual(momentoPublico(base).deteccion, { metodo: 'contenido', tipo: 'chisme_confidencia', intensidad: 80, motivo: 'texto' });
  assert.equal(momentoPublico({ ...base, envivo: { origen: 'manual' } }).deteccion, null);
  assert.equal(momentoPublico({ id: 'c2', estado: 'listo' }).deteccion, null);
});
