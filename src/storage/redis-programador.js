import crypto from 'node:crypto';
import { createClient } from 'redis';
import { logger } from '../utils/logger.js';

const PREFIJO_DEFECTO = 'cliplab:prog';
const VENTANA_MS_DEFECTO = 60 * 60 * 1000;
const REINTENTO_MS_DEFECTO = 30 * 1000;

const LUA_LIBERAR_LOCK = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const LUA_RENOVAR_LOCK = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

const LUA_RESERVAR_VENTANA = `
redis.call("zremrangebyscore", KEYS[1], "-inf", ARGV[1])
local total = redis.call("zcard", KEYS[1])
local tope = tonumber(ARGV[2])
if total >= tope then
  local oldest = redis.call("zrange", KEYS[1], 0, 0, "WITHSCORES")
  local proximo = oldest[2] and (tonumber(oldest[2]) + tonumber(ARGV[3])) or (tonumber(ARGV[4]) + tonumber(ARGV[3]))
  return {0, total, tostring(proximo)}
end
redis.call("zadd", KEYS[1], ARGV[4], ARGV[5])
redis.call("pexpire", KEYS[1], ARGV[6])
return {1, total + 1, "0"}
`;

function limpiarPrefijo(prefijo) {
  const s = String(prefijo || PREFIJO_DEFECTO).trim();
  return s.replace(/:+$/, '') || PREFIJO_DEFECTO;
}

function resumirError(err) {
  if (!err) return 'Error desconocido';
  return err.message || String(err);
}

function coincidirPatron(clave, patron) {
  if (!patron.includes('*')) return clave === patron;
  const escaped = patron.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(clave);
}

