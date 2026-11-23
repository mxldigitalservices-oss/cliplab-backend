import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analizarBloque,
  analizarBloqueLocal,
  muletillasIniciales,
  cortarSemantico,
  terminaColgado,
  ANGULOS,
  VEREDICTOS,
} from '../src/engine/cerebro-marketing.js';
import { generarMarketing, generarMarketingInteligente } from '../src/engine/marketing.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(raiz, 'scripts', 'analizar-inteligente.js');

// ~52 s de habla: gancho con error comun, cifras, contraste y cierre con frase completa.
const BLOQUE_FUERTE =
  'El error más grande que cometen los emprendedores es no hablar con sus clientes. ' +
  'Yo perdí un millón de pesos por no preguntar. ' +
  'Los clientes te dicen exactamente qué comprar, pero casi nadie los escucha. ' +
  'Si preguntas tres cosas simples cada semana, tus ventas pueden subir un 30 por ciento. ' +
  'Hazlo durante un mes y compara tus resultados con el mes anterior. ' +
  'Ese método me costó diez años aprenderlo y hoy te lo cuento completo. ' +
  'Empieza con una llamada corta a tu mejor cliente y anota todo lo que te diga. ' +
  'Después repite el proceso con cinco clientes más y verás patrones claros.';

const BLOQUE_MULETILLAS = 'Eh bueno o sea este mira, ' + BLOQUE_FUERTE;

const BLOQUE_DEBIL = 'Eh eh bueno este o sea pues eh no sé mm la verdad este eh como que sí eh pues bueno eh.';

test('bloque de 52 s: estructura completa, angulo valido y veredicto publicar', () => {
  const r = analizarBloqueLocal({ texto: BLOQUE_FUERTE, duracion: 52 });
  assert.equal(r.motor, 'heuristico-local');
  assert.ok(ANGULOS.includes(r.angulo), r.angulo);
  assert.equal(r.angulo, 'error_comun');
  assert.ok(VEREDICTOS.includes(r.veredicto));
  assert.equal(r.veredicto, 'publicar');
  assert.ok(Number.isInteger(r.puntaje) && r.puntaje >= 62 && r.puntaje <= 100, String(r.puntaje));
  assert.ok(r.gancho.split(/\s+/).length <= 14 && r.gancho.split(/\s+/).length >= 3);
  assert.match(r.gancho, /error/i);
  assert.ok(r.copy.length > 20 && r.copy.length <= 321);
  assert.ok(r.cta.length > 5);
  assert.ok(r.tituloPrincipal.length >= 20 && r.tituloPrincipal.length <= 90);
});

test('bloque de 45 y de 60 s son validos; la duracion ideal puntua mejor que una fuera de rango', () => {
  const a = analizarBloqueLocal({ texto: BLOQUE_FUERTE, duracion: 45 });
  const b = analizarBloqueLocal({ texto: BLOQUE_FUERTE, duracion: 60 });
  const corto = analizarBloqueLocal({ texto: BLOQUE_FUERTE, duracion: 12 });
  assert.ok(a.puntaje >= 62 && b.puntaje >= 62);
  assert.ok(a.puntaje > corto.puntaje && b.puntaje > corto.puntaje);
});

test('ranking de titulos: ordenado por puntaje, sin duplicados y sin muletillas al inicio', () => {
  const r = analizarBloqueLocal({ texto: BLOQUE_MULETILLAS, duracion: 55, instruccion: 'clientes' });
  const v = r.variantesTitulo;
  assert.ok(v.length >= 3);
  for (let i = 1; i < v.length; i++) assert.ok(v[i - 1].puntaje >= v[i].puntaje, 'ordenado de mayor a menor');
  assert.equal(r.tituloPrincipal, v[0].titulo);
  assert.equal(new Set(v.map((x) => x.titulo.toLowerCase())).size, v.length);
  for (const x of v) {
    assert.ok(x.tipo && x.titulo && x.puntaje >= 0 && x.puntaje <= 100);
    if (x.tipo !== 'respaldo') assert.equal(muletillasIniciales(x.titulo).cuenta, 0, x.titulo);
  }
});

