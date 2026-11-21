import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Sin whisper no se rompe el clip: se devuelve una lista vacia (el flujo "sin voz" ya existe) y se avisa una vez.
const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-sinwhisper-'));
process.env.LOG_LEVEL = 'error';
process.env.WHISPER_PATH = path.join(raiz, 'no-existe', 'whisper-cli');
const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const { transcribirAudio } = await import('../src/engine/transcribe.js');
const fuente = path.join(raiz, 'v.mp4');
if (hayFfmpeg) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=2:r=8000', '-c:a', 'aac', fuente]);
  assert.equal(r.status, 0);
}
test.after(() => fs.rm(raiz, { recursive: true, force: true }));

test('whisper ausente (spawn ENOENT): devuelve [] y no lanza', { skip: !hayFfmpeg && 'ffmpeg no disponible' }, async () => {
  assert.deepEqual(await transcribirAudio(fuente, path.join(raiz, 'a1'), { duracion: 2 }), []);
  assert.deepEqual(await transcribirAudio(fuente, path.join(raiz, 'a2'), { duracion: 2 }), [], 'las siguientes llamadas tambien');
});
