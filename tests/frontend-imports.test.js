import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Regresion: un modulo del frontend que dejo de exportar algo que otro importa deja la pagina "congelada"
// (el navegador aborta el modulo ANTES de registrar un solo listener: pestanas y botones muertos, "Conectando..." eterno).
// Esta prueba cruza cada `import { ... } from './x.js'` de public/js con los `export` reales de x.js.
const publico = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const dirJs = path.join(publico, 'js');
const archivos = fs.readdirSync(dirJs).filter((f) => f.endsWith('.js'));
const leer = (f) => fs.readFileSync(path.join(dirJs, f), 'utf8');

function exportsDe(texto) {
  const nombres = new Set();
  for (const m of texto.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) nombres.add(m[1]);
  for (const m of texto.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const parte of m[1].split(',')) {
      const [original, alias] = parte.trim().split(/\s+as\s+/);
      if (original) nombres.add((alias || original).trim());
    }
  }
  if (/export\s+default\b/.test(texto)) nombres.add('default');
  return nombres;
}

test('todos los archivos de public/js tienen sintaxis valida (node --check)', () => {
  for (const f of archivos) {
    const r = spawnSync(process.execPath, ['--check', path.join(dirJs, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, f + ': ' + r.stderr.split('\n').slice(0, 4).join(' '));
  }
});

test('cada import relativo de public/js apunta a un archivo y a nombres que ese archivo realmente exporta', () => {
  const exportados = Object.fromEntries(archivos.map((f) => [f, exportsDe(leer(f))]));
  const problemas = [];

  for (const f of archivos) {
    for (const m of leer(f).matchAll(/import\s+([^;]*?)\s+from\s+['"](\.[^'"]+)['"]/gs)) {
      const destino = path.basename(m[2]);
      if (!exportados[destino]) {
        problemas.push(f + ' importa ' + m[2] + ' y ese archivo no existe');
        continue;
      }
      const llaves = m[1].match(/\{([^}]*)\}/s);
      for (const parte of llaves ? llaves[1].split(',') : []) {
        const nombre = parte.trim().split(/\s+as\s+/)[0].trim();
        if (nombre && !exportados[destino].has(nombre)) {
          problemas.push(f + ' importa "' + nombre + '" de ' + destino + ', que no lo exporta');
        }
      }
    }
  }
  assert.deepEqual(problemas, [], 'Imports rotos en el frontend:\n - ' + problemas.join('\n - '));
});

test('index.html solo carga scripts que existen, y la guardia clasica va antes de los modulos', () => {
  const html = fs.readFileSync(path.join(publico, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)\bsrc="([^"]+)"/g)].map((m) => ({ modulo: /type="module"/.test(m[1]), src: m[2] }));
  assert.ok(scripts.length >= 2);
  for (const { src } of scripts) {
    assert.ok(fs.existsSync(path.join(publico, src.replace(/^\//, ''))), 'no existe ' + src);
  }
  const primeroModulo = scripts.findIndex((s) => s.modulo);
  const guardia = scripts.findIndex((s) => s.src === '/js/guardia.js');
  assert.ok(guardia !== -1 && guardia < primeroModulo, 'guardia.js debe cargarse antes que cualquier modulo');
});
