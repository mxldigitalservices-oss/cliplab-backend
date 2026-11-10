import { readFileSync, writeFileSync } from 'node:fs';

const f = 'src/server.js';
let s = readFileSync(f, 'utf8');
if (s.includes('"/motor.html"')) { console.log('Ya aplicado. Nada que hacer.'); process.exit(0); }

const anchor = /^app\.use\("\/api\/motor", rutasMotor\);\s*$/m;
if (!anchor.test(s) || !s.includes('CSP_PANEL') || !/\bPUB\b/.test(s)) {
  console.error('No encontré las anclas (rutasMotor, CSP_PANEL, PUB) en src/server.js. No se modificó nada.');
  process.exit(1);
}
s = s.replace(anchor, (m) =>
  `${m.trimEnd()}\napp.get("/motor.html", (req, res) => res.set("Content-Security-Policy", CSP_PANEL).sendFile("motor.html", { root: PUB, dotfiles: "deny" }));`);
writeFileSync(f, s);
console.log('server.js: /motor.html ahora se sirve con CSP_PANEL. Para revertir: git checkout src/server.js');
