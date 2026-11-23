// Integracion de la rotacion ciclica con el flujo: validacion en la ruta, tandas por trabajo, respaldo ante fallos de disco
// y pipeline real (FFmpeg) con varios clips. Las pruebas del modulo en si estan en tests/rotacion.test.js.
import test from 'node:test';
import { SIN_SHELL } from './helpers/plataforma.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-rotflujo-'));
const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.SESSION_DIR = path.join(raiz, 'sesion');
process.env.UPLOADS_DIR = path.join(raiz, 'uploads');
process.env.MASTER_KEY = 'llave-de-prueba';
process.env.LOG_LEVEL = 'error';
process.env.LOGO_PATH = path.join(raiz, 'klikap-logo.png');
process.env.VIDEO_PRESET = 'ultrafast';
process.env.SEGMENT_MIN_SECONDS = '5';      // clips cortos: la prueba valida la rotacion, no la duracion
process.env.SEGMENT_MAX_SECONDS = '8';
process.env.YTDLP_PATH = path.join(raiz, 'no-debe-usarse.sh');
process.env.WHISPER_PATH = path.join(raiz, 'whisper-falso.sh');
process.env.FAKE_ASR = path.join(raiz, 'asr.json');
delete process.env.DEFAULT_RENDER_MODE;

await fs.writeFile(process.env.WHISPER_PATH, `#!/bin/sh\nANT=""; BASE=""\nfor a in "$@"; do [ "$ANT" = "-of" ] && BASE="$a"; ANT="$a"; done\ncp "$FAKE_ASR" "$BASE.json"\n`, { mode: 0o755 });
{
  const frases = ['El clima de la ciudad estuvo bastante normal durante la tarde.', 'La gente caminaba por la calle principal sin mucha prisa.', 'Hubo algo de trafico cerca del parque central esta semana.'];
  const transcription = [];
  let t = 0;
  for (let i = 0; t < 118; i++) {
    for (const w of frases[i % frases.length].split(' ')) {
      transcription.push({ text: w, offsets: { from: Math.round(t * 1000), to: Math.round((t + 0.33) * 1000) } });
      t += 0.36;
    }
    t += 0.3;
  }
  await fs.writeFile(process.env.FAKE_ASR, JSON.stringify({ transcription }));
}

const fuente = path.join(raiz, 'fuente.mp4');
if (hayFfmpeg) {
  const ff = (args) => assert.equal(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]).status, 0);
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=120:r=2', '-f', 'lavfi', '-i', 'sine=d=120:r=8000', '-shortest',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '16k', fuente]);
  ff(['-f', 'lavfi', '-i', 'color=c=lime:s=300x100', '-frames:v', '1', process.env.LOGO_PATH]);
}

const { AUTO, esAuto, pedirEstilo, pedirModo, perfilesDeTrabajo, MODOS } = await import('../src/engine/rotacion-flujo.js');
const { rotador } = await import('../src/engine/rotacion-estado.js');
const { nombresEstilos } = await import('../src/estilos-subtitulos.js');
const { store } = await import('../src/storage/store.js');
const { procesarClip } = await import('../src/engine/pipeline.js');
const { validarVideo, dirUploads } = await import('../src/upload.js');

test.after(() => fs.rm(raiz, { recursive: true, force: true }));

const ESTILOS = nombresEstilos();
const OPCIONES_MODO = [...MODOS];
// Estas pruebas no dependen de la forma interna de rotador.estado(canal, opciones): solo comparan "fotos" antes y despues.
const reiniciarTodo = async () => { await rotador.reiniciar('estilo', ESTILOS); await rotador.reiniciar('modo', OPCIONES_MODO); };
const foto = async () => JSON.stringify([await rotador.estado('estilo', ESTILOS), await rotador.estado('modo', OPCIONES_MODO)]);
const sinRepetirSeguido = (lista) => lista.every((v, i) => i === 0 || v !== lista[i - 1]);

test('esAuto: ausente, vacio y "auto" (con espacios o mayusculas) rotan; un valor concreto no', () => {
  for (const v of [undefined, null, '', '   ', 'auto', ' AUTO ', 'Auto']) assert.equal(esAuto(v), true, JSON.stringify(v));
  for (const v of ['dinamico', 'recorte', 'blur', 'x']) assert.equal(esAuto(v), false, v);
});

