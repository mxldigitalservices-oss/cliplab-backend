import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-curador-'));
const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.SESSION_DIR = path.join(raiz, 'sesion');
process.env.MASTER_KEY = 'llave-de-prueba';
process.env.LOG_LEVEL = 'error';
process.env.LOGO_PATH = path.join(raiz, 'klikap-logo.png');
process.env.VIDEO_PRESET = 'ultrafast';
process.env.YTDLP_PATH = path.join(raiz, 'yt-dlp-falso.sh');
process.env.WHISPER_PATH = path.join(raiz, 'whisper-falso.sh');
process.env.FAKE_VIDEO = path.join(raiz, 'fuente.mp4');
process.env.FAKE_ASR = path.join(raiz, 'asr.json');
process.env.FAKE_ASR_LLAMADAS = path.join(raiz, 'asr-llamadas.txt');

await fs.writeFile(process.env.YTDLP_PATH, `#!/bin/sh
SALIDA=""; ANT=""
for a in "$@"; do [ "$ANT" = "-o" ] && SALIDA="$a"; ANT="$a"; done
DIR="$(dirname "$SALIDA")"; mkdir -p "$DIR"
cp "$FAKE_VIDEO" "$DIR/vidfalso.mp4"
echo "vidfalso|900|$DIR/vidfalso.mp4|Como escalar tu negocio"
`, { mode: 0o755 });

// whisper falso: devuelve siempre la misma charla de 300 s (tiempos relativos al trozo) y cuenta cuantas veces se llamo.
await fs.writeFile(process.env.WHISPER_PATH, `#!/bin/sh
ANT=""; BASE=""
for a in "$@"; do [ "$ANT" = "-of" ] && BASE="$a"; ANT="$a"; done
echo x >> "$FAKE_ASR_LLAMADAS"
cp "$FAKE_ASR" "$BASE.json"
`, { mode: 0o755 });

const FRASES = [
  '¿Sabías que el error más caro en tu negocio es nunca medir los resultados?',
  'El primer paso de la estrategia es medir tus ventas cada semana con una herramienta simple.',
  'Un ejemplo claro: un cliente subió sus ingresos 40 por ciento con este método.',
  'Eso cambió su negocio y fue una historia increíble de éxito.',
  'La clave es aplicar el sistema todos los días sin excepción.',
  'El clima de la ciudad estuvo bastante normal durante la tarde.',
];
{
  const transcription = [];
  let t = 0;
  for (let i = 0; t < 296; i++) {
    for (const w of FRASES[i % FRASES.length].split(' ')) {
      transcription.push({ text: w, offsets: { from: Math.round(t * 1000), to: Math.round((t + 0.33) * 1000) } });
      t += 0.36;
    }
    t += 0.3;
  }
  await fs.writeFile(process.env.FAKE_ASR, JSON.stringify({ transcription }));
}

if (hayFfmpeg) {
  const ff = (args) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    assert.equal(r.status, 0, String(r.stderr));
  };
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=900:r=2', '-f', 'lavfi', '-i', 'sine=d=900:r=8000', '-shortest',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '16k', process.env.FAKE_VIDEO]);
  ff(['-f', 'lavfi', '-i', 'color=c=lime:s=300x100', '-frames:v', '1', process.env.LOGO_PATH]);
}

const { config } = await import('../src/config/index.js');
const { store } = await import('../src/storage/store.js');
const { procesarClip } = await import('../src/engine/pipeline.js');
const { createApp } = await import('../src/app.js');

const URL_VIDEO = 'https://www.youtube.com/watch?v=vidfalso';
const skip = !hayFfmpeg && 'ffmpeg no disponible';
test.after(() => fs.rm(raiz, { recursive: true, force: true }));

