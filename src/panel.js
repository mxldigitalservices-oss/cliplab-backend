// Fase 5 — datos del panel de administración: estado del sistema, "¿listo para operar?", inventario,
// incidencias, variantes y canal en vivo (Server-Sent Events).
// Las funciones puras (evaluar*, resolverFiltro, crearCentro) se prueban sin base de datos; las consultas reciben
// la función de consulta y los lectores externos por parámetro para poder simularlos.
import { cfg } from "./config.js";
import { ErrorHttp } from "./errores.js";
import { PLATAFORMAS } from "./sesiones.js";
import { listarConexiones } from "./sesiones-env.js";

const num = v => Number(v) || 0;
const mapa = (rows, k = "estado") => Object.fromEntries(rows.map(r => [r[k], num(r.n)]));
const ARRANQUE = new Date().toISOString();
const AVISO_VENCE_H = 72;

export const ESTADOS_VARIANTE = Object.freeze(["programada", "en_cola", "publicando", "publicada", "simulada", "parcial", "incierta", "error", "cancelada"]);
export const VARIANTES_ACTIVAS = Object.freeze(["programada", "en_cola", "publicando", "incierta", "parcial", "error"]);
export const VARIANTES_HISTORIAL = Object.freeze(["publicada", "simulada", "cancelada"]);

// ---------- Funciones puras ----------

