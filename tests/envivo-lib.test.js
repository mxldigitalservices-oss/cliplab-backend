import test from 'node:test';
import assert from 'node:assert/strict';
import { tandas, liberarVideos, textoEstado, textoSegundos, slug } from '../public/js/envivo-lib.js';

function videoFalso(registro, nombre) {
  return {
    pause: () => registro.push(nombre + ':pause'),
    removeAttribute: (a) => registro.push(nombre + ':removeAttribute:' + a),
    load: () => registro.push(nombre + ':load'),
    remove: () => registro.push(nombre + ':remove'),
  };
}

test('tandas parte en grupos de 5 por defecto', () => {
  assert.deepEqual(tandas([1, 2, 3, 4, 5, 6, 7]).map((t) => t.length), [5, 2]);
  assert.deepEqual(tandas([], 5), []);
  assert.deepEqual(tandas([1, 2, 3], 2), [[1, 2], [3]]);
  assert.deepEqual(tandas([1, 2, 3], 0).length, 1);
});

test('liberarVideos pausa, quita el src, fuerza load y saca el nodo del DOM', () => {
  const reg = [];
  const raiz = { querySelectorAll: (sel) => (sel === 'video' ? [videoFalso(reg, 'a'), videoFalso(reg, 'b')] : []) };
  assert.equal(liberarVideos(raiz), 2);
  assert.deepEqual(reg.slice(0, 4), ['a:pause', 'a:removeAttribute:src', 'a:load', 'a:remove']);
  assert.equal(liberarVideos(null), 0);
});

test('liberarVideos saca el nodo aunque pause() falle (finally)', () => {
  const reg = [];
  const roto = { pause: () => { throw new Error('boom'); }, removeAttribute: () => {}, load: () => {}, remove: () => reg.push('removido') };
  assert.throws(() => liberarVideos({ querySelectorAll: () => [roto] }), /boom/);
  assert.deepEqual(reg, ['removido']);
});

test('textos de estado y utilidades', () => {
  assert.equal(textoSegundos(125), '2:05');
  assert.equal(textoSegundos(3725), '1:02:05');
  assert.match(textoEstado({ estado: 'grabando', segundosGrabados: 65, momentos: 1, auto: true }), /Capturando en vivo · 1:05 capturados · 1 momento · Auto: sí/);
  assert.match(textoEstado({ estado: 'error', error: 'sin red' }), /Error · sin red/);
  assert.equal(textoEstado(null), 'Sin captura');
  assert.equal(slug('¡Gran Título: Épico!'), 'gran-titulo-epico');
});
