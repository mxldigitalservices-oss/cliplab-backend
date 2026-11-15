import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-diag-'));
const falso = path.join(raiz, 'yt-dlp-falso.sh');
await fs.writeFile(falso, [
  '#!/bin/sh',
  'echo "$*" >> "$FAKE_LOG"',
  'case "$*" in',
  '  *--list-formats*)',
  '    echo "[debug] JS runtimes: node-20.1.0" >&2',
  '    echo "WARNING: [youtube] abc: n challenge solving failed: Some formats may be missing." >&2',
  '    echo "linea de ruido que no importa" >&2',
  '    echo "sb0 mhtml 320x180 images storyboard"',
  '    exit 0 ;;',
  'esac',
  'echo "ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats" >&2',
  'exit 1',
  '',
].join('\n'), { mode: 0o755 });

process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.SESSION_DIR = path.join(raiz, 'datos');
process.env.YTDLP_PATH = falso;
process.env.FAKE_LOG = path.join(raiz, 'llamadas.log');
process.env.YTDLP_EXTRA_ARGS = '--remote-components ejs:github';
process.env.LOG_LEVEL = 'error';

const { diagnosticarFormatos, descargarVideo } = await import('../src/engine/download.js');
const URL_VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

test.after(async () => {
  await fs.rm(raiz, { recursive: true, force: true });
});

test('el diagnostico muestra los formatos y solo los avisos relevantes del modo verbose', async () => {
  const { formatos, avisos } = await diagnosticarFormatos(URL_VIDEO);
  assert.ok(formatos.some((l) => l.includes('storyboard')));
  assert.ok(avisos.some((l) => l.includes('JS runtimes')));
  assert.ok(avisos.some((l) => l.includes('challenge solving failed')));
  assert.ok(!avisos.some((l) => l.includes('ruido')));
});

test('YTDLP_EXTRA_ARGS se pasa a la descarga y al diagnostico', async () => {
  await fs.rm(process.env.FAKE_LOG, { force: true });
  await assert.rejects(
    descargarVideo(URL_VIDEO, path.join(raiz, 'a')),
    /Diagnostico de yt-dlp/
  );
  const llamadas = (await fs.readFile(process.env.FAKE_LOG, 'utf8')).split('\n').filter(Boolean);
  assert.equal(llamadas.length, 2);
  for (const linea of llamadas) assert.ok(linea.includes('--remote-components ejs:github'));
  assert.ok(llamadas[1].includes('-v') && llamadas[1].includes('--list-formats'));
});