test('deteccion de muletillas iniciales y gancho limpio', () => {
  assert.equal(muletillasIniciales('Eh bueno o sea este mira, hoy hablamos de dinero').cuenta, 6);
  assert.equal(muletillasIniciales('Hoy hablamos de dinero').cuenta, 0);
  assert.equal(muletillasIniciales('Eh bueno o sea este mira, hoy hablamos de dinero').resto, 'hoy hablamos de dinero');

  const r = analizarBloqueLocal({ texto: BLOQUE_MULETILLAS, duracion: 55 });
  assert.equal(r.detalle.muletillasIniciales, 6);
  assert.equal(muletillasIniciales(r.gancho).cuenta, 0, 'el gancho no arranca con muletillas');
  assert.ok(!/^(eh|bueno|o sea|este)\b/i.test(r.tituloPrincipal));
});

test('veredictos: publicar, ajustar_inicio (muletillas al arranque) y descartar', () => {
  assert.equal(analizarBloqueLocal({ texto: BLOQUE_FUERTE, duracion: 52 }).veredicto, 'publicar');
  const con = analizarBloqueLocal({ texto: BLOQUE_MULETILLAS, duracion: 52 });
  assert.equal(con.veredicto, 'ajustar_inicio');
  assert.ok(con.puntaje < analizarBloqueLocal({ texto: BLOQUE_FUERTE, duracion: 52 }).puntaje, 'las muletillas penalizan');
  assert.equal(analizarBloqueLocal({ texto: BLOQUE_DEBIL, duracion: 50 }).veredicto, 'descartar');
  const vacio = analizarBloqueLocal({ texto: '   ', duracion: 50 });
  assert.equal(vacio.veredicto, 'descartar');
  assert.equal(vacio.puntaje, 0);
});

test('angulos: cifra, contraste, pregunta y autoridad segun la frase de apertura', () => {
  const rel = ' Esto lo explico con calma durante todo el video para que se entienda bien cada detalle del tema.';
  assert.equal(analizarBloqueLocal({ texto: 'Solo el 3 por ciento de las empresas llega a facturar 500 millones.' + rel }).angulo, 'cifra_dato');
  assert.equal(analizarBloqueLocal({ texto: 'Todos creen que vender es fácil, pero en cambio casi nadie lo logra.' + rel }).angulo, 'contraste');
  assert.equal(analizarBloqueLocal({ texto: '¿Por qué tus clientes nunca vuelven a comprarte?' + rel.replace('nunca', 'casi') }).angulo, 'pregunta_abierta');
  assert.equal(analizarBloqueLocal({ texto: 'Después de quince años de experiencia puedo asegurarte algo importante.' + rel }).angulo, 'autoridad');
});

// Bloques de reality (45-60 s): choque, discusion y tension.
const BLOQUE_REALITY =
  'Tú me faltaste el respeto delante de todos y no te lo voy a permitir. ' +
  'Cállate y escúchame, eres una mentirosa y una hipócrita. ' +
  'Se armó una pelea enorme en la sala y todos empezaron a gritar. ' +
  'Ella dijo que me iba a nominar esta semana y yo le dije que no tenía miedo. ' +
  'Después de la discusión nadie quiso hablar con nadie durante horas. ' +
  'Al final la producción tuvo que intervenir para separarlas en el comedor. ' +
  'Mañana hay nominaciones y esto todavía no se termina.';

// Bloque de chisme/confidencia, dicho a media voz.
const BLOQUE_CHISME =
  '[susurrando] Oye, no le digas a nadie lo que me contó Mariela, dijo de ti que hablaba mal a tus espaldas. ' +
  'Es un secreto, pero ya hay un rumor en toda la casa. ' +
  'Me contó que tú le habías dicho cosas feas de ella. ' +
  'Se armó un chisme tremendo y nadie sabe quién empezó. ' +
  'Yo solo te lo cuento en confianza para que lo sepas antes de que te enteres por otro lado. ' +
  'Prométeme que no vas a decir que fui yo quien te lo contó. ' +
  'Entre nosotros, creo que ella lo hizo a propósito.';

