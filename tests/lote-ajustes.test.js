import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL = 'error';

const F = await import('../public/js/ajustes.js');
const B = await import('../src/ajustes.js');

test('catalogos del panel y del backend coinciden (si cambia uno, esta prueba avisa)', () => {
  assert.deepEqual(F.VELOCIDADES.map((v) => v.valor), [...B.VELOCIDADES]);
  assert.deepEqual(F.TONOS.map((t) => t.valor), [...B.TONOS]);
  assert.deepEqual(Object.keys(F.COLORES), [...B.COLORES]);
  assert.deepEqual(Object.keys(F.ENCUADRES_AJUSTE), [...B.ENCUADRES]);
  assert.deepEqual(F.LOGO_ESCALA, B.LOGO_ESCALA);
});

test('lo que normaliza el panel siempre lo acepta el backend', () => {
  const a = F.normalizarAjustes({ velocidad: '1.25', tono: '1', color: 'bn', encuadre: 'centrado', espejo: true, logo: { id: 'logo_0123456789abcdef', x: 2, y: -1, escala: 5, recorteFondo: true } });
  assert.deepEqual(B.sanearAjustes(a), a);
});

test('normalizarAjustes: basura vuelve al neutro y nunca lanza', () => {
  for (const crudo of [null, undefined, 'x', 7, [], { velocidad: 9, tono: 99, color: 'rosa', encuadre: 'zoom', espejo: 'si', logo: { id: '../x' } }]) {
    assert.deepEqual(F.normalizarAjustes(crudo), F.ajustesVacios());
  }
  assert.equal(F.esNulo(F.ajustesVacios()), true);
});

test('resumen y comparacion de ajustes', () => {
  assert.deepEqual(F.resumenAjustes(F.ajustesVacios()), []);
  const a = F.normalizarAjustes({ velocidad: 1.5, tono: -2, espejo: true, color: 'calido', logo: { id: 'logo_0123456789abcdef', recorteFondo: true } });
  assert.deepEqual(F.resumenAjustes(a), ['1.5x', 'Tono -2', 'Cálido', 'Espejo', 'Logo sin fondo']);
  assert.equal(F.igualesAjustes(a, { ...a }), true);
  assert.equal(F.igualesAjustes(a, F.ajustesVacios()), false);
});

test('logo: validacion de archivo, posicion siempre dentro del cuadro y tamano acotado', () => {
  assert.equal(F.validarArchivoLogo({ type: 'image/png', size: 1000 }).ok, true);
  assert.match(F.validarArchivoLogo({ type: 'image/gif', size: 10 }).error, /PNG, JPG o WebP/);
  assert.match(F.validarArchivoLogo({ type: 'image/png', size: 6 * 1048576 }).error, /5 MB/);
  assert.equal(F.validarArchivoLogo(null).ok, false);
  assert.deepEqual(F.posicionDesdePunto(150, -20, 100, 200), { x: 1, y: 0 });
  assert.deepEqual(F.posicionDesdePunto(50, 100, 100, 200), { x: 0.5, y: 0.5 });
  const l = { id: 'logo_0123456789abcdef', recorteFondo: false, x: 0.99, y: 0.01, escala: 0.25 };
  assert.deepEqual([F.desplazarLogo(l, 0.1, -0.1).x, F.desplazarLogo(l, 0.1, -0.1).y], [1, 0]);
  assert.equal(F.redimensionarLogo(l, 9).escala, 0.6);
  assert.equal(F.redimensionarLogo(l, 0).escala, 0.08);
});

test('planAplicar: exige seleccion y ajustes; podarSeleccion quita clips que ya no existen', () => {
  const a = F.normalizarAjustes({ espejo: true });
  assert.equal(F.planAplicar({ seleccion: new Set(), ajustes: a }).ok, false);
  assert.equal(F.planAplicar({ seleccion: new Set(['c1']), ajustes: F.ajustesVacios() }).ok, false);
  const plan = F.planAplicar({ seleccion: new Set(['c1', 'c2']), ajustes: a });
  assert.deepEqual([plan.ok, plan.ids, plan.resumen], [true, ['c1', 'c2'], ['Espejo']]);
  assert.deepEqual([...F.podarSeleccion(new Set(['c1', 'c9']), new Set(['c1', 'c2']))], ['c1']);
});

test('ajustesParaNuevos: solo si el toggle esta activo y hay algo que aplicar', () => {
  const a = F.normalizarAjustes({ velocidad: 1.2 });
  assert.equal(F.ajustesParaNuevos({ aplicarNuevos: false, ajustes: a }), null);
  assert.equal(F.ajustesParaNuevos({ aplicarNuevos: true, ajustes: F.ajustesVacios() }), null);
  assert.deepEqual(F.ajustesParaNuevos({ aplicarNuevos: true, ajustes: a }), a);
});
