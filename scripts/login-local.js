// Se ejecuta en TU equipo (no en Railway): abre un navegador visible en la pagina oficial de login, tu inicias
// sesion a mano (captcha / 2FA incluidos, con tu propia IP) y, en cuanto detecta la sesion, la envia cifrada-en-reposo
// al servidor, que la guarda en SESSION_DIR igual que la de YouTube. El panel pasa a "Sesion activa" solo.
//
// Requisitos (una sola vez):  npm i --no-save playwright && npx playwright install chromium
// Uso:  CLIPLAB_URL=https://tu-app.up.railway.app MASTER_KEY=tu-llave npm run login -- tiktok|instagram|facebook
import fs from 'node:fs';
import { PERFIL } from '../src/agent/perfil.js';
import { PLATAFORMAS_RED, esPlataformaRed, esperarLogin, validarEstado } from '../src/sesion/plataformas.js';

const plataforma = process.argv[2];
if (!esPlataformaRed(plataforma)) {
  console.log('Uso: CLIPLAB_URL=https://tu-app.up.railway.app MASTER_KEY=... npm run login -- tiktok|instagram|facebook');
  process.exit(1);
}

const base = (process.env.CLIPLAB_URL || '').replace(/\/$/, '');
const llave = (process.env.MASTER_KEY || '').trim();
if (!base || !llave) {
  console.log('Faltan CLIPLAB_URL y/o MASTER_KEY. Sin ellas la sesion solo se guardara en un archivo local.');
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Falta Playwright. Instalalo con:  npm i --no-save playwright && npx playwright install chromium');
  process.exit(1);
}

const def = PLATAFORMAS_RED[plataforma];
const navegador = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
const contexto = await navegador.newContext(PERFIL);
const pagina = await contexto.newPage();
await pagina.goto(def.urlLogin);
console.log('Inicia sesion en ' + def.nombre + ' en la ventana abierta. Se detectara sola (maximo 5 minutos)...');

let estado;
try {
  estado = await esperarLogin(contexto, plataforma);
} catch (error) {
  console.error(error.message);
  await navegador.close().catch(() => {});
  process.exit(1);
}
await navegador.close().catch(() => {});

const valido = validarEstado(plataforma, estado);
if (!valido.ok) {
  console.error(valido.error);
  process.exit(1);
}

if (base && llave) {
  const r = await fetch(base + '/api/panel/conexiones/' + plataforma, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-master-key': llave },
    body: JSON.stringify({ estado: valido.estado }),
  });
  const cuerpo = await r.json().catch(() => ({}));
  if (r.ok && cuerpo.success) {
    console.log('Listo: sesion de ' + def.nombre + ' guardada en el servidor. Revisa la pestana Conexiones.');
    process.exit(0);
  }
  console.error('El servidor respondio ' + r.status + ': ' + (cuerpo.error || 'sin detalle'));
}

const archivo = 'sesion-' + plataforma + '.json';
fs.writeFileSync(archivo, JSON.stringify(valido.estado), { mode: 0o600 });
console.log('Sesion guardada en ' + archivo + ' (permiso 600). NO la subas a GitHub; bórrala cuando termines.');
process.exit(1);
