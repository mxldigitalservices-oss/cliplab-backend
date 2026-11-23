import test from 'node:test';
import { SIN_SHELL } from './helpers/plataforma.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-archivo-'));
const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.SESSION_DIR = path.join(raiz, 'sesion');
process.env.UPLOADS_DIR = path.join(raiz, 'uploads');
process.env.MASTER_KEY = 'llave-de-prueba';
process.env.LOG_LEVEL = 'error';
process.env.LOGO_PATH = path.join(raiz, 'klikap-logo.png');
process.env.VIDEO_PRESET = 'ultrafast';
process.env.YTDLP_PATH = path.join(raiz, 'no-debe-usarse.sh');   // un archivo local nunca descarga nada
process.env.WHISPER_PATH = path.join(raiz, 'whisper-falso.sh');
process.env.FAKE_ASR = path.join(raiz, 'asr.json');

await fs.writeFile(process.env.WHISPER_PATH, `#!/bin/sh\nANT=""; BASE=""\nfor a in "$@"; do [ "$ANT" = "-of" ] && BASE="$a"; ANT="$a"; done\ncp "$FAKE_ASR" "$BASE.json"\n`, { mode: 0o755 });

// Charla de 120 s: frases corrientes y UNA frase distintiva (precio del dolar) hacia el segundo 85.
const NORMALES = [
  'El clima de la ciudad estuvo bastante normal durante la tarde.',
  'La gente caminaba por la calle principal sin mucha prisa.',
  'Hubo algo de trafico cerca del parque central esta semana.',
];
const DISTINTIVA = 'Atencion porque el precio del dolar subio mucho y afecta tu ahorro mensual.';
const ESPECIAL_DESDE = 82;
{
  const transcription = [];
  let t = 0;
  let especial = false;
  for (let i = 0; t < 118; i++) {
    const frase = !especial && t >= ESPECIAL_DESDE ? (especial = true, DISTINTIVA) : NORMALES[i % NORMALES.length];
    for (const w of frase.split(' ')) {
      transcription.push({ text: w, offsets: { from: Math.round(t * 1000), to: Math.round((t + 0.33) * 1000) } });
      t += 0.36;
    }
    t += 0.3;
  }
  await fs.writeFile(process.env.FAKE_ASR, JSON.stringify({ transcription }));
}

const skip = (!hayFfmpeg && 'ffmpeg no disponible') || SIN_SHELL;
const fuente = path.join(raiz, 'fuente.mp4');
if (hayFfmpeg) {
  const ff = (args) => assert.equal(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]).status, 0);
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=120:r=2', '-f', 'lavfi', '-i', 'sine=d=120:r=8000', '-shortest',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '16k', fuente]);
  ff(['-f', 'lavfi', '-i', 'color=c=lime:s=300x100', '-frames:v', '1', process.env.LOGO_PATH]);
}

const { store } = await import('../src/storage/store.js');
const { procesarClip } = await import('../src/engine/pipeline.js');
const { validarVideo, dirUploads } = await import('../src/upload.js');

test.after(() => fs.rm(raiz, { recursive: true, force: true }));

async function subirArchivo() {
  await fs.mkdir(dirUploads(), { recursive: true });
  const ruta = path.join(dirUploads(), 'up-' + crypto.randomUUID() + '.mp4');
  await fs.copyFile(fuente, ruta);
  return { tipo: 'archivo', ...(await validarVideo(ruta, 'entrevista.mp4')) };
}

test('archivo local + instruccion + estilo: se procesa sin descargar, prioriza lo pedido y borra el upload', { skip, timeout: 240000 }, async () => {
  const archivo = await subirArchivo();
  const instruccion = 'cuando hablan del precio del dolar';
  const clip = store.encolar(archivo.nombreOriginal, { origen: 'archivo', instruccion, estiloSubtitulos: 'clasico' });

  await procesarClip({
    id: clip.id, url: null, archivo, auto: true, cantidad: 1, inicio: 0, duracion: 45, modo: 'recorte',
    instruccion, estiloSubtitulos: 'clasico',
  });

  const clips = store.snapshot().clips.filter((c) => c.jobId === clip.id);
  assert.equal(clips.length, 1);
  const [c] = clips;
  assert.equal(c.estado, 'listo', c.etapa);
  assert.equal(c.titulo.startsWith('entrevista.mp4'), true);
  assert.deepEqual([c.ancho, c.alto], [1080, 1920]);
  assert.equal(c.estiloSubtitulos, 'clasico');
  assert.equal(c.ficha.instruccion.coincide, true, 'el clip elegido contiene lo que se pidio');
  assert.ok(c.ficha.instruccion.coincidencias.length > 0);
  assert.ok(c.inicio <= ESPECIAL_DESDE + 3 && c.inicio + c.duracion >= ESPECIAL_DESDE + 3, 'el clip cubre el momento pedido: ' + c.inicio + '+' + c.duracion);
  assert.match(c.transcripcion, /dolar/i);

  await assert.rejects(fs.access(archivo.ruta), 'el upload se borra al terminar el trabajo');
});
