import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL = 'error';

const P = await import('../public/js/proyectos.js');
const { curarVideo, armarRevisionTecnica } = await import('../src/engine/curador.js');

// Clips con fichas REALES del curador (lo que el backend deja en clip.ficha), no inventadas.
const FRASES = [
  '¿Sabías que el error más caro en tu negocio es nunca medir los resultados?',
  'El primer paso de la estrategia es medir tus ventas cada semana con una herramienta simple.',
  'Un ejemplo claro: un cliente subió sus ingresos 40 por ciento con este método.',
  'La clave es aplicar el sistema todos los días sin excepción.',
];
const PLANAS = ['El clima de la ciudad estuvo bastante normal durante la tarde.', 'La gente caminaba por la calle principal sin mucha prisa.'];

function charla() {
  const palabras = [];
  let t = 0;
  for (let i = 0; i < 160; i++) {
    const caliente = (i >= 60 && i < 85) || (i >= 120 && i < 135);
    for (const w of (caliente ? FRASES[i % FRASES.length] : PLANAS[i % PLANAS.length]).split(' ')) {
      palabras.push({ texto: w, inicio: t, fin: t + 0.33 });
      t += 0.36;
    }
    t += 0.3;
  }
  return { palabras, duracion: Math.ceil(t) };
}

const { palabras, duracion } = charla();
const curado = curarVideo({ palabras, duracionVideo: duracion, tituloVideo: 'Charla de negocios' });
assert.ok(curado.clips.length >= 2, 'el curador debe devolver clips para la prueba');

function clipDe(c, i, extra = {}) {
  const ficha = { ...c.ficha, revisionTecnica: armarRevisionTecnica({ modo: 'recorte', duracion: c.duracion, resultado: { ancho: 1080, alto: 1920, duracion: c.duracion, conLogo: true }, palabras: 40 }) };
  return {
    id: 'clip_' + i, jobId: 'clip_0', titulo: 'Charla de negocios', fuente: 'https://youtu.be/abc',
    url: '/clips/' + i + '.mp4', estado: 'listo', duracion: c.duracion, inicio: c.inicio,
    transcripcion: 'texto del clip ' + i + ' sobre estrategia', ficha, marketing: null, copy: ficha.descripcion,
    creadoEn: '2026-11-18T10:0' + i + ':00.000Z', ...extra,
  };
}
const clips = curado.clips.map((c, i) => clipDe(c, i));

test('bloquesDe devuelve Gancho / Flujo / Valor / Interés con los puntajes del curador', () => {
  const b = P.bloquesDe(clips[0]);
  assert.deepEqual(b.map((x) => x.etiqueta), ['Gancho', 'Flujo', 'Valor', 'Interés']);
  assert.equal(b[0].puntaje, clips[0].ficha.gancho.puntaje);
  assert.equal(b[2].puntaje, clips[0].ficha.valor.puntaje);
  assert.ok(b.every((x) => ['alto', 'medio', 'bajo'].includes(x.nivel)));
});

test('un clip sin ficha (planificador) no rompe: puntajes nulos y nivel "sin"', () => {
  const sinFicha = { id: 'x', estado: 'listo', titulo: 'Solo titulo', copy: 'copy viejo' };
  assert.equal(P.puntajeDe(sinFicha), null);
  assert.equal(P.tituloDe(sinFicha), 'Solo titulo');
  assert.equal(P.descripcionDe(sinFicha), 'copy viejo');
  assert.ok(P.bloquesDe(sinFicha).every((b) => b.puntaje === null && b.nivel === 'sin'));
  assert.equal(P.revisionDe(sinFicha).estado, 'sin-datos');
});

test('revisionDe resume la revision tecnica verificada y marca alertas', () => {
  const r = P.revisionDe(clips[0]);
  assert.equal(r.estado, 'verificado');
  assert.equal(r.clase, 'ok');
  assert.ok(r.filas.some(([k, v]) => k === 'Resolución' && v.includes('1080x1920')));
  const mala = { ficha: { revisionTecnica: armarRevisionTecnica({ resultado: { ancho: 720, alto: 1280, duracion: 20 }, palabras: 0 }) } };
  const rm = P.revisionDe(mala);
  assert.equal(rm.clase, 'warn');
  assert.ok(rm.alertas.length >= 2);
});

