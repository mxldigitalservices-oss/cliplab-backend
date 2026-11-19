// Arranque seguro: si la carpeta de subidas no se puede crear o escribir (Railway: /data sin permisos o sin montar -> EACCES/EROFS/ENOENT),
// el servidor NO se cae al importar: usa una carpeta de respaldo y avisa en el log. Las subidas de archivo solo fallan (503) si no queda
// ninguna carpeta escribible; los enlaces de YouTube siguen funcionando siempre.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cliplab-resp-'));
const bloqueo = path.join(raiz, 'archivo-no-directorio');   // un ARCHIVO donde deberia haber una carpeta: mkdir falla (ENOTDIR), igual que un /data sin permisos
fs.writeFileSync(bloqueo, 'x');
const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const sinRoot = typeof process.getuid === 'function' && process.getuid() !== 0;   // root ignora los permisos de carpeta

process.env.LOG_LEVEL = 'error';   // el modulo se prueba en procesos hijos; aqui solo importa el comportamiento
process.env.UPLOADS_DIR = path.join(bloqueo, 'uploads');   // configurada pero inutilizable
process.env.TMP_DIR = path.join(raiz, 'tmp');

const { subidaOpcional, origenDeEncolar, borrarUpload, dirUploads, purgarUploads } = await import('../src/upload.js');
const express = (await import('express')).default;

test.after(() => fs.rmSync(raiz, { recursive: true, force: true }));

const RAIZ_REPO = path.resolve(import.meta.dirname, '..');
function hijo(codigo, env) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', codigo], { cwd: RAIZ_REPO, encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'warn', ...env } });
  return { codigo: r.status, salida: r.stdout, avisos: (r.stdout + '\n' + r.stderr).split('\n').filter((l) => l.startsWith('{"time"')).map((l) => JSON.parse(l)) };
}
const ultimaLinea = (salida) => JSON.parse(salida.trim().split('\n').filter((l) => !l.startsWith('{"time"')).pop());

test('importar la ruta del panel con /data inutilizable NO lanza y registra una advertencia', () => {
  const r = hijo(`
    process.env.MASTER_KEY = 'k';
    await import('./src/routes/panel.js');
    const { dirUploads } = await import('./src/upload.js');
    console.log(JSON.stringify({ dir: dirUploads() }));`,
  { UPLOADS_DIR: path.join(bloqueo, 'uploads'), TMP_DIR: path.join(raiz, 'tmp-hijo') });
  assert.equal(r.codigo, 0, r.salida);
  assert.equal(ultimaLinea(r.salida).dir, path.join(raiz, 'tmp-hijo', 'uploads'), 'respaldo: TMP_DIR/uploads');
  assert.ok(r.avisos.some((a) => /No se puede escribir/.test(a.message) && a.meta.dir.endsWith(path.join('archivo-no-directorio', 'uploads'))), 'avisa del directorio que fallo');
  assert.ok(r.avisos.some((a) => /respaldo/.test(a.message) && a.level === 'warn'), 'avisa de que usa el respaldo');
});

test('sin TMP_DIR el respaldo es <tmp del sistema>/cliplab-uploads', () => {
  const tmp = path.join(raiz, 'tmp-sistema');
  fs.mkdirSync(tmp);
  const r = hijo(`const { dirUploads } = await import('./src/upload.js'); console.log(JSON.stringify({ dir: dirUploads() }));`,
    { UPLOADS_DIR: path.join(bloqueo, 'uploads'), TMP_DIR: '', TMPDIR: tmp });
  assert.equal(r.codigo, 0, r.salida);
  assert.equal(ultimaLinea(r.salida).dir, path.join(fs.realpathSync(tmp), 'cliplab-uploads'));
});

test('carpeta configurada sana: se usa tal cual y sin advertencias', () => {
  const buena = path.join(raiz, 'buena', 'uploads');
  const r = hijo(`const { dirUploads } = await import('./src/upload.js'); console.log(JSON.stringify({ dir: dirUploads() }));`, { UPLOADS_DIR: buena });
  assert.equal(ultimaLinea(r.salida).dir, buena);
  assert.equal(r.avisos.length, 0);
  assert.ok(fs.existsSync(buena));
  assert.deepEqual(fs.readdirSync(buena), [], 'la prueba de escritura no deja archivos');
});

