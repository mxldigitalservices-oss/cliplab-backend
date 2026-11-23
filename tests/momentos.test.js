process.env.LOG_LEVEL = 'error';
import test from 'node:test';
import assert from 'node:assert/strict';

const { curarVideo } = await import('../src/engine/curador.js');
const { puntuarIntensidad, enriquecerClip } = await import('../src/engine/cerebro-marketing.js');

// Transcripcion sintetica: relleno neutro con un bloque de reality y otro de chisme escondidos entre medio.
const NEUTRAS = [
  'Hoy estuvimos organizando la cocina y revisando el menu de la semana con calma.',
  'La temperatura bajo un poco en la tarde y salimos a caminar por el jardin del fondo.',
  'Preparamos arroz con pollo y ensalada para todos los que estaban en la casa.',
  'Despues de comer lavamos los platos y ordenamos las sillas del comedor principal.',
  'Mas tarde miramos una pelicula tranquila y comentamos las partes que mas nos gustaron.',
];
const REALITY = [
  'Tu me faltaste el respeto delante de todos y no te lo voy a permitir.',
  'Callate y escuchame, eres una mentirosa y una hipocrita.',
  'Se armo una pelea enorme en la sala y todos empezaron a gritar.',
  'Ella dijo que me iba a nominar esta semana y yo le dije que no tenia miedo.',
  'Despues de la discusion nadie quiso hablar con nadie durante horas.',
  'Al final la produccion tuvo que intervenir para separarlas en el comedor.',
  'Manana hay nominaciones y esto todavia no se termina.',
];
const CHISME = [
  'Oye, no le digas a nadie lo que me conto Mariela de ti.',
  'Dijo que hablabas mal a tus espaldas y que ya hay un rumor en toda la casa.',
  'Es un secreto, pero se armo un chisme tremendo y nadie sabe quien empezo.',
  'Yo solo te lo cuento en confianza para que lo sepas antes de que te enteres.',
  'Prometeme que no vas a decir que fui yo quien te lo conto.',
  'Entre nosotros, creo que ella lo hizo a proposito.',
];

function palabrasDe(frases) {
  const palabras = [];
  let t = 0;
  const rangos = [];
  for (const f of frases) {
    const inicio = t;
    for (const w of f.texto.split(/\s+/)) {
      palabras.push({ texto: w, inicio: t, fin: t + 0.34 });
      t += 0.4;
    }
    rangos.push({ tipo: f.tipo, inicio, fin: t });
    t += 0.9; // pausa entre frases
  }
  return { palabras, rangos, duracion: Math.ceil(t) };
}

// 8 + 1 + 8 + 1 + 8 repeticiones: ~13 min con un bloque de reality (~40 s) y uno de chisme (~40 s) entre relleno neutro.
function guion() {
  const frases = [];
  const rep = (lista, tipo, veces = 1) => { for (let k = 0; k < veces; k++) for (const texto of lista) frases.push({ texto, tipo }); };
  rep(NEUTRAS, 'neutro', 8);
  rep(REALITY, 'reality');
  rep(NEUTRAS, 'neutro', 8);
  rep(CHISME, 'chisme');
  rep(NEUTRAS, 'neutro', 8);
  return palabrasDe(frases);
}

test('puntuarIntensidad: reality, chisme, neutro y voz baja', () => {
  const r = puntuarIntensidad(REALITY.join(' '));
  assert.equal(r.tipo, 'tension_reality');
  assert.ok(r.intensidad >= 40 && r.intensidad <= 100);
  const c = puntuarIntensidad(CHISME.join(' '));
  assert.equal(c.tipo, 'chisme_confidencia');
  assert.ok(c.intensidad >= 40);
  const n = puntuarIntensidad(NEUTRAS.join(' '));
  assert.equal(n.tipo, null);
  assert.equal(n.intensidad, 0);
  assert.equal(puntuarIntensidad('').tipo, null);
  const baja = puntuarIntensidad('[susurrando] Ven, te voy a contar algo. Es un secreto.');
  assert.equal(baja.tipo, 'chisme_confidencia');
});

