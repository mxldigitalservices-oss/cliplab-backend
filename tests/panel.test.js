// Fase 5: panel de administración. Las pruebas puras corren siempre; las de integración (consultas, rutas y canal en
// vivo contra Postgres real) solo si defines TEST_DATABASE_URL (una base DESECHABLE: se vacía).
//   TEST_DATABASE_URL=postgres://cl:cl@localhost/cliplab_test npm test
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const URL_DB = process.env.TEST_DATABASE_URL;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cliplab-p-"));
Object.assign(process.env, { CLIPS_DIR: dir, DATA_DIR: dir, MAX_PUB_DIA: "10", MASTER_KEY: "k".repeat(20) });
delete process.env.PUBLICAR_REAL;
if (URL_DB) process.env.DATABASE_URL = URL_DB;

const P = await import("../src/panel.js");
const { ErrorHttp } = await import("../src/errores.js");
const dbTest = (nombre, fn) => test(nombre, { skip: URL_DB ? false : "Define TEST_DATABASE_URL para correr las pruebas con Postgres" }, fn);

const AHORA = Date.parse("2026-11-08T12:00:00Z");
const horas = h => new Date(AHORA + h * 3600e3).toISOString();
const sesion = (extra = {}) => ({ actualizado_en: horas(-5), expira_en: horas(24 * 20), ultimo_test: horas(-1), test_ok: true, test_detalle: null, ...extra });

test("duracionCorta", () => {
  assert.equal(P.duracionCorta(30e3), "1 min");
  assert.equal(P.duracionCorta(45 * 60e3), "45 min");
  assert.equal(P.duracionCorta(5 * 3600e3), "5 h");
  assert.equal(P.duracionCorta(60 * 3600e3), "2 d");
});

test("evaluarPlataforma: lista, con avisos y bloqueada", () => {
  const lista = P.evaluarPlataforma({ plataforma: "tiktok", sesion: sesion(), usoDia: 2, maxPubDia: 10, ahora: AHORA });
  assert.equal(lista.estado, "lista"); assert.ok(lista.listo); assert.deepEqual([lista.motivos, lista.avisos], [[], []]);
  assert.equal(lista.sesion.cargada, true);

  const sin = P.evaluarPlataforma({ plataforma: "instagram", sesion: null, usoDia: 0, maxPubDia: 10, ahora: AHORA });
  assert.equal(sin.estado, "bloqueada"); assert.ok(!sin.listo); assert.match(sin.motivos[0], /No hay sesión/); assert.deepEqual(sin.sesion, { cargada: false });

  const vencida = P.evaluarPlataforma({ plataforma: "tiktok", sesion: sesion({ expira_en: horas(-1) }), ahora: AHORA });
  assert.equal(vencida.estado, "bloqueada"); assert.match(vencida.motivos.join(" "), /venció/);

  const porVencer = P.evaluarPlataforma({ plataforma: "tiktok", sesion: sesion({ expira_en: horas(30) }), ahora: AHORA });
  assert.equal(porVencer.estado, "atencion"); assert.ok(porVencer.listo); assert.match(porVencer.avisos[0], /vence en 30 h/);

  const fallo = P.evaluarPlataforma({ plataforma: "facebook", sesion: sesion({ test_ok: false, test_detalle: "pide login" }), ahora: AHORA });
  assert.equal(fallo.estado, "bloqueada"); assert.match(fallo.motivos[0], /falló: pide login/);

  const sinProbar = P.evaluarPlataforma({ plataforma: "tiktok", sesion: sesion({ test_ok: null, ultimo_test: null }), ahora: AHORA });
  assert.equal(sinProbar.estado, "atencion"); assert.match(sinProbar.avisos[0], /no se ha probado/);

  const sinFecha = P.evaluarPlataforma({ plataforma: "tiktok", sesion: sesion({ expira_en: null }), ahora: AHORA });
  assert.equal(sinFecha.estado, "lista");
});