test('agruparProyectos junta los clips por jobId con conteo, duracion y mejor puntaje', () => {
  const otro = clipDe(curado.clips[0], 9, { id: 'clip_9', jobId: 'clip_9', titulo: 'Otro video', creadoEn: '2026-11-18T11:00:00.000Z' });
  const procesando = clipDe(curado.clips[0], 8, { id: 'clip_8', jobId: 'clip_0', estado: 'procesando', url: null, duracion: null });
  const proyectos = P.agruparProyectos([...clips, procesando, otro]);
  assert.equal(proyectos.length, 2);
  assert.equal(proyectos[0].id, 'clip_9', 'el mas reciente primero');
  const p = proyectos[1];
  assert.equal(p.total, clips.length + 1);
  assert.equal(p.listos, clips.length);
  assert.equal(p.estado, 'procesando');
  assert.equal(p.mejorPuntaje, Math.max(...clips.map(P.puntajeDe)));
  assert.ok(Math.abs(p.duracionTotal - clips.reduce((s, c) => s + c.duracion, 0)) < 1e-9);
  assert.equal(p.miniatura.id, p.clips.find((c) => c.url).id);
  const inicios = p.clips.filter((c) => c.inicio !== undefined).map((c) => c.inicio);
  assert.deepEqual(inicios, [...inicios].sort((a, b) => a - b), 'clips en orden cronologico del video');
});

test('estado del proyecto: error cuando nada salio, parcial cuando hay mezcla', () => {
  assert.equal(P.agruparProyectos([{ id: 'a', jobId: 'a', estado: 'error', creadoEn: 'x' }])[0].estado, 'error');
  const mezcla = P.agruparProyectos([clips[0], { ...clips[1], estado: 'error' }])[0];
  assert.equal(mezcla.estado, 'parcial');
});

test('filtrarClipsFlujo: solo terminados, busqueda sin acentos, favoritos, orden y proyecto', () => {
  const todos = [...clips, { ...clips[0], id: 'c_proc', estado: 'procesando' }, clipDe(curado.clips[0], 7, { id: 'c_otro', jobId: 'otro' })];
  assert.equal(P.filtrarClipsFlujo(todos).every(P.esTerminado), true);
  assert.equal(P.filtrarClipsFlujo(todos, { texto: 'ESTRATEGIA' }).length, clips.length + 1);
  assert.equal(P.filtrarClipsFlujo(todos, { texto: 'estratégia' }).length, clips.length + 1, 'ignora acentos');
  assert.equal(P.filtrarClipsFlujo(todos, { texto: 'zzzz' }).length, 0);
  assert.equal(P.filtrarClipsFlujo(todos, { texto: 'estrategia', soloFavoritos: true, favoritos: [clips[1].id] }).length, 1);
  assert.equal(P.filtrarClipsFlujo(todos, { proyecto: 'otro' }).length, 1);
  const porPuntaje = P.filtrarClipsFlujo(clips, { orden: 'puntaje' }).map(P.puntajeDe);
  assert.deepEqual(porPuntaje, [...porPuntaje].sort((a, b) => b - a));
});

test('las ediciones locales mandan sobre la ficha y se buscan por titulo editado', () => {
  const ed = { [clips[0].id]: { titulo: 'Mi titulo propio', descripcion: 'Mi descripcion' } };
  assert.equal(P.tituloDe(clips[0], ed), 'Mi titulo propio');
  assert.equal(P.descripcionDe(clips[0], ed), 'Mi descripcion');
  assert.equal(P.filtrarClipsFlujo(clips, { texto: 'titulo propio', ediciones: ed }).length, 1);
});

test('prepararEncolar valida y arma el cuerpo que acepta /api/panel/encolar', () => {
  assert.deepEqual(P.prepararEncolar({ url: ' https://youtu.be/x ', modo: 'blur', cantidad: '3' }), { ok: true, cuerpo: { url: 'https://youtu.be/x', modo: 'blur', cantidad: 3 } });
  assert.deepEqual(P.prepararEncolar({ url: 'https://youtu.be/x', cantidad: 'auto' }).cuerpo, { url: 'https://youtu.be/x', modo: 'recorte' });
  assert.equal(P.prepararEncolar({ url: 'youtube.com' }).ok, false);
  assert.equal(P.prepararEncolar({ url: 'https://a.b', modo: 'zoom' }).ok, false);
  assert.equal(P.prepararEncolar({ url: 'https://a.b', cantidad: '9' }).ok, false);
  assert.equal(P.prepararEncolar({ url: 'https://a.b', cantidad: '1.5' }).ok, false);
});

