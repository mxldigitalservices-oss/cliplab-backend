import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-render-'));
const logoPath = path.join(raiz, 'logo.png');
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.LOGO_PATH = logoPath;
process.env.LOG_LEVEL = 'error';

const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ffmpeg = (args) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  assert.equal(r.status, 0, String(r.stderr));
};

// Frame RGB crudo del segundo 1 del clip (1080x1920).
function frame(archivo) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', archivo, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
}
const pixel = (buf, x, y) => [buf[(y * 1080 + x) * 3], buf[(y * 1080 + x) * 3 + 1], buf[(y * 1080 + x) * 3 + 2]];

function centroideRojo(buf) {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < 1920; y += 2) {
    for (let x = 0; x < 1080; x += 2) {
      const [r, g, b] = pixel(buf, x, y);
      if (r > 200 && g < 60 && b < 60) { sx += x; sy += y; n++; }
    }
  }
  return { x: sx / n, y: sy / n, n };
}

test('render 9:16 centrado, con logo arriba a la derecha y metadatos reales', { skip: !hayFfmpeg && 'ffmpeg no disponible' }, async () => {
  // Fuente 16:9 azul con un cuadro rojo EXACTAMENTE en el centro (960,540).
  const fuente = path.join(raiz, 'fuente.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:d=3:r=30,drawbox=x=860:y=440:w=200:h=200:color=red:t=fill',
    '-f', 'lavfi', '-i', 'sine=d=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fuente]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=lime:s=300x100', '-frames:v', '1', logoPath]);

  const { renderizarClip } = await import('../src/engine/render.js');
  const { config } = await import('../src/config/index.js');
  const salida = path.join(raiz, 'clip.mp4');
  const r = await renderizarClip({ entrada: fuente, salida, inicio: 0, duracion: 2 });

  assert.equal(r.ancho, 1080);
  assert.equal(r.alto, 1920);
  assert.equal(r.conLogo, true);
  assert.ok(r.duracion > 1.8 && r.duracion < 2.3, 'duracion real ' + r.duracion);
  assert.ok(r.bytes > 0);

  const buf = frame(salida);
  const c = centroideRojo(buf);
  assert.ok(c.n > 1000, 'se encontro el marcador rojo');
  assert.ok(Math.abs(c.x - 540) <= 6 && Math.abs(c.y - 960) <= 6, 'centrado en (540,960), real (' + c.x.toFixed(1) + ',' + c.y.toFixed(1) + ')');

  // Logo: ancho 216, alto 72, margen 56 -> x 808..1024, y 56..128.
  const [lr, lg, lb] = pixel(buf, 916, 92);
  assert.ok(lg > 150 && lr < 120 && lb < 120, 'logo verde presente: ' + [lr, lg, lb]);
  assert.equal(config.logoPosition, 'top-right');

  // Sin logo (opcion explicita): ese mismo pixel es el fondo azul.
  const sin = path.join(raiz, 'sin-logo.mp4');
  const r2 = await renderizarClip({ entrada: fuente, salida: sin, inicio: 0, duracion: 2, logo: false });
  assert.equal(r2.conLogo, false);
  const [sr, sg, sb] = pixel(frame(sin), 916, 92);
  assert.ok(sb > 150 && sg < 100 && sr < 100, 'sin logo el fondo es azul: ' + [sr, sg, sb]);
});

test('logo inexistente: el clip se genera igual, sin logo, y se avisa', { skip: !hayFfmpeg && 'ffmpeg no disponible' }, async () => {
  const fuente = path.join(raiz, 'fuente.mp4');
  const { renderizarClip } = await import('../src/engine/render.js');
  const salida = path.join(raiz, 'clip-sin-archivo-logo.mp4');
  const r = await renderizarClip({ entrada: fuente, salida, duracion: 1, logo: path.join(raiz, 'no-existe.png') });
  assert.equal(r.conLogo, false);
  assert.equal(r.alto, 1920);
});