test("evaluarPlataforma: límite diario", () => {
  const cerca = P.evaluarPlataforma({ plataforma: "tiktok", sesion: sesion(), usoDia: 8, maxPubDia: 10, ahora: AHORA });
  assert.equal(cerca.estado, "atencion"); assert.ok(cerca.listo);
  const tope = P.evaluarPlataforma({ plataforma: "tiktok", sesion: sesion(), usoDia: 10, maxPubDia: 10, ahora: AHORA });
  assert.equal(tope.estado, "bloqueada"); assert.match(tope.motivos[0], /Límite diario alcanzado \(10\/10\)/);
});

const llaves = (cfgs = {}) => ["copy", "auditoria", "analisis", "respaldo"].map(rol => ({
  rol, variable: "K_" + rol, configurada: cfgs[rol] ?? true, modelo: "m", enfriamientoSeg: 0, usos: 0, fallos: 0
}));

test("evaluarIA: llaves propias, respaldo y faltantes", () => {
  const ok = P.evaluarIA(llaves());
  assert.ok(ok.ok); assert.deepEqual(ok.problemas, []); assert.equal(ok.roles.length, 4);

  const conRespaldo = P.evaluarIA(llaves({ copy: false }));
  assert.ok(conRespaldo.ok); assert.match(conRespaldo.avisos[0], /usa la de respaldo/);

  const sinRespaldo = P.evaluarIA(llaves({ analisis: false, respaldo: false }));
  assert.ok(!sinRespaldo.ok);
  assert.deepEqual(sinRespaldo.problemas.length, 1, "los roles con llave propia siguen cubiertos aunque falte el respaldo");
  assert.match(sinRespaldo.problemas[0], /rol analisis/);
  assert.ok(sinRespaldo.avisos.some(a => /No hay llave de respaldo/.test(a)), "el respaldo ausente es un aviso, no un bloqueo");

  const soloRespaldoFalta = P.evaluarIA(llaves({ respaldo: false }));
  assert.ok(soloRespaldoFalta.ok); assert.equal(soloRespaldoFalta.avisos.length, 1);

  const ninguna = P.evaluarIA(llaves({ copy: false, respaldo: false }));
  assert.ok(!ninguna.ok); assert.match(ninguna.problemas.join(" "), /rol copy/);

  const frio = llaves(); frio[1].enfriamientoSeg = 42;
  assert.match(P.evaluarIA(frio).avisos[0], /enfriamiento \(42 s\)/);
});

test("evaluarListo: listo, con avisos y bloqueado", () => {
  const plat = (estado, listo = estado !== "bloqueada") => ({ estado, listo });
  const ia = P.evaluarIA(llaves());
  const bien = P.evaluarListo({ plataformas: [plat("lista"), plat("lista"), plat("lista")], ia, agenteOcupado: false, publicarReal: true });
  assert.deepEqual([bien.nivel, bien.operativo, bien.plataformasListas], ["listo", true, 3]);

  const prueba = P.evaluarListo({ plataformas: [plat("lista"), plat("bloqueada"), plat("lista")], ia, publicarReal: false });
  assert.equal(prueba.nivel, "atencion"); assert.ok(prueba.operativo); assert.match(prueba.avisos[0], /Modo prueba/);

  const ocupado = P.evaluarListo({ plataformas: [plat("lista")], ia, agenteOcupado: true, publicarReal: true });
  assert.equal(ocupado.nivel, "atencion"); assert.match(ocupado.avisos[0], /ocupado/);

  const ninguna = P.evaluarListo({ plataformas: [plat("bloqueada"), plat("bloqueada")], ia, publicarReal: true });
  assert.equal(ninguna.nivel, "bloqueado"); assert.ok(!ninguna.operativo); assert.match(ninguna.problemas[0], /Ninguna red social/);

  const sinIA = P.evaluarListo({ plataformas: [plat("lista")], ia: P.evaluarIA(llaves({ analisis: false, respaldo: false })), publicarReal: true });
  assert.equal(sinIA.nivel, "bloqueado");
});

test("resolverFiltro", () => {
  assert.deepEqual(P.resolverFiltro(undefined), [...P.VARIANTES_ACTIVAS]);
  assert.deepEqual(P.resolverFiltro("historial"), ["publicada", "simulada", "cancelada"]);
  assert.equal(P.resolverFiltro("todas").length, P.ESTADOS_VARIANTE.length);
  assert.deepEqual(P.resolverFiltro("incierta"), ["incierta"]);
  assert.throws(() => P.resolverFiltro("x'; DROP TABLE variantes;--"), e => e instanceof ErrorHttp && e.status === 400);
});

