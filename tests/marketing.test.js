import test from 'node:test';
import assert from 'node:assert/strict';
import { generarMarketing } from '../src/engine/marketing.js';

const TRANSCRIPCION =
  'Mira, el error más grande que cometen los emprendedores es nunca hablar con sus clientes. ' +
  'Yo perdí un millón de pesos por no preguntar. Los clientes te dicen exactamente qué comprar.';

test('entrega titulo gancho, descripcion con CTA y hashtags listos para publicar', () => {
  const m = generarMarketing({ tituloVideo: 'Cómo escalar tu negocio', transcripcion: TRANSCRIPCION, semilla: 'c1|30', indice: 2, total: 5 });
  assert.ok(m.titulo.length > 10 && m.titulo.length <= 90);
  assert.ok(!/^mira,/i.test(m.titulo), 'sin muletillas al inicio');
  assert.ok(m.descripcion.includes(m.titulo), 'la descripcion arranca con el gancho');
  assert.ok(m.descripcion.includes('parte 2 de 5'));
  assert.ok(m.cta.length > 5);
  assert.ok(m.hashtags.length >= 5 && m.hashtags.every((h) => /^#[a-z0-9]+$/.test(h)), m.hashtags.join(' '));
  assert.equal(new Set(m.hashtags).size, m.hashtags.length, 'sin hashtags repetidos');
  assert.equal(m.nicho, 'negocios');
});

test('sin voz detectada igual genera paquete a partir del titulo del video', () => {
  const m = generarMarketing({ tituloVideo: 'Entrevista completa', transcripcion: '', semilla: 'x' });
  assert.ok(m.titulo && m.descripcion && m.cta && m.hashtags.length > 0);
});

test('clips distintos del mismo video no repiten exactamente el mismo texto', () => {
  const a = generarMarketing({ tituloVideo: 'Tema', transcripcion: '', semilla: 'clip_a|10' });
  const b = generarMarketing({ tituloVideo: 'Tema', transcripcion: '', semilla: 'clip_b|400' });
  assert.ok(a.titulo !== b.titulo || a.cta !== b.cta);
});

test('es determinista para el mismo clip', () => {
  const a = generarMarketing({ tituloVideo: 'T', transcripcion: TRANSCRIPCION, semilla: 's' });
  const b = generarMarketing({ tituloVideo: 'T', transcripcion: TRANSCRIPCION, semilla: 's' });
  assert.equal(a.titulo, b.titulo);
  assert.equal(a.descripcion, b.descripcion);
  assert.deepEqual(a.hashtags, b.hashtags);
});
