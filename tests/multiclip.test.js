import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-multi-'));
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

// yt-dlp falso: copia un video real de 900 s o falla escribiendo un stderr enorme (modo "fallo").
await fs.writeFile(process.env.YTDLP_PATH, `#!/bin/sh
if [ "$FAKE_MODE" = "fallo" ]; then
  i=0; while [ $i -lt 400 ]; do echo "ERROR: linea $i de un stderr muy largo de yt-dlp con detalle tecnico completo" >&2; i=$((i+1)); done
  echo "ERROR: [youtube] ultima-linea-importante: Video unavailable" >&2
  exit 1
fi
SALIDA=""; ANT=""
for a in "$@"; do [ "$ANT" = "-o" ] && SALIDA="$a"; ANT="$a"; done
DIR="$(dirname "$SALIDA")"; mkdir -p "$DIR"
cp "$FAKE_VIDEO" "$DIR/vidfalso.mp4"
echo "vidfalso|900|$DIR/vidfalso.mp4|Como escalar tu negocio"
`, { mode: 0o755 });

// whisper falso: deja un JSON sin palabras (sin voz) donde lo pide -of.
await fs.writeFile(process.env.WHISPER_PATH, `#!/bin/sh
ANT=""; BASE=""
for a in "$@"; do [ "$ANT" = "-of" ] && BASE="$a"; ANT="$a"; done
echo '{"transcription":[]}' > "$BASE.json"
`, { mode: 0o755 });

process.env.FAKE_VIDEO = path.join(raiz, 'fuente.mp4');
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
const { procesarClip, directorioDeTrabajo } = await import('../src/engine/pipeline.js');
const { createApp } = await import('../src/app.js');

const URL_VIDEO = 'https://www.youtube.com/watch?v=vidfalso';
const skip = !hayFfmpeg && 'ffmpeg no disponible';

test.after(() => fs.rm(raiz, { recursive: true, force: true }));

async function procesar(extra = {}) {
  const clip = store.encolar(URL_VIDEO);
  await procesarClip({ id: clip.id, url: URL_VIDEO, auto: true, inicio: 0, duracion: 45, modo: 'recorte', ...extra });
  return clip.id;
}
const clipsDe = (jobId) => store.snapshot().clips.filter((c) => c.jobId === jobId);
const rango = (c) => ({ inicio: c.segmento.inicio, fin: c.segmento.inicio + c.segmento.duracion });
const solapan = (a, b) => a.inicio < b.fin && b.inicio < a.fin;

test('un video genera 4-5 clips 1080x1920 con logo, marketing y sin dejar basura', { skip, timeout: 240000 }, async () => {
  const jobId = await procesar();
  const clips = clipsDe(jobId);

  assert.ok(clips.length === 4 || clips.length === 5, 'clips: ' + clips.length);
  assert.equal(new Set(clips.map((c) => c.id)).size, clips.length, 'cada clip con id propio');

  for (const c of clips) {
    assert.equal(c.estado, 'listo', c.etapa);
    assert.equal(c.ancho, 1080);
    assert.equal(c.alto, 1920);
    assert.equal(c.conLogo, true);
    assert.ok(c.segmento.duracion >= 30 && c.segmento.duracion <= 60);
    assert.ok(c.duracion > 29 && c.duracion < 61.5, 'duracion real ' + c.duracion);
    await fs.access(path.join(config.clipsDir, path.basename(c.url)));

    // Paquete de marketing asociado al clip
    assert.ok(c.marketing.titulo.length > 5);
    assert.ok(c.marketing.descripcion.includes('Mira hasta el final'));
    assert.ok(c.marketing.cta);
    assert.ok(c.marketing.hashtags.length >= 5 && c.marketing.hashtags.every((h) => h.startsWith('#')));
    assert.ok(c.copy.includes(c.marketing.hashtags[0]) && c.cta === c.marketing.cta);
  }

  const rangos = clips.map(rango);
  for (let i = 0; i < rangos.length; i++) for (let j = i + 1; j < rangos.length; j++) {
    assert.ok(!solapan(rangos[i], rangos[j]), 'sin solapes dentro del mismo video');
  }

  // Aislamiento: el directorio del job se elimina al terminar y vive bajo tmp/jobs/<id>
  assert.equal(directorioDeTrabajo(jobId), path.join(config.tmpDir, 'jobs', jobId));
  await assert.rejects(fs.access(directorioDeTrabajo(jobId)));
});