async function procesar() {
  const clip = store.encolar(URL_VIDEO);
  await procesarClip({ id: clip.id, url: URL_VIDEO, auto: true, inicio: 0, duracion: 45, modo: 'recorte' });
  return clip.id;
}
const clipsDe = (jobId) => store.snapshot().clips.filter((c) => c.jobId === jobId);
const llamadasAsr = async () => (await fs.readFile(process.env.FAKE_ASR_LLAMADAS, 'utf8')).trim().split('\n').length;
const rango = (c) => ({ inicio: c.segmento.inicio, fin: c.segmento.inicio + c.segmento.duracion });
const solapan = (a, b) => a.inicio < b.fin && b.inicio < a.fin;

test('curaduria de punta a punta: fichas completas, una sola pasada de ASR y revision tecnica verificada', { skip, timeout: 280000 }, async () => {
  const jobId = await procesar();
  const clips = clipsDe(jobId);
  assert.ok(clips.length === 4 || clips.length === 5, 'clips: ' + clips.length);

  for (const c of clips) {
    assert.equal(c.estado, 'listo', c.etapa);
    assert.deepEqual([c.ancho, c.alto], [1080, 1920]);
    const f = c.ficha;
    assert.equal(f.origen, 'curador');
    for (const k of ['gancho', 'flujo', 'valor', 'interes']) assert.equal(typeof f[k].puntaje, 'number', k);
    assert.equal(typeof f.puntaje, 'number');
    assert.ok(f.titulo && f.descripcion.includes('#'));
    assert.equal(c.marketing.titulo, f.titulo);
    assert.equal(c.copy, f.descripcion);
    assert.equal(c.cta, f.cta);

    const rt = f.revisionTecnica;
    assert.deepEqual([rt.formato, rt.resolucion, rt.estado, rt.cumpleFormato], ['9:16', '1080x1920', 'verificado', true]);
    assert.deepEqual(rt.medido, { ancho: 1080, alto: 1920 });
    assert.equal(rt.cpu.preset, 'ultrafast');
    assert.ok(rt.encuadre.tipo && rt.encuadre.interlocutor);
    assert.ok(c.segmento.duracion >= 30 && c.segmento.duracion <= 60);
  }
  const rangos = clips.map(rango);
  for (let i = 0; i < rangos.length; i++) for (let j = i + 1; j < rangos.length; j++) assert.ok(!solapan(rangos[i], rangos[j]));

  // El video se transcribe UNA vez, en 2 trozos de hasta 600 s (900 s en total); los clips reutilizan esas palabras.
  assert.equal(await llamadasAsr(), 2);
  await fs.access(path.join(config.dataDir, 'transcripciones', 'vidfalso.json'));
});

test('re-procesar usa la cache de transcripcion y no repite momentos', { skip, timeout: 280000 }, async () => {
  const jobId = await procesar();
  const nuevos = clipsDe(jobId).filter((c) => c.estado === 'listo');
  assert.ok(nuevos.length >= 4, 'segunda pasada: ' + nuevos.length);
  assert.equal(await llamadasAsr(), 2, 'sin transcribir de nuevo');
  const previos = store.snapshot().clips.filter((c) => c.jobId !== jobId && c.segmento).map(rango);
  for (const n of nuevos.map(rango)) for (const p of previos) assert.ok(!solapan(n, p), 'repite ' + p.inicio);
});

test('/api/panel/estado devuelve la ficha enriquecida de cada clip', { skip }, async () => {
  const servidor = createApp().listen(0, '127.0.0.1');
  await new Promise((ok) => servidor.once('listening', ok));
  try {
    const r = await fetch('http://127.0.0.1:' + servidor.address().port + '/api/panel/estado', { headers: { 'x-master-key': 'llave-de-prueba' } });
    const j = await r.json();
    assert.equal(j.success, true);
    const listo = j.data.clips.find((c) => c.estado === 'listo');
    assert.ok(listo.ficha.gancho.frase && listo.ficha.revisionTecnica.resolucion === '1080x1920');
  } finally {
    servidor.close();
  }
});