test('tension_reality: choque y discusion de reality (bloque de 50 s)', () => {
  const r = analizarBloqueLocal({ texto: BLOQUE_REALITY, duracion: 50 });
  assert.equal(r.angulo, 'tension_reality');
  assert.ok(ANGULOS.includes(r.angulo));
  assert.ok(r.cta.length > 5 && /razón|lado/i.test(r.cta), r.cta);
  assert.ok(r.hashtags.includes('#reality') && r.hashtags.includes('#drama'), r.hashtags.join(' '));
  assert.ok(r.puntaje >= 62 && r.veredicto === 'publicar', r.puntaje + ' ' + r.veredicto);
  assert.ok(r.variantesTitulo.some((v) => v.tipo === 'tension'));
});

test('tension_reality con muletillas al arranque pide ajustar_inicio', () => {
  const r = analizarBloqueLocal({ texto: 'Eh bueno o sea ' + BLOQUE_REALITY, duracion: 52 });
  assert.equal(r.angulo, 'tension_reality');
  assert.equal(r.veredicto, 'ajustar_inicio');
});

test('chisme_confidencia: rumores y comentarios a espaldas, tambien a media voz', () => {
  const r = analizarBloqueLocal({ texto: BLOQUE_CHISME, duracion: 55 });
  assert.equal(r.angulo, 'chisme_confidencia');
  assert.ok(r.hashtags.includes('#chisme') && r.hashtags.includes('#confidencias'), r.hashtags.join(' '));
  assert.ok(r.cta.length > 5);
  assert.ok(!/\[|susurr/i.test(r.gancho), 'la acotacion de voz baja no entra en el gancho: ' + r.gancho);
  assert.ok(r.hashtags.every((h) => !/susurr/.test(h)), 'ni en los hashtags');
  assert.ok(r.puntaje >= 62 && r.veredicto === 'publicar', r.puntaje + ' ' + r.veredicto);
  assert.ok(r.variantesTitulo.some((v) => v.tipo === 'chisme'));
});

test('chisme_confidencia: cada senal clave de la lista dispara el angulo', () => {
  const relleno = ' Eso fue lo que pasó durante toda la tarde en la casa con el resto del grupo.';
  const senales = ['Hablaban a mis espaldas.', 'Me contó una cosa increíble.', 'No le digas a nadie.', 'Dijo de ti cosas horribles.', 'Estaban hablando mal de ella.', 'Es un secreto enorme.', 'Corre un rumor en la casa.', 'Se armó en el comedor.', 'Te lo digo bajito.'];
  for (const senal of senales) {
    assert.equal(analizarBloqueLocal({ texto: senal + relleno }).angulo, 'chisme_confidencia', senal);
  }
  const voz = analizarBloqueLocal({ texto: '(en voz baja) Esto es lo que vi durante toda la tarde en la casa con el resto del grupo.' });
  assert.equal(voz.angulo, 'chisme_confidencia');
});

test('los angulos nuevos no tapan a los existentes', () => {
  assert.equal(analizarBloqueLocal({ texto: BLOQUE_FUERTE, duracion: 52 }).angulo, 'error_comun');
  assert.ok(ANGULOS.length >= 8 && ANGULOS.includes('tension_reality') && ANGULOS.includes('chisme_confidencia'));
});

test('cortes limpios: titulos y ganchos nunca terminan colgados', () => {
  const frases = [
    'El error más grande que cometen los emprendedores es nunca hablar con sus clientes',
    'Si preguntas tres cosas simples cada semana, tus ventas suben un 30 por ciento',
    'Los clientes te dicen exactamente qué comprar, pero casi nadie los escucha y por eso fallan',
    'Ella dijo que me iba a nominar esta semana y yo le dije que no tenía miedo de nadie',
    'Ella me dijo que no quería volver a verme porque yo había hablado mal de su familia delante de todos',
  ];
  for (const f of frases) {
    const c = cortarSemantico(f, 62);
    assert.ok(c.length <= 62, c);
    assert.equal(terminaColgado(c), false, 'colgado: ' + c);
    assert.ok(f.toLowerCase().startsWith(c.toLowerCase().replace(/,$/, '')) || f.toLowerCase().includes(c.toLowerCase()), 'es un prefijo de la frase: ' + c);
  }
  assert.equal(cortarSemantico('Los clientes te dicen exactamente qué comprar, pero casi nadie los escucha y por eso fallan', 62), 'Los clientes te dicen exactamente qué comprar');
  assert.equal(cortarSemantico('Hablemos de dinero', 62), 'Hablemos de dinero');
});

test('terminaColgado detecta cierres incompletos', () => {
  for (const f of ['Es nunca hablar con', 'Tus ventas suben un 30', 'El problema es no hablar', 'Yo le dije', 'Lo hizo porque']) assert.equal(terminaColgado(f), true, f);
  for (const f of ['Tus ventas suben un 30 por ciento', 'Perdí un millón de pesos', 'Los clientes te dicen qué comprar']) assert.equal(terminaColgado(f), false, f);
});

test('ganchos y titulos de todos los bloques de prueba salen completos', () => {
  for (const texto of [BLOQUE_FUERTE, BLOQUE_MULETILLAS, BLOQUE_REALITY, BLOQUE_CHISME]) {
    const r = analizarBloqueLocal({ texto, duracion: 55 });
    assert.equal(terminaColgado(r.gancho), false, 'gancho: ' + r.gancho);
    assert.ok(r.gancho.split(/\s+/).length <= 14, r.gancho);
    for (const v of r.variantesTitulo.filter((x) => x.tipo !== 'respaldo')) {
      assert.equal(terminaColgado(v.titulo), false, 'titulo: ' + v.titulo);
      assert.ok(v.titulo.length <= 90);
    }
    assert.equal(terminaColgado(r.tituloPrincipal), false, r.tituloPrincipal);
  }
});

test('es determinista y no depende de Ollama', () => {
  const a = analizarBloqueLocal({ texto: BLOQUE_FUERTE, duracion: 50, instruccion: 'ventas' });
  const b = analizarBloqueLocal({ texto: BLOQUE_FUERTE, duracion: 50, instruccion: 'ventas' });
  assert.deepEqual(a, b);
});

test('hashtags limpios: sin espacios, sin duplicados, en minusculas', () => {
  const r = analizarBloqueLocal({ texto: BLOQUE_FUERTE, duracion: 50, instruccion: 'Clientes clientes' });
  assert.ok(r.hashtags.length >= 4 && r.hashtags.length <= 7);
  assert.ok(r.hashtags.every((h) => /^#[a-z0-9]+$/.test(h)), r.hashtags.join(' '));
  assert.equal(new Set(r.hashtags).size, r.hashtags.length);
});

test('la instruccion sube la relevancia del bloque que habla del tema', () => {
  const con = analizarBloqueLocal({ texto: BLOQUE_FUERTE, duracion: 50, instruccion: 'clientes ventas' });
  const sin = analizarBloqueLocal({ texto: BLOQUE_FUERTE, duracion: 50, instruccion: 'astronomia' });
  assert.ok(con.puntaje >= sin.puntaje);
  assert.ok(con.detalle.relevancia > sin.detalle.relevancia);
});

test('cortarSemantico no deja el texto colgando', () => {
  const c = cortarSemantico('El error más grande que cometen los emprendedores es nunca hablar con sus clientes', 62);
  assert.ok(c.length <= 62);
  assert.ok(!/\s(con|de|los|que|y|nunca)$/i.test(c), c);
});

test('respaldo: Ollama apagado (conexion rechazada) -> motor heuristico sin lanzar error', async () => {
  const fetchCaido = async () => { throw new TypeError('fetch failed: ECONNREFUSED'); };
  const r = await analizarBloque({ texto: BLOQUE_FUERTE, duracion: 52 }, { ollama: true, fetch: fetchCaido });
  assert.equal(r.motor, 'heuristico-local');
  assert.deepEqual(r, analizarBloqueLocal({ texto: BLOQUE_FUERTE, duracion: 52 }));
});

test('respaldo: respuesta HTTP de error, JSON roto o timeout -> heuristico', async () => {
  const base = analizarBloqueLocal({ texto: BLOQUE_FUERTE, duracion: 52 });
  const casos = [
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ response: 'esto no es json' }) }),
    async () => ({ ok: true, json: async () => { throw new Error('cuerpo invalido'); } }),
    async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; },
    async () => ({ ok: true, json: async () => ({ response: JSON.stringify({ gancho: 1, tituloPrincipal: null, copy: {}, cta: [] }) }) }),
  ];
  for (const fetch of casos) {
    const r = await analizarBloque({ texto: BLOQUE_FUERTE, duracion: 52 }, { ollama: true, fetch });
    assert.deepEqual(r, base);
  }
});

