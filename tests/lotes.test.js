// Integración con Postgres real. Se ejecuta solo si defines TEST_DATABASE_URL (una base DESECHABLE: se vacía).
//   TEST_DATABASE_URL=postgres://cl:cl@localhost/cliplab_test npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const URL_DB = process.env.TEST_DATABASE_URL;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cliplab-l-"));
Object.assign(process.env, { CLIPS_DIR: dir, LOTE_PAUSA_S: "0", MAX_PUB_DIA: "3", APLAZO_MIN: "120", PROTEGER_HORAS: "3", MASTER_KEY: "k".repeat(20) });
if (URL_DB) process.env.DATABASE_URL = URL_DB;

const { estadoLote } = await import("../src/lotes.js");
const dbTest = (nombre, fn) => test(nombre, { skip: URL_DB ? false : "Define TEST_DATABASE_URL para correr las pruebas con Postgres" }, fn);

test("estadoLote: transiciones puras", () => {
  assert.equal(estadoLote({ estado: "pendiente", vivos: 5, errores: 0, iniciados: 0 }), "pendiente");
  assert.equal(estadoLote({ estado: "pendiente", vivos: 5, errores: 0, iniciados: 2 }), "corriendo");
  assert.equal(estadoLote({ estado: "corriendo", vivos: 0, errores: 0, iniciados: 9 }), "completado");
  assert.equal(estadoLote({ estado: "corriendo", vivos: 0, errores: 2, iniciados: 9 }), "con_errores");
  for (const e of ["pausado", "cancelado", "completado"]) assert.equal(estadoLote({ estado: e, vivos: 0, errores: 0, iniciados: 1 }), e);
});

