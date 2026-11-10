import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const TAG = '<script src="/js/motor-nav.js" defer></script>';
for (const f of ['src/public/index.html', 'src/public/motor.html']) {
  if (!existsSync(f)) { console.log(`${f}: no existe, se omite.`); continue; }
  const s = readFileSync(f, 'utf8');
  if (s.includes('motor-nav.js')) { console.log(`${f}: ya enlazado.`); continue; }
  const i = s.lastIndexOf('</body>');
  if (i < 0) { console.log(`${f}: no tiene </body>, no se modificó.`); continue; }
  copyFileSync(f, `${f}.bak-nav`);
  writeFileSync(f, `${s.slice(0, i)}${TAG}\n${s.slice(i)}`);
  console.log(`${f}: enlazado (copia en ${f}.bak-nav).`);
}
