import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL = 'error';
delete process.env.REDIS_URL;
const { crearAlmacen } = await import('../src/storage/redis-programador.js');

// ---- Redis simulado: SOLO los comandos que usa el modulo (SET NX PX, GET, DEL, EVAL de los dos scripts, ZSET, SCAN) ----
class ServidorFalso {
  constructor(reloj) { this.reloj = reloj; this.claves = new Map(); this.caido = false; }
  vivo(key) {
    const e = this.claves.get(key);
    if (e && e.expira !== null && e.expira <= this.reloj()) { this.claves.delete(key); return null; }
    return e || null;
  }
  cliente() {
    const s = this;
    const f = (fn) => async (...a) => { if (s.caido) throw new Error('ECONNRESET'); return fn(...a); };
    const manejadores = {};
    return {
      on: (ev, fn) => { manejadores[ev] = fn; },
      emitir: (ev, ...a) => manejadores[ev] && manejadores[ev](...a),
      connect: async () => { if (s.caido) throw new Error('ECONNREFUSED'); },
      quit: async () => {}, disconnect: async () => {},
      set: f(async (key, val, o = {}) => {
        if (o.NX && s.vivo(key)) return null;
        s.claves.set(key, { tipo: 's', val, expira: o.PX ? s.reloj() + o.PX : null });
        return 'OK';
      }),
      get: f(async (key) => { const e = s.vivo(key); return e ? e.val : null; }),
      del: f(async (k) => { const ks = [].concat(k); let n = 0; for (const x of ks) if (s.claves.delete(x)) n++; return n; }),
      eval: f(async (script, { keys, arguments: args }) => {
        const e = s.vivo(keys[0]);
        if (!e || e.val !== args[0]) return 0;
        if (script.includes('"zremrangebyscore"')) {
          const e = s.vivo(keys[0]) || { tipo: 'z', miembros: [], expira: null };
          const min = Number(args[0]);
          e.miembros = e.miembros.filter((m) => !(m.score <= min));
          const total = e.miembros.length;
          const tope = Number(args[1]);
          const ventana = Number(args[2]);
          const ts = Number(args[3]);
          if (total >= tope) {
            const ord = [...e.miembros].sort((a, b) => a.score - b.score);
            const proximo = ord[0] ? Number(ord[0].score) + ventana : ts + ventana;
            s.claves.set(keys[0], e);
            return [0, total, String(proximo)];
          }
          e.miembros.push({ score: ts, value: args[4] });
          e.expira = ts + Number(args[5]);
          s.claves.set(keys[0], e);
          return [1, total + 1, "0"];
        }
        if (script.includes('"del"')) { s.claves.delete(keys[0]); return 1; }
        if (script.includes('"pexpire"')) { e.expira = s.reloj() + Number(args[1]); return 1; }
        throw new Error('script desconocido');
      }),
      zAdd: f(async (key, { score, value }) => { const e = s.vivo(key) || { tipo: 'z', miembros: [], expira: null }; e.miembros.push({ score, value }); s.claves.set(key, e); return 1; }),
      zCard: f(async (key) => (s.vivo(key) ? s.vivo(key).miembros.length : 0)),
      zRemRangeByScore: f(async (key, min, max) => { const e = s.vivo(key); if (!e) return 0; const antes = e.miembros.length; e.miembros = e.miembros.filter((m) => !(m.score >= min && m.score <= max)); return antes - e.miembros.length; }),
      zRangeWithScores: f(async (key, a, b) => { const e = s.vivo(key); if (!e) return []; return [...e.miembros].sort((x, y) => x.score - y.score).slice(a, b + 1); }),
      zRem: f(async (key, id) => { const e = s.vivo(key); if (!e) return 0; const antes = e.miembros.length; e.miembros = e.miembros.filter((m) => m.value !== id); return antes - e.miembros.length; }),
      pExpire: f(async (key, ms) => { const e = s.vivo(key); if (e) e.expira = s.reloj() + ms; return 1; }),
      scanIterator: ({ MATCH }) => (async function* () { const pre = MATCH.replace(/\*$/, ''); for (const key of [...s.claves.keys()]) if (key.startsWith(pre) && s.vivo(key)) yield key; })(),
    };
  }
}

function reloj(inicio = 1_000_000) {
  let t = inicio;
  const ahora = () => t;
  ahora.avanzar = (ms) => { t += ms; };
  return ahora;
}
const HORA = 3600 * 1000;

// ============================ modo memoria (sin REDIS_URL) ============================
test('sin REDIS_URL: arranca en memoria, lo dice claramente y no intenta conectar', async () => {
  let fabricado = false;
  const a = crearAlmacen({ url: '', fabricaCliente: () => { fabricado = true; } });
  const e = await a.iniciar();
  assert.equal(e.modo, 'memoria');
  assert.equal(e.conectado, false);
  assert.equal(e.configurado, false);
  assert.match(e.detalle, /REDIS_URL/);
  assert.equal(fabricado, false);
});

