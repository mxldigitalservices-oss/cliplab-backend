import test from 'node:test';
import assert from 'node:assert/strict';
import { generarCandidatosTitulo, puntuarTitulo } from '../src/engine/titulos.js';
import { filtrarClipsFlujo } from '../public/js/proyectos.js';

test('candidatos y puntaje de titulo', () => {
  const res = generarCandidatosTitulo({
    transcripcion: 'Eh bueno o sea hoy revelamos el precio real del dolar en la casa y nadie lo esperaba.',
    gancho: 'Revelamos el precio real del dolar en la casa',
    tituloFuente: 'La Casa de Alofoke 3 En Vivo 24/7',
    queBuscar: 'precio dolar'
  });
  assert.ok(res.alternativas.length >= 2);
  assert.match(res.titulo.toLowerCase(), /precio|dolar/);
  assert.ok(puntuarTitulo('Revelan el precio real del dolar en vivo', { transcripcion: 'precio dolar' }).puntaje > puntuarTitulo('Eh bueno o sea mira esto').puntaje);
});

test('busqueda por palabras, tolerancia, relevancia y origen', () => {
  const clips = [
    { id: '1', estado: 'listo', origen: 'envivo', envivo: { origen: 'auto' }, titulo: 'Charla de tarde', transcripcion: 'Hablamos del precio del dolar hoy.' },
    { id: '2', estado: 'listo', origen: 'envivo', envivo: { origen: 'manual' }, titulo: 'Precio del dolar en vivo', transcripcion: 'Subio el precio del dolar.' },
    { id: '3', estado: 'listo', origen: 'enlace', titulo: 'Otro tema', transcripcion: 'Cocina.' }
  ];
  const r = filtrarClipsFlujo(clips, { q: 'dolar precia', origen: 'envivo' });
  assert.equal(r.length, 2);
  assert.equal(r[0].id, '2');
  assert.ok(r[0].relevancia > r[1].relevancia && r[0].contextoCoincidencia.length > 0);
});
