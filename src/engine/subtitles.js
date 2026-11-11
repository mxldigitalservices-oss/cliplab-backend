import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';

const COLOR_ACTIVA = '&H0000D4FF&';
const COLOR_CLAVE = '&H00A0E500&';
const COLA_SEGUNDOS = 0.3;
const DURACION_MINIMA = 0.08;

const PALABRAS_CLAVE = new Set([
  'gratis', 'oferta', 'ofertas', 'descuento', 'exclusivo', 'secreto', 'secretos',
  'nuevo', 'nueva', 'ahora', 'hoy', 'dinero', 'ganar', 'ganancias', 'resultados',
  'garantizado', 'increible', 'urgente', 'limitado', 'promocion', 'ventas',
  'clientes', 'negocio', 'millones', 'facil', 'rapido', 'error', 'errores',
  'verdad', 'imposible',
  'free', 'sale', 'offer', 'money', 'secret', 'new', 'now', 'today', 'win',
  'results', 'guaranteed', 'limited', 'business', 'easy', 'fast',
]);

function normalizar(texto) {
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function limpiarTexto(texto, mayusculas) {
  const limpio = String(texto).replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim();
  return mayusculas ? limpio.toLocaleUpperCase('es') : limpio;
}

function tiempoAss(segundos) {
  const cs = Math.max(0, Math.round(segundos * 100));
  const horas = Math.floor(cs / 360000);
  const minutos = Math.floor((cs % 360000) / 6000);
  const segs = Math.floor((cs % 6000) / 100);
  const centesimas = cs % 100;
  return horas + ':' + String(minutos).padStart(2, '0') + ':' + String(segs).padStart(2, '0') +
    '.' + String(centesimas).padStart(2, '0');
}

function agrupar(palabras, opciones) {
  const grupos = [];
  let actual = [];
  let largo = 0;

  for (const palabra of palabras) {
    const anterior = actual[actual.length - 1];

    if (anterior) {
      const hayPausa = palabra.inicio - anterior.fin > opciones.pausaMaxima;
      const excedePalabras = actual.length >= opciones.maxPalabras;
      const excedeLargo = largo + 1 + palabra.texto.length > opciones.maxCaracteres;
      const cierraFrase = /[.!?…]$/.test(anterior.texto);

      if (hayPausa || excedePalabras || excedeLargo || cierraFrase) {
        grupos.push(actual);
        actual = [];
        largo = 0;
      }
    }

    largo += (actual.length > 0 ? 1 : 0) + palabra.texto.length;
    actual.push(palabra);
  }

  if (actual.length > 0) grupos.push(actual);
  return grupos;
}

function construirTexto(grupo, activo, acumulativo) {
  return grupo.map((palabra, indice) => {
    if (indice > activo && acumulativo) {
      return '{\\alpha&HFF&}' + palabra.texto;
    }
    if (indice === activo) {
      const color = palabra.clave ? COLOR_CLAVE : COLOR_ACTIVA;
      const escala = palabra.clave ? 125 : 115;
      return '{\\r\\c' + color + '\\fscx85\\fscy85\\t(0,100,\\fscx' + escala + '\\fscy' + escala + ')}' + palabra.texto;
    }
    return palabra.clave ? '{\\r\\c' + COLOR_CLAVE + '}' + palabra.texto : '{\\r}' + palabra.texto;
  }).join(' ');
}

function cabecera(opciones) {
  const fuente = String(opciones.fuente).replace(/,/g, '');
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Principal,' + fuente + ',' + opciones.tamano + ',&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,7,3,2,70,70,' + opciones.margenV + ',1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
}

export function generarAss(palabras, opciones = {}) {
  const ajustes = {
    fuente: opciones.fuente || config.subtitleFont,
    tamano: opciones.tamano || 96,
    margenV: opciones.margenV || 560,
    maxPalabras: opciones.maxPalabras || 3,
    maxCaracteres: opciones.maxCaracteres || 22,
    pausaMaxima: opciones.pausaMaxima || 0.7,
    mayusculas: opciones.mayusculas !== false,
    acumulativo: opciones.acumulativo !== false,
  };

  const extras = new Set((opciones.palabrasClave || []).map(normalizar));

  const limpias = (palabras || [])
    .filter((p) => p && Number.isFinite(p.inicio) && Number.isFinite(p.fin))
    .map((p) => ({
      texto: limpiarTexto(p.texto, ajustes.mayusculas),
      inicio: p.inicio,
      fin: p.fin,
    }))
    .filter((p) => p.texto.length > 0)
    .sort((a, b) => a.inicio - b.inicio)
    .map((p) => {
      const normal = normalizar(p.texto);
      return { ...p, clave: PALABRAS_CLAVE.has(normal) || extras.has(normal) };
    });

  const lineas = cabecera(ajustes);
  const grupos = agrupar(limpias, ajustes);

  grupos.forEach((grupo, indiceGrupo) => {
    const siguienteGrupo = grupos[indiceGrupo + 1];
    const limite = siguienteGrupo ? siguienteGrupo[0].inicio : null;

    grupo.forEach((palabra, i) => {
      const siguiente = grupo[i + 1];
      let fin = siguiente ? siguiente.inicio : palabra.fin + COLA_SEGUNDOS;
      if (!siguiente && limite !== null) fin = Math.min(fin, limite);
      if (fin < palabra.inicio + DURACION_MINIMA) fin = palabra.inicio + DURACION_MINIMA;

      lineas.push(
        'Dialogue: 0,' + tiempoAss(palabra.inicio) + ',' + tiempoAss(fin) +
        ',Principal,,0,0,0,,' + construirTexto(grupo, i, ajustes.acumulativo)
      );
    });
  });

  return lineas.join('\n') + '\n';
}

export async function escribirAss(palabras, ruta, opciones = {}) {
  await fs.mkdir(path.dirname(ruta), { recursive: true });
  await fs.writeFile(ruta, generarAss(palabras, opciones), 'utf8');
  return ruta;
}