// ---------- Canal en vivo (sin red ni base de datos) ----------
function falsos() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.escrito = []; res.cabeceras = null; res.cerrado = false;
  res.writeHead = (c, h) => { res.codigo = c; res.cabeceras = h; };
  res.flushHeaders = () => {};
  res.write = t => { res.escrito.push(t); return true; };
  res.end = () => { res.cerrado = true; };
  return { req, res };
}
const soltar = () => new Promise(r => setImmediate(r));
const eventos = res => res.escrito.filter(t => t.startsWith("event:")).map(t => t.split("\n")[0].slice(7));

test("crearCentro: envía cuando cambia, latido cuando no, y se detiene sin clientes", async () => {
  let reloj = 1_000_000, n = 0, valor = "a";
  const timers = [];
  const temporizador = { set: fn => { const t = { fn, borrado: false, unref() {} }; timers.push(t); return t; }, clear: t => { t.borrado = true; } };
  const centro = P.crearCentro({ construir: async () => { n++; return { t: "x" + n, valor }; }, ahora: () => reloj, latidoMs: 10000, temporizador });

  const a = falsos();
  assert.ok(centro.suscribir(a.req, a.res));
  assert.equal(a.res.codigo, 200);
  assert.match(a.res.cabeceras["Content-Type"], /text\/event-stream/);
  assert.equal(a.res.cabeceras["X-Accel-Buffering"], "no");
  await soltar();
  assert.deepEqual(eventos(a.res), ["estado"]);
  assert.match(a.res.escrito[0], /^retry: 5000/);

  await centro.tick();                                   // mismo contenido (solo cambia "t"): no se reenvía
  assert.deepEqual(eventos(a.res), ["estado"]);
  reloj += 11000; await centro.tick();                  // pasó el intervalo de latido
  assert.deepEqual(eventos(a.res), ["estado", "latido"]);

  valor = "b"; await centro.tick();
  assert.deepEqual(eventos(a.res), ["estado", "latido", "estado"]);
  assert.match(a.res.escrito.at(-1), /"valor":"b"/);

  const b = falsos();                                    // un cliente nuevo recibe lo último de inmediato
  centro.suscribir(b.req, b.res);
  assert.match(b.res.escrito.find(t => t.startsWith("event: estado")), /"valor":"b"/);
  await soltar();

  const antes = n;
  a.req.emit("close"); assert.equal(centro.conectados, 1);
  b.req.emit("close"); assert.equal(centro.conectados, 0);
  assert.ok(timers.at(-1).borrado, "sin clientes el temporizador se detiene");
  await centro.tick(); assert.equal(n, antes, "sin clientes no se consulta nada");
});

test("crearCentro: límite de conexiones, errores y cierre", async () => {
  let falla = true;
  const centro = P.crearCentro({ construir: async () => { if (falla) throw new Error("db caída\ndetalle interno"); return { t: "1", ok: true }; }, max: 2, temporizador: { set: () => ({ unref() {} }), clear() {} } });
  const a = falsos(), b = falsos(), c = falsos();
  assert.ok(centro.suscribir(a.req, a.res)); assert.ok(centro.suscribir(b.req, b.res));
  assert.equal(centro.suscribir(c.req, c.res), false, "la tercera conexión se rechaza");
  assert.equal(c.res.codigo, undefined, "la rechazada no recibe cabeceras SSE");
  await soltar();
  assert.deepEqual(eventos(a.res), ["fallo"]);
  const fallo = a.res.escrito.find(t => t.startsWith("event: fallo"));
  assert.match(fallo, /db caída/); assert.doesNotMatch(fallo, /detalle interno/);

  falla = false; await centro.tick();                    // tras el fallo vuelve a enviar aunque el contenido sea nuevo
  assert.deepEqual(eventos(b.res), ["fallo", "estado"]);

  centro.cerrar();
  assert.ok(a.res.cerrado && b.res.cerrado); assert.equal(centro.conectados, 0);
});

