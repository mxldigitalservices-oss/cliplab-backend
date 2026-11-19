import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL = 'error';

const { curarVideo, dividirFrases, fichaDeVentana, armarRevisionTecnica, resumirEncuadre, CURADOR } = await import('../src/engine/curador.js');
const { pesoDe, INDICE, normalizar } = await import('../src/engine/diccionario.js');
const { presetLigero } = await import('../src/engine/render.js');

const PLANAS = [
  'El clima de la ciudad estuvo bastante normal durante la tarde.',
  'La gente caminaba por la calle principal sin mucha prisa.',
  'Hubo algo de trafico cerca del parque central esta semana.',
  'Los vecinos comentaron que el barrio sigue tranquilo como siempre.',
];
const CALIENTES = [
  '¿Sabías que el error más caro en tu negocio es nunca medir los resultados?',
  'El primer paso de la estrategia es medir tus ventas cada semana con una herramienta simple.',
  'Un ejemplo claro: un cliente subió sus ingresos 40 por ciento con este método.',
  'Eso cambió su negocio y fue una historia increíble de éxito.',
  'La clave es aplicar el sistema todos los días sin excepción.',
];

// Charla sintetica de ~680 s: bloques "calientes" (gancho + valor) en las frases 60-85 y 120-135.
function charla() {
  const palabras = [];
  const frases = [];
  let t = 0;
  for (let i = 0; i < 160; i++) {
    const caliente = (i >= 60 && i < 85) || (i >= 120 && i < 135);
    const texto = caliente ? CALIENTES[i % CALIENTES.length] : PLANAS[i % PLANAS.length];
    const inicio = t;
    for (const w of texto.split(' ')) {
      palabras.push({ texto: w, inicio: t, fin: t + 0.33 });
      t += 0.36;
    }
    frases.push({ inicio, fin: t - 0.03, caliente });
    t += 0.3;
  }
  return { palabras, frases, duracion: Math.ceil(t) };
}

const entrada = (extra = {}) => {
  const c = charla();
  return { palabras: c.palabras, duracionVideo: c.duracion, tituloVideo: 'Como escalar tu negocio', semilla: 'vid1', ...extra };
};
const solapan = (a, b) => a.inicio < b.fin && b.inicio < a.fin;

test('el curador declara rol y mision', () => {
  assert.match(CURADOR.rol, /curador y segmentador/i);
  assert.ok(CURADOR.mision.length > 20);
});

test('diccionario: normaliza acentos, raices y terminos exactos', () => {
  assert.equal(normalizar('¿Sabías?'), 'sabias');
  assert.equal(pesoDe(INDICE.valor, 'aprendizaje'), 2);
  assert.equal(pesoDe(INDICE.gancho, 'secreto'), 2);
  assert.equal(pesoDe(INDICE.gancho, 'zapato'), 0);
});

test('dividirFrases corta por puntuacion, por pausa y por tope de palabras', () => {
  const p = (texto, inicio) => ({ texto, inicio, fin: inicio + 0.3 });
  const { frases } = dividirFrases([p('Hola', 0), p('mundo.', 0.4), p('Otra', 1.0), p('frase', 1.4), p('sin', 3.0), p('punto', 3.4)]);
  assert.equal(frases.length, 3, 'punto + pausa de 1.2 s');
  const largas = Array.from({ length: 90 }, (_, i) => p('palabra', i * 0.35));
  assert.ok(dividirFrases(largas).frases.length >= 3, 'sin puntuacion ni pausas tambien se parte');
});

test('de un video largo salen 4-5 clips de 30-60 s, sin solapes y alineados a frases', () => {
  const c = charla();
  const r = curarVideo(entrada());
  assert.ok(r.clips.length === 4 || r.clips.length === 5, 'clips: ' + r.clips.length);
  for (const clip of r.clips) {
    assert.ok(clip.duracion >= 30 && clip.duracion <= 60, 'duracion ' + clip.duracion);
    assert.ok(clip.fin <= c.duracion);
    const arranca = c.frases.some((f) => Math.abs(f.inicio - clip.inicio) <= 0.2);
    const cierra = c.frases.some((f) => clip.fin - f.fin >= 0 && clip.fin - f.fin <= 0.35);
    assert.ok(arranca, 'arranca en el limite de una frase: ' + clip.inicio);
    assert.ok(cierra, 'cierra en el limite de una frase: ' + clip.fin);
  }
  for (let i = 0; i < r.clips.length; i++) for (let j = i + 1; j < r.clips.length; j++) {
    assert.ok(!solapan(r.clips[i], r.clips[j]), 'sin solapes');
  }
  const inicios = r.clips.map((x) => x.inicio);
  assert.deepEqual(inicios, [...inicios].sort((a, b) => a - b), 'salen en orden cronologico');
});

test('es determinista: misma transcripcion, misma salida', () => {
  assert.deepEqual(curarVideo(entrada()), curarVideo(entrada()));
});

test('prefiere los momentos con gancho y valor sobre la charla plana', () => {
  const c = charla();
  const r = curarVideo(entrada());
  const mejor = r.clips.find((x) => x.ficha.ranking === 1);
  const dentro = c.frases.filter((f) => f.caliente && f.inicio >= mejor.inicio - 0.5 && f.fin <= mejor.fin + 0.5).length;
  assert.ok(dentro >= 5, 'el mejor clip cae sobre un bloque caliente (' + dentro + ' frases calientes)');
  assert.ok(mejor.ficha.gancho.puntaje > 60);
  assert.ok(mejor.ficha.valor.claves.length > 0);
});