test('Ollama responde: se usa el modelo del entorno, timeout corto y se mezcla con validacion', async () => {
  let llamada = null;
  const fetch = async (url, init) => {
    llamada = { url, init, cuerpo: JSON.parse(init.body) };
    return {
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          gancho: 'Estás perdiendo clientes sin saberlo',
          tituloPrincipal: 'El error con tus clientes que te cuesta ventas cada mes',
          copy: 'Si no hablas con tus clientes, estás adivinando. Mira cómo corregirlo en un minuto.',
          cta: 'Guárdalo y aplícalo hoy.',
          hashtags: ['#Clientes', 'Ventas Online', 'ventas', 'x'],
        }),
      }),
    };
  };
  process.env.OLLAMA_MODEL = 'llama3.2:3b';
  try {
    const r = await analizarBloque({ texto: BLOQUE_FUERTE, duracion: 52 }, { ollama: true, fetch });
    assert.equal(r.motor, 'ollama');
    assert.equal(r.modelo, 'llama3.2:3b');
    assert.equal(llamada.cuerpo.model, 'llama3.2:3b');
    assert.equal(llamada.cuerpo.stream, false);
    assert.match(llamada.url, /\/api\/generate$/);
    assert.ok(llamada.init.signal instanceof AbortSignal, 'lleva AbortSignal de timeout');
    assert.equal(r.gancho, 'Estás perdiendo clientes sin saberlo');
    assert.ok(r.variantesTitulo.some((v) => v.tipo === 'ollama'));
    assert.ok(r.hashtags.every((h) => /^#[a-z0-9]+$/.test(h)));
    assert.equal(new Set(r.hashtags).size, r.hashtags.length);
    // El puntaje y el veredicto siguen saliendo del motor determinista.
    const local = analizarBloqueLocal({ texto: BLOQUE_FUERTE, duracion: 52 });
    assert.equal(r.puntaje, local.puntaje);
    assert.equal(r.veredicto, local.veredicto);
  } finally {
    delete process.env.OLLAMA_MODEL;
  }
});

