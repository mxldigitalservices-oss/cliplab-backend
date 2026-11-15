import { readFileSync, writeFileSync } from 'node:fs';

/* ---------- Dockerfile: Node 22 (yt-dlp actual exige Node >= 22 para resolver los retos JS de YouTube) ---------- */
let docker = readFileSync('Dockerfile', 'utf8');
if (/^FROM node:22-/m.test(docker)) {
  console.log('Dockerfile: ya usa Node 22');
} else if (/^FROM node:20-bookworm-slim$/m.test(docker)) {
  docker = docker.replace(/^FROM node:20-bookworm-slim$/m, 'FROM node:22-bookworm-slim');
  writeFileSync('Dockerfile', docker);
  console.log('Dockerfile: imagen final cambiada a node:22-bookworm-slim');
} else {
  console.error('Dockerfile: no encontre "FROM node:20-bookworm-slim". Cambia la imagen final a node:22-bookworm-slim a mano.');
  process.exit(1);
}

/* ---------- download.js: diagnostico verbose + YTDLP_EXTRA_ARGS ---------- */
let texto = readFileSync('src/engine/download.js', 'utf8');
if (texto.includes('diagnosticarFormatos')) {
  console.log('download.js: ya tiene el diagnostico');
  process.exit(0);
}

const inicio = texto.indexOf('async function registrarFormatos(url, signal) {');
const fin = texto.indexOf('export async function descargarVideo');
const anclaFfmpeg = '  if (path.isAbsolute(config.ffmpegPath)) {';
if (inicio < 0 || fin < 0 || fin < inicio || !texto.includes(anclaFfmpeg)) {
  console.error('download.js: no reconoci la estructura. No se modifico.');
  process.exit(1);
}

const nuevo = `const RELEVANTE = /(jsc|JS runtimes?|challenge|SABR|Only images|yt-dlp version|PO ?Token|Signature solving|remote components)/i;

// Argumentos extra opcionales, p. ej. YTDLP_EXTRA_ARGS="--remote-components ejs:github"
function argumentosExtra() {
  return String(process.env.YTDLP_EXTRA_ARGS || '').split(/\\s+/).filter(Boolean);
}

export async function diagnosticarFormatos(url, signal) {
  const avisos = [];
  const resultado = await conSesion((rutaCookies) => {
    const args = [
      '--no-colors', '--no-playlist', '-v',
      '--js-runtimes', 'node', '--socket-timeout', '20', ...argumentosExtra(), '--list-formats',
    ];
    if (rutaCookies) args.push('--cookies', rutaCookies);
    args.push('--', url);
    return run(config.ytdlpPath, args, {
      timeoutMs: TIMEOUT_DIAGNOSTICO_MS,
      signal,
      onStderrLine: (linea) => {
        if (RELEVANTE.test(linea) && avisos.length < 40) avisos.push(linea.slice(0, 300));
      },
    });
  });
  return { formatos: resultado.stdout.split('\\n').filter(Boolean).slice(0, 40), avisos };
}

async function registrarFormatos(url, signal) {
  try {
    const { formatos, avisos } = await diagnosticarFormatos(url, signal);
    logger.warn('Formatos disponibles', { lineas: formatos });
    logger.warn('Diagnostico de yt-dlp (JS runtime, retos, SABR)', { avisos });
  } catch (error) {
    const detalle = String(error.stderr || error.message || '').trim().split('\\n').filter(Boolean).pop();
    logger.warn('No se pudo listar los formatos', { detalle });
  }
}

`;

texto = texto.slice(0, inicio) + nuevo + texto.slice(fin);
texto = texto.replace(anclaFfmpeg, () => '  base.push(...argumentosExtra());\n\n' + anclaFfmpeg);
texto = texto.replace(
  'Revisa en los logs la entrada "Formatos disponibles".',
  'Revisa en los logs las entradas "Formatos disponibles" y "Diagnostico de yt-dlp".'
);
writeFileSync('src/engine/download.js', texto);
console.log('download.js: diagnostico verbose y YTDLP_EXTRA_ARGS agregados');

const paquete = JSON.parse(readFileSync('package.json', 'utf8'));
const prueba = 'tests/diagnostico.test.js';
if (paquete.scripts && paquete.scripts.test && !paquete.scripts.test.includes(prueba)) {
  paquete.scripts.test += ' ' + prueba;
  writeFileSync('package.json', JSON.stringify(paquete, null, 2) + '\n');
  console.log('package.json: prueba del diagnostico registrada');
}
