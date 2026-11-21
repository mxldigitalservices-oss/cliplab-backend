import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cliplab-ajustes-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.SESSION_DIR = path.join(raiz, 'sesion');
process.env.UPLOADS_DIR = path.join(raiz, 'uploads');
process.env.MASTER_KEY = 'llave-de-prueba';
process.env.LOG_LEVEL = 'error';
process.env.LOGO_ENABLED = 'false';        // sin marca Klikap: asi las pruebas miden solo los ajustes
process.env.VIDEO_PRESET = 'ultrafast';

const A = await import('../src/ajustes.js');
const { guardarLogo, rutaLogo } = await import('../src/logos.js');
const { renderizarClip } = await import('../src/engine/render.js');
const { createApp } = await import('../src/app.js');
const { detenerCola, trabajosPendientes } = await import('../src/engine/cola.js');
const { store } = await import('../src/storage/store.js');

detenerCola();   // las rutas solo encolan: el pipeline real no corre en estas pruebas

const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const duracion = (f, sel = 'format=duration') => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', sel, '-of', 'csv=p=0', f]).toString().split('\n')[0]);
const pixel = (f, t, x, y) => {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', f, '-vf', `crop=2:2:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  return { r: b[0], g: b[1], b: b[2] };
};
const rojo = (p) => p.r > 180 && p.g < 80 && p.b < 80;
const azul = (p) => p.b > 180 && p.r < 80 && p.g < 80;

