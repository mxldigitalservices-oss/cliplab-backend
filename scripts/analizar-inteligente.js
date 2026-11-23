#!/usr/bin/env node
// CLI del cerebro de marketing: node scripts/analizar-inteligente.js "texto" | --texto "..." | --archivo ruta.txt | stdin
// Opciones: --duracion <seg> --instruccion "tema" --titulo "titulo del video" --json --sin-ollama
import fs from 'node:fs';
import { analizarBloque } from '../src/engine/cerebro-marketing.js';

const AYUDA = [
  'Uso: node scripts/analizar-inteligente.js [texto] [opciones]',
  '  --texto "..."         texto o transcripcion del bloque',
  '  --archivo ruta.txt    leer el texto desde un archivo',
  '  (stdin)               si no hay texto ni archivo, se lee de la entrada estandar',
  '  --duracion <seg>      duracion aproximada del bloque (por defecto se estima)',
  '  --instruccion "..."   tema o instruccion opcional',
  '  --titulo "..."        titulo del video (opcional)',
  '  --json                salida en JSON',
  '  --sin-ollama          usar solo el motor heuristico local',
].join('\n');

export function leerArgumentos(argv) {
  const r = { texto: '', archivo: '', duracion: undefined, instruccion: '', titulo: '', json: false, ollama: undefined, ayuda: false, sueltos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const valor = () => (argv[++i] ?? '');
    if (a === '--texto') r.texto = valor();
    else if (a === '--archivo') r.archivo = valor();
    else if (a === '--duracion') r.duracion = Number(valor());
    else if (a === '--instruccion') r.instruccion = valor();
    else if (a === '--titulo') r.titulo = valor();
    else if (a === '--json') r.json = true;
    else if (a === '--sin-ollama') r.ollama = false;
    else if (a === '--ayuda' || a === '--help' || a === '-h') r.ayuda = true;
    else r.sueltos.push(a);
  }
  if (!r.texto && r.sueltos.length) r.texto = r.sueltos.join(' ');
  return r;
}

function leerStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function formatearLegible(r) {
  const lineas = [
    'Veredicto : ' + r.veredicto.toUpperCase() + '  (puntaje ' + r.puntaje + '/100, motor: ' + r.motor + ')',
    'Ángulo    : ' + r.angulo,
    'Gancho    : ' + (r.gancho || '(sin gancho)'),
    'Título    : ' + r.tituloPrincipal,
    '',
    'Variantes de título:',
    ...r.variantesTitulo.map((v, i) => '  ' + (i + 1) + '. [' + v.puntaje + '] (' + v.tipo + ') ' + v.titulo),
    '',
    'Copy:',
    r.copy ? r.copy.split('\n').map((l) => '  ' + l).join('\n') : '  (vacío)',
    '',
    'CTA       : ' + r.cta,
    'Hashtags  : ' + r.hashtags.join(' '),
  ];
  return lineas.join('\n');
}

async function principal() {
  const args = leerArgumentos(process.argv.slice(2));
  if (args.ayuda) {
    console.log(AYUDA);
    return 0;
  }
  let texto = args.texto;
  if (!texto && args.archivo) {
    try {
      texto = fs.readFileSync(args.archivo, 'utf8');
    } catch (error) {
      console.error('No se pudo leer el archivo: ' + error.message);
      return 2;
    }
  }
  if (!texto && !process.stdin.isTTY) texto = leerStdin();
  texto = String(texto || '').trim();
  if (!texto) {
    console.error('Falta el texto del bloque.\n\n' + AYUDA);
    return 2;
  }
  const resultado = await analizarBloque(
    { texto, duracion: args.duracion, instruccion: args.instruccion, tituloVideo: args.titulo },
    { ollama: args.ollama }
  );
  console.log(args.json ? JSON.stringify(resultado, null, 2) : formatearLegible(resultado));
  return 0;
}

principal().then((codigo) => { process.exitCode = codigo; }).catch((error) => {
  console.error('Error inesperado: ' + (error && error.message ? error.message : error));
  process.exitCode = 1;
});