test('permiso denegado real (EACCES) en la carpeta configurada: respaldo', { skip: !sinRoot && 'se ejecuta como root: ignora permisos' }, () => {
  const solo = path.join(raiz, 'solo-lectura');
  fs.mkdirSync(solo, { mode: 0o500 });
  const r = hijo(`const { dirUploads } = await import('./src/upload.js'); console.log(JSON.stringify({ dir: dirUploads() }));`,
    { UPLOADS_DIR: path.join(solo, 'uploads'), TMP_DIR: path.join(raiz, 'tmp-eacces') });
  fs.chmodSync(solo, 0o700);
  assert.equal(r.codigo, 0, r.salida);
  assert.equal(ultimaLinea(r.salida).dir, path.join(raiz, 'tmp-eacces', 'uploads'));
  assert.ok(r.avisos.some((a) => a.meta && a.meta.codigo === 'EACCES'));
});

test('ninguna carpeta escribible: no lanza, el multipart responde 503 y el JSON (enlace) sigue su curso', () => {
  const r = hijo(`
    const { subidaOpcional, ErrorSubida } = await import('./src/upload.js');
    const mw = subidaOpcional();   // no debe lanzar
    const llamar = (esMultipart) => new Promise((ok) => mw({ is: () => esMultipart }, {}, (e) => ok(e ? { status: e.status, esErrorSubida: e instanceof ErrorSubida } : { pasa: true })));
    console.log(JSON.stringify({ multipart: await llamar(true), json: await llamar(false) }));`,
  { UPLOADS_DIR: path.join(bloqueo, 'a'), TMP_DIR: path.join(bloqueo, 'b'), TMPDIR: bloqueo });
  assert.equal(r.codigo, 0, r.salida);
  const { multipart, json } = ultimaLinea(r.salida);
  assert.deepEqual(multipart, { status: 503, esErrorSubida: true });
  assert.deepEqual(json, { pasa: true });
  assert.ok(r.avisos.some((a) => a.level === 'error' && /Ninguna carpeta de subidas/.test(a.message)));
});

// ---- En el mismo proceso: la subida real funciona con el respaldo y borrar/purgar usan esa carpeta ----
const skip = !hayFfmpeg && 'ffmpeg no disponible';

test('subida real con /data inutilizable: se guarda en el respaldo, se valida y se borra', { skip }, async () => {
  const mp4 = path.join(raiz, 'v.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mp4]);
  const app = express();
  app.post('/encolar', express.json(), subidaOpcional(), (req, res, next) => { try { res.json({ origen: origenDeEncolar(req) }); } catch (e) { next(e); } });
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  const servidor = app.listen(0, '127.0.0.1');
  await new Promise((ok) => servidor.once('listening', ok));
  try {
    const fd = new FormData();
    fd.append('archivo', new Blob([fs.readFileSync(mp4)]), 'mi video.mp4');
    const r = await fetch('http://127.0.0.1:' + servidor.address().port + '/encolar', { method: 'POST', body: fd });
    const cuerpo = await r.json();
    assert.equal(r.status, 200, JSON.stringify(cuerpo));
    const esperado = path.join(raiz, 'tmp', 'uploads');
    assert.equal(dirUploads(), esperado);
    assert.equal(path.dirname(cuerpo.origen.ruta), esperado);
    assert.ok(fs.existsSync(cuerpo.origen.ruta));

    const viejo = path.join(esperado, 'up-12345678-1234-1234-1234-123456789012.mp4');
    fs.writeFileSync(viejo, 'x');
    const hace = new Date(Date.now() - 100 * 3600e3);
    fs.utimesSync(viejo, hace, hace);
    assert.equal(await purgarUploads({ ttlMs: 48 * 3600e3 }), 1, 'la purga trabaja en la carpeta de respaldo');

    await borrarUpload(cuerpo.origen.ruta);
    assert.ok(!fs.existsSync(cuerpo.origen.ruta), 'borrarUpload acepta la carpeta de respaldo');
    const fuera = path.join(raiz, 'importante.txt');
    fs.writeFileSync(fuera, 'x');
    await borrarUpload(fuera);
    assert.ok(fs.existsSync(fuera), 'y sigue sin borrar nada fuera de las carpetas de subidas');

    const j = await fetch('http://127.0.0.1:' + servidor.address().port + '/encolar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://youtu.be/abcdefghijk' }) });
    assert.equal((await j.json()).origen.tipo, 'url', 'el flujo con enlace no se ve afectado');
  } finally { servidor.close(); }
});