if (URL_DB) {
  const { db, q, iniciarDb } = await import("../src/db.js");
  const { cfg } = await import("../src/config.js");
  const L = await import("../src/lotes.js");
  const V = await import("../src/variantes.js");
  const { limpiar, borrarArchivoClip } = await import("../src/janitor.js");
  const { rutasLotes } = await import("../src/rutas-lotes.js");
  const express = (await import("express")).default;

  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await iniciarDb();
  await iniciarDb();   // idempotente

  const reset = () => q("TRUNCATE lote_eventos, lote_items, lote_ciclos, variantes, lotes, publicaciones, clips, fuentes, jobs, sesiones RESTART IDENTITY CASCADE");
  const sembrar = async (n, extra = {}) => {
    const { rows: [f] } = await q("INSERT INTO fuentes(url, video_id) VALUES('https://youtu.be/x','abcdefghijk') RETURNING id");
    const ids = [];
    for (let i = 0; i < n; i++) {
      const { rows: [c] } = await q("INSERT INTO clips(fuente_id, titulo, gancho, descripcion, cta, hashtags, inicio_seg, fin_seg, estado, archivo) VALUES($1,$2,'gancho base','desc base','cta base','{#base}',10,50,$3,$4) RETURNING id, token",
        [f.id, `Clip base ${i}`, extra.estado || "listo", extra.archivo || null]);
      ids.push(c);
    }
    return ids;
  };
  // Simula el worker: reclama cada job pendiente y corre hLoteItem con manejadores falsos.
  const correrJobs = async manejadores => {
    const { rows } = await q("SELECT * FROM jobs WHERE estado='pendiente' ORDER BY id");
    for (const j of rows) {
      await q("UPDATE jobs SET estado='corriendo', intentos=intentos+1 WHERE id=$1", [j.id]);
      const job = { ...j, intentos: j.intentos + 1 };
      try { await L.hLoteItem(job, { manejadores }); await q("UPDATE jobs SET estado='hecho' WHERE id=$1", [j.id]); }
      catch (e) { await q("UPDATE jobs SET estado=$2, error=$3 WHERE id=$1", [j.id, job.intentos >= job.max_intentos ? "error" : "pendiente", e.message]); }
    }
    return rows.length;
  };
  const cuenta = async (tabla, donde = "true") => (await q(`SELECT count(*)::int AS n FROM ${tabla} WHERE ${donde}`)).rows[0].n;
  const ok = async () => ({ ok: true, detalle: "ok" });

  dbTest("ciclos: bloques de 10 a 20, uno a la vez, hasta terminar el lote", async () => {
    await reset();
    const clips = await sembrar(25);
    const lote = await L.crearLoteCortes({ nombre: "prueba", clipIds: clips.map(c => c.id) });
    assert.equal(lote.total, 25);
    assert.equal(await cuenta("lote_items", "estado='pendiente'"), 25);

    const t1 = await L.tick();
    assert.equal(t1.ciclo.n, 10, "primer ciclo = LOTE_TAMANO (10)");
    assert.equal(await cuenta("jobs", "estado='pendiente' AND tipo='lote_medios'"), 10, "solo 10 jobs vivos");
    assert.equal(await cuenta("lote_items", "estado='encolado'"), 10);
    assert.equal((await q("SELECT estado FROM lotes")).rows[0].estado, "corriendo");

    assert.equal((await L.tick()).ciclo, null, "no abre otro ciclo mientras el primero sigue abierto");
    assert.equal(await cuenta("jobs"), 10);

    await correrJobs({ cortar: ok });
    const t2 = await L.tick();
    assert.equal(t2.cerrados, 1);
    assert.equal(t2.ciclo.n, 10, "segundo ciclo");
    await correrJobs({ cortar: ok });
    const t3 = await L.tick();
    assert.equal(t3.ciclo.n, 5, "el resto corre como ciclo parcial");
    await correrJobs({ cortar: ok });
    const t4 = await L.tick();
    assert.equal(t4.ciclo, null);

    const { rows: ciclos } = await q("SELECT * FROM lote_ciclos ORDER BY id");
    assert.deepEqual(ciclos.map(c => [c.total, c.hechos, c.fallidos, c.estado]), [[10, 10, 0, "completado"], [10, 10, 0, "completado"], [5, 5, 0, "completado"]]);
    assert.ok(ciclos.every(c => c.terminado_en && c.iniciado_en));
    const { rows: [l] } = await q("SELECT * FROM lotes");
    assert.equal(l.estado, "completado");
    assert.ok(l.iniciado_en && l.terminado_en);
    assert.equal(await cuenta("lote_items", "estado='hecho' AND encolado_en IS NOT NULL AND iniciado_en IS NOT NULL AND terminado_en IS NOT NULL"), 25);
    const ev = (await q("SELECT DISTINCT evento FROM lote_eventos")).rows.map(r => r.evento);
    for (const e of ["lote_creado", "ciclo_iniciado", "ciclo_cerrado", "item_corriendo", "item_hecho", "lote_estado"]) assert.ok(ev.includes(e), `falta evento ${e}`);
  });

  dbTest("tamaño de ciclo siempre entre 10 y 20", async () => {
    await reset();
    const clips = await sembrar(30);
    await L.crearLoteCortes({ clipIds: clips.map(c => c.id) });
    assert.equal((await L.iniciarCiclo({ tam: 50 })).n, 20);
    await q("UPDATE lote_ciclos SET estado='completado', terminado_en=now() - interval '1 minute'");
    await q("UPDATE lote_items SET estado='hecho' WHERE estado='encolado'");
    assert.equal((await L.iniciarCiclo({ tam: 3 })).n, 10);
  });

  dbTest("pausa entre ciclos: no arranca otro hasta que pase LOTE_PAUSA_S", async () => {
    await reset();
    const clips = await sembrar(12);
    await L.crearLoteCortes({ clipIds: clips.map(c => c.id) });
    await L.iniciarCiclo({ pausaS: 0 });
    await correrJobs({ cortar: ok });
    await L.cerrarCiclos();
    assert.equal(await L.iniciarCiclo({ pausaS: 3600 }), null, "dentro de la pausa");
    assert.equal((await L.iniciarCiclo({ pausaS: 0 })).n, 2);
  });

  dbTest("errores: reintento, error final, ciclo y lote con_errores", async () => {
    await reset();
    const clips = await sembrar(3);
    await L.crearLoteCortes({ clipIds: clips.map(c => c.id) });
    await L.tick();
    let intentos = 0;
    const falla = async it => { if (it.clip_id === clips[0].id && ++intentos < 2) throw new Error("ffmpeg cayó"); if (it.clip_id === clips[1].id) throw new Error("siempre falla"); return { ok: true }; };
    await correrJobs({ cortar: falla });
    assert.equal(await cuenta("lote_items", "estado='encolado'"), 2, "los dos que fallaron esperan su 2.º intento");
    assert.equal(await cuenta("lote_items", "estado='error'"), 0, "con max_intentos=2 el primer fallo aún no es final");
    assert.equal(await cuenta("lote_items", "estado='hecho'"), 1);
    await q("UPDATE jobs SET ejecutar_en=now()");
    await correrJobs({ cortar: falla });
    const { rows: fin } = await q("SELECT estado, detalle FROM lote_items ORDER BY id");
    assert.deepEqual(fin.map(r => r.estado), ["hecho", "error", "hecho"]);
    assert.match(fin[1].detalle, /siempre falla/);
    await L.tick();
    assert.equal((await q("SELECT estado FROM lote_ciclos")).rows[0].estado, "con_errores");
    assert.equal((await q("SELECT estado FROM lotes")).rows[0].estado, "con_errores");
  });

  const crearReciclaje = async (clipId, extra = {}) => V.crearReciclaje({
    clipId, plataformas: ["tiktok", "instagram"], cantidad: 5, desde: "2026-11-09T12:00:00Z", ...extra
  }, { generar: async () => ({ texto: JSON.stringify([
    { titulo: "Ángulo uno", gancho: "g1", descripcion: "d1", cta: "c1", hashtags: ["#uno"], angulo: "Polémica" },
    { titulo: "Ángulo dos", gancho: "g2", descripcion: "d2", cta: "c2", hashtags: ["#dos"], angulo: "Valor" }]) }) });

  dbTest("reciclaje: lote + variantes en ventanas distintas sobre el mismo clip base", async () => {
    await reset();
    const [clip] = await sembrar(1);
    const r = await crearReciclaje(clip.id);
    assert.equal(r.variantes.length, 5);
    assert.equal(r.lote.tipo, "reciclaje");
    assert.equal(r.lote.total, 5);
    assert.deepEqual(r.variantes.map(v => v.origen), ["ia", "ia", "plantilla", "plantilla", "plantilla"]);
    assert.equal(new Set(r.variantes.map(v => v.titulo)).size, 5);
    assert.ok(r.variantes.every(v => v.clip_id === clip.id && v.estado === "programada"), "mismo clip base, sin copiar video");
    const horas = r.variantes.map(v => new Date(v.programada_para));
    horas.forEach((d, i) => i && assert.ok(d - horas[i - 1] >= 90 * 60e3));
    const local = horas.map(d => { const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: cfg.zonaHoraria, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).split(":").map(Number); return h * 60 + m; });
    assert.ok(local.every(m => (m >= 540 && m < 660) || (m >= 780 && m < 900) || (m >= 1140 && m < 1320)), `fuera de ventana: ${local}`);
    assert.equal(await cuenta("lote_items", "estado='pendiente' AND tipo='publicar_variante'"), 5);
    assert.equal(await cuenta("lote_eventos", "evento='variante_programada'"), 5);

    const r2 = await crearReciclaje(clip.id, { cantidad: 2, ventanas: ["06:00-07:00"] });
    const todos = (await q("SELECT titulo FROM variantes")).rows.map(x => x.titulo);
    assert.equal(new Set(todos).size, todos.length, "no repite títulos de reciclajes anteriores");
    assert.equal(r2.variantes.length, 2);
  });

  dbTest("reciclaje: validaciones", async () => {
    await reset();
    const [clip] = await sembrar(1);
    const falla = (p, st) => assert.rejects(() => crearReciclaje(clip.id, p), e => e.status === st, JSON.stringify(p));
    await falla({ cantidad: 0 }, 400);
    await falla({ cantidad: 21 }, 400);
    await falla({ plataformas: [] }, 400);
    await falla({ desde: "ayer" }, 400);
    await falla({ ventanas: ["25:00-26:00"] }, 400);
    await falla({ separacionMin: -5 }, 400);
    await assert.rejects(() => crearReciclaje("999999"), e => e.status === 404);
    assert.equal(await cuenta("lotes"), 0, "nada a medias");
    const m = await crearReciclaje(clip.id, { cantidad: 9, manuales: [{ titulo: "Mi variante A", cta: "x" }, { titulo: "Mi variante A" }, { titulo: "Mi variante B" }] });
    assert.equal(m.variantes.length, 2);
    assert.ok(m.variantes.every(v => v.origen === "manual"));
    assert.ok(m.avisos.length);
  });

  dbTest("vencimiento: una variante solo entra a un ciclo cuando llega su hora", async () => {
    await reset();
    const [clip] = await sembrar(1);
    const { variantes } = await crearReciclaje(clip.id, { cantidad: 2, desde: new Date(Date.now() + 5 * 864e5).toISOString() });
    assert.equal(await L.iniciarCiclo(), null, "faltan días");
    await q("UPDATE variantes SET programada_para = now() - interval '1 minute' WHERE id=$1", [variantes[0].id]);
    assert.equal((await L.iniciarCiclo()).n, 1);
    assert.equal((await q("SELECT estado FROM variantes WHERE id=$1", [variantes[0].id])).rows[0].estado, "en_cola");
    assert.equal((await q("SELECT estado FROM variantes WHERE id=$1", [variantes[1].id])).rows[0].estado, "programada");
  });

  const prepararPublicacion = async (plataformas = ["tiktok", "instagram"]) => {
    await reset();
    const [clip] = await sembrar(1);
    const { variantes, lote } = await crearReciclaje(clip.id, { cantidad: 1, plataformas });
    await q("UPDATE variantes SET programada_para = now() - interval '1 minute'");
    await L.iniciarCiclo();
    const { rows: [item] } = await q("SELECT * FROM lote_items WHERE variante_id=$1", [variantes[0].id]);
    return { clip, v: variantes[0], lote, item };
  };
  const deps = (publicar, extra = {}) => ({ publicar, asegurarArchivo: async () => "/tmp/base.mp4", pausar: async () => {}, ...extra });

  dbTest("publicar variante: usa los metadatos de la variante, no del clip, y no toca las publicaciones del base", async () => {
    const { clip, v, item } = await prepararPublicacion();
    const vistas = [];
    const r = await V.hPublicarVariante(item, {}, deps(async (p, pieza) => { vistas.push([p, pieza]); return { detalle: "ok " + p }; }));
    assert.deepEqual(r, { ok: true, detalle: "Variante publicada." });
    assert.deepEqual(vistas.map(x => x[0]), ["tiktok", "instagram"]);
    for (const [, pieza] of vistas) {
      assert.equal(pieza.titulo, v.titulo); assert.equal(pieza.cta, v.cta); assert.equal(pieza.archivo, "/tmp/base.mp4");
      assert.equal(pieza.id, `${clip.id}v${v.id}`);
    }
    const { rows: [vv] } = await q("SELECT * FROM variantes WHERE id=$1", [v.id]);
    assert.equal(vv.estado, "publicada");
    assert.ok(vv.publicado_en && vv.iniciado_en);
    assert.equal(await cuenta("publicaciones", `variante_id=${v.id} AND estado='ok'`), 2);
    assert.equal(await cuenta("publicaciones", "variante_id IS NULL"), 0);
    const r2 = await V.hPublicarVariante(item, {}, deps(async () => { throw new Error("no debe llamarse"); }));
    assert.match(r2.detalle, /nada que hacer/, "idempotente");
  });

  dbTest("publicar variante: parcial → reintento solo en lo pendiente; modo prueba → simulada", async () => {
    const { v, item } = await prepararPublicacion();
    const r = await V.hPublicarVariante(item, {}, deps(async p => { if (p === "instagram") throw new Error("Selector no encontrado\nlínea 2"); return { detalle: "ok" }; }));
    assert.equal(r.ok, false);
    assert.equal((await q("SELECT estado, error FROM variantes WHERE id=$1", [v.id])).rows[0].estado, "parcial");
    const llamadas = [];
    const r2 = await V.hPublicarVariante(item, {}, deps(async p => { llamadas.push(p); return { detalle: "ok" }; }));
    assert.deepEqual(llamadas, ["instagram"], "tiktok ya estaba ok");
    assert.equal(r2.ok, true);
    assert.equal((await q("SELECT estado FROM variantes WHERE id=$1", [v.id])).rows[0].estado, "publicada");

    const { v: v2, item: item2 } = await prepararPublicacion(["tiktok"]);
    const r3 = await V.hPublicarVariante(item2, {}, deps(async () => ({ simulado: true, detalle: "prueba" })));
    assert.equal(r3.ok, true);
    const { rows: [s] } = await q("SELECT estado, publicado_en FROM variantes WHERE id=$1", [v2.id]);
    assert.equal(s.estado, "simulada");
    assert.equal(s.publicado_en, null, "una simulación no cuenta como publicada");
  });

  dbTest("publicar variante: incierto bloquea, y se resuelve desde el panel", async () => {
    const { v, item } = await prepararPublicacion(["tiktok"]);
    await V.hPublicarVariante(item, {}, deps(async () => { const e = new Error("sin confirmación"); e.incierto = true; throw e; }));
    assert.equal((await q("SELECT estado FROM variantes WHERE id=$1", [v.id])).rows[0].estado, "incierta");
    const r = await V.hPublicarVariante(item, {}, deps(async () => { throw new Error("no debe reintentar a ciegas"); }));
    assert.match(r.detalle, /incierta/);
    await assert.rejects(() => V.resolverVariante(v.id, "tiktok", "nada"), e => e.status === 400);
    assert.equal((await V.resolverVariante(v.id, "tiktok", "publicado")).estado, "publicada");
    assert.equal(await cuenta("publicaciones", `variante_id=${v.id} AND estado='descartado'`), 1);
  });

  dbTest("publicar variante: límite diario y agente ocupado aplazan sin perder la variante", async () => {
    const { clip, v, item } = await prepararPublicacion(["tiktok"]);
    for (let i = 0; i < 3; i++) await q("INSERT INTO publicaciones(clip_id, plataforma, estado) VALUES($1,'tiktok','ok')", [clip.id]);
    const r = await V.hPublicarVariante(item, {}, deps(async () => { throw new Error("no debe publicar"); }));
    assert.match(r.aplazar.motivo, /límite diario/);
    assert.equal(r.aplazar.minutos, 120);

    await q("DELETE FROM publicaciones");
    const ocupado = await V.hPublicarVariante(item, {}, deps(async () => { throw new Error("El agente está ocupado con otra tarea."); }));
    assert.equal(ocupado.aplazar.minutos, 2);
    assert.equal(await cuenta("publicaciones", "variante_id IS NOT NULL"), 0, "ocupado no cuenta como fallo");

    await L.hLoteItem({ ref_id: item.id, intentos: 1, max_intentos: 1 }, { manejadores: { publicar_variante: async () => r } });
    const { rows: its } = await q("SELECT estado, detalle FROM lote_items ORDER BY id");
    assert.deepEqual(its.map(i => i.estado), ["aplazado", "pendiente"], "queda un elemento nuevo esperando");
    const { rows: [vv] } = await q("SELECT estado, aplazos, programada_para, error FROM variantes WHERE id=$1", [v.id]);
    assert.equal(vv.estado, "programada");
    assert.equal(vv.aplazos, 1);
    assert.ok(new Date(vv.programada_para) - Date.now() > 100 * 60e3);
    assert.ok(await cuenta("lote_eventos", "evento='variante_aplazada'"));
  });

  dbTest("publicar variante: si el video base no se puede preparar, la variante queda en error y el job no se reintenta a ciegas", async () => {
    const { v, item } = await prepararPublicacion(["tiktok"]);
    const r = await V.hPublicarVariante(item, {}, deps(async () => ({}), { asegurarArchivo: async () => { throw new Error("yt-dlp: video privado"); } }));
    assert.equal(r.ok, false);
    const { rows: [vv] } = await q("SELECT estado, error FROM variantes WHERE id=$1", [v.id]);
    assert.equal(vv.estado, "error");
    assert.match(vv.error, /video privado/);
  });

  dbTest("reconciliar: un job muerto cierra su elemento; si publicaba, la variante pasa a incierta", async () => {
    const { v, item } = await prepararPublicacion(["tiktok"]);
    await q("UPDATE lote_items SET estado='corriendo' WHERE id=$1", [item.id]);
    await q("UPDATE variantes SET estado='publicando' WHERE id=$1", [v.id]);
    await q("UPDATE jobs SET estado='error', error='Interrumpido por un reinicio' WHERE id=$1", [item.job_id]);
    assert.equal(await L.reconciliar(), 1);
    assert.equal((await q("SELECT estado FROM lote_items WHERE id=$1", [item.id])).rows[0].estado, "error");
    assert.equal((await q("SELECT estado FROM variantes WHERE id=$1", [v.id])).rows[0].estado, "incierta");
    assert.equal(await L.reconciliar(), 0, "idempotente");
  });

  dbTest("recuperarJobs: tras un reinicio, un publicar de lote NO se repite", async () => {
    const { recuperarJobs } = await import("../src/queue.js");
    const { item } = await prepararPublicacion(["tiktok"]);
    await q("UPDATE jobs SET estado='corriendo'");
    await recuperarJobs();
    assert.equal((await q("SELECT estado FROM jobs WHERE id=$1", [item.job_id])).rows[0].estado, "error");
  });

  dbTest("control: pausar, reanudar y cancelar lotes; cancelar/reprogramar variantes", async () => {
    await reset();
    const [clip] = await sembrar(1);
    const { lote, variantes } = await crearReciclaje(clip.id, { cantidad: 3 });
    await q("UPDATE variantes SET programada_para = now() - interval '1 minute'");
    assert.equal((await L.pausarLote(lote.id)).estado, "pausado");
    assert.equal(await L.iniciarCiclo(), null, "pausado no despacha");
    await assert.rejects(() => L.pausarLote(lote.id), e => e.status === 409);
    await L.reanudarLote(lote.id);
    await L.refrescarLotes();
    assert.equal((await q("SELECT estado FROM lotes WHERE id=$1", [lote.id])).rows[0].estado, "pendiente");

    await V.cancelarVariante(variantes[0].id);
    assert.equal((await q("SELECT estado FROM variantes WHERE id=$1", [variantes[0].id])).rows[0].estado, "cancelada");
    await assert.rejects(() => V.cancelarVariante(variantes[0].id), e => e.status === 409);
    const re = await V.reprogramarVariante(variantes[0].id, new Date(Date.now() + 864e5).toISOString());
    assert.ok(re.ok);
    assert.equal(await cuenta("lote_items", `variante_id=${variantes[0].id} AND estado='pendiente'`), 1, "vuelve a su lote con un elemento nuevo");
    await assert.rejects(() => V.reprogramarVariante(variantes[0].id, "mañana"), e => e.status === 400);

    const c = await L.cancelarLote(lote.id);
    assert.equal(c.cancelados, 3);
    assert.equal(await cuenta("variantes", "estado='cancelada'"), 3);
    assert.equal(await L.iniciarCiclo(), null);
    await assert.rejects(() => L.cancelarLote(lote.id), e => e.status === 409);
    await assert.rejects(() => V.reprogramarVariante(variantes[1].id, new Date(Date.now() + 864e5).toISOString()), e => e.status === 409);
  });

  dbTest("variante viva única: no se puede encolar dos veces la misma variante", async () => {
    await reset();
    const [clip] = await sembrar(1);
    const { variantes, lote } = await crearReciclaje(clip.id, { cantidad: 1 });
    await assert.rejects(() => q("INSERT INTO lote_items(lote_id, tipo, clip_id, variante_id) VALUES($1,'publicar_variante',$2,$3)", [lote.id, clip.id, variantes[0].id]), /lote_items_variante_viva_idx/);
  });

  dbTest("concurrencia: dos despachadores a la vez abren un solo ciclo", async () => {
    await reset();
    const clips = await sembrar(30);
    await L.crearLoteCortes({ clipIds: clips.map(c => c.id) });
    const r = await Promise.all([L.iniciarCiclo(), L.iniciarCiclo(), L.iniciarCiclo()]);
    assert.equal(r.filter(Boolean).length, 1);
    assert.equal(await cuenta("lote_ciclos"), 1);
    assert.equal(await cuenta("jobs"), 10);
  });

  dbTest("janitor: no borra el video base si una variante sale pronto; sí lo borra cuando ya no hace falta", async () => {
    await reset();
    const [clip] = await sembrar(1, { estado: "publicado" });
    const archivo = path.join(dir, `clip-${clip.token}.mp4`);
    fs.writeFileSync(archivo, Buffer.alloc(100));
    await q("UPDATE clips SET archivo=$2 WHERE id=$1", [clip.id, archivo]);
    const { variantes } = await crearReciclaje(clip.id, { cantidad: 1, desde: new Date(Date.now() + 3600e3).toISOString(), ventanas: ["00:00-23:59"] });
    await q("UPDATE variantes SET programada_para = now() + interval '1 hour'");
    assert.equal(await borrarArchivoClip(clip.id), false, "variante en 1 h: protegido");
    await limpiar();
    assert.ok(fs.existsSync(archivo), "limpiar() respeta la protección aunque el clip esté publicado");
    await q("UPDATE variantes SET programada_para = now() + interval '2 days'");
    assert.equal(await borrarArchivoClip(clip.id, "expirado", { forzar: false }), true, "variante lejana: se puede purgar (se regenera después)");
    assert.ok(!fs.existsSync(archivo));
    assert.equal((await q("SELECT estado FROM clips WHERE id=$1", [clip.id])).rows[0].estado, "publicado");

    fs.writeFileSync(archivo, Buffer.alloc(100));
    await q("UPDATE clips SET archivo=$2 WHERE id=$1", [clip.id, archivo]);
    await q("UPDATE variantes SET estado='en_cola' WHERE id=$1", [variantes[0].id]);
    assert.equal(await borrarArchivoClip(clip.id), false, "en cola: protegido");
    assert.equal(await borrarArchivoClip(clip.id, "pendiente", { forzar: true }), true, "el usuario puede forzar");
  });

  dbTest("API HTTP: reciclar, listar, monitorear y controlar", async () => {
    await reset();
    const [clip] = await sembrar(2);
    const app = express();
    app.use(express.json());
    app.use("/api", rutasLotes);
    app.use((e, req, res, next) => res.status(e.status || 500).json({ error: e.message }));
    const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}/api`;
    const j = async (m, ruta, body) => { const r = await fetch(base + ruta, { method: m, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) }); return [r.status, await r.json()]; };
    try {
      let [st, b] = await j("POST", `/clips/${clip.id}/reciclar`, { cantidad: 3, plataformas: ["tiktok"] });
      assert.equal(st, 400); assert.match(b.error, /Falta la sesión de tiktok/);
      await q("INSERT INTO sesiones(plataforma, datos) VALUES('tiktok','x')");
      [st, b] = await j("POST", `/clips/${clip.id}/reciclar`, { cantidad: 3, plataformas: ["tiktok", "nope"], desde: "2026-11-09T12:00:00Z" });
      assert.equal(st, 201);
      assert.equal(b.variantes.length, 3);
      assert.ok(b.variantes.every(v => v.origen === "plantilla"), "sin llaves Gemini cae a plantillas, sin romper");
      assert.ok(b.avisos.length);
      const loteId = b.lote.id;
      [st, b] = await j("GET", `/clips/${clip.id}/variantes`); assert.equal(b.length, 3);
      [st, b] = await j("GET", `/lotes/${loteId}`); assert.equal(b.variantes.length, 3); assert.equal(b.items.length, 3); assert.equal(b.lote.items.pendiente, 3);
      [st, b] = await j("GET", `/lotes/${loteId}/eventos`); assert.ok(b.length >= 4);
      [st, b] = await j("GET", "/lotes/monitor"); assert.equal(st, 200); assert.equal(b.variantes.programada, 3); assert.equal(b.config.tamanoCiclo, 10); assert.equal(b.proximasVariantes.length, 3);
      [st, b] = await j("POST", "/lotes", { clip_ids: [clip.id] }); assert.equal(st, 201); assert.equal(b.tipo, "cortes");
      [st, b] = await j("POST", "/lotes", { clip_ids: ["999999"] }); assert.equal(st, 400);
      [st, b] = await j("POST", "/lotes", { clip_ids: [] }); assert.equal(st, 400);
      [st, b] = await j("POST", `/lotes/${loteId}/pausar`); assert.equal(b.estado, "pausado");
      [st, b] = await j("POST", `/lotes/${loteId}/cancelar`); assert.equal(b.cancelados, 3);
      [st, b] = await j("GET", "/lotes/abc"); assert.equal(st, 404);
      [st, b] = await j("GET", "/lotes/99999"); assert.equal(st, 404);
      [st, b] = await j("GET", "/lotes"); assert.equal(b.length, 2);
      [st, b] = await j("GET", "/ciclos"); assert.equal(st, 200);
    } finally { srv.close(); }
  });

  test.after(async () => { await db.end(); fs.rmSync(dir, { recursive: true, force: true }); });
} else {
  test("integración con Postgres (lotes, ciclos, reciclaje, janitor, API)", { skip: "Define TEST_DATABASE_URL para correrla" }, () => {});
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
}