export function crearAlmacen(opciones = {}) {
  const ahora = typeof opciones.ahora === 'function' ? opciones.ahora : () => Date.now();
  const url = opciones.url !== undefined ? String(opciones.url).trim() : String(process.env.REDIS_URL || '').trim();
  const prefijo = limpiarPrefijo(opciones.prefijo || process.env.REDIS_PROG_PREFIJO || PREFIJO_DEFECTO);
  const ventanaMs = Number.isFinite(Number(opciones.ventanaMs)) && Number(opciones.ventanaMs) > 0
    ? Number(opciones.ventanaMs)
    : VENTANA_MS_DEFECTO;
  const reintentoMs = Number.isFinite(Number(opciones.reintentoMs)) && Number(opciones.reintentoMs) >= 0
    ? Number(opciones.reintentoMs)
    : REINTENTO_MS_DEFECTO;
  const fabricaCliente = typeof opciones.fabricaCliente === 'function'
    ? opciones.fabricaCliente
    : (u) => createClient({ url: u });

  const locksMem = new Map();
  const ventanasMem = new Map();
  const cacheMem = new Map();

  let cliente = null;
  let conectado = false;
  let cerrado = false;
  let ultimoError = null;
  let proximoIntentoMs = 0;
  let reconectando = null;

  const claveLock = (nombre) => `${prefijo}:lock:${nombre}`;
  const claveVentana = (canal) => `${prefijo}:ventana:${canal}`;
  const claveCache = (clave) => `${prefijo}:cache:${clave}`;

  function marcarCaida(err) {
    conectado = false;
    ultimoError = resumirError(err);
    proximoIntentoMs = ahora() + reintentoMs;
    logger?.warn?.({ err: ultimoError }, 'Redis no disponible en programador; usando respaldo en memoria');
  }

  async function intentarConectar({ forzar = false } = {}) {
    if (cerrado || !url) return false;
    if (!forzar && ahora() < proximoIntentoMs) return false;
    if (reconectando) return reconectando;

    reconectando = (async () => {
      try {
        const cli = fabricaCliente(url);
        cli.on?.('error', (err) => {
          if (conectado) marcarCaida(err);
        });
        await cli.connect();
        cliente = cli;
        conectado = true;
        ultimoError = null;
        return true;
      } catch (err) {
        cliente = null;
        marcarCaida(err);
        return false;
      } finally {
        reconectando = null;
      }
    })();

    return reconectando;
  }

  async function asegurarRedis() {
    if (cerrado || !url) return false;
    if (conectado && cliente) return true;
    return intentarConectar();
  }

  function purgarLockMem(key) {
    const item = locksMem.get(key);
    if (!item) return null;
    if (item.expira <= ahora()) {
      locksMem.delete(key);
      return null;
    }
    return item;
  }

  function purgarVentanaMem(key, ts) {
    const limite = ts - ventanaMs;
    const lista = ventanasMem.get(key) || [];
    const filtrada = lista.filter((item) => item.ts > limite);
    if (filtrada.length > 0) {
      ventanasMem.set(key, filtrada);
    } else {
      ventanasMem.delete(key);
    }
    return filtrada;
  }

  function agregarVentanaMem(key, id, ts) {
    const lista = purgarVentanaMem(key, ts);
    if (!lista.some((item) => item.id === id)) {
      lista.push({ id, ts });
      ventanasMem.set(key, lista);
    }
    return lista;
  }

  function leerCacheMem(key) {
    const item = cacheMem.get(key);
    if (!item) return undefined;
    if (item.expira !== null && item.expira <= ahora()) {
      cacheMem.delete(key);
      return undefined;
    }
    return item.valor;
  }

  async function iniciar() {
    cerrado = false;
    if (!url) {
      return estado();
    }
    await intentarConectar({ forzar: true });
    return estado();
  }

  async function adquirirLock(nombre, ttlMs = 15000) {
    const key = claveLock(nombre);
    const token = crypto.randomUUID();
    const ttl = Math.max(50, Number(ttlMs) || 15000);

    if (await asegurarRedis()) {
      try {
        const ok = await cliente.set(key, token, { NX: true, PX: ttl });
        if (ok === 'OK') {
          locksMem.set(key, { token, expira: ahora() + ttl });
          return token;
        }
        return null;
      } catch (err) {
        marcarCaida(err);
      }
    }

    const actual = purgarLockMem(key);
    if (actual) return null;
    locksMem.set(key, { token, expira: ahora() + ttl });
    return token;
  }

  async function liberarLock(nombre, token) {
    if (!token) return false;
    const key = claveLock(nombre);

    if (conectado && cliente) {
      try {
        const res = await cliente.eval(LUA_LIBERAR_LOCK, { keys: [key], arguments: [token] });
        const actual = locksMem.get(key);
        if (actual && actual.token === token) locksMem.delete(key);
        return Number(res) === 1;
      } catch (err) {
        marcarCaida(err);
      }
    }

    const actual = purgarLockMem(key);
    if (!actual || actual.token !== token) return false;
    locksMem.delete(key);
    return true;
  }

  async function renovarLock(nombre, token, ttlMs = 15000) {
    if (!token) return false;
    const key = claveLock(nombre);
    const ttl = Math.max(50, Number(ttlMs) || 15000);

    if (conectado && cliente) {
      try {
        const res = await cliente.eval(LUA_RENOVAR_LOCK, { keys: [key], arguments: [token, String(ttl)] });
        if (Number(res) === 1) {
          locksMem.set(key, { token, expira: ahora() + ttl });
          return true;
        }
        return false;
      } catch (err) {
        marcarCaida(err);
      }
    }

    const actual = purgarLockMem(key);
    if (!actual || actual.token !== token) return false;
    actual.expira = ahora() + ttl;
    return true;
  }

  async function conLock(nombre, ttlMs, fn) {
    const token = await adquirirLock(nombre, ttlMs);
    if (!token) return { adquirido: false };
    try {
      const valor = await fn();
      return { adquirido: true, valor };
    } finally {
      await liberarLock(nombre, token);
    }
  }

  const colasVentana = new Map();
  function enColaVentana(key, tarea) {
    const previa = colasVentana.get(key) || Promise.resolve();
    const siguiente = previa.catch(() => {}).then(tarea);
    const guardada = siguiente.finally(() => {
      if (colasVentana.get(key) === guardada) colasVentana.delete(key);
    });
    colasVentana.set(key, guardada);
    return siguiente;
  }

  async function reservarEnVentana(canal, { tope = 2 } = {}) {
    const max = Number(tope);
    if (!Number.isFinite(max) || max < 1) {
      throw new Error("El tope de la ventana debe ser un numero mayor o igual a 1");
    }
    const ts = ahora();
    const key = claveVentana(canal);
    const id = crypto.randomUUID();
    const miembro = `${ts}:${id}`;

    return enColaVentana(key, async () => {
      if (await asegurarRedis()) {
        try {
          await cliente.zRemRangeByScore(key, "-inf", ts - ventanaMs);
          const total = Number(await cliente.zCard(key));
          if (total >= max) {
            const masAntiguo = await cliente.zRangeWithScores(key, 0, 0);
            const proximoEn = masAntiguo[0] ? Number(masAntiguo[0].score) + ventanaMs : ts + ventanaMs;
            return { permitido: false, cuenta: total, tope: max, proximoEn };
          }
          await cliente.zAdd(key, { score: ts, value: miembro });
          await cliente.pExpire(key, ventanaMs + 1000);
          agregarVentanaMem(key, id, ts);
          return { permitido: true, id, cuenta: total + 1, tope: max };
        } catch (err) {
          marcarCaida(err);
        }
      }

      const lista = purgarVentanaMem(key, ts);
      if (lista.length >= max) {
        const proximoEn = lista[0].ts + ventanaMs;
        return { permitido: false, cuenta: lista.length, tope: max, proximoEn };
      }
      lista.push({ id, ts });
      ventanasMem.set(key, lista);
      return { permitido: true, id, cuenta: lista.length, tope: max };
    });
  }

  async function devolverReserva(canal, id) {
    if (!id) return false;
    const key = claveVentana(canal);
    if (conectado && cliente) {
      try {
        for await (const miembro of cliente.zRangeWithScores(key, 0, -1)) {
          if (String(miembro.value).endsWith(`:${id}`)) {
            await cliente.zRem(key, miembro.value);
            break;
          }
        }
      } catch (err) {
        marcarCaida(err);
      }
    }
    const lista = ventanasMem.get(key);
    if (!lista) return true;
    const filtrada = lista.filter((item) => item.id !== id);
    if (filtrada.length > 0) ventanasMem.set(key, filtrada);
    else ventanasMem.delete(key);
    return true;
  }

  async function contarVentana(canal) {
    const ts = ahora();
    const key = claveVentana(canal);
    if (conectado && cliente) {
      try {
        await cliente.zRemRangeByScore(key, '-inf', ts - ventanaMs);
        return Number(await cliente.zCard(key));
      } catch (err) {
        marcarCaida(err);
      }
    }
    return purgarVentanaMem(key, ts).length;
  }

  async function cacheLeer(clave) {
    const key = claveCache(clave);
    if (await asegurarRedis()) {
      try {
        const raw = await cliente.get(key);
        if (raw === null || raw === undefined) return undefined;
        return JSON.parse(raw);
      } catch (err) {
        marcarCaida(err);
      }
    }
    return leerCacheMem(key);
  }

  async function cacheEscribir(clave, valor, ttlMs = 5000) {
    const key = claveCache(clave);
    const ttl = Math.max(100, Number(ttlMs) || 5000);
    cacheMem.set(key, { valor, expira: ahora() + ttl });
    if (conectado && cliente) {
      try {
        await cliente.set(key, JSON.stringify(valor), { PX: ttl });
      } catch (err) {
        marcarCaida(err);
      }
    }
    return true;
  }

  async function cacheObtener(clave, ttlMs, cargar) {
    const existente = await cacheLeer(clave);
    if (existente !== undefined) return existente;
    const valor = await cargar();
    await cacheEscribir(clave, valor, ttlMs);
    return valor;
  }

  async function invalidarCache(patron) {
    const claveObjetivo = claveCache(patron);
    for (const key of [...cacheMem.keys()]) {
      if (coincidirPatron(key, claveObjetivo)) cacheMem.delete(key);
    }
    if (conectado && cliente) {
      try {
        const coincidencias = [];
        for await (const key of cliente.scanIterator({ MATCH: claveObjetivo, COUNT: 100 })) {
          coincidencias.push(key);
        }
        if (coincidencias.length > 0) {
          await cliente.del(coincidencias);
        }
      } catch (err) {
        marcarCaida(err);
      }
    }
    return true;
  }

  async function cerrar() {
    cerrado = true;
    const cli = cliente;
    cliente = null;
    conectado = false;
    if (cli) {
      try {
        await cli.quit();
      } catch {
        try { cli.disconnect?.(); } catch {}
      }
    }
  }

  function estado() {
    const configurado = Boolean(url);
    const modo = conectado ? 'redis' : 'memoria';
    let detalle = 'Modo memoria activo (sin REDIS_URL configurado)';
    if (conectado) {
      detalle = 'Conectado a Redis';
    } else if (configurado && ultimoError) {
      detalle = `Redis no disponible (${ultimoError}); respaldo en memoria activo`;
    } else if (configurado) {
      detalle = 'Respaldo en memoria activo';
    }
    return {
      configurado,
      conectado,
      modo,
      prefijo,
      ultimoError,
      detalle,
    };
  }

  return {
    iniciar,
    cerrar,
    estado,
    adquirirLock,
    liberarLock,
    renovarLock,
    conLock,
    reservarEnVentana,
    devolverReserva,
    contarVentana,
    cacheLeer,
    cacheEscribir,
    cacheObtener,
    invalidarCache,
  };
}

export const almacenRedis = crearAlmacen();
