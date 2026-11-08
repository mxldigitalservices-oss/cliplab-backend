// Prueba real de las 4 llaves: npm run gemini:probar  (con las variables GEMINI_API_KEY_1..4 cargadas)
import { ROL, estadoLlaves, generarTexto } from "../src/gemini.js";
import { db } from "../src/db.js";

console.table(estadoLlaves());
let fallos = 0;
for (const rol of Object.values(ROL)) {
  const lista = estadoLlaves().find(x => x.rol === rol);
  if (!lista.configurada) { console.log(`- ${rol}: sin llave (${lista.variable})`); continue; }
  try {
    const t0 = Date.now();
    const r = await generarTexto(rol, "Responde solo con la palabra: ok");
    console.log(`✔ ${rol}: "${r.texto.trim().slice(0, 20)}" vía ${r.rol} en ${Date.now() - t0} ms`);
  } catch (e) { fallos++; console.log(`✘ ${rol}: ${e.message}`); }
}
await db.end().catch(() => {});
process.exit(fallos ? 1 : 0);