test('pedirEstilo: auto/vacio -> AUTO, valido normalizado, desconocido lanza el error de siempre', () => {
  assert.equal(pedirEstilo(undefined), AUTO);
  assert.equal(pedirEstilo('auto'), AUTO);
  assert.equal(pedirEstilo(' Clasico '), 'clasico');
  assert.throws(() => pedirEstilo('neon'), /dinamico, clasico, minimal/);
});

test('pedirModo: auto/vacio -> AUTO, recorte|blur se respetan, otro lanza', () => {
  assert.equal(pedirModo(''), AUTO);
  assert.equal(pedirModo(undefined), AUTO);
  assert.equal(pedirModo('AUTO'), AUTO);
  assert.equal(pedirModo(' Blur '), 'blur');
  assert.equal(pedirModo('recorte'), 'recorte');
  assert.throws(() => pedirModo('zoom'), /recorte, blur o auto/);
});

test('DEFAULT_RENDER_MODE fijado por el operador: un modo vacio lo usa, un "auto" explicito sigue rotando', () => {
  const codigo = `const { pedirModo } = await import('./src/engine/rotacion-flujo.js');
    console.log(JSON.stringify([pedirModo(''), pedirModo(undefined), pedirModo('auto'), pedirModo('recorte')]));`;
  const salida = execFileSync(process.execPath, ['--input-type=module', '-e', codigo], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8',
    env: { ...process.env, DEFAULT_RENDER_MODE: 'blur', DATA_DIR: path.join(raiz, 'otro') },
  });
  assert.deepEqual(JSON.parse(salida), ['blur', 'blur', 'auto', 'recorte']);
});

test('valores manuales: se respetan en todos los clips y NO tocan el estado de la rotacion', async () => {
  await reiniciarTodo();
  const antes = await foto();
  const perfiles = await perfilesDeTrabajo({ estiloSubtitulos: 'clasico', modo: 'blur' }, 4);
  assert.deepEqual(perfiles, Array(4).fill({ estilo: 'clasico', modo: 'blur' }));
  assert.equal(await foto(), antes, 'sin avance de ciclo con valores manuales');
});

test('trabajo sin estilo (llamada heredada): conserva el subtitulado clasico del pipeline (estilo null)', async () => {
  const perfiles = await perfilesDeTrabajo({ modo: 'recorte' }, 2);
  assert.deepEqual(perfiles, Array(2).fill({ estilo: null, modo: 'recorte' }));
});

test('auto: una tanda de 3 clips usa los 3 estilos sin repetir y el ciclo se reinicia solo', async () => {
  await reiniciarTodo();
  const primera = await perfilesDeTrabajo({ estiloSubtitulos: AUTO, modo: 'recorte' }, ESTILOS.length);
  assert.deepEqual([...new Set(primera.map((p) => p.estilo))].sort(), [...ESTILOS].sort(), 'todos los estilos una vez');
  const segunda = await perfilesDeTrabajo({ estiloSubtitulos: AUTO, modo: 'recorte' }, ESTILOS.length);
  assert.deepEqual([...new Set(segunda.map((p) => p.estilo))].sort(), [...ESTILOS].sort(), 'ciclo nuevo completo');
  assert.ok(sinRepetirSeguido([...primera, ...segunda].map((p) => p.estilo)), 'tampoco se repite en el cruce de ciclos');
});

test('auto: el ciclo continua ENTRE trabajos y a lo largo de 5 clips nunca repite seguido', async () => {
  await reiniciarTodo();
  const todos = [];
  for (let i = 0; i < 4; i++) todos.push(...(await perfilesDeTrabajo({ estiloSubtitulos: AUTO, modo: AUTO }, 5)));
  assert.equal(todos.length, 20);
  assert.ok(sinRepetirSeguido(todos.map((p) => p.estilo)));
  assert.ok(sinRepetirSeguido(todos.map((p) => p.modo)), 'con dos modos alternan estrictamente');
  assert.ok(todos.every((p) => ESTILOS.includes(p.estilo) && MODOS.includes(p.modo)));
  const cuentas = Object.fromEntries(ESTILOS.map((e) => [e, todos.filter((p) => p.estilo === e).length]));
  const valores = Object.values(cuentas);
  assert.ok(Math.max(...valores) - Math.min(...valores) <= 1, 'reparto parejo: ' + JSON.stringify(cuentas));
});