test('lock en memoria: exclusivo, con TTL, renovable y solo lo libera su dueno', async () => {
  const ahora = reloj();
  const a = crearAlmacen({ url: '', ahora });
  const t1 = await a.adquirirLock('envio', 1000);
  assert.ok(t1);
  assert.equal(await a.adquirirLock('envio', 1000), null);
  assert.equal(await a.liberarLock('envio', 'token-ajeno'), false);
  assert.equal(await a.renovarLock('envio', t1, 5000), true);
  ahora.avanzar(4000);
  assert.equal(await a.adquirirLock('envio', 1000), null, 'renovado: sigue tomado');
  ahora.avanzar(1500);
  const t2 = await a.adquirirLock('envio', 1000);
  assert.ok(t2 && t2 !== t1, 'vencido por TTL: otro puede tomarlo');
  assert.equal(await a.liberarLock('envio', t2), true);
  assert.ok(await a.adquirirLock('envio', 1000));
});

test('conLock: ejecuta, libera siempre (incluso si falla) y avisa si esta ocupado', async () => {
  const a = crearAlmacen({ url: '' });
  const r = await a.conLock('x', 1000, async () => 42);
  assert.deepEqual(r, { adquirido: true, valor: 42 });
  await assert.rejects(a.conLock('x', 1000, async () => { throw new Error('boom'); }), /boom/);
  assert.equal((await a.conLock('x', 1000, async () => 1)).adquirido, true, 'se libero tras el error');
  const token = await a.adquirirLock('y', 1000);
  assert.deepEqual(await a.conLock('y', 1000, async () => 1), { adquirido: false });
  await a.liberarLock('y', token);
});

test('ventana deslizante: maximo 2 por hora, informa cuando se libera el siguiente hueco y se recupera', async () => {
  const ahora = reloj();
  const a = crearAlmacen({ url: '', ahora });
  const r1 = await a.reservarEnVentana('tiktok', { tope: 2 });
  ahora.avanzar(10 * 60 * 1000);
  const r2 = await a.reservarEnVentana('tiktok', { tope: 2 });
  assert.equal(r1.permitido && r2.permitido, true);
  assert.equal(r2.cuenta, 2);

  ahora.avanzar(5 * 60 * 1000);
  const r3 = await a.reservarEnVentana('tiktok', { tope: 2 });
  assert.equal(r3.permitido, false);
  assert.equal(r3.proximoEn, 1_000_000 + HORA, 'el hueco se abre cuando vence la mas antigua');
  assert.equal(await a.contarVentana('tiktok'), 2);

  assert.equal((await a.reservarEnVentana('instagram', { tope: 2 })).permitido, true, 'cada canal tiene su ventana');

  ahora.avanzar(HORA - 15 * 60 * 1000 + 1);
  assert.equal((await a.reservarEnVentana('tiktok', { tope: 2 })).permitido, true, 'vencida la primera, hay hueco');
  await assert.rejects(a.reservarEnVentana('x', { tope: 0 }), /tope/);
});

test('devolver una reserva libera el hueco', async () => {
  const a = crearAlmacen({ url: '' });
  const r1 = await a.reservarEnVentana('fb', { tope: 1 });
  assert.equal((await a.reservarEnVentana('fb', { tope: 1 })).permitido, false);
  await a.devolverReserva('fb', r1.id);
  assert.equal((await a.reservarEnVentana('fb', { tope: 1 })).permitido, true);
});

test('cache corta: TTL, lectura-escritura, cacheObtener carga una sola vez e invalida por clave o prefijo', async () => {
  const ahora = reloj();
  const a = crearAlmacen({ url: '', ahora });
  assert.equal(await a.cacheLeer('cola'), undefined);
  let cargas = 0;
  const cargar = async () => { cargas++; return { n: cargas }; };
  assert.deepEqual(await a.cacheObtener('cola', 5000, cargar), { n: 1 });
  assert.deepEqual(await a.cacheObtener('cola', 5000, cargar), { n: 1 });
  assert.equal(cargas, 1);
  ahora.avanzar(5001);
  assert.deepEqual(await a.cacheObtener('cola', 5000, cargar), { n: 2 }, 'vencida por TTL');

  await a.cacheEscribir('cola:a', 1); await a.cacheEscribir('cola:b', 2); await a.cacheEscribir('otra', 3);
  await a.invalidarCache('cola:*');
  assert.equal(await a.cacheLeer('cola:a'), undefined);
  assert.equal(await a.cacheLeer('cola:b'), undefined);
  assert.equal(await a.cacheLeer('otra'), 3);
  await a.invalidarCache('otra');
  assert.equal(await a.cacheLeer('otra'), undefined);
});

