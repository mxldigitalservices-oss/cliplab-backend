import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplab-series-'));
process.env.TMP_DIR = path.join(raiz, 'tmp');
process.env.DATA_DIR = path.join(raiz, 'datos');
process.env.SESSION_DIR = path.join(raiz, 'sesion');
process.env.LOG_LEVEL = 'error';
test.after(() => fs.rm(raiz, { recursive: true, force: true }));

const { planificarSerie, metadatosSerie, procesarSerie } = await import('../src/services/storySeriesEngine.js');
const { crearColaSeries } = await import('../src/services/seriesQueue.js');

// Habla sintetica: frases de `n` palabras (0.4 s cada una) separadas por 0.6 s, terminadas en punto.
function hablar(frases, { n = 8, dur = 0.4, gapPalabra = 0.05, gapFrase = 0.6, inicio = 0.5 } = {}) {
  const palabras = [];
  let t = inicio;
  for (let f = 0; f < frases; f++) {
    for (let i = 0; i < n; i++) {
      palabras.push({ texto: 'palabra' + f + 'x' + i + (i === n - 1 ? '.' : ''), inicio: +t.toFixed(3), fin: +(t + dur).toFixed(3) });
      t += dur + (i === n - 1 ? gapFrase : gapPalabra);
    }
  }
  return { palabras, fin: t };
}

test('plan: episodios de 60 s exactos, cortes en final de frase, sin perder palabras', () => {
  const { palabras, fin } = hablar(75);   // ~4.6 min de voz
  const plan = planificarSerie({ palabras, duracionVideo: Math.ceil(fin) + 2 });
  assert.ok(plan.episodios.length >= 4, 'partes: ' + plan.episodios.length);
  const finesFrase = palabras.filter((p) => p.texto.endsWith('.')).map((p) => p.fin);
  for (const ep of plan.episodios) {
    assert.ok(Math.abs(ep.contenido + ep.relleno - 60) < 0.002 || ep.relleno === 0, 'contenido + relleno = 60');
    assert.ok(ep.contenido <= 60.001, 'nunca pasa de 60 s');
    if (!ep.ultimo) {
      assert.equal(ep.tipoCorte, 'frase');
      assert.equal(ep.corteLimpio, true);
      assert.ok(ep.relleno <= 6.001, 'relleno dentro de la tolerancia: ' + ep.relleno);
      assert.ok(finesFrase.some((f) => ep.fin >= f && ep.fin - f <= 0.26), 'termina justo despues de un final de frase');
    }
  }
  // continuidad: ninguna palabra queda fuera de todos los episodios, ni a la mitad de un corte
  for (const w of palabras) {
    const dentro = plan.episodios.some((ep) => w.inicio >= ep.inicio - 0.001 && w.fin <= ep.fin + 0.001);
    const omitida = plan.omitido && w.inicio >= plan.omitido.desde - 0.001;
    assert.ok(dentro || omitida, 'palabra perdida o cortada: ' + w.texto + ' @' + w.inicio);
  }
  for (let i = 1; i < plan.episodios.length; i++) assert.ok(plan.episodios[i].inicio >= plan.episodios[i - 1].fin - 0.001, 'sin solape');
  assert.equal(plan.episodios.at(-1).ultimo, true);
  assert.deepEqual(plan.episodios.map((e) => e.parte), plan.episodios.map((_, i) => i + 1));
});

test('plan: el sobrante final menor a 20 s no se convierte en episodio (queda registrado como omitido)', () => {
  const { palabras } = hablar(40);   // ~2.4 min
  const finVoz = palabras.at(-1).fin;
  const plan = planificarSerie({ palabras, duracionVideo: finVoz + 1, minUltimo: 200 });
  assert.ok(plan.omitido && plan.omitido.segundos > 0);
  assert.ok(plan.episodios.at(-1).fin <= plan.omitido.desde + 0.001);
});

test('plan: sin ninguna frase que cierre dentro de la tolerancia, corta "duro" a los 60 s y lo marca', () => {
  const { palabras, fin } = hablar(40, { n: 8, gapFrase: 0.05 });   // voz continua: sin pausas ni frases cortas utiles
  const plan = planificarSerie({ palabras, duracionVideo: fin + 1, maxRelleno: 0.05 });
  const duros = plan.episodios.filter((e) => e.tipoCorte === 'duro');
  assert.ok(duros.length >= 1);
  for (const d of duros) { assert.equal(d.corteLimpio, false); assert.equal(d.relleno, 0); assert.ok(Math.abs(d.contenido - 60) < 0.01); }
});

