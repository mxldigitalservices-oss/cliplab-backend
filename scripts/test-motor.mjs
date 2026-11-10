import assert from 'node:assert/strict';
import express from 'express';
import rutas from '../src/rutas-motor.js';

const app = express();
app.use('/api/motor', rutas);
const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}/api/motor`;
const j = async (m, p, b) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) });
  return [r.status, await r.json()];
};

let [s, d] = await j('GET', '/salud');
assert.equal(s, 200); assert.equal(typeof d.ffmpeg, 'boolean');
[s] = await j('POST', '/trabajos', {}); assert.equal(s, 400);
[s] = await j('POST', '/trabajos', { archivo: '../etc/passwd.mp4' }); assert.equal(s, 400);
[s] = await j('POST', '/trabajos', { url: 'file:///etc/passwd' }); assert.equal(s, 400);
[s] = await j('POST', '/trabajos', { archivo: 'no-existe.mp4' }); assert.equal(s, 404);
[s] = await j('GET', '/archivo/..%2F..%2Fx/clip_01.mp4'); assert.ok([400, 404].includes(s));
[s, d] = await j('GET', '/biblioteca'); assert.equal(s, 200); assert.ok(Array.isArray(d));
srv.close();
console.log('OK: router del motor responde y valida entradas.');
