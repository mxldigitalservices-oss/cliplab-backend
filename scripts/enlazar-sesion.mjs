import { readFileSync, writeFileSync } from 'node:fs';

const archivo = 'public/index.html';
const ancla = '<button id="btn-llave" class="btn" type="button">&#128273; Llave</button>';
const enlace = '<a class="btn" id="lnk-sesion" href="/sesion.html" style="text-decoration:none">&#127850; Sesion</a>';

const html = readFileSync(archivo, 'utf8');
if (html.includes('href="/sesion.html"')) {
  console.log('index.html ya tiene el enlace a la sesion.');
  process.exit(0);
}
if (!html.includes(ancla)) {
  console.error('No encontre el boton Llave en public/index.html. No se modifico nada.');
  process.exit(1);
}
writeFileSync(archivo, html.replace(ancla, () => enlace + '\n        ' + ancla));
console.log('index.html: enlace "Sesion" agregado junto al boton Llave.');
