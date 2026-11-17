const fs = require('fs');
const f = 'src/engine/render.js';
let s = fs.readFileSync(f, 'utf8');
if (s.includes('analizarCortes')) { console.error('Ya aplicado.'); process.exit(1); }

function cambiar(regex, reemplazo, nombre) {
  if (!regex.test(s)) { console.error('NO ENCONTRADO: ' + nombre + ' (no se modifico nada)'); process.exit(1); }
  s = s.replace(regex, reemplazo);
}

// 1) import (despues del ultimo import de una linea)
const imports = [...s.matchAll(/^import .+;$/gm)];
if (imports.length === 0) { console.error('NO ENCONTRADO: imports'); process.exit(1); }
const ultimo = imports[imports.length - 1];
const pos = ultimo.index + ultimo[0].length;
s = s.slice(0, pos) + "\nimport { analizarCortes, xRostro } from './sujeto.js';" + s.slice(pos);

// 2) crop del modo recorte centrado en el rostro (solo dentro del bloque de cortes: lleva [v<i>])
cambiar(
  /'crop=' \+ ANCHO \+ ':' \+ ALTO \+ ':\(in_w-out_w\)\/2:\(in_h-out_h\)\/2,setsar=1\[v' \+ i \+ '\]'/,
  "'crop=' + ANCHO + ':' + ALTO + ':' + xRostro(c.sujeto) + ':(in_h-out_h)/2,setsar=1[v' + i + ']'",
  'crop en cortes'
);

// 3) analizar rostros antes de construir el filtro
cambiar(
  /const filtro = construirFiltro\(\{ modo, subtitulos: rutaAss, fontsDir, logo, cortes \}\);/,
  "const cortesRostro = await analizarCortes(entrada, cortes, desde);\n  const filtro = construirFiltro({ modo, subtitulos: rutaAss, fontsDir, logo, cortes: cortesRostro });",
  'construirFiltro en renderizarClip'
);

fs.writeFileSync(f, s);

// package.json: incluir la prueba nueva
const p = fs.readFileSync('package.json', 'utf8');
if (!p.includes('tests/sujeto.test.js')) {
  fs.writeFileSync('package.json', p.replace('tests/editorial.test.js', 'tests/editorial.test.js tests/sujeto.test.js'));
}
console.log('OK: render.js y package.json actualizados.');