test('plan: video sin voz -> ventanas fijas de 60 s', () => {
  const plan = planificarSerie({ palabras: [], duracionVideo: 190 });   // 60 + 60 + 60 + 10 s sobrantes (menos de 20 s: se omiten)
  assert.equal(plan.sinVoz, true);
  assert.equal(plan.episodios.length, 3);
  assert.equal(plan.omitido.segundos, 10);
  assert.ok(plan.episodios.every((e) => e.corteLimpio === false));
  assert.throws(() => planificarSerie({ palabras: [], duracionVideo: 0 }), (e) => e.codigo === 'SIN_DURACION');
});

test('metadatos: Parte N/T — Titulo | Sigue para la Parte N+1 (la ultima cierra la serie)', () => {
  const { palabras, fin } = hablar(60);
  const plan = planificarSerie({ palabras, duracionVideo: fin + 1 });
  const meta = metadatosSerie({ titulo: '  La   casa del   lago ', episodios: plan.episodios, serieId: 'serie_t1' });
  const t = plan.episodios.length;
  assert.equal(meta[0].caption_con_gancho, 'Parte 1/' + t + ' — La casa del lago | Sigue para la Parte 2');
  assert.equal(meta.at(-1).caption_con_gancho, 'Parte ' + t + '/' + t + ' — La casa del lago | Fin de la serie');
  assert.ok(meta.every((m) => m.series_id === 'serie_t1' && m.total_parts === t));
  assert.deepEqual(meta.map((m) => m.part_number), plan.episodios.map((e) => e.parte));
  assert.ok(meta[0].caption.startsWith(meta[0].caption_con_gancho));
  assert.ok(meta[0].caption.includes('#serie'));
});

// ---- procesarSerie con dobles (sin ffmpeg, whisper ni red) ----
function almacenFalso() {
  const clips = new Map();
  let n = 0;
  const nuevo = (extra = {}) => { const c = { id: 'clip_' + (++n), estado: 'procesando', ...extra }; clips.set(c.id, c); return c; };
  return {
    clips,
    sembrar: () => nuevo(),
    actualizar: (id, p) => Object.assign(clips.get(id), p),
    buscar: (id) => clips.get(id),
    crearHijo: (_, campos) => nuevo(campos),
    completar: (id, p) => Object.assign(clips.get(id), p, { estado: 'listo' }),
    fallar: (id, msg) => Object.assign(clips.get(id), { estado: 'error', error: msg }),
    registrarIncidencia: () => {},
  };
}

async function escenario({ falla = null, publicar = false } = {}) {
  const dir = await fs.mkdtemp(path.join(raiz, 'e-'));
  const clipsDir = path.join(dir, 'clips');
  const dirTrabajo = path.join(dir, 'job');
  await fs.mkdir(clipsDir, { recursive: true });
  await fs.mkdir(dirTrabajo, { recursive: true });
  const almacen = almacenFalso();
  const base = almacen.sembrar();
  const { palabras, fin } = hablar(75);
  const llamadas = [];
  const encoladas = [];
  const r = { dir, clipsDir, dirTrabajo, almacen, base, llamadas, encoladas };
  r.ejecutar = () => procesarSerie({
    trabajo: { id: base.id, serie: { titulo: 'Mi historia', publicarInstagram: publicar } },
    video: { id: 'v1', titulo: 'video largo', archivo: path.join(dir, 'fuente.mp4'), duracion: Math.ceil(fin) + 2 },
    dirTrabajo, transcribir: async () => palabras, almacen, clipsDir,
    perfiles: async (_, n) => Array.from({ length: n }, () => ({ estilo: null, modo: 'recorte' })),
    cola: { encolarSerie: (x) => { encoladas.push(x); return { partes: x.episodios.length }; } },
    renderizar: async (o) => {
      llamadas.push(o);
      if (falla && llamadas.length === falla) throw new Error('ffmpeg exploto');
      await fs.writeFile(o.salida, 'mp4');
      return { archivo: o.salida, bytes: 4, duracion: 60, ancho: 1080, alto: 1920, conLogo: false };
    },
  });
  return r;
}

test('procesarSerie: renderiza cada episodio a 60 s exactos, registra metadatos y limpia temporales', async () => {
  const e = await escenario({ publicar: true });
  const r = await e.ejecutar();
  assert.ok(r.partes >= 4);
  assert.equal(e.llamadas.length, r.partes);
  for (const l of e.llamadas) {
    assert.equal(l.duracionExacta, 60);
    assert.ok(l.duracion <= 60.001 && l.duracion >= 20);
    assert.deepEqual(l.cortes, [{ desde: 0, hasta: l.duracion, plano: 'medio' }]);
  }
  const clips = [...e.almacen.clips.values()].sort((a, b) => a.serie.part_number - b.serie.part_number);
  assert.equal(clips.length, r.partes);
  assert.ok(clips.every((c) => c.estado === 'listo' && c.duracion === 60 && c.serie.series_id === r.serieId));
  assert.match(clips[0].marketing.descripcion, /^Parte 1\/\d+ — Mi historia \| Sigue para la Parte 2/);
  const sobrantes = await fs.readdir(e.dirTrabajo);
  assert.deepEqual(sobrantes, [], 'no quedan carpetas de episodio en el temporal del trabajo');
  // entrega a la cola ordenada de publicacion
  assert.equal(e.encoladas.length, 1);
  assert.deepEqual(e.encoladas[0].episodios.map((x) => x.parte), clips.map((c) => c.serie.part_number));
  assert.ok(e.encoladas[0].episodios.every((x) => x.rutaVideo.startsWith(e.clipsDir) && x.caption.includes('Parte')));
});

