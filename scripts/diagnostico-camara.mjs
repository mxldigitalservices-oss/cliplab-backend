// Calibracion con material real, SIN renderizar:  node scripts/diagnostico-camara.mjs <video> [desde=0] [hasta=60] [corte=6]
// Parte el rango en cortes de `corte` segundos y muestra, por corte, lo que el motor decidiria:
// rostros, estabilidad de 2 personas, separacion, split y la trayectoria de la camara (cx).
// Ajusta con variables de entorno y vuelve a correr: CAM_ZONA_ON, CAM_TAU, CAM_VMAX, SPLIT_SEP_ON, SPLIT_SEP_OFF, ...
import { analizarCortes } from '../src/engine/sujeto.js';

const [video, d = '0', h = '60', c = '6'] = process.argv.slice(2);
if (!video) { console.error('Uso: node scripts/diagnostico-camara.mjs <video> [desde] [hasta] [corte]'); process.exit(1); }
const desde = Number(d), hasta = Number(h), paso = Number(c);
const cortes = [];
for (let t = 0; t < hasta - desde; t += paso) cortes.push({ desde: t, hasta: Math.min(t + paso, hasta - desde), plano: 'medio' });

const res = await analizarCortes(video, cortes, desde);
const f = (v) => (v == null ? '  -  ' : v.toFixed(2).padStart(5));
console.log('corte        n  pers cambios ratio2  sep   split  camara cx (min..max, keyframes)');
res.forEach((x, i) => {
  const s = x.sujeto;
  const rango = `${desde + x.desde}-${desde + x.hasta}s`.padEnd(11);
  if (!s) { console.log(`${rango}  sin rostro -> recorte centrado`); return; }
  const cxs = (s.kf || []).map((k) => k.cx);
  const cam = cxs.length ? `${Math.min(...cxs).toFixed(3)}..${Math.max(...cxs).toFixed(3)} (${cxs.length} kf)` : `fijo ${s.cx?.toFixed(3)}`;
  console.log(`${rango}  ${String(s.n).padStart(2)}  ${String(s.personas ?? '-').padStart(3)}  ${String(s.cambios ?? '-').padStart(5)}  ${f(s.ratio2)}  ${f(s.l != null ? s.r - s.l : null)}  ${s.split ? 'SPLIT' : '  .  '}  ${cam}`);
});
