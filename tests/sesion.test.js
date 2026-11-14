import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-sesion-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.SESSION_DIR = path.join(raiz, 'datos');
process.env.SESSION_KEY = 'clave-de-prueba-que-no-es-real';
process.env.YTDLP_PATH = fileURLToPath(new URL('./fixtures/yt-dlp-falso.sh', import.meta.url));
process.env.FAKE_COUNT = path.join(raiz, 'contador');
process.env.LOG_LEVEL = 'error';

const cookies = await import('../src/sesion/cookies.js');
const almacen = await import('../src/sesion/almacen.js');
const gestor = await import('../src/sesion/gestor.js');
const { descargarVideo } = await import('../src/engine/download.js');

const NETSCAPE = [
  '# Netscape HTTP Cookie File',
  '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t4102444800\t__Secure-1PSID\tVALOR_SECRETO_1',
  '.youtube.com\tTRUE\t/\tTRUE\t4102444800\tLOGIN_INFO\tVALOR_SECRETO_2',
  '.google.com\tTRUE\t/\tTRUE\t4102444800\tSID\tVALOR_SECRETO_3',
  '.example.com\tTRUE\t/\tFALSE\t0\tajeno\tNO_DEBE_GUARDARSE',
].join('\n');

const relevantes = () => cookies.normalizar(cookies.filtrarRelevantes(cookies.parsearCookies(NETSCAPE)));

test.after(async () => {
  await fs.rm(raiz, { recursive: true, force: true });
});

test('parsea Netscape, descarta dominios ajenos y resume sin exponer valores', () => {
  assert.equal(cookies.parsearCookies(NETSCAPE).length, 4);
  const lista = relevantes();
  assert.equal(lista.length, 3);
  const resumen = cookies.resumir(lista);
  assert.equal(resumen.autenticada, true);
  assert.equal(resumen.vencida, false);
  assert.ok(!JSON.stringify(resumen).includes('VALOR_SECRETO'));
});

test('acepta el JSON exportado por extensiones del navegador', () => {
  const json = JSON.stringify([
    { name: '__Secure-1PSID', value: 'abc', domain: '.youtube.com', path: '/', secure: true, httpOnly: true, expirationDate: 4102444800 },
  ]);
  const lista = cookies.parsearCookies(json);
  assert.equal(lista[0].nombre, '__Secure-1PSID');
  assert.equal(lista[0].httpOnly, true);
  assert.throws(() => cookies.parsearCookies('texto sin cookies'), /No se reconocio/);
});

test('serializar y volver a parsear conserva HttpOnly y valores', () => {
  const ida = cookies.serializar(relevantes());
  const vuelta = cookies.normalizar(cookies.parsearNetscape(ida));
  assert.deepEqual(vuelta, relevantes());
  assert.ok(ida.includes('#HttpOnly_.youtube.com'));
});

test('el almacen cifra en disco y recupera el perfil', async () => {
  await almacen.guardarPerfil({ cookies: cookies.serializar(relevantes()) });
  const { dir } = await almacen.infoAlmacen();
  const crudo = await fs.readFile(path.join(dir, 'perfil.enc'), 'utf8');
  assert.ok(!crudo.includes('VALOR_SECRETO'));
  const perfil = await almacen.leerPerfil();
  assert.ok(perfil.cookies.includes('VALOR_SECRETO_1'));
});

test('importar guarda la sesion y persiste las cookies que yt-dlp rota', async () => {
  process.env.FAKE_MODE = 'ok';
  await gestor.borrar();
  await gestor.importar(NETSCAPE);
  await gestor.esperarInactivo();

  const estado = await gestor.obtenerEstado();
  assert.equal(estado.estado, 'activa');
  assert.equal(estado.tienePerfil, true);
  assert.ok(!JSON.stringify(estado).includes('VALOR_SECRETO'));

  const perfil = await almacen.leerPerfil();
  assert.ok(perfil.cookies.includes('ROTADA'), 'la cookie renovada debe quedar guardada');
  const sobrantes = await fs.readdir(path.join(process.env.TMP_DIR, 'sesion'));
  assert.equal(sobrantes.length, 0, 'no deben quedar cookies descifradas en disco');
});

test('un bloqueo anti-bot deja la sesion como bloqueada', async () => {
  process.env.FAKE_MODE = 'bot';
  const estado = await gestor.verificar({ motivo: 'prueba' });
  assert.equal(estado.estado, 'bloqueada');
});

test('descargarVideo renueva la sesion y reintenta una vez ante anti-bot', async () => {
  process.env.FAKE_MODE = 'botuna';
  await fs.rm(process.env.FAKE_COUNT, { force: true });
  const video = await descargarVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ', path.join(raiz, 'descarga'));
  assert.equal(video.id, 'vid123');
  await fs.access(process.env.FAKE_COUNT);
});

test('sin sesion y con bloqueo persistente no reintenta y pide importar cookies', async () => {
  process.env.FAKE_MODE = 'bot';
  await gestor.borrar();
  await assert.rejects(
    descargarVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ', path.join(raiz, 'descarga2')),
    /Importa cookies/
  );
});

test('rechaza cookies sin login o ajenas a YouTube', async () => {
  await assert.rejects(gestor.importar('.example.com\tTRUE\t/\tFALSE\t0\tx\ty'), /no tiene cookies de YouTube/);
  await assert.rejects(
    gestor.importar('.youtube.com\tTRUE\t/\tFALSE\t0\tPREF\tf1=1'),
    /Faltan las cookies de inicio de sesion/
  );
});
