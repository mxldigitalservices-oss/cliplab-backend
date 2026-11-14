import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-formato-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.SESSION_DIR = path.join(raiz, 'datos');
process.env.YTDLP_PATH = fileURLToPath(new URL('./fixtures/yt-dlp-falso.sh', import.meta.url));
process.env.FAKE_LOG = path.join(raiz, 'llamadas.log');
process.env.LOG_LEVEL = 'error';

const { descargarVideo, FORMATO_DESCARGA } = await import('../src/engine/download.js');
const URL_VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

test.after(async () => {
  await fs.rm(raiz, { recursive: true, force: true });
});

test('el selector es flexible: no exige codecs y termina en un archivo unico', () => {
  assert.ok(!FORMATO_DESCARGA.includes('vcodec'));
  assert.ok(!FORMATO_DESCARGA.includes('ext=m4a'));
  assert.ok(FORMATO_DESCARGA.endsWith('/bv*+ba/b'));
});

test('descargarVideo usa ese selector al invocar yt-dlp', async () => {
  process.env.FAKE_MODE = 'ok';
  await fs.rm(process.env.FAKE_LOG, { force: true });
  const video = await descargarVideo(URL_VIDEO, path.join(raiz, 'a'));
  assert.equal(video.id, 'vid123');
  const llamadas = await fs.readFile(process.env.FAKE_LOG, 'utf8');
  assert.ok(llamadas.includes('-f ' + FORMATO_DESCARGA));
});

test('si YouTube no ofrece formatos: lista los formatos y devuelve un error claro', async () => {
  process.env.FAKE_MODE = 'formato';
  await fs.rm(process.env.FAKE_LOG, { force: true });
  await assert.rejects(
    descargarVideo(URL_VIDEO, path.join(raiz, 'b')),
    /ningun formato descargable/
  );
  const llamadas = await fs.readFile(process.env.FAKE_LOG, 'utf8');
  assert.ok(llamadas.includes('--list-formats'), 'debe registrar los formatos disponibles');
});
