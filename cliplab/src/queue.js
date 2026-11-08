// Cola en Postgres (FOR UPDATE SKIP LOCKED): los trabajos sobreviven a reinicios.
import { q } from "./db.js";

const dormir = ms => new Promise(r => setTimeout(r, ms));

export const encolar = (tipo, refId, payload = {}, retrasoMs = 0, maxIntentos = 3) =>
  q(
    `INSERT INTO jobs(tipo, ref_id, payload, max_intentos, ejecutar_en)
     VALUES($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval) RETURNING id`,
    [tipo, refId, payload, maxIntentos, String(retrasoMs)]
  );

// Un reinicio nunca repite una publicación a ciegas (podría duplicar el post).
export async function recuperarJobs() {
  await q(`UPDATE jobs SET
      estado = CASE WHEN tipo IN ('publicar','lote_agente') THEN 'error' ELSE 'pendiente' END,
      error = CASE WHEN tipo IN ('publicar','lote_agente') THEN 'Interrumpido por un reinicio: verifica en la plataforma antes de reintentar.' ELSE error END
    WHERE estado = 'corriendo'`);
  await q(`UPDATE clips SET estado = 'listo', error = 'Publicación interrumpida por un reinicio: verifica en la plataforma.' WHERE estado = 'publicando'`);
  await q(`UPDATE clips SET estado = 'pendiente' WHERE estado = 'cortando'`);
}

async function reclamar(tipos) {
  const { rows: [j] } = await q(
    `UPDATE jobs SET estado = 'corriendo', intentos = intentos + 1, iniciado_en = now()
     WHERE id = (SELECT id FROM jobs WHERE estado = 'pendiente' AND tipo = ANY($1) AND ejecutar_en <= now()
                 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING *`,
    [tipos]
  );
  return j || null;
}

export function iniciarWorker(nombre, tipos, manejar, cadaMs = 3000) {
  let activo = true;
  (async () => {
    while (activo) {
      let job = null;
      try { job = await reclamar(tipos); } catch (e) { console.error(`[${nombre}] db:`, e.message); }
      if (!job) { await dormir(cadaMs); continue; }
      try {
        await manejar(job);
        await q("UPDATE jobs SET estado = 'hecho' WHERE id = $1", [job.id]);
      } catch (e) {
        const fin = job.intentos >= job.max_intentos;
        console.error(`[${nombre}] job ${job.id} (${job.tipo}):`, e.message);
        await q(
          "UPDATE jobs SET estado = $2, error = $3, ejecutar_en = now() + interval '30 seconds' * $4::int WHERE id = $1",
          [job.id, fin ? "error" : "pendiente", String(e.message).slice(0, 500), job.intentos]
        ).catch(() => {});
      }
    }
  })();
  return () => { activo = false; };
}