// Fuente vertical 360x640: mitad izquierda ROJA, derecha AZUL (el recorte 9:16 es exacto: no pierde ningun lado).
const fuente = path.join(raiz, 'fuente.mp4');
ff(['-f', 'lavfi', '-i', 'color=c=blue:s=360x640:d=6:r=10,drawbox=x=0:y=0:w=180:h=640:color=red:t=fill', '-f', 'lavfi', '-i', 'sine=f=440:d=6',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', fuente]);
// Logo de prueba: cuadrado verde sobre fondo blanco liso.
const logoPng = path.join(raiz, 'logo.png');
ff(['-f', 'lavfi', '-i', 'color=c=white:s=200x200,drawbox=x=40:y=40:w=120:h=120:color=lime:t=fill', '-frames:v', '1', logoPng]);

const servidor = createApp().listen(0, '127.0.0.1');
await new Promise((ok) => servidor.once('listening', ok));
const BASE = 'http://127.0.0.1:' + servidor.address().port;
const AUTH = { 'x-master-key': 'llave-de-prueba' };
test.after(() => { servidor.close(); fs.rmSync(raiz, { recursive: true, force: true }); });

/* ---------- Validacion y filtros (puros) ---------- */

test('sanearAjustes: neutro => null; valores del catalogo se normalizan; JSON como texto (multipart) funciona', () => {
  assert.equal(A.sanearAjustes(undefined), null);
  assert.equal(A.sanearAjustes({}), null);
  assert.equal(A.sanearAjustes('{"velocidad":1,"tono":0}'), null);
  const a = A.sanearAjustes('{"velocidad":"1.25","tono":1,"color":"Calido","espejo":"true","encuadre":"CENTRADO"}');
  assert.deepEqual(a, { velocidad: 1.25, tono: 1, color: 'calido', encuadre: 'centrado', espejo: true, logo: null });
  assert.deepEqual(A.resumen(a), ['1.25x', 'Tono +1', 'Color calido', 'Encuadre centrado', 'Espejo']);
});

test('sanearAjustes: rechaza lo que no esta en el catalogo (400) y acota posicion/tamano del logo', () => {
  for (const malo of [{ velocidad: 3 }, { velocidad: 1.3 }, { tono: 5 }, { color: 'rosa' }, { encuadre: 'zoom' }, '{roto', [], { logo: { id: '../etc/passwd' } }]) {
    assert.throws(() => A.sanearAjustes(malo), (e) => e instanceof A.ErrorAjustes && e.status === 400, JSON.stringify(malo));
  }
  const l = A.sanearAjustes({ logo: { id: 'logo_0123456789abcdef', x: 7, y: -3, escala: 0.9, recorteFondo: 'true' } }).logo;
  assert.deepEqual(l, { id: 'logo_0123456789abcdef', recorteFondo: true, x: 1, y: 0, escala: 0.6 });
});

test('filtros: espejo y color antes de logo/subtitulos; audio: atempo = velocidad / factor de tono', () => {
  assert.equal(A.filtroImagen({ espejo: true, color: 'bn' }), 'hflip,hue=s=0');
  assert.equal(A.filtroImagen({ espejo: false, color: 'normal' }), '');
  assert.equal(A.filtroVelocidadVideo({ velocidad: 1.25 }), 'setpts=PTS/1.25');
  assert.equal(A.filtroAudio({ velocidad: 1, tono: 0 }), '');
  assert.equal(A.filtroAudio({ velocidad: 1.25, tono: 0 }), 'atempo=1.25000');
  for (const v of A.VELOCIDADES) for (const t of A.TONOS) {
    const m = /atempo=([\d.]+)/.exec(A.filtroAudio({ velocidad: v, tono: t }) || 'atempo=1');
    assert.ok(Number(m[1]) >= 0.5 && Number(m[1]) <= 2, `atempo fuera de rango para ${v}x tono ${t}`);
  }
});

/* ---------- Render real con FFmpeg ---------- */

test('render: velocidad 1.5x acorta video y audio por igual y deja 1080x1920', async () => {
  const salida = path.join(raiz, 'vel.mp4');
  const r = await renderizarClip({ entrada: fuente, salida, inicio: 0, duracion: 6, modo: 'recorte', ajustes: { velocidad: 1.5 } });
  assert.deepEqual([r.ancho, r.alto], [1080, 1920]);
  assert.ok(Math.abs(duracion(salida, 'stream=duration') - 4) < 0.15, 'duracion ' + duracion(salida));
  assert.ok(Math.abs(r.duracion - 4) < 0.15);
  assert.equal(r.ajustes.velocidad, 1.5);
});

test('render: espejo voltea la imagen; color bn la deja en grises', async () => {
  const normal = path.join(raiz, 'normal.mp4');
  const espejo = path.join(raiz, 'espejo.mp4');
  const bn = path.join(raiz, 'bn.mp4');
  await renderizarClip({ entrada: fuente, salida: normal, inicio: 0, duracion: 3, modo: 'recorte' });
  await renderizarClip({ entrada: fuente, salida: espejo, inicio: 0, duracion: 3, modo: 'recorte', ajustes: { espejo: true } });
  await renderizarClip({ entrada: fuente, salida: bn, inicio: 0, duracion: 3, modo: 'recorte', ajustes: { color: 'bn' } });
  assert.ok(rojo(pixel(normal, 1, 100, 900)) && azul(pixel(normal, 1, 980, 900)), 'sin ajustes: rojo a la izquierda');
  assert.ok(azul(pixel(espejo, 1, 100, 900)) && rojo(pixel(espejo, 1, 980, 900)), 'espejo: rojo a la derecha');
  const g = pixel(bn, 1, 100, 900);
  assert.ok(Math.abs(g.r - g.g) < 8 && Math.abs(g.g - g.b) < 8, 'bn: gris ' + JSON.stringify(g));
});

test('render: el tono cambia el audio sin cambiar la duracion; con cortes y velocidad la duracion sigue siendo la real', async () => {
  const tono = path.join(raiz, 'tono.mp4');
  await renderizarClip({ entrada: fuente, salida: tono, inicio: 0, duracion: 4, modo: 'recorte', ajustes: { tono: 2 } });
  assert.ok(Math.abs(duracion(tono, 'stream=duration') - 4) < 0.1);

  const cortes = [{ desde: 0, hasta: 2, plano: 'medio' }, { desde: 2, hasta: 5, plano: 'cerrado' }];
  const salida = path.join(raiz, 'cortes.mp4');
  await renderizarClip({ entrada: fuente, salida, inicio: 0, duracion: 6, modo: 'recorte', cortes, ajustes: { velocidad: 1.25, tono: -1, espejo: true } });
  assert.ok(Math.abs(duracion(salida) - 4) < 0.15, 'duracion ' + duracion(salida));
  assert.ok(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', salida]).toString().includes('aac'));
});

test('render: encuadre "amplio" usa fondo desenfocado y "centrado" no sigue rostros; ambos salen 1080x1920', async () => {
  for (const encuadre of ['amplio', 'centrado']) {
    const r = await renderizarClip({
      entrada: fuente, salida: path.join(raiz, encuadre + '.mp4'), inicio: 0, duracion: 3, modo: 'recorte',
      cortes: [{ desde: 0, hasta: 3, plano: 'medio' }], ajustes: { encuadre },
    });
    assert.deepEqual([r.ancho, r.alto], [1080, 1920], encuadre);
    assert.equal(r.analisis[0].sujeto, null, 'sin analisis de rostro');
  }
});

/* ---------- Logos ---------- */

test('logo: se valida el contenido, se detecta el fondo liso y la copia "sin fondo" queda transparente', async () => {
  const logo = await guardarLogo(fs.readFileSync(logoPng));
  assert.match(logo.id, /^logo_[0-9a-f]{16}$/);
  assert.deepEqual([logo.fondoDetectado, logo.fondoColor, logo.conAlfa], [true, '#ffffff', false]);
  assert.ok(await rutaLogo(logo.id, true), 'existe la copia sin fondo');
  const esquina = execFileSync('ffmpeg', ['-v', 'error', '-i', await rutaLogo(logo.id, true), '-vf', 'crop=2:2:0:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
  assert.ok(esquina[3] < 16, 'esquina transparente');
  assert.equal(await rutaLogo('../x', false), null);
  await assert.rejects(guardarLogo(Buffer.from('esto no es una imagen')), /PNG, JPG o WebP/);
  await assert.rejects(guardarLogo(Buffer.alloc(0)), /Falta la imagen/);
});

test('logo: una foto con fondo irregular no ofrece recorte; un PNG ya transparente tampoco lo necesita', async () => {
  const ruido = path.join(raiz, 'ruido.png');
  ff(['-f', 'lavfi', '-i', 'testsrc=size=160x160:rate=1', '-frames:v', '1', ruido]);
  const a = await guardarLogo(fs.readFileSync(ruido));
  assert.deepEqual([a.fondoDetectado, a.conAlfa], [false, false]);
  assert.equal(await rutaLogo(a.id, true), null);

  const alfa = path.join(raiz, 'alfa.png');
  ff(['-f', 'lavfi', '-i', 'color=c=red@0.0:s=100x100,format=rgba,drawbox=x=30:y=30:w=40:h=40:color=red@1.0:t=fill', '-frames:v', '1', alfa]);
  const b = await guardarLogo(fs.readFileSync(alfa));
  assert.equal(b.conAlfa, true);
});

test('render: logo propio sin fondo en el centro (el fondo blanco no tapa el video); con posicion distinta cambia de sitio', async () => {
  const logo = await guardarLogo(fs.readFileSync(logoPng));
  const centro = path.join(raiz, 'logo-centro.mp4');
  const r = await renderizarClip({
    entrada: fuente, salida: centro, inicio: 0, duracion: 3, modo: 'recorte',
    ajustes: { logo: { id: logo.id, recorteFondo: true, x: 0.5, y: 0.5, escala: 0.4 } },
  });
  assert.equal(r.conLogoPropio, true);
  const verde = pixel(centro, 1, 540, 960);
  assert.ok(verde.g > 180 && verde.r < 100 && verde.b < 100, 'logo verde al centro ' + JSON.stringify(verde));
  // Esquina del cuadro del logo (fondo blanco): con "sin fondo" se ve el video (rojo), no blanco.
  const borde = pixel(centro, 1, 540 - 216 + 10, 960 - 216 + 10);
  assert.ok(rojo(borde), 'el fondo blanco se quito: ' + JSON.stringify(borde));

  const arriba = path.join(raiz, 'logo-arriba.mp4');
  await renderizarClip({ entrada: fuente, salida: arriba, inicio: 0, duracion: 3, modo: 'recorte', ajustes: { logo: { id: logo.id, recorteFondo: false, x: 0.5, y: 0.1, escala: 0.4 } } });
  assert.ok(pixel(arriba, 1, 540, 192).g > 180, 'logo arriba');
  assert.ok(!(pixel(arriba, 1, 540, 960).g > 180), 'ya no esta al centro');
});

test('render: si el logo ya no existe el clip sale igual, sin logo', async () => {
  const r = await renderizarClip({
    entrada: fuente, salida: path.join(raiz, 'sin-logo.mp4'), inicio: 0, duracion: 2, modo: 'recorte',
    ajustes: { logo: { id: 'logo_ffffffffffffffff', x: 0.5, y: 0.5, escala: 0.3 } },
  });
  assert.equal(r.conLogoPropio, false);
});

/* ---------- Rutas ---------- */

async function subirLogo(archivo = logoPng, cabeceras = AUTH) {
  const fd = new FormData();
  fd.append('logo', new Blob([fs.readFileSync(archivo)]), 'logo.png');
  const r = await fetch(BASE + '/api/panel/logo', { method: 'POST', headers: cabeceras, body: fd });
  return { status: r.status, cuerpo: await r.json() };
}
const post = async (ruta, cuerpo) => {
  const r = await fetch(BASE + ruta, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
  return { status: r.status, cuerpo: await r.json() };
};

test('POST /api/panel/logo exige llave, valida la imagen y GET devuelve el PNG', async () => {
  assert.equal((await subirLogo(logoPng, {})).status, 401);
  const ok = await subirLogo();
  assert.equal(ok.status, 201);
  assert.equal(ok.cuerpo.data.logo.fondoDetectado, true);
  const texto = path.join(raiz, 'falso.png');
  fs.writeFileSync(texto, 'no soy una imagen');
  const malo = await subirLogo(texto);
  assert.equal(malo.status, 400);
  assert.match(malo.cuerpo.error, /imagen/);

  const id = ok.cuerpo.data.logo.id;
  const img = await fetch(BASE + '/api/panel/logo/' + id + '?sinFondo=1', { headers: AUTH });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(BASE + '/api/panel/logo/logo_ffffffffffffffff', { headers: AUTH })).status, 404);
  assert.equal((await fetch(BASE + '/api/panel/logo/' + id, { headers: AUTH })).status, 200);
});

test('POST /encolar: ajustes validos viajan al trabajo y al clip; invalidos => 400', async () => {
  const YT = 'https://www.youtube.com/watch?v=abcdefghijk';
  const bien = await post('/api/panel/encolar', { url: YT, ajustes: { velocidad: 1.2, espejo: true, tono: -1 } });
  assert.equal(bien.status, 201);
  assert.deepEqual(bien.cuerpo.data.clip.ajustes, { velocidad: 1.2, tono: -1, color: 'normal', encuadre: 'auto', espejo: true, logo: null });
  const trabajo = trabajosPendientes().find((t) => t.id === bien.cuerpo.data.clip.id);
  assert.equal(trabajo.ajustes.velocidad, 1.2);

  const sin = await post('/api/panel/encolar', { url: YT });
  assert.equal(sin.cuerpo.data.clip.ajustes, undefined, 'sin ajustes no se guarda nada');

  const malo = await post('/api/panel/encolar', { url: YT, ajustes: { velocidad: 9 } });
  assert.equal(malo.status, 400);
  assert.match(malo.cuerpo.error, /Velocidad/);
});

test('POST /lote/aplicar: encola una variante por clip listo con sus ajustes y explica los omitidos', async () => {
  const YT = 'https://www.youtube.com/watch?v=abcdefghijk';
  const listo = store.encolar(YT, { origen: 'url' });
  store.completar(listo.id, { url: '/clips/a.mp4', segmento: { indice: 1, total: 4, inicio: 12.5, duracion: 41 }, modo: 'blur', duracion: 41 });
  const enProceso = store.encolar(YT, { origen: 'url' });
  const subido = store.encolar('mi video.mp4', { origen: 'archivo' });
  store.completar(subido.id, { url: '/clips/b.mp4', segmento: { indice: 1, total: 1, inicio: 0, duracion: 30 } });

  const r = await post('/api/panel/lote/aplicar', { ids: [listo.id, enProceso.id, subido.id, 'clip_noexiste', listo.id], ajustes: { velocidad: 1.1, espejo: true } });
  assert.equal(r.status, 201);
  assert.equal(r.cuerpo.data.encolados.length, 1, 'ids repetidos cuentan una vez');
  assert.deepEqual(r.cuerpo.data.ajustes, ['1.1x', 'Espejo']);
  assert.deepEqual(r.cuerpo.data.omitidos.map((o) => o.id).sort(), [enProceso.id, subido.id, 'clip_noexiste'].sort());
  assert.ok(r.cuerpo.data.omitidos.find((o) => o.id === subido.id).motivo.includes('subido'));

  const nuevo = store.buscar(r.cuerpo.data.encolados[0].id);
  assert.equal(nuevo.varianteDe, listo.id);
  assert.equal(nuevo.ajustes.espejo, true);
  const trabajo = trabajosPendientes().find((t) => t.id === nuevo.id);
  assert.deepEqual([trabajo.auto, trabajo.inicio, trabajo.duracion, trabajo.modo, trabajo.url], [false, 12.5, 41, 'blur', YT]);
  assert.equal(trabajo.ajustes.velocidad, 1.1);

  assert.equal((await post('/api/panel/lote/aplicar', { ids: [], ajustes: { espejo: true } })).status, 400);
  assert.equal((await post('/api/panel/lote/aplicar', { ids: [listo.id], ajustes: {} })).status, 400);
  assert.equal((await post('/api/panel/lote/aplicar', { ids: [listo.id], ajustes: { tono: 9 } })).status, 400);
});
