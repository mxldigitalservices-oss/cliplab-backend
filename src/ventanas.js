// Planificador de ventanas horarias. Módulo puro (sin red ni base de datos): fácil de probar.
// Una ventana es "HH:MM-HH:MM" en la zona horaria de publicación; cada variante cae en una ventana distinta.
import { cfg } from "./config.js";

export const VENTANAS_DEFECTO = Object.freeze(["09:00-11:00", "13:00-15:00", "19:00-22:00"]);

export function parseVentana(texto) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(texto ?? "").trim());
  if (!m) throw new Error(`Ventana inválida "${texto}": usa el formato HH:MM-HH:MM.`);
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  const ini = h1 * 60 + m1, fin = h2 * 60 + m2;
  if (h1 > 23 || h2 > 24 || m1 > 59 || m2 > 59 || fin > 1440) throw new Error(`Ventana inválida "${texto}": hora fuera de rango.`);
  if (fin - ini < 5) throw new Error(`Ventana inválida "${texto}": debe durar al menos 5 minutos y no cruzar la medianoche.`);
  return { ini, fin };
}

export function zonaValida(zona) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zona }); return true; } catch { return false; }
}

const partesEnZona = (ms, zona) => Object.fromEntries(
  new Intl.DateTimeFormat("en-US", { timeZone: zona, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));

// Diferencia (ms) entre la hora local de la zona y UTC en ese instante.
const desfaseMs = (ms, zona) => {
  const p = partesEnZona(ms, zona);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};

export const fechaEnZona = (ms, zona) => { const p = partesEnZona(ms, zona); return { y: p.year, m: p.month, d: p.day }; };

// Hora de pared (año, mes, día, minutos desde medianoche) en `zona` → instante UTC en ms. Respeta cambios de horario.
export function zonaAUtc(y, mes, d, minutosDia, zona) {
  const ingenuo = Date.UTC(y, mes - 1, d, Math.floor(minutosDia / 60), minutosDia % 60);
  const t = ingenuo - desfaseMs(ingenuo, zona);
  return ingenuo - desfaseMs(t, zona);
}

// Devuelve `cantidad` instantes (Date) ordenados: uno por ventana, a partir de `desde`, separados al menos
// `separacionMin` minutos y con hora aleatoria dentro de cada ventana (rnd inyectable para pruebas).
export function planificarVentanas({ cantidad, ventanas = VENTANAS_DEFECTO, desde = Date.now() + 60e3, zona = cfg.zonaHoraria, separacionMin = 90, rnd = Math.random, maxDias = 60 } = {}) {
  if (!Number.isInteger(cantidad) || cantidad < 1) throw new Error("cantidad debe ser un entero positivo.");
  if (!zonaValida(zona)) throw new Error(`Zona horaria inválida: ${zona}`);
  if (!Array.isArray(ventanas) || !ventanas.length) throw new Error("Indica al menos una ventana horaria.");
  const vs = ventanas.map(parseVentana).sort((a, b) => a.ini - b.ini);
  const base = fechaEnZona(desde, zona);
  const out = [];
  let ultimo = -Infinity;
  for (let dia = 0; dia < maxDias && out.length < cantidad; dia++) {
    const f = new Date(Date.UTC(base.y, base.m - 1, base.d + dia));
    const [y, m, d] = [f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate()];
    for (const v of vs) {
      if (out.length >= cantidad) break;
      const a = zonaAUtc(y, m, d, v.ini, zona), b = zonaAUtc(y, m, d, v.fin, zona);
      const piso = Math.max(a, desde, ultimo + separacionMin * 60e3);
      if (piso >= b) continue;   // esta ventana ya pasó o no deja espacio
      ultimo = piso + Math.floor(rnd() * (b - piso));
      out.push(ultimo);
    }
  }
  if (out.length < cantidad) throw new Error(`Las ventanas no alcanzan para ${cantidad} variantes en ${maxDias} días: agrega ventanas o reduce la separación.`);
  return out.map(t => new Date(t));
}