export function duracionCorta(ms) {
  const min = Math.max(1, Math.round(ms / 60e3));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

// Estado de una red social: "lista" (todo bien), "atencion" (puede operar pero conviene revisar) o "bloqueada".
export function evaluarPlataforma({ plataforma, sesion = null, usoDia = 0, maxPubDia = cfg.maxPubDia, ahora = Date.now() }) {
  const motivos = [], avisos = [];
  if (!sesion) {
    motivos.push("No hay sesión cargada. Genera el archivo con npm run login y súbelo.");
  } else {
    const exp = sesion.expira_en ? new Date(sesion.expira_en).getTime() : null;
    if (exp != null && exp <= ahora) motivos.push("La sesión ya venció. Sube una nueva.");
    else if (exp != null && exp - ahora < AVISO_VENCE_H * 3600e3) avisos.push(`La sesión vence en ${duracionCorta(exp - ahora)}.`);
    if (sesion.test_ok === false) motivos.push(`La última prueba falló${sesion.test_detalle ? `: ${sesion.test_detalle}` : "."}`);
    else if (sesion.test_ok == null) avisos.push("La sesión aún no se ha probado. Pulsa Probar para confirmarla.");
  }
  if (usoDia >= maxPubDia) motivos.push(`Límite diario alcanzado (${usoDia}/${maxPubDia}): las publicaciones se aplazan.`);
  else if (maxPubDia > 0 && usoDia >= Math.ceil(maxPubDia * 0.8)) avisos.push(`Cerca del límite diario (${usoDia}/${maxPubDia}).`);
  return {
    plataforma,
    estado: motivos.length ? "bloqueada" : avisos.length ? "atencion" : "lista",
    listo: motivos.length === 0,
    motivos, avisos, usoDia, maxPubDia,
    sesion: sesion
      ? { cargada: true, actualizadoEn: sesion.actualizado_en, expiraEn: sesion.expira_en ?? null, ultimoTest: sesion.ultimo_test ?? null, testOk: sesion.test_ok ?? null, testDetalle: sesion.test_detalle ?? null }
      : { cargada: false }
  };
}

// Cada rol de Gemini usa su llave y, si falta o se enfría, la de respaldo (ver gemini.js).
export function evaluarIA(llaves) {
  const respaldo = llaves.find(k => k.rol === "respaldo");
  const problemas = [], avisos = [];
  const roles = llaves.map(k => {
    const cubierta = k.configurada || (k.rol !== "respaldo" && !!respaldo?.configurada);
    if (k.rol === "respaldo") { if (!k.configurada) avisos.push(`No hay llave de respaldo (${k.variable}): si otra llave se agota, no hay relevo.`); }
    else if (!cubierta) problemas.push(`Falta la llave de Gemini del rol ${k.rol} (${k.variable}) y no hay respaldo.`);
    else if (!k.configurada) avisos.push(`El rol ${k.rol} no tiene llave propia: usa la de respaldo.`);
    if (k.enfriamientoSeg > 0) avisos.push(`El rol ${k.rol} está en enfriamiento (${k.enfriamientoSeg} s).`);
    return { rol: k.rol, variable: k.variable, configurada: k.configurada, cubierta, enfriamientoSeg: k.enfriamientoSeg, usos: k.usos, fallos: k.fallos };
  });
  return { ok: problemas.length === 0, modelo: llaves[0]?.modelo || cfg.geminiModel, roles, problemas, avisos };
}

// Veredicto global: "bloqueado" (algo impide operar), "atencion" (opera, pero hay avisos) o "listo".
export function evaluarListo({ plataformas, ia, agenteOcupado = false, publicarReal = false }) {
  const problemas = [...ia.problemas], avisos = [...ia.avisos];
  const listas = plataformas.filter(p => p.listo).length;
  if (!listas) problemas.push("Ninguna red social está lista para publicar.");
  if (!publicarReal) avisos.push("Modo prueba: el agente llega hasta el botón final sin pulsarlo.");
  if (agenteOcupado) avisos.push("El navegador del agente está ocupado ahora mismo.");
  const nivel = problemas.length ? "bloqueado" : avisos.length || plataformas.some(p => p.estado !== "lista") ? "atencion" : "listo";
  return { nivel, operativo: problemas.length === 0, plataformasListas: listas, problemas, avisos };
}

export function resolverFiltro(valor) {
  const v = String(valor || "activas");
  if (v === "activas") return [...VARIANTES_ACTIVAS];
  if (v === "historial") return [...VARIANTES_HISTORIAL];
  if (v === "todas") return [...ESTADOS_VARIANTE];
  if (ESTADOS_VARIANTE.includes(v)) return [v];
  throw new ErrorHttp(400, "Filtro de estado inválido.");
}

// ---------- Consultas ----------

const SQL_INVENTARIO = `SELECT estado, count(*)::int AS n, count(archivo)::int AS con_archivo,
  COALESCE(sum(tam_bytes) FILTER (WHERE archivo IS NOT NULL), 0)::float8 AS bytes FROM clips GROUP BY estado`;
const SQL_FUENTES = "SELECT estado, count(*)::int AS n FROM fuentes GROUP BY estado";
const SQL_JOBS = `SELECT tipo, estado, count(*)::int AS n FROM jobs
  WHERE estado IN ('pendiente','corriendo') OR (estado = 'error' AND creado_en > now() - interval '24 hours') GROUP BY tipo, estado`;
const SQL_PUBS = `SELECT plataforma,
  count(*) FILTER (WHERE estado IN ('ok','incierto') AND creado_en > now() - interval '24 hours')::int AS dia,
  max(creado_en) FILTER (WHERE estado = 'ok') AS ultima_ok
  FROM publicaciones GROUP BY plataforma`;
const SQL_EVENTOS = `SELECT e.id, e.lote_id, e.variante_id, e.evento, e.estado, e.detalle, e.creado_en, l.nombre AS lote
  FROM lote_eventos e LEFT JOIN lotes l ON l.id = e.lote_id ORDER BY e.id DESC LIMIT $1`;

// Publicaciones "inciertas" vigentes: la última no descartada de cada (clip, variante, plataforma) sigue en "incierto".
const SQL_INCIERTAS = `WITH u AS (
    SELECT DISTINCT ON (clip_id, variante_id, plataforma) id, clip_id, variante_id, plataforma, estado, detalle, creado_en
    FROM publicaciones WHERE estado <> 'descartado' ORDER BY clip_id, variante_id, plataforma, id DESC)
  SELECT u.id, u.clip_id, u.variante_id, u.plataforma, u.detalle, u.creado_en,
         c.titulo AS clip_titulo, v.titulo AS variante_titulo, v.estado AS variante_estado
  FROM u JOIN clips c ON c.id = u.clip_id LEFT JOIN variantes v ON v.id = u.variante_id
  WHERE u.estado = 'incierto' ORDER BY u.creado_en DESC LIMIT 100`;
const SQL_VARIANTES_PROBLEMA = `SELECT v.id, v.clip_id, v.lote_id, v.titulo, v.angulo, v.plataformas, v.estado, v.programada_para, v.error,
    v.intentos, v.aplazos, v.actualizado_en, c.titulo AS clip_titulo, l.nombre AS lote, l.estado AS lote_estado
  FROM variantes v JOIN clips c ON c.id = v.clip_id JOIN lotes l ON l.id = v.lote_id
  WHERE v.estado IN ('error','parcial') ORDER BY v.actualizado_en DESC LIMIT 100`;
const SQL_CLIPS_ERROR = `SELECT c.id, c.titulo, c.error, c.creado_en, f.video_id
  FROM clips c JOIN fuentes f ON f.id = c.fuente_id WHERE c.estado = 'error' ORDER BY c.creado_en DESC LIMIT 50`;
const SQL_ITEMS_ERROR = `SELECT i.id, i.lote_id, i.tipo, i.detalle, i.intentos, COALESCE(i.terminado_en, i.creado_en) AS cuando, l.nombre AS lote
  FROM lote_items i JOIN lotes l ON l.id = i.lote_id
  WHERE i.estado = 'error' AND COALESCE(i.terminado_en, i.creado_en) > now() - interval '7 days' ORDER BY cuando DESC LIMIT 30`;

export async function incidencias(consulta) {
  const [inc, vars, clips, items] = await Promise.all([
    consulta(SQL_INCIERTAS), consulta(SQL_VARIANTES_PROBLEMA), consulta(SQL_CLIPS_ERROR), consulta(SQL_ITEMS_ERROR)
  ]);
  const conteos = { inciertas: inc.rows.length, variantes: vars.rows.length, clips: clips.rows.length, items: items.rows.length };
  conteos.accionables = conteos.inciertas + conteos.variantes + conteos.clips;   // lo que el panel puede resolver
  return { conteos, inciertas: inc.rows, variantes: vars.rows, clips: clips.rows, items: items.rows };
}

export async function variantesPanel(consulta, { estado, limite } = {}) {
  const estados = resolverFiltro(estado);
  const orden = estados.every(e => VARIANTES_ACTIVAS.includes(e)) ? "ASC" : "DESC";
  const tope = Math.min(300, Math.max(1, Number(limite) || 100));
  const { rows } = await consulta(
    `SELECT v.id, v.clip_id, v.lote_id, v.titulo, v.gancho, v.angulo, v.origen, v.plataformas, v.estado, v.programada_para,
            v.intentos, v.aplazos, v.error, v.publicado_en, c.titulo AS clip_titulo, l.nombre AS lote, l.estado AS lote_estado
     FROM variantes v JOIN clips c ON c.id = v.clip_id JOIN lotes l ON l.id = v.lote_id
     WHERE v.estado = ANY($1::text[]) ORDER BY v.programada_para ${orden}, v.id LIMIT $2`, [estados, tope]);
  return rows;
}

export async function eventosRecientes(consulta, limite = 30) {
  return (await consulta(SQL_EVENTOS, [Math.min(200, Math.max(1, Number(limite) || 30))])).rows;
}

// ¿Está el asistente listo para operar? Combina sesiones, límites diarios, llaves de IA, modo y agente.
export async function estadoListo({ consulta, listarSesiones, estadoLlaves, agenteOcupado, ahora = Date.now(), env = process.env }) {
  const [ses, pubs] = await Promise.all([listarSesiones(), consulta(SQL_PUBS)]);
  const sesPor = new Map(ses.rows.map(s => [s.plataforma, s]));
  const pubPor = new Map(pubs.rows.map(p => [p.plataforma, p]));
  const plataformas = PLATAFORMAS.map(p => ({
    ...evaluarPlataforma({ plataforma: p, sesion: sesPor.get(p) || null, usoDia: num(pubPor.get(p)?.dia), maxPubDia: cfg.maxPubDia, ahora }),
    ultimaOk: pubPor.get(p)?.ultima_ok || null
  }));
  // Conexiones (variables Base64 de Railway + sesión guardada): lo que muestran los indicadores verde/rojo.
  const conexiones = listarConexiones({ filas: ses.rows, env, ahora });
  for (const p of plataformas) {
    const c = conexiones.find(x => x.plataforma === p.plataforma);
    if (!p.sesion.cargada && c?.estado === "valida" && c.fuente === "variable")
      p.motivos = [`La variable ${c.variable} es válida pero la sesión aún no está activa: pulsa Activar sesión.`];
  }
  const ia = evaluarIA(estadoLlaves());
  const ocupado = !!agenteOcupado();
  return { ...evaluarListo({ plataformas, ia, agenteOcupado: ocupado, publicarReal: cfg.publicarReal }), plataformas, conexiones, ia, agenteOcupado: ocupado };
}

// Paquete completo que consume el dashboard (una sola ida a la base por ciclo de refresco).
export async function instantanea(deps) {
  const { consulta, monitor, listarLotes, discoMb } = deps;
  const [listo, mon, lotes, inv, fuentes, jobs, inc, actividad, disco] = await Promise.all([
    estadoListo(deps), monitor(), listarLotes(12), consulta(SQL_INVENTARIO), consulta(SQL_FUENTES), consulta(SQL_JOBS),
    incidencias(consulta), eventosRecientes(consulta, 15), discoMb()
  ]);
  const clips = mapa(inv.rows);
  return {
    t: new Date().toISOString(),
    sistema: {
      modo: cfg.publicarReal ? "real" : "prueba", agenteOcupado: listo.agenteOcupado, discoMb: disco, maxDiscoMb: cfg.maxDiscoMb,
      zona: cfg.zonaHoraria, arranque: ARRANQUE, db: true
    },
    listo,
    inventario: {
      clips, total: Object.values(clips).reduce((a, b) => a + b, 0),
      conArchivo: inv.rows.reduce((a, r) => a + num(r.con_archivo), 0),
      mb: Math.round(inv.rows.reduce((a, r) => a + num(r.bytes), 0) / 1048576),
      fuentes: mapa(fuentes.rows),
      jobs: {
        pendientes: jobs.rows.filter(r => r.estado === "pendiente").reduce((a, r) => a + num(r.n), 0),
        corriendo: jobs.rows.filter(r => r.estado === "corriendo").reduce((a, r) => a + num(r.n), 0),
        errores24h: jobs.rows.filter(r => r.estado === "error").reduce((a, r) => a + num(r.n), 0),
        porTipo: jobs.rows.map(r => ({ tipo: r.tipo, estado: r.estado, n: num(r.n) }))
      }
    },
    monitor: mon,
    lotes,
    incidencias: inc,
    actividad
  };
}

// ---------- Canal en vivo (Server-Sent Events) ----------
// Un solo temporizador construye el paquete una vez por ciclo y lo reparte a todos los clientes conectados;
// sin clientes no consulta nada. Solo se envía cuando cambió algo (más un latido para saber que la línea vive).
export function crearCentro({ construir, cadaMs = 4000, latidoMs = 10000, max = 8, ahora = Date.now, temporizador = { set: setInterval, clear: clearInterval } }) {
  const clientes = new Set();
  let timer = null, ocupado = false, ultimaFirma = "", ultimo = null, ultimoEnvio = 0;

  const escribir = (res, texto) => { try { res.write(texto); } catch { clientes.delete(res); } };
  const enviar = (evento, datos) => {
    const texto = `event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`;
    ultimoEnvio = ahora();
    for (const r of [...clientes]) escribir(r, texto);
  };

  async function tick() {
    if (ocupado || !clientes.size) return;
    ocupado = true;
    try {
      const paquete = await construir();
      const { t, ...resto } = paquete;
      const firma = JSON.stringify(resto);
      if (firma !== ultimaFirma) { ultimaFirma = firma; ultimo = paquete; enviar("estado", paquete); }
      else if (ahora() - ultimoEnvio >= latidoMs) enviar("latido", { t: new Date(ahora()).toISOString() });
    } catch (e) {
      ultimaFirma = "";
      enviar("fallo", { error: String(e.message || "Error interno.").split("\n")[0].slice(0, 200), t: new Date(ahora()).toISOString() });
    } finally { ocupado = false; }
  }

  function parar() {
    if (timer) { temporizador.clear(timer); timer = null; }
    ultimo = null; ultimaFirma = "";
  }

  return {
    get conectados() { return clientes.size; },
    suscribir(req, res) {
      if (clientes.size >= max) return false;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive", "X-Accel-Buffering": "no"
      });
      res.flushHeaders?.();
      res.write("retry: 5000\n\n");
      clientes.add(res);
      if (ultimo) escribir(res, `event: estado\ndata: ${JSON.stringify(ultimo)}\n\n`);
      if (!timer) { timer = temporizador.set(tick, cadaMs); timer.unref?.(); }
      const salir = () => { clientes.delete(res); if (!clientes.size) parar(); };
      req.on("close", salir);
      res.on("error", salir);
      tick();
      return true;
    },
    tick,
    cerrar() {
      for (const r of [...clientes]) { try { r.end(); } catch { /* ya cerrado */ } }
      clientes.clear();
      parar();
    }
  };
}