test('Ollama con titulo que arranca con muletilla: se rechaza el titulo', async () => {
  const fetch = async () => ({ ok: true, json: async () => ({ response: JSON.stringify({ tituloPrincipal: 'Eh bueno o sea este es el titulo malo', cta: 'Sígueme para más.' }) }) });
  const r = await analizarBloque({ texto: BLOQUE_FUERTE, duracion: 52 }, { ollama: true, fetch });
  assert.ok(!r.variantesTitulo.some((v) => v.tipo === 'ollama'));
  assert.equal(r.cta, 'Sígueme para más.');
});

test('OLLAMA_OFF desactiva la consulta (no se llama a fetch)', async () => {
  process.env.OLLAMA_OFF = '1';
  try {
    let llamado = false;
    const r = await analizarBloque({ texto: BLOQUE_FUERTE, duracion: 52 }, { fetch: async () => { llamado = true; return { ok: false }; } });
    assert.equal(llamado, false);
    assert.equal(r.motor, 'heuristico-local');
  } finally {
    delete process.env.OLLAMA_OFF;
  }
});

test('integracion: generarMarketing conserva titulo/descripcion/cta y suma el campo cerebro', () => {
  const m = generarMarketing({ tituloVideo: 'Cómo escalar tu negocio', transcripcion: BLOQUE_FUERTE, semilla: 'c1|30', indice: 2, total: 5 });
  assert.ok(m.titulo.length > 10 && m.titulo.length <= 90);
  assert.ok(m.descripcion.includes('parte 2 de 5'));
  assert.ok(m.cerebro && ANGULOS.includes(m.cerebro.angulo));
  assert.ok(VEREDICTOS.includes(m.cerebro.veredicto));
  assert.equal(m.cerebro.motor, 'heuristico-local');
  assert.ok(m.cerebro.variantesTitulo.length <= 3);
  const sin = generarMarketing({ tituloVideo: 'Entrevista', transcripcion: '', semilla: 'x' });
  assert.ok(sin.titulo && !('cerebro' in sin), 'sin voz no hay cerebro y el paquete sale igual');
});