test('procesarSerie: sin publicar no toca la cola de Instagram', async () => {
  const e = await escenario({ publicar: false });
  await e.ejecutar();
  assert.equal(e.encoladas.length, 0);
});

test('procesarSerie: si un episodio falla, todo o nada (se borran los renderizados y se marca la serie)', async () => {
  const e = await escenario({ falla: 3 });
  await assert.rejects(e.ejecutar(), /ffmpeg exploto/);
  assert.deepEqual(await fs.readdir(e.clipsDir), [], 'ningun mp4 huerfano');
  assert.deepEqual(await fs.readdir(e.dirTrabajo), []);
  assert.ok([...e.almacen.clips.values()].every((c) => c.estado === 'error' && /Serie cancelada/.test(c.error)));
  assert.equal(e.encoladas.length, 0);
});

test('procesarSerie: un video demasiado corto no es una serie', async () => {
  const dir = await fs.mkdtemp(path.join(raiz, 'c-'));
  const almacen = almacenFalso();
  const base = almacen.sembrar();
  const { palabras } = hablar(6);
  await assert.rejects(procesarSerie({
    trabajo: { id: base.id, serie: {} }, video: { id: 'v', titulo: 't', archivo: 'x', duracion: 40 }, dirTrabajo: dir,
    transcribir: async () => palabras, almacen, clipsDir: dir, perfiles: async () => [], cola: {}, renderizar: async () => ({}),
  }), (err) => err.codigo === 'SERIE_CORTA');
});

// ---- cola ordenada ----
function colaDe({ publicar, ahora, limpiados = [], config = {} }) {
  return crearColaSeries({
    rutaJson: path.join(raiz, 'q-' + Math.random().toString(36).slice(2) + '.json'), ahora, configurado: () => true, publicar,
    limpiar: async (x) => { limpiados.push(path.basename(x.rutaVideo)); }, almacen: { actualizar() {} },
    env: { SERIES_INTERVALO_MIN: '30', SERIES_MAX_DIA: '20', SERIES_MAX_INTENTOS: '3' }, config,
  });
}
const episodios = (n) => Array.from({ length: n }, (_, i) => ({ clipId: 'c' + (i + 1), parte: i + 1, total: n, rutaVideo: '/clips/p' + (i + 1) + '.mp4', caption: 'Parte ' + (i + 1) }));
const MIN = 60000;

test('cola: publica en orden, una por vez y respetando el espaciado entre publicaciones', async () => {
  let t = Date.parse('2026-01-01T10:00:00Z');
  const orden = [];
  const limpiados = [];
  const q = colaDe({ ahora: () => t, limpiados, publicar: async (it) => { orden.push(it.parte); return { mediaId: 'm' + it.parte }; } });
  q.encolarSerie({ serieId: 's1', titulo: 'T', episodios: episodios(3) });
  assert.equal((await q.tick()).estado, 'published');
  assert.equal((await q.tick()).motivo, 'espaciado');
  t += 29 * MIN;
  assert.equal((await q.tick()).motivo, 'espaciado');
  t += 2 * MIN;
  assert.equal((await q.tick()).estado, 'published');
  t += 31 * MIN;
  await q.tick();
  assert.deepEqual(orden, [1, 2, 3]);
  assert.deepEqual(limpiados, ['p1.mp4', 'p2.mp4', 'p3.mp4'], 'cada mp4 se borra tras publicarse');
  t += 31 * MIN;
  assert.equal((await q.tick()).motivo, 'vacia');
});

