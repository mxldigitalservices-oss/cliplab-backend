import test from 'node:test';
import { SIN_SHELL } from './helpers/plataforma.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// whisper existe pero falla: sin modelo -> respaldo limpio ([]); cualquier otro fallo real -> se propaga como error.
const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-whisperfallos-'));
process.env.LOG_LEVEL = 'error';
process.env.WHISPER_PATH = path.join(raiz, 'whisper-falso.sh');
await fs.writeFile(process.env.WHISPER_PATH, `#!/bin/sh
case "$FAKE_WHISPER" in
  sin-modelo) echo "error: failed to initialize whisper context" >&2; exit 3 ;;
  *) echo "segfault inesperado" >&2; exit 139 ;;
esac
`, { mode: 0o755 });
const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const { transcribirAudio } = await import('../src/engine/transcribe.js');
const fuente = path.join(raiz, 'v.mp4');
if (hayFfmpeg) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=2:r=8000', '-c:a', 'aac', fuente]);
  assert.equal(r.status, 0);
}
test.after(() => fs.rm(raiz, { recursive: true, force: true }));
const skip = (!hayFfmpeg && 'ffmpeg no disponible') || SIN_SHELL;

test('whisper presente pero sin modelo: se trata como no disponible y devuelve []', { skip }, async () => {
  process.env.FAKE_WHISPER = 'sin-modelo';
  assert.deepEqual(await transcribirAudio(fuente, path.join(raiz, 'a1'), { duracion: 2 }), []);
});

test('un fallo REAL de whisper (otro error y codigo de salida) si se propaga', { skip }, async () => {
  process.env.FAKE_WHISPER = 'roto';
  await assert.rejects(transcribirAudio(fuente, path.join(raiz, 'a2'), { duracion: 2 }), /segfault|139/);
});