// ---------- Integración con Postgres real ----------
if (URL_DB) {
  const { db, q, iniciarDb } = await import("../src/db.js");
  const express = (await import("express")).default;
  const { rutasPanel, cerrarPanel } = await import("../src/rutas-panel.js");

  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await iniciarDb();

  const reset = () => q("TRUNCATE lote_eventos, lote_items, lote_ciclos, variantes, lotes, publicaciones, clips, fuentes, jobs, sesiones RESTART IDENTITY CASCADE");
  const sembrar = async () => {
    await reset();
    const { rows: [f] } = await q("INSERT INTO fuentes(url, video_id, estado) VALUES('https://youtu.be/x','abcdefghijk','listo') RETURNING id");
    const clip = async (titulo, estado, extra = {}) => (await q(
      "INSERT INTO clips(fuente_id, titulo, inicio_seg, fin_seg, estado, error, archivo, tam_bytes) VALUES($1,$2,10,50,$3,$4,$5,$6) RETURNING id",
      [f.id, titulo, estado, extra.error || null, extra.archivo || null, extra.bytes || null])).rows[0].id;
    const c1 = await clip("Clip listo", "listo", { archivo: "/tmp/no-existe.mp4", bytes: 3 * 1048576 });
    const c2 = await clip("Clip roto", "error", { error: "FFmpeg falló" });
    const c3 = await clip("Clip publicado", "publicado");
    const { rows: [lote] } = await q("INSERT INTO lotes(nombre, tipo, clip_id, estado, total) VALUES('Reciclaje A','reciclaje',$1,'corriendo',5) RETURNING id", [c1]);
    const variante = async (titulo, estado, horasMas = 1, error = null) => (await q(
      "INSERT INTO variantes(clip_id, lote_id, titulo, angulo, plataformas, estado, programada_para, error) VALUES($1,$2,$3,'Valor','{tiktok,instagram}',$4, now() + ($5 || ' hours')::interval, $6) RETURNING id",
      [c1, lote.id, titulo, estado, String(horasMas), error])).rows[0].id;
    const v = {
      prog: await variante("Variante programada", "programada", 2),
      incierta: await variante("Variante incierta", "incierta", -1),
      error: await variante("Variante con error", "error", -2, "No se publicó en ninguna plataforma."),
      parcial: await variante("Variante parcial", "parcial", -3, "Solo en algunas."),
      ok: await variante("Variante publicada", "publicada", -4)
    };
    await q("INSERT INTO lote_items(lote_id, tipo, clip_id, variante_id, estado, detalle, terminado_en) VALUES($1,'publicar_variante',$2,$3,'error','Se agotaron los intentos', now())", [lote.id, c1, v.error]);
    await q("INSERT INTO lote_items(lote_id, tipo, clip_id, variante_id, estado) VALUES($1,'publicar_variante',$2,$3,'pendiente')", [lote.id, c1, v.prog]);
    await q("INSERT INTO lote_ciclos(estado, total, hechos, fallidos) VALUES('abierto', 10, 3, 1)");
    await q("INSERT INTO lote_eventos(lote_id, variante_id, evento, estado, detalle) VALUES($1,$2,'variante_resultado','error','x')", [lote.id, v.error]);
    // publicaciones: incierta del clip base, incierta de una variante, una "ok" de TikTok hoy y una incierta ya descartada
    await q("INSERT INTO publicaciones(clip_id, plataforma, estado, detalle) VALUES($1,'tiktok','incierto','Se pulsó Publicar pero no se confirmó')", [c1]);
    await q("INSERT INTO publicaciones(clip_id, plataforma, estado, detalle, variante_id) VALUES($1,'instagram','incierto','sin confirmar',$2)", [c1, v.incierta]);
    await q("INSERT INTO publicaciones(clip_id, plataforma, estado, detalle) VALUES($1,'facebook','ok','')", [c3]);
    await q("INSERT INTO publicaciones(clip_id, plataforma, estado, detalle) VALUES($1,'facebook','descartado','viejo')", [c3]);
    await q("INSERT INTO jobs(tipo, ref_id, estado) VALUES('cortar',1,'pendiente'),('publicar',1,'corriendo'),('analizar',1,'error')");
    await q("INSERT INTO sesiones(plataforma, datos, expira_en, ultimo_test, test_ok) VALUES('tiktok','x', now() + interval '20 days', now(), true)");
    return { c1, c2, c3, lote: lote.id, v };
  };
  const deps = async () => {
    const { listarSesiones } = await import("../src/sesiones.js");
    const { estadoLlaves } = await import("../src/gemini.js");
    const { monitor, listarLotes } = await import("../src/lotes.js");
    return { consulta: q, monitor, listarLotes, listarSesiones, estadoLlaves, agenteOcupado: () => false, discoMb: async () => 12 };
  };

  dbTest("incidencias: inciertas vigentes, variantes con problemas, clips y elementos con error", async () => {
    const s = await sembrar();
    const inc = await P.incidencias(q);
    assert.equal(inc.inciertas.length, 2);
    const base = inc.inciertas.find(i => !i.variante_id), enVariante = inc.inciertas.find(i => i.variante_id);
    assert.deepEqual([base.clip_id, base.plataforma, base.clip_titulo], [String(s.c1), "tiktok", "Clip listo"]);
    assert.deepEqual([enVariante.variante_id, enVariante.plataforma, enVariante.variante_titulo], [String(s.v.incierta), "instagram", "Variante incierta"]);
    assert.deepEqual(inc.variantes.map(v => v.estado).sort(), ["error", "parcial"]);
    assert.ok(inc.variantes.every(v => v.lote === "Reciclaje A" && v.lote_estado === "corriendo" && v.clip_titulo === "Clip listo"));
    assert.deepEqual(inc.clips.map(c => c.titulo), ["Clip roto"]);
    assert.equal(inc.items.length, 1); assert.equal(inc.items[0].lote, "Reciclaje A");
    assert.deepEqual(inc.conteos, { inciertas: 2, variantes: 2, clips: 1, items: 1, accionables: 5 });

    // Resolver (descartar) la incierta del clip base la saca de la lista; la ya descartada de Facebook nunca aparece.
    await q("UPDATE publicaciones SET estado='descartado' WHERE clip_id=$1 AND variante_id IS NULL AND plataforma='tiktok'", [s.c1]);
    const despues = await P.incidencias(q);
    assert.deepEqual(despues.inciertas.map(i => i.plataforma), ["instagram"]);
    // Un incierto reemplazado por un "ok" posterior ya no es una incidencia vigente.
    await q("INSERT INTO publicaciones(clip_id, plataforma, estado, variante_id) VALUES($1,'instagram','ok',$2)", [s.c1, s.v.incierta]);
    assert.equal((await P.incidencias(q)).inciertas.length, 0);
  });

  dbTest("variantesPanel: filtros, orden y límite", async () => {
    const s = await sembrar();
    const activas = await P.variantesPanel(q, {});
    assert.deepEqual(activas.map(v => v.estado), ["parcial", "error", "incierta", "programada"], "de la más atrasada a la más próxima");
    assert.equal(activas.length, 4, "publicada no es activa");
    const horasProg = activas.map(v => new Date(v.programada_para).getTime());
    assert.deepEqual(horasProg, [...horasProg].sort((a, b) => a - b), "las activas salen por hora de salida ascendente");
    assert.equal(activas.at(-1).id, String(s.v.prog));
    assert.deepEqual((await P.variantesPanel(q, { estado: "historial" })).map(v => v.estado), ["publicada"]);
    assert.equal((await P.variantesPanel(q, { estado: "todas" })).length, 5);
    assert.equal((await P.variantesPanel(q, { estado: "todas", limite: 2 })).length, 2);
    await assert.rejects(() => P.variantesPanel(q, { estado: "inventado" }), e => e.status === 400);
    const v = activas[0];
    for (const k of ["titulo", "angulo", "plataformas", "lote", "lote_estado", "clip_titulo", "programada_para", "intentos", "aplazos", "error"]) assert.ok(k in v, k);
  });

  dbTest("instantanea: estado, listo para operar, inventario, monitor y actividad", async () => {
    const s = await sembrar();
    const snap = await P.instantanea(await deps());
    assert.equal(snap.sistema.modo, "prueba"); assert.equal(snap.sistema.discoMb, 12); assert.equal(snap.sistema.db, true);

    const por = Object.fromEntries(snap.listo.plataformas.map(p => [p.plataforma, p]));
    assert.equal(por.tiktok.estado, "lista"); assert.equal(por.tiktok.usoDia, 1, "el incierto de hoy cuenta para el límite diario");
    assert.equal(por.instagram.estado, "bloqueada"); assert.equal(por.instagram.usoDia, 1);
    assert.equal(por.facebook.usoDia, 1); assert.ok(por.facebook.ultimaOk);
    assert.equal(snap.listo.plataformasListas, 1);
    assert.ok(snap.listo.avisos.some(a => /Modo prueba/.test(a)));
    assert.equal(snap.listo.ia.roles.length, 4);

    assert.deepEqual(snap.inventario.clips, { listo: 1, error: 1, publicado: 1 });
    assert.equal(snap.inventario.total, 3); assert.equal(snap.inventario.conArchivo, 1); assert.equal(snap.inventario.mb, 3);
    assert.deepEqual(snap.inventario.fuentes, { listo: 1 });
    assert.deepEqual([snap.inventario.jobs.pendientes, snap.inventario.jobs.corriendo, snap.inventario.jobs.errores24h], [1, 1, 1]);

    assert.equal(snap.monitor.cicloAbierto.total, 10);
    assert.equal(snap.monitor.variantes.programada, 1);
    assert.equal(snap.monitor.proximasVariantes[0].id, String(s.v.prog));
    assert.equal(snap.lotes.length, 1); assert.equal(snap.lotes[0].items.error, 1);
    assert.equal(snap.incidencias.conteos.accionables, 5);
    assert.equal(snap.actividad[0].evento, "variante_resultado"); assert.equal(snap.actividad[0].lote, "Reciclaje A");

    const sinTodo = await (async () => { await reset(); return P.instantanea(await deps()); })();
    assert.equal(sinTodo.listo.nivel, "bloqueado");
    assert.equal(sinTodo.inventario.total, 0); assert.equal(sinTodo.monitor.cicloAbierto, null); assert.deepEqual(sinTodo.actividad, []);
    assert.equal(JSON.parse(JSON.stringify(sinTodo)).sistema.arranque, snap.sistema.arranque, "el arranque no cambia entre lecturas");
  });

  dbTest("rutas /api/panel/*: JSON, filtros y canal en vivo (SSE)", async () => {
    await sembrar();
    const app = express();
    app.use("/api", rutasPanel);
    app.use((e, req, res, next) => res.status(e.status || 500).json({ error: e.message }));
    const srv = await new Promise(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}/api/panel`;
    const get = async (ruta, opts) => { const r = await fetch(base + ruta, opts); return { r, d: await r.json() }; };
    try {
      const { r, d } = await get("/instantanea");
      assert.equal(r.status, 200); assert.equal(d.listo.plataformas.length, 3); assert.ok(d.monitor.config);
      assert.equal((await get("/listo")).d.plataformas.length, 3);
      assert.equal((await get("/incidencias")).d.conteos.accionables, 5);
      assert.equal((await get("/variantes?estado=historial")).d.length, 1);
      assert.equal((await get("/variantes?estado=raro")).r.status, 400);
      assert.equal((await get("/eventos?limite=5")).d.length, 1);

      // SSE: la primera lectura llega sola y las cabeceras son las de un canal de eventos.
      const ac = new AbortController();
      const r2 = await fetch(base + "/stream", { signal: ac.signal });
      assert.equal(r2.status, 200);
      assert.match(r2.headers.get("content-type"), /text\/event-stream/);
      const lector = r2.body.getReader();
      let texto = "";
      const limite = Date.now() + 10000;
      while (!/event: estado\ndata: \{.*\}\n\n/s.test(texto) && Date.now() < limite) {
        const { value, done } = await lector.read();
        if (done) break;
        texto += Buffer.from(value).toString("utf8");
      }
      assert.match(texto, /^retry: 5000/);
      const dato = texto.match(/event: estado\ndata: (.*)\n\n/)[1];
      assert.equal(JSON.parse(dato).listo.plataformas.length, 3);
      ac.abort();
    } finally {
      cerrarPanel();
      await new Promise(r => srv.close(r));
    }
  });

  test.after(async () => { cerrarPanel(); await db.end(); });
}