test('cola: un fallo permanente retiene las partes siguientes hasta reintentar', async () => {
  let t = Date.parse('2026-01-01T10:00:00Z');
  const orden = [];
  let romper = true;
  const q = colaDe({ ahora: () => t, publicar: async (it) => {
    if (it.parte === 2 && romper) { const e = new Error('video rechazado'); e.codigo = 'MEDIA_INVALIDA'; e.transitorio = false; throw e; }
    orden.push(it.parte); return { mediaId: 'm' };
  } });
  q.encolarSerie({ serieId: 's1', episodios: episodios(3) });
  await q.tick(); t += 31 * MIN;
  assert.equal((await q.tick()).estado, 'failed');
  t += 31 * MIN;
  assert.equal((await q.tick()).motivo, 'vacia', 'la Parte 3 NO sale mientras la 2 este caida');
  assert.deepEqual(orden, [1]);
  assert.equal(q.estado().series[0].retenida, true);
  const caida = q.listar().find((x) => x.estado === 'failed');
  romper = false;
  await q.reintentar(caida.id);
  await q.tick(); t += 31 * MIN; await q.tick();
  assert.deepEqual(orden, [1, 2, 3]);
});

test('cola: transitorios con backoff; los limites de Meta esperan 30 min y no gastan intentos', async () => {
  let t = Date.parse('2026-01-01T10:00:00Z');
  let modo = 'red';
  const q = colaDe({ ahora: () => t, publicar: async () => {
    const e = new Error('x'); e.transitorio = true; e.codigo = modo === 'red' ? 'RED' : 'LIMITE_API'; throw e;
  } });
  q.encolarSerie({ serieId: 's1', episodios: episodios(2) });
  await q.tick();
  let it = q.listar()[0];
  assert.equal(it.estado, 'queued'); assert.equal(it.intentos, 1);
  assert.ok(Date.parse(it.proximoIntento) - t >= 2 * MIN, 'backoff de 2 min o mas');
  t += 3 * MIN; await q.tick(); it = q.listar()[0];
  assert.equal(it.intentos, 2);
  t += 10 * MIN; await q.tick(); it = q.listar()[0];
  assert.equal(it.estado, 'failed', 'al tercer intento (SERIES_MAX_INTENTOS=3) se rinde');
  // limite de Meta: no cuenta
  const q2 = colaDe({ ahora: () => t, publicar: async () => { modo = 'limite'; const e = new Error('limite'); e.transitorio = true; e.codigo = 'LIMITE_API'; throw e; } });
  q2.encolarSerie({ serieId: 's2', episodios: episodios(1) });
  await q2.tick();
  const lim = q2.listar()[0];
  assert.equal(lim.estado, 'queued'); assert.equal(lim.intentos, 0);
  assert.ok(Date.parse(lim.proximoIntento) - t >= 30 * MIN);
});

test('cola: tope diario y series en orden de llegada', async () => {
  let t = Date.parse('2026-01-01T10:00:00Z');
  const orden = [];
  const q = crearColaSeries({
    rutaJson: path.join(raiz, 'q-tope.json'), ahora: () => t, configurado: () => true, almacen: { actualizar() {} }, limpiar: async () => {},
    publicar: async (it) => { orden.push(it.serieId + ':' + it.parte); return { mediaId: 'm' }; },
    env: { SERIES_INTERVALO_MIN: '0', SERIES_MAX_DIA: '3' },
  });
  q.encolarSerie({ serieId: 'A', episodios: episodios(2) });
  t += 1000;
  q.encolarSerie({ serieId: 'B', episodios: episodios(2) });
  for (let i = 0; i < 3; i++) { await q.tick(); t += 1000; }
  assert.deepEqual(orden, ['A:1', 'A:2', 'B:1']);
  assert.equal((await q.tick()).motivo, 'tope_diario');
  t += 25 * 60 * MIN;
  assert.equal((await q.tick()).estado, 'published');
  assert.equal(orden.at(-1), 'B:2');
});

test('cola: sin configuracion de Instagram espera; reinicio a mitad de publicacion NO reintenta solo', async () => {
  const ruta = path.join(raiz, 'q-reinicio.json');
  const q = crearColaSeries({ rutaJson: ruta, configurado: () => false, publicar: async () => ({}), almacen: { actualizar() {} }, limpiar: async () => {}, env: {} });
  q.encolarSerie({ serieId: 'X', episodios: episodios(1) });
  assert.equal((await q.tick()).motivo, 'sin_config');
  await new Promise((r) => setTimeout(r, 50));
  const guardado = JSON.parse(await fs.readFile(ruta, 'utf8'));
  guardado.items[0].estado = 'running';
  await fs.writeFile(ruta, JSON.stringify(guardado));
  const q2 = crearColaSeries({ rutaJson: ruta, configurado: () => true, publicar: async () => { throw new Error('no debe publicar'); }, almacen: { actualizar() {} }, limpiar: async () => {}, env: {} });
  await q2.cargar();
  const it = q2.listar()[0];
  assert.equal(it.estado, 'failed');
  assert.equal(it.ultimoError.codigo, 'INTERRUMPIDO');
  assert.equal(q2.rutasPendientes().size, 0);
});