test('respeta el historial: no repite rangos ya usados', () => {
  const usados = curarVideo(entrada()).clips.map((x) => ({ inicio: x.inicio, fin: x.fin }));
  const nuevos = curarVideo(entrada({ historial: usados })).clips;
  for (const n of nuevos) for (const u of usados) assert.ok(!solapan(n, u), 'repite ' + u.inicio);
});

test('cada clip trae la ficha completa', () => {
  const r = curarVideo(entrada());
  for (const [i, clip] of r.clips.entries()) {
    const f = clip.ficha;
    assert.equal(f.origen, 'curador');
    for (const k of ['gancho', 'flujo', 'valor', 'interes']) assert.ok(f[k].puntaje >= 0 && f[k].puntaje <= 100, k);
    assert.ok(f.puntaje > 0 && f.puntaje <= 100);
    assert.equal(f.puntaje, clip.puntaje);
    assert.ok(f.gancho.frase.length > 3);
    assert.ok(f.titulo.length > 5 && f.titulo.length <= 90);
    assert.ok(f.descripcion.includes(f.titulo) && f.descripcion.includes('#') && f.descripcion.includes(f.cta));
    assert.ok(f.descripcion.includes('parte ' + (i + 1) + ' de ' + r.clips.length));
    assert.ok(f.hashtags.every((h) => h.startsWith('#')));
    assert.equal(f.revisionTecnica, null, 'la revision tecnica la completa el pipeline tras el render');
  }
  assert.deepEqual(r.clips.map((x) => x.ficha.ranking).sort(), r.clips.map((_, i) => i + 1));
});

test('sin voz o con muy poco texto no inventa clips; la ficha basica mantiene la estructura', () => {
  assert.equal(curarVideo({ palabras: [], duracionVideo: 600 }).clips.length, 0);
  assert.equal(curarVideo({ palabras: charla().palabras.slice(0, 10), duracionVideo: 600 }).clips.length, 0);
  const f = fichaDeVentana({ palabras: [], tituloVideo: 'Como escalar tu negocio', semilla: 'x' });
  assert.equal(f.origen, 'planificador');
  assert.equal(f.puntaje, null);
  assert.ok(f.titulo && f.descripcion.includes('Mira hasta el final') && f.hashtags.length >= 5);
});

test('fichaDeVentana puntua un clip ya cortado con el mismo evaluador', () => {
  const c = charla();
  const ventana = c.palabras.filter((w) => w.inicio >= c.frases[60].inicio && w.fin <= c.frases[72].fin);
  const f = fichaDeVentana({ palabras: ventana, tituloVideo: 'Como escalar tu negocio', semilla: 'x' });
  assert.equal(f.origen, 'curador');
  assert.ok(f.puntaje > 40);
});

test('revision tecnica: 9:16, 1080x1920 y alertas si el render no cumple', () => {
  const pendiente = armarRevisionTecnica({ modo: 'recorte', duracion: 45 });
  assert.deepEqual([pendiente.formato, pendiente.resolucion, pendiente.estado, pendiente.cumpleFormato], ['9:16', '1080x1920', 'pendiente', null]);

  const ok = armarRevisionTecnica({ modo: 'recorte', resultado: { ancho: 1080, alto: 1920, duracion: 44, conLogo: true }, palabras: 90, cpu: { preset: 'veryfast', hilos: 2 } });
  assert.deepEqual([ok.estado, ok.cumpleFormato, ok.subtitulos, ok.logo, ok.alertas.length], ['verificado', true, true, true, 0]);
  assert.equal(ok.cpu.preset, 'veryfast');

  const mal = armarRevisionTecnica({ resultado: { ancho: 720, alto: 1280, duracion: 44, conLogo: false, logoOmitido: true }, palabras: 0 });
  assert.equal(mal.estado, 'con-alertas');
  assert.equal(mal.cumpleFormato, false);
  assert.ok(mal.alertas.length >= 3);
});

test('resumirEncuadre distingue centrado, seguimiento, split e interlocutor', () => {
  assert.equal(resumirEncuadre(null, 'recorte').tipo, 'centrado');
  assert.equal(resumirEncuadre(null, 'blur').tipo, 'blur');
  const kf = [{ t: 0, cx: 0.4 }, { t: 2, cx: 0.6 }];
  const seguimiento = resumirEncuadre([{ desde: 0, hasta: 3, plano: 'medio', sujeto: { n: 1, kf } }], 'recorte');
  assert.deepEqual([seguimiento.tipo, seguimiento.interlocutor, seguimiento.personas], ['seguimiento', 'unico', 1]);
  const split = resumirEncuadre([
    { desde: 0, hasta: 3, plano: 'medio', sujeto: { n: 2, personas: 2, split: true, cambios: 3 } },
    { desde: 3, hasta: 6, plano: 'cerrado', sujeto: { n: 2, personas: 2, split: true } },
  ], 'recorte');
  assert.deepEqual([split.tipo, split.interlocutor, split.cambiosInterlocutor, split.splitSeg], ['split', 'dialogo-split', 3, 6]);
  assert.deepEqual(split.planos, { medio: 1, cerrado: 1 });
});

test('render: solo presets ligeros de CPU (veryfast/faster); lo pesado se baja a veryfast', () => {
  for (const p of ['ultrafast', 'veryfast', 'faster']) assert.equal(presetLigero(p), p);
  for (const p of ['medium', 'slow', 'veryslow', '', undefined, 'x']) assert.equal(presetLigero(p), 'veryfast');
});