// ============================ modo Redis (servidor simulado) ============================
test('con Redis sano: usa Redis, las claves llevan prefijo y estado() no filtra la URL', async () => {
  const ahora = reloj();
  const srv = new ServidorFalso(ahora);
  const a = crearAlmacen({ url: 'redis://usuario:SECRETO@host:6379', ahora, fabricaCliente: () => srv.cliente() });
  const e = await a.iniciar();
  assert.equal(e.modo, 'redis');
  assert.equal(e.conectado, true);
  assert.ok(!JSON.stringify(e).includes('SECRETO'));

  const token = await a.adquirirLock('envio', 1000);
  assert.ok([...srv.claves.keys()].includes('cliplab:prog:lock:envio'));
  assert.equal(await a.adquirirLock('envio', 1000), null);
  assert.equal(await a.liberarLock('envio', 'otro'), false);
  assert.equal(await a.liberarLock('envio', token), true);

  await a.cacheEscribir('cola', { a: 1 }, 3000);
  assert.deepEqual(await a.cacheLeer('cola'), { a: 1 });
  ahora.avanzar(3001);
  assert.equal(await a.cacheLeer('cola'), undefined);
  await a.cacheEscribir('cola:1', 1); await a.cacheEscribir('cola:2', 2);
  await a.invalidarCache('cola:*');
  assert.equal(await a.cacheLeer('cola:1'), undefined);
});

test('dos instancias comparten Redis: lock mutuamente excluyente y el tope de 2/h se respeta en conjunto', async () => {
  const ahora = reloj();
  const srv = new ServidorFalso(ahora);
  const mk = () => crearAlmacen({ url: 'redis://x', ahora, fabricaCliente: () => srv.cliente() });
  const A = mk(); const B = mk();
  await A.iniciar(); await B.iniciar();

  const tA = await A.adquirirLock('ejecucion', 5000);
  assert.ok(tA);
  assert.equal(await B.adquirirLock('ejecucion', 5000), null, 'B no ejecuta mientras A lo tiene');
  await A.liberarLock('ejecucion', tA);
  assert.ok(await B.adquirirLock('ejecucion', 5000));

  const resultados = await Promise.all([
    A.reservarEnVentana('tiktok', { tope: 2 }), B.reservarEnVentana('tiktok', { tope: 2 }),
    A.reservarEnVentana('tiktok', { tope: 2 }), B.reservarEnVentana('tiktok', { tope: 2 }),
  ]);
  assert.equal(resultados.filter((r) => r.permitido).length, 2, JSON.stringify(resultados.map((r) => r.permitido)));
  assert.equal(await A.contarVentana('tiktok'), 2);
});

// ============================ fallos y recuperacion ============================
test('Redis inalcanzable al arrancar: cae a memoria, sigue funcionando y reintenta pasado el plazo', async () => {
  const ahora = reloj();
  const srv = new ServidorFalso(ahora);
  srv.caido = true;
  const a = crearAlmacen({ url: 'redis://x', ahora, reintentoMs: 30000, fabricaCliente: () => srv.cliente() });
  const e = await a.iniciar();
  assert.equal(e.modo, 'memoria');
  assert.match(e.detalle, /Redis no disponible/);
  assert.ok(await a.adquirirLock('envio', 1000), 'sigue operando en memoria');

  srv.caido = false;
  await a.cacheLeer('x');                       // antes del plazo: no reintenta
  assert.equal(a.estado().modo, 'memoria');
  ahora.avanzar(31000);
  await a.cacheLeer('x');                       // dispara la reconexion en segundo plano
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(a.estado().modo, 'redis');
});

test('Redis cae EN USO: la operacion no falla, se cambia a memoria y el tope por hora no se pierde', async () => {
  const ahora = reloj();
  const srv = new ServidorFalso(ahora);
  const a = crearAlmacen({ url: 'redis://x', ahora, fabricaCliente: () => srv.cliente() });
  await a.iniciar();
  assert.equal((await a.reservarEnVentana('tiktok', { tope: 2 })).permitido, true);
  assert.equal((await a.reservarEnVentana('tiktok', { tope: 2 })).permitido, true);

  srv.caido = true;                             // Redis desaparece
  const r = await a.reservarEnVentana('tiktok', { tope: 2 });
  assert.equal(r.permitido, false, 'el espejo local recuerda las 2 publicaciones: no se supera el tope');
  assert.equal(a.estado().modo, 'memoria');
  assert.match(a.estado().ultimoError, /ECONNRESET/);
  assert.equal(await a.cacheLeer('cola'), undefined, 'las demas operaciones siguen respondiendo');
});

test('un evento de error del cliente tambien activa el respaldo en memoria', async () => {
  const srv = new ServidorFalso(reloj());
  let cli;
  const a = crearAlmacen({ url: 'redis://x', fabricaCliente: () => (cli = srv.cliente()) });
  await a.iniciar();
  assert.equal(a.estado().modo, 'redis');
  cli.emitir('error', new Error('socket cerrado'));
  assert.equal(a.estado().modo, 'memoria');
  assert.ok(await a.adquirirLock('x', 1000));
});

test('cerrar() deja el almacen en memoria y no reintenta conectar', async () => {
  const srv = new ServidorFalso(reloj());
  let fabricas = 0;
  const a = crearAlmacen({ url: 'redis://x', reintentoMs: 0, fabricaCliente: () => { fabricas++; return srv.cliente(); } });
  await a.iniciar();
  await a.cerrar();
  await a.cacheLeer('x');
  await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(fabricas, 1);
  assert.equal(a.estado().modo, 'memoria');
});