test('el curador prioriza picos de reality y chisme y respeta la cantidad pedida', () => {
  const { palabras, rangos, duracion } = guion();
  const solapaCon = (clip, tipo) => rangos.some((r) => r.tipo === tipo && clip.inicio < r.fin && clip.fin > r.inicio);

  for (const cantidad of [1, 2, 3]) {
    const r = curarVideo({ palabras, duracionVideo: duracion, cantidad, tituloVideo: 'Casa', semilla: 'x' });
    assert.ok(r.clips.length >= 1 && r.clips.length <= cantidad, 'cantidad ' + cantidad + ' -> ' + r.clips.length);
    assert.ok(r.clips.every((c) => c.duracion >= 30 && c.duracion <= 60), 'clips de 30-60 s');
  }

  const dos = curarVideo({ palabras, duracionVideo: duracion, cantidad: 2, tituloVideo: 'Casa', semilla: 'x' });
  assert.equal(dos.clips.length, 2);
  assert.ok(dos.clips.some((c) => solapaCon(c, 'reality')), 'incluye el bloque de reality');
  assert.ok(dos.clips.some((c) => solapaCon(c, 'chisme')), 'incluye el bloque de chisme');
  const tipos = dos.clips.map((c) => c.ficha.momento && c.ficha.momento.tipo).sort();
  assert.deepEqual(tipos, ['chisme_confidencia', 'tension_reality']);

  // Sin el bono el segundo clip es un tramo de relleno que apenas roza el reality: no queda marcado como momento.
  const sin = curarVideo({ palabras, duracionVideo: duracion, cantidad: 2, momentos: false, semilla: 'x' });
  assert.ok(!sin.clips.some((c) => c.ficha.momento));
});

test('momentos:false desactiva el bono y la marca en la ficha', () => {
  const { palabras, duracion } = guion();
  const r = curarVideo({ palabras, duracionVideo: duracion, cantidad: 2, momentos: false, semilla: 'x' });
  assert.ok(r.clips.every((c) => !('momento' in c.ficha)));
});

test('un video sin reality ni chisme se cura igual que antes (sin marca de momento)', () => {
  const frases = [];
  for (let k = 0; k < 20; k++) for (const texto of NEUTRAS) frases.push({ texto, tipo: 'neutro' });
  const { palabras, duracion } = palabrasDe(frases);
  const con = curarVideo({ palabras, duracionVideo: duracion, cantidad: 3, semilla: 'y' });
  const sin = curarVideo({ palabras, duracionVideo: duracion, cantidad: 3, momentos: false, semilla: 'y' });
  assert.deepEqual(con.clips.map((c) => [c.inicio, c.duracion]), sin.clips.map((c) => [c.inicio, c.duracion]));
  assert.ok(con.clips.every((c) => !c.ficha.momento));
});

test('enriquecerClip: agrega cerebro a ficha y marketing sin cambiar titulo si Ollama no responde', async () => {
  const ficha = { titulo: 'Titulo de ficha', descripcion: 'desc', cta: 'cta', hashtags: ['#a'] };
  const marketing = { titulo: 'Titulo mk', descripcion: 'desc mk', cta: 'cta mk', hashtags: ['#a', '#b', '#c'] };
  const texto = CHISME.join(' ');
  const caido = async () => { throw new Error('ECONNREFUSED'); };
  const r = await enriquecerClip({ ficha, marketing, transcripcion: texto, duracion: 50 }, { ollama: true, fetch: caido });
  assert.equal(r.ficha.cerebro.angulo, 'chisme_confidencia');
  assert.equal(r.ficha.cerebro.motor, 'heuristico-local');
  assert.equal(r.ficha.cerebro.momento.tipo, 'chisme_confidencia');
  assert.equal(r.marketing.titulo, 'Titulo mk');
  assert.equal(r.marketing.cta, 'cta mk');
  assert.equal(ficha.cerebro, undefined, 'no muta la ficha original');

  const ia = async () => ({ ok: true, json: async () => ({ response: JSON.stringify({ tituloPrincipal: 'Lo que dijeron de ti a tus espaldas en la casa', cta: 'Cuéntame si lo sabías.' }) }) });
  const r2 = await enriquecerClip({ ficha, marketing, transcripcion: texto, duracion: 50 }, { ollama: true, fetch: ia });
  assert.equal(r2.ficha.cerebro.motor, 'ollama');
  assert.equal(r2.marketing.titulo, 'Lo que dijeron de ti a tus espaldas en la casa');
  assert.equal(r2.marketing.cta, 'Cuéntame si lo sabías.');
  assert.equal(r2.ficha.titulo, 'Titulo de ficha', 'la ficha del curador no se reescribe');
});

test('enriquecerClip nunca lanza: texto vacio o ficha nula', async () => {
  const r = await enriquecerClip({ transcripcion: '' }, { ollama: false });
  assert.equal(r.cerebro, null);
  assert.equal(r.ficha, null);
  const r2 = await enriquecerClip(undefined, { ollama: false });
  assert.equal(r2.cerebro, null);
});
