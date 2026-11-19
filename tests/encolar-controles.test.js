import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cliplab-controles-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.SESSION_DIR = path.join(raiz, 'datos');
process.env.UPLOADS_DIR = path.join(raiz, 'uploads');
process.env.MASTER_KEY = 'llave-de-prueba';
process.env.LOG_LEVEL = 'error';

const { createApp } = await import('../src/app.js');
const { detenerCola, trabajosPendientes } = await import('../src/engine/cola.js');
const { dirUploads } = await import('../src/upload.js');
const { store } = await import('../src/storage/store.js');

detenerCola();   // la ruta solo encola: el pipeline real (yt-dlp, transcripcion) no corre en estas pruebas

const servidor = createApp().listen(0, '127.0.0.1');
await new Promise((ok) => servidor.once('listening', ok));
const URL_ENCOLAR = 'http://127.0.0.1:' + servidor.address().port + '/api/panel/encolar';
const AUTH = { 'x-master-key': 'llave-de-prueba' };
const YT = 'https://www.youtube.com/watch?v=abcdefghijk';

const mp4 = path.join(raiz, 'v.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mp4]);

test.after(() => { servidor.close(); fs.rmSync(raiz, { recursive: true, force: true }); });

const subidos = () => (fs.existsSync(dirUploads()) ? fs.readdirSync(dirUploads()) : []);

async function enviarForm(campos, { archivo = mp4, nombre = 'mi video.mp4', cabeceras = AUTH } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.append(k, v);
  if (archivo) fd.append('archivo', new Blob([fs.readFileSync(archivo)]), nombre);
  const r = await fetch(URL_ENCOLAR, { method: 'POST', headers: cabeceras, body: fd });
  return { status: r.status, cuerpo: await r.json() };
}

async function enviarJson(cuerpo) {
  const r = await fetch(URL_ENCOLAR, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
  return { status: r.status, cuerpo: await r.json() };
}

test('enlace (JSON): instruccion y estiloSubtitulos llegan al clip y al trabajo', async () => {
  const { status, cuerpo } = await enviarJson({ url: YT, instruccion: '  hablan   de precios ', estiloSubtitulos: 'Clasico', modo: 'blur' });
  assert.equal(status, 201);
  const clip = cuerpo.data.clip;
  assert.equal(clip.origen, 'url');
  assert.equal(clip.instruccion, 'hablan de precios');
  assert.equal(clip.estiloSubtitulos, 'clasico');
  const trabajo = trabajosPendientes().find((t) => t.id === clip.id);
  assert.equal(trabajo.instruccion, 'hablan de precios');
  assert.equal(trabajo.estiloSubtitulos, 'clasico');
  assert.equal(trabajo.archivo, null);
  assert.equal(trabajo.modo, 'blur');
});

test('sin instruccion, estilo ni modo: rotan (el pipeline asignara cada clip) y la instruccion queda nula', async () => {
  const { status, cuerpo } = await enviarJson({ url: YT });
  assert.equal(status, 201);
  assert.equal(cuerpo.data.clip.instruccion, null);
  assert.equal(cuerpo.data.clip.estiloSubtitulos, null, 'aun sin estilo concreto: lo fija la rotacion al planificar los cortes');
  const trabajo = trabajosPendientes().find((t) => t.id === cuerpo.data.clip.id);
  assert.equal(trabajo.estiloSubtitulos, 'auto');
  assert.equal(trabajo.modo, 'auto');
});

test('estilo y modo en "auto" (cualquier capitalizacion) rotan igual que vacios', async () => {
  const { status, cuerpo } = await enviarJson({ url: YT, estiloSubtitulos: ' AUTO ', modo: 'Auto' });
  assert.equal(status, 201);
  assert.equal(cuerpo.data.clip.estiloSubtitulos, null);
  const trabajo = trabajosPendientes().find((t) => t.id === cuerpo.data.clip.id);
  assert.equal(trabajo.estiloSubtitulos, 'auto');
  assert.equal(trabajo.modo, 'auto');
});

test('estilo manual con modo en auto: el estilo se respeta y solo el modo rota', async () => {
  const { status, cuerpo } = await enviarJson({ url: YT, estiloSubtitulos: 'minimal', modo: 'auto' });
  assert.equal(status, 201);
  assert.equal(cuerpo.data.clip.estiloSubtitulos, 'minimal');
  const trabajo = trabajosPendientes().find((t) => t.id === cuerpo.data.clip.id);
  assert.equal(trabajo.estiloSubtitulos, 'minimal');
  assert.equal(trabajo.modo, 'auto');
});

test('modo invalido: 400 y el mensaje menciona auto', async () => {
  const { status, cuerpo } = await enviarJson({ url: YT, modo: 'zoom' });
  assert.equal(status, 400);
  assert.match(cuerpo.error, /recorte, blur o auto/);
});

test('archivo (multipart): se valida, se encola sin URL y conserva instruccion, estilo y cantidad', async () => {
  const { status, cuerpo } = await enviarForm({ modo: 'recorte', cantidad: '2', instruccion: 'ahorro', estiloSubtitulos: 'minimal' });
  assert.equal(status, 201);
  const clip = cuerpo.data.clip;
  assert.equal(clip.origen, 'archivo');
  assert.equal(clip.titulo, 'mi video.mp4');
  assert.equal(clip.estiloSubtitulos, 'minimal');
  const trabajo = trabajosPendientes().find((t) => t.id === clip.id);
  assert.equal(trabajo.url, null);
  assert.equal(trabajo.cantidad, 2);
  assert.equal(trabajo.instruccion, 'ahorro');
  assert.equal(trabajo.archivo.tipo, 'archivo');
  assert.ok(fs.existsSync(trabajo.archivo.ruta), 'el archivo queda en uploads esperando su turno');
  assert.ok(trabajo.archivo.duracion > 1);
  assert.ok(store.buscar(clip.id));
});

test('estilo invalido: 400 y el archivo recien subido se borra', async () => {
  const antes = subidos().length;
  const { status, cuerpo } = await enviarForm({ estiloSubtitulos: 'neon' });
  assert.equal(status, 400);
  assert.match(cuerpo.error, /dinamico, clasico, minimal/);
  assert.equal(subidos().length, antes);
});

test('enlace y archivo a la vez: 400 y no queda nada en disco', async () => {
  const antes = subidos().length;
  const { status, cuerpo } = await enviarForm({ url: YT });
  assert.equal(status, 400);
  assert.match(cuerpo.error, /no ambos/);
  assert.equal(subidos().length, antes);
});

test('ni enlace ni archivo: 400', async () => {
  const { status } = await enviarJson({ instruccion: 'algo' });
  assert.equal(status, 400);
});

test('enlace que no es de YouTube: 400', async () => {
  const { status } = await enviarJson({ url: 'https://example.com/video.mp4' });
  assert.equal(status, 400);
});

test('formato no permitido: 400', async () => {
  const antes = subidos().length;
  const { status, cuerpo } = await enviarForm({}, { nombre: 'notas.txt' });
  assert.equal(status, 400);
  assert.match(cuerpo.error, /mp4, mov, mkv o webm/);
  assert.equal(subidos().length, antes);
});

test('sin llave maestra: 401 antes de recibir el archivo', async () => {
  const antes = subidos().length;
  const { status } = await enviarForm({}, { cabeceras: {} });
  assert.equal(status, 401);
  assert.equal(subidos().length, antes);
});

test('un parametro invalido tras recibir el archivo tambien lo descarta', async () => {
  const antes = subidos().length;
  const { status } = await enviarForm({ cantidad: '99' });
  assert.equal(status, 400);
  assert.equal(subidos().length, antes);
});