test('slug y formatoSeg', () => {
  assert.equal(P.slug('¡Cómo vender MÁS! en 2026'), 'como-vender-mas-en-2026');
  assert.equal(P.slug('???'), 'clip');
  assert.equal(P.formatoSeg(65.4), '1:05');
  assert.equal(P.formatoSeg(null), '—');
});

test('prepararEncolar: instruccion y estilo de subtitulos viajan en el cuerpo', () => {
  const r = P.prepararEncolar({ url: 'https://youtu.be/x', instruccion: '  momentos   de   precios ', estiloSubtitulos: 'Clasico' });
  assert.deepEqual(r.cuerpo, { url: 'https://youtu.be/x', modo: 'recorte', estiloSubtitulos: 'clasico', instruccion: 'momentos de precios' });
  assert.equal(P.prepararEncolar({ url: 'https://youtu.be/x', instruccion: '   ' }).cuerpo.instruccion, undefined);
  assert.equal(P.prepararEncolar({ url: 'https://youtu.be/x', instruccion: 'a'.repeat(500) }).cuerpo.instruccion.length, P.INSTRUCCION_MAX);
  for (const estilo of Object.keys(P.ESTILOS_SUBTITULOS)) assert.equal(P.prepararEncolar({ url: 'https://a.b', estiloSubtitulos: estilo }).ok, true);
  assert.equal(P.prepararEncolar({ url: 'https://a.b', estiloSubtitulos: 'neon' }).ok, false);
});

test('prepararEncolar: archivo local reemplaza al enlace (nunca ambos) y valida la extension', () => {
  const archivo = { name: 'Entrevista.MOV', size: 10 };
  const r = P.prepararEncolar({ url: '', archivo, modo: 'blur', cantidad: '2', instruccion: 'ahorro', estiloSubtitulos: 'minimal' });
  assert.equal(r.ok, true);
  assert.equal(r.archivo, archivo);
  assert.deepEqual(r.cuerpo, { modo: 'blur', cantidad: 2, estiloSubtitulos: 'minimal', instruccion: 'ahorro' });   // sin url
  assert.equal(P.prepararEncolar({ url: 'https://a.b', archivo }).ok, false);
  assert.equal(P.prepararEncolar({ archivo: { name: 'notas.txt' } }).ok, false);
  assert.equal(P.prepararEncolar({ archivo: { name: 'sin-extension' } }).ok, false);
  for (const ext of P.EXTENSIONES_VIDEO) assert.equal(P.prepararEncolar({ archivo: { name: 'v' + ext } }).ok, true);
  assert.equal(P.prepararEncolar({}).ok, false);
});

test('instruccion y origen: se leen del clip y se agrupan por proyecto', () => {
  const clips = [
    { id: 'a', jobId: 'a', estado: 'listo', creadoEn: '2026-01-01', origen: 'archivo', instruccion: 'precios', estiloSubtitulos: 'clasico', titulo: 'entrevista.mp4 (clip 1/2)', ficha: { puntaje: 60, instruccion: { texto: 'precios', coincide: true } } },
    { id: 'b', jobId: 'a', estado: 'listo', creadoEn: '2026-01-01', origen: 'archivo', instruccion: 'precios', estiloSubtitulos: 'clasico', ficha: { puntaje: 50, instruccion: { texto: 'precios', coincide: false } } },
    { id: 'c', jobId: 'c', estado: 'listo', creadoEn: '2026-01-02', ficha: { puntaje: 40 } },
  ];
  assert.equal(P.instruccionDe(clips[0]), 'precios');
  assert.equal(P.instruccionDe({ ficha: { instruccion: { texto: 'x' } } }), 'x');
  assert.equal(P.instruccionDe(clips[2]), '');
  assert.deepEqual([P.coincideInstruccion(clips[0]), P.coincideInstruccion(clips[1]), P.coincideInstruccion(clips[2])], [true, false, null]);
  assert.equal(P.estiloDe(clips[0]), 'Clásico');
  assert.equal(P.esArchivoLocal(clips[0]), true);
  const [reciente, proyecto] = P.agruparProyectos(clips);
  assert.equal(reciente.instruccion, '');
  assert.equal(proyecto.instruccion, 'precios');
  assert.equal(proyecto.coinciden, 1);
  assert.equal(proyecto.origen, 'archivo');
  assert.equal(proyecto.estilo, 'Clásico');
  assert.equal(P.filtrarProyectos([reciente, proyecto], 'precios').length, 1);
});