test('estilo manual + modo auto: solo rota el modo', async () => {
  await reiniciarTodo();
  const perfiles = await perfilesDeTrabajo({ estiloSubtitulos: 'minimal', modo: AUTO }, 4);
  assert.ok(perfiles.every((p) => p.estilo === 'minimal'));
  assert.deepEqual([...new Set(perfiles.map((p) => p.modo))].sort(), [...MODOS].sort());
});

test('si el disco falla, el trabajo no se cae: usa el valor de respaldo', async () => {
  const bloqueo = path.join(raiz, 'archivo-no-directorio');
  await fs.writeFile(bloqueo, 'x');   // DATA_DIR dentro de un archivo -> no se puede guardar el estado
  const codigo = `const { perfilesDeTrabajo } = await import('./src/engine/rotacion-flujo.js');
    console.log(JSON.stringify(await perfilesDeTrabajo({ estiloSubtitulos: 'auto', modo: 'auto' }, 3)));`;
  const salida = execFileSync(process.execPath, ['--input-type=module', '-e', codigo], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8',
    env: { ...process.env, DATA_DIR: path.join(bloqueo, 'datos') },
  });
  // Si el rotador falla al guardar se usa el respaldo; si no falla, la rotacion normal. En ambos casos el trabajo sigue con 3 perfiles validos.
  const perfiles = JSON.parse(salida.trim().split('\n').pop());
  assert.equal(perfiles.length, 3);
  assert.ok(perfiles.every((p) => ESTILOS.includes(p.estilo) && MODOS.includes(p.modo)), salida);
});

// ---------------------------------------------------------------------------
// Pipeline real: los clips de un mismo video salen con estilos y modos rotados.
// ---------------------------------------------------------------------------
const skip = (!hayFfmpeg && 'ffmpeg no disponible') || SIN_SHELL;

async function subirArchivo() {
  await fs.mkdir(dirUploads(), { recursive: true });
  const ruta = path.join(dirUploads(), 'rot-' + Math.random().toString(36).slice(2) + '.mp4');
  await fs.copyFile(fuente, ruta);
  return { tipo: 'archivo', ...(await validarVideo(ruta, 'charla.mp4')) };
}

async function correr(extra) {
  const archivo = await subirArchivo();
  const clip = store.encolar('charla.mp4', { origen: 'archivo', estiloSubtitulos: extra.estiloSubtitulos === AUTO ? null : extra.estiloSubtitulos });
  await procesarClip({ id: clip.id, url: null, archivo, auto: true, inicio: 0, duracion: 45, ...extra });
  return store.snapshot().clips.filter((c) => c.jobId === clip.id);
}

test('pipeline con estilo y modo en auto: 3 clips -> 3 estilos distintos, modos alternados y registrados en cada clip', { skip, timeout: 280000 }, async () => {
  await reiniciarTodo();
  const antes = await foto();
  const clips = await correr({ cantidad: 3, modo: AUTO, estiloSubtitulos: AUTO });
  assert.equal(clips.length, 3);
  for (const c of clips) assert.equal(c.estado, 'listo', c.etapa);
  assert.deepEqual([...new Set(clips.map((c) => c.estiloSubtitulos))].sort(), [...ESTILOS].sort(), 'cada clip, un estilo distinto');
  assert.ok(clips.every((c) => MODOS.includes(c.modo)));
  assert.equal(new Set(clips.map((c) => c.modo)).size, 2, 'los dos modos aparecen');
  assert.ok(clips.every((c) => c.ficha.revisionTecnica.modo === c.modo), 'la revision tecnica refleja el modo realmente usado');

  assert.notEqual(await foto(), antes, 'el avance del ciclo quedo guardado');
});

test('pipeline con valores manuales: todos los clips los respetan y la rotacion no avanza', { skip, timeout: 280000 }, async () => {
  await reiniciarTodo();
  const antes = await foto();
  const clips = await correr({ cantidad: 2, modo: 'blur', estiloSubtitulos: 'minimal' });
  assert.equal(clips.length, 2);
  for (const c of clips) {
    assert.equal(c.estado, 'listo', c.etapa);
    assert.equal(c.estiloSubtitulos, 'minimal');
    assert.equal(c.modo, 'blur');
  }
  assert.equal(await foto(), antes, 'valores manuales: el estado de la rotacion queda intacto');
});
