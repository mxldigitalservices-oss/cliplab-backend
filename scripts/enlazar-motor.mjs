import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const f = 'src/server.js';
let s = readFileSync(f, 'utf8');
if (s.includes('rutas-motor.js')) { console.log('server.js ya está enlazado. Nada que hacer.'); process.exit(0); }

const impRe = /^import \{ hAnalizar, hCortar, hPublicar, ytUrl \} from "\.\/pipeline\.js";\s*$/m;
const authRe = /^app\.use\(requireAuth\);\s*$/m;
if (!impRe.test(s) || !authRe.test(s)) {
  console.error('No encontré las líneas ancla en src/server.js. No se modificó nada.');
  process.exit(1);
}

copyFileSync(f, 'src/server.js.bak-motor');
s = s.replace(impRe, (m) => `${m.trimEnd()}\nimport rutasMotor from "./rutas-motor.js";`);
s = s.replace(authRe, (m) => `${m.trimEnd()}\napp.use("/api/motor", rutasMotor);`);
writeFileSync(f, s);
console.log('Enlazado. Copia de seguridad en src/server.js.bak-motor');
