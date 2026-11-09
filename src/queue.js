const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const db = require('./db');
const ytdlp = require('./ytdlp');
const cortes = require('./cortes');
const investigador = require('./engine/investigador');

let activos = 0;
let detenido = false;
let timer = null;
let staleTimer = null;

const msg = (e) => String((e && e.message) || e).slice(0, 800);

async function reclamar() {
  const { rows } = await db.query(
    `UPDATE trabajos_cola
        SET estado = 'procesando', intentos = intentos + 1, locked_at = now(), updated_at = now(), error = NULL
      WHERE id = (
        SELECT id FROM trabajos_cola
         WHERE estado = 'pendiente'
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
    RETURNING *`
  );
  return rows[0] || null;
}

async function recuperarHuerfanos(todos = false) {
  const { rowCount } = await db.query(
    `UPDATE trabajos_cola
        SET estado = 'pendiente', updated_at = now(), error = 'Reencolado tras interrupción'
      WHERE estado = 'procesando'
        AND ($1::boolean OR locked_at < now() - make_interval(mins => $2::int))`,
    [todos, cfg.staleMinutos]
  );
  if (rowCount) console.log(`[cola] ${rowCount} trabajo(s) reencolado(s)`);
}

async function procesar(job) {
  let idVideo = null;
  try {
    // limpiar resultados previos de intentos anteriores
    const previos = await db.query('SELECT archivo FROM vivo_clips WHERE trabajo_id = $1', [job.id]);
    for (const r of previos.rows) {
      if (r.archivo) { try { fs.unlinkSync(path.join(cfg.exportDir, path.basename(r.archivo))); } catch (_) {} }
    }
    await db.query('DELETE FROM vivo_clips WHERE trabajo_id = $1', [job.id]);

    const meta = await ytdlp.metadata(job.url);
    idVideo = meta.id;
    await db.query(
      'UPDATE trabajos_cola SET video_id=$2, video_titulo=$3, duracion=$4, updated_at=now() WHERE id=$1',
      [job.id, meta.id, meta.titulo, meta.duracion]
    );

    const subs = await ytdlp.subtitulos(job.url, meta.id);
    const analisis = investigador.analizar(
      { ...meta, vtt: subs.texto },
      { maxClips: cfg.clipsPorVideo, duracionClip: cfg.duracionClip }
    );
    if (!analisis.ganchos.length) throw new Error('El motor no encontró candidatos de corte');

    await db.query(
      'UPDATE trabajos_cola SET palabras_clave=$2::jsonb, resumen=$3, updated_at=now() WHERE id=$1',
      [job.id, JSON.stringify(analisis.palabrasClave), analisis.resumen]
    );

    const clips = [];
    for (const g of analisis.ganchos) {
      const { rows } = await db.query(
        `INSERT INTO vivo_clips (trabajo_id, titulo, estado, marca_tiempo, marca_fin, resumen)
         VALUES ($1,$2,'pendiente',$3,$4,$5) RETURNING id`,
        [job.id, g.titulo, g.inicio.toFixed(2), g.fin.toFixed(2), g.resumen]
      );
      clips.push({ id: rows[0].id, g });
    }

    const origen = await ytdlp.descargar(job.url, meta.id);

    let ok = 0;
    for (const c of clips) {
      await db.query("UPDATE vivo_clips SET estado='procesando', updated_at=now() WHERE id=$1", [c.id]);
      const nombre = `clip_${job.id}_${c.id}.mp4`;
      try {
        await cortes.cortar({
          entrada: origen,
          inicio: c.g.inicio,
          duracion: Math.max(1, c.g.fin - c.g.inicio),
          salida: path.join(cfg.exportDir, nombre),
        });
        await db.query(
          "UPDATE vivo_clips SET estado='completado', archivo=$2, error=NULL, updated_at=now() WHERE id=$1",
          [c.id, nombre]
        );
        ok++;
      } catch (err) {
        console.error(`[cola] corte ${c.id} falló: ${msg(err)}`);
        await db.query("UPDATE vivo_clips SET estado='error', error=$2, updated_at=now() WHERE id=$1", [c.id, msg(err)]);
      }
    }

    if (ok === 0) throw new Error('Todos los cortes fallaron');
    await db.query(
      "UPDATE trabajos_cola SET estado='completado', error=$2, locked_at=NULL, updated_at=now() WHERE id=$1",
      [job.id, ok < clips.length ? `${clips.length - ok} corte(s) fallaron` : null]
    );
  } catch (err) {
    console.error(`[cola] trabajo ${job.id} falló: ${msg(err)}`);
    const final = job.intentos >= cfg.maxIntentos;
    try {
      await db.query(
        `UPDATE trabajos_cola SET estado=$2, error=$3, locked_at=NULL, updated_at=now() WHERE id=$1`,
        [job.id, final ? 'error' : 'pendiente', msg(err)]
      );
      if (final) {
        await db.query(
          `UPDATE vivo_clips SET estado='error', error=COALESCE(error,$2), updated_at=now()
            WHERE trabajo_id=$1 AND estado IN ('pendiente','procesando')`,
          [job.id, msg(err)]
        );
      }
    } catch (e2) {
      console.error('[cola] no se pudo registrar el fallo:', msg(e2));
    }
  } finally {
    if (idVideo) ytdlp.limpiar(idVideo);
  }
}

async function tick() {
  if (detenido) return;
  try {
    while (activos < cfg.workerConcurrency) {
      const job = await reclamar();
      if (!job) break;
      activos++;
      procesar(job)
        .catch((e) => console.error('[cola] error no controlado:', msg(e)))
        .finally(() => { activos--; });
    }
  } catch (err) {
    console.error('[cola] error en ciclo:', msg(err));
  }
  if (!detenido) timer = setTimeout(tick, cfg.workerPollMs);
}

function iniciar() {
  fs.mkdirSync(cfg.tmpDir, { recursive: true });
  fs.mkdirSync(cfg.exportDir, { recursive: true });
  staleTimer = setInterval(() => recuperarHuerfanos(false).catch((e) => console.error(msg(e))), 60000);
  tick();
  console.log(`[cola] worker iniciado (concurrencia ${cfg.workerConcurrency})`);
}

async function detener() {
  detenido = true;
  clearTimeout(timer);
  clearInterval(staleTimer);
  const t0 = Date.now();
  while (activos > 0 && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 300));
}

module.exports = { iniciar, detener, recuperarHuerfanos };