test('integracion async: sin Ollama devuelve el paquete base con cerebro; con Ollama usa su titulo', async () => {
  const entrada = { tituloVideo: 'Ventas', transcripcion: BLOQUE_FUERTE, semilla: 's', duracion: 52 };
  const caido = await generarMarketingInteligente(entrada, { ollama: true, fetch: async () => { throw new Error('apagado'); } });
  const base = generarMarketing(entrada);
  assert.equal(caido.titulo, base.titulo);
  assert.equal(caido.cta, base.cta);
  assert.equal(caido.cerebro.motor, 'heuristico-local');

  const fetch = async () => ({ ok: true, json: async () => ({ response: JSON.stringify({ tituloPrincipal: 'Habla con tus clientes antes de gastar un peso más', cta: 'Guárdalo para tu próxima reunión.' }) }) });
  const ia = await generarMarketingInteligente(entrada, { ollama: true, fetch });
  assert.equal(ia.cerebro.motor, 'ollama');
  assert.equal(ia.cta, 'Guárdalo para tu próxima reunión.');
  assert.ok(ia.hashtags.length >= 3);
});

function cli(args, opciones = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: raiz, env: { ...process.env, OLLAMA_OFF: '1' }, timeout: 20000, ...opciones });
}

test('CLI: texto por argumento posicional y --texto, salida legible con codigo 0', () => {
  const a = cli(['--duracion', '52', BLOQUE_FUERTE]);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /Veredicto/);
  assert.match(a.stdout, /PUBLICAR/);
  const b = cli(['--texto', BLOQUE_FUERTE, '--duracion', '52']);
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /Variantes de título/);
});

test('CLI: --json valido, --archivo y stdin', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-'));
  const archivo = path.join(dir, 'bloque.txt');
  fs.writeFileSync(archivo, BLOQUE_FUERTE);
  try {
    const j = cli(['--archivo', archivo, '--duracion', '52', '--json']);
    assert.equal(j.status, 0, j.stderr);
    const datos = JSON.parse(j.stdout);
    assert.equal(datos.veredicto, 'publicar');
    assert.equal(datos.motor, 'heuristico-local');
    for (const k of ['gancho', 'angulo', 'tituloPrincipal', 'variantesTitulo', 'copy', 'cta', 'hashtags', 'puntaje', 'veredicto', 'motor']) assert.ok(k in datos, k);

    const s = cli(['--json', '--sin-ollama'], { input: BLOQUE_FUERTE });
    assert.equal(s.status, 0, s.stderr);
    assert.equal(JSON.parse(s.stdout).angulo, 'error_comun');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: sin texto sale con codigo 2 y muestra la ayuda; archivo inexistente tambien', () => {
  const sin = cli([], { input: '' });
  assert.equal(sin.status, 2);
  assert.match(sin.stderr, /Falta el texto/);
  const mal = cli(['--archivo', '/no/existe/nada.txt']);
  assert.equal(mal.status, 2);
  const ayuda = cli(['--ayuda']);
  assert.equal(ayuda.status, 0);
  assert.match(ayuda.stdout, /Uso:/);
});