test('re-procesar la misma URL explora otros momentos (no repite cortes)', { skip, timeout: 240000 }, async () => {
  // La prueba anterior ya registro una pasada de vidfalso en el historial.
  const jobId = await procesar();
  const nuevos = clipsDe(jobId).filter((c) => c.estado === 'listo');
  assert.ok(nuevos.length >= 4, 'segunda pasada genero ' + nuevos.length + ' clips');

  const previos = store.snapshot().clips.filter((c) => c.jobId !== jobId && c.segmento).map(rango);
  assert.ok(previos.length >= 4);
  for (const n of nuevos.map(rango)) {
    for (const p of previos) assert.ok(!solapan(n, p), 'repite el momento ' + p.inicio + '-' + p.fin);
  }
});

test('directorios por job: ids invalidos o con rutas relativas se rechazan', () => {
  assert.throws(() => directorioDeTrabajo('../escape'), /invalido/);
  assert.throws(() => directorioDeTrabajo('a/b'), /invalido/);
  assert.notEqual(directorioDeTrabajo('clip_1'), directorioDeTrabajo('clip_2'));
});

test('corte manual (inicio/duracion) sigue generando un unico clip', { skip, timeout: 120000 }, async () => {
  const jobId = await procesar({ auto: false, inicio: 20, duracion: 35 });
  const clips = clipsDe(jobId);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].estado, 'listo');
  assert.equal(clips[0].inicio, 20);
  assert.ok(clips[0].marketing.titulo);
});

test('fallo de descarga: stderr COMPLETO en Incidencias, sin inflar /estado, envelope limpio', async () => {
  process.env.FAKE_MODE = 'fallo';
  const { agregarTrabajo } = await import('../src/engine/cola.js');
  const clip = store.encolar(URL_VIDEO);
  agregarTrabajo({ id: clip.id, url: URL_VIDEO, auto: true, inicio: 0, duracion: 45, modo: 'recorte' });
  for (let i = 0; i < 100 && store.buscar(clip.id).estado === 'procesando'; i++) await new Promise((r) => setTimeout(r, 100));
  delete process.env.FAKE_MODE;
  assert.equal(store.buscar(clip.id).estado, 'error');

  const servidor = createApp().listen(0, '127.0.0.1');
  await new Promise((ok) => servidor.once('listening', ok));
  const base = 'http://127.0.0.1:' + servidor.address().port;
  const AUTH = { 'x-master-key': 'llave-de-prueba' };
  try {
    // /estado: solo resumen, nunca el stderr entero
    const estado = await (await fetch(base + '/api/panel/estado', { headers: AUTH })).json();
    assert.equal(estado.success, true);
    assert.equal(estado.error, null);
    const inc = estado.data.incidencias.find((i) => i.mensaje.includes('Video unavailable') || i.origen === 'cola');
    assert.ok(inc, 'incidencia registrada');
    assert.equal(inc.detalle, null);
    assert.equal(inc.tieneDetalle, true);
    assert.ok(inc.detalleResumen.includes('ultima-linea-importante'));
    assert.ok(JSON.stringify(estado).length < 50000, 'el sondeo no se infla con el stderr');

    // Detalle bajo demanda: stderr completo (mas de los 1500 caracteres que se guardaban antes)
    const completo = await (await fetch(base + '/api/panel/incidencias/' + inc.id, { headers: AUTH })).json();
    assert.equal(completo.success, true);
    assert.ok(completo.data.incidencia.detalle.length > 5000, 'longitud ' + completo.data.incidencia.detalle.length);
    assert.ok(completo.data.incidencia.detalle.includes('linea 0 de un stderr'), 'conserva el principio');
    assert.ok(completo.data.incidencia.detalle.includes('ultima-linea-importante'), 'conserva el final');

    // Errores: misma estructura { success:false, data:null, error }
    const r404 = await fetch(base + '/api/panel/incidencias/inc_noexiste', { headers: AUTH });
    const c404 = await r404.json();
    assert.equal(r404.status, 404);
    assert.deepEqual([c404.success, c404.data], [false, null]);
    assert.ok(c404.error);

    const rMal = await fetch(base + '/api/panel/encolar', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ url: URL_VIDEO, cantidad: 9 }) });
    const cMal = await rMal.json();
    assert.equal(rMal.status, 400);
    assert.equal(cMal.success, false);

    const rJson = await fetch(base + '/api/panel/encolar', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: '{roto' });
    const cJson = await rJson.json();
    assert.equal(rJson.status, 400);
    assert.deepEqual([cJson.success, cJson.data], [false, null]);
  } finally {
    servidor.close();
  }
});
