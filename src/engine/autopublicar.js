// ---------------------------------------------------------------------------
// Autopublicacion tras el render.
//  AUTO_PUBLICAR=instagram | instagram,facebook | tiktok,instagram,facebook | todas      (vacio u off = apagado)
//  Cada clip que termina de renderizarse se ENCOLA en el programador (no se publica en el acto): el programador aplica su
//  ritmo (tope de 2 por hora, plan diario, reintentos con backoff) y publica por la API oficial cuando esta configurada.
//  - Con el reenvio a Facebook activo (IG_CROSSPOST_FACEBOOK=on) y sin FB_PUBLICAR_DIRECTO, "instagram,facebook" genera UN solo
//    trabajo [instagram, facebook]: Facebook sale con el Reel de Instagram y no se duplica.
//  - En cualquier otro caso se crea un trabajo por red, cada uno con su copy.
//  - NUNCA lanza ni retrasa el pipeline: un fallo de la cola se registra como aviso y el clip queda listo igualmente.
//  - Las series (storySeriesEngine) no pasan por aqui: tienen su propia cola ordenada.
// ---------------------------------------------------------------------------
import { programador as programadorDefecto } from './programador.js';
import { store as storeDefecto } from '../storage/store.js';
import { adaptarCopyPorRed } from './marketing.js';
import { REDES } from '../utils/plataformas.js';
import { logger } from '../utils/logger.js';
import { crosspostFacebookActivo } from '../services/instagramPublisher.js';
import { facebookDirectoForzado } from '../services/facebookPublisher.js';

const APAGADO = /^(0|off|false|no|none|ninguna|ninguno)$/i;
const TODAS = /^(todas|all|\*)$/i;
let avisoTokens = new Set();

/** Redes pedidas en AUTO_PUBLICAR (ordenadas y sin repetir). Lo desconocido se ignora con un aviso unico. */
export function redesAutoPublicar(env = process.env) {
  const crudo = String(env.AUTO_PUBLICAR ?? '').trim();
  if (!crudo || APAGADO.test(crudo)) return [];
  if (TODAS.test(crudo)) return [...REDES];
  const piezas = crudo.toLowerCase().split(/[\s,;|]+/).filter(Boolean);
  const validas = piezas.filter((p) => REDES.includes(p));
  for (const p of piezas.filter((x) => !REDES.includes(x) && !avisoTokens.has(x))) {
    avisoTokens.add(p);
    logger.warn('AUTO_PUBLICAR: red desconocida ignorada', { valor: p.slice(0, 20), validas: REDES.join(',') });
  }
  return REDES.filter((r) => validas.includes(r));
}
export const _reiniciarAvisos = () => { avisoTokens = new Set(); };

/** Trabajos a crear para esas redes: [{ platforms, copyDe }]. */
export function planDeTrabajos(redes, { crosspost = crosspostFacebookActivo(), directoForzado = facebookDirectoForzado() } = {}) {
  if (redes.includes('instagram') && redes.includes('facebook') && crosspost && !directoForzado) {
    const resto = redes.filter((r) => r !== 'instagram' && r !== 'facebook');
    return [{ platforms: ['instagram', 'facebook'], copyDe: 'instagram' }, ...resto.map((r) => ({ platforms: [r], copyDe: r }))];
  }
  return redes.map((r) => ({ platforms: [r], copyDe: r }));
}

/** Mismo contexto de clip que usan las rutas del programador (ficha/marketing reales, no la URL de origen). */
function contextoDeClip(clip) {
  const f = clip.ficha || {};
  const m = clip.marketing || {};
  return {
    ...clip,
    titulo: f.titulo ?? m.titulo ?? clip.titulo ?? '',
    descripcion: f.descripcion ?? clip.copy ?? m.descripcion ?? '',
    gancho: f.gancho?.frase ?? undefined,
  };
}

/**
 * Encola un clip ya renderizado segun AUTO_PUBLICAR.
 * @returns {Promise<{ redes:string[], jobs:object[], errores:object[] }|null>} null si la autopublicacion esta apagada o el clip no esta listo
 */
export async function autoPublicarClip(clipId, { env = process.env, programador = programadorDefecto, almacen = storeDefecto, adaptar = adaptarCopyPorRed } = {}) {
  const redes = redesAutoPublicar(env);
  if (redes.length === 0) return null;
  const clip = almacen.buscar(clipId);
  if (!clip || clip.estado !== 'listo' || !clip.url) return null;

  const contexto = contextoDeClip(clip);
  const plan = planDeTrabajos(redes);
  const jobs = [];
  const errores = [];
  try { await programador.cargar(); } catch (error) { logger.warn('Autopublicacion: no se pudo cargar el programador', { mensaje: error.message }); }
  for (const item of plan) {
    try {
      const copy = adaptar({ clip: contexto, red: item.copyDe });
      const job = await programador.encolar({ clipId, porRed: true, platforms: item.platforms, descripcion: copy.descripcion, etiquetas: copy.hashtags });
      jobs.push({ id: job && job.id, platforms: item.platforms });
    } catch (error) {
      errores.push({ platforms: item.platforms, codigo: error.codigo || 'ERROR', mensaje: error.message });
      logger.warn('Autopublicacion: no se pudo encolar', { clipId, redes: item.platforms.join(','), codigo: error.codigo, mensaje: error.message });
      try { almacen.registrarIncidencia('warn', 'Autopublicacion: no se pudo encolar en ' + item.platforms.join('+') + ': ' + error.message, 'autopublicar'); } catch { /* informativo */ }
    }
  }
  try {
    almacen.actualizar(clipId, { autoPublicar: { redes, jobs: jobs.map((j) => j.id), errores: errores.length, en: new Date().toISOString() } });
  } catch { /* el clip pudo archivarse */ }
  try {
    const e = typeof programador.estado === 'function' ? programador.estado() : null;
    if (jobs.length && e && e.activo === false && !/^(1|true|si|on)$/i.test(String(env.PROG_AUTOARRANQUE || ''))) {
      logger.warn('Autopublicacion: hay trabajos en cola pero el programador esta APAGADO. Activalo en el panel o define PROG_AUTOARRANQUE=on.');
    }
  } catch { /* aviso opcional */ }
  if (jobs.length) logger.info('Autopublicacion: clip en cola', { clipId, trabajos: jobs.length, redes: redes.join(',') });
  return { redes, jobs, errores };
}
