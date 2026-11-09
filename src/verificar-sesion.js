// Verifica un archivo de cookies con EXACTAMENTE las reglas del panel (src/sesiones-env.js) y, si pasa,
// deja el Base64 listo para la variable de Railway. Nunca imprime valores de cookies, solo nombres.
//
// Uso:  node scripts/verificar-sesion.js <tiktok|instagram|facebook|youtube> <archivo> [salida.b64]
// <archivo>: JSON exportado con Cookie-Editor, un cookies.txt (Netscape) o un Base64 ya generado.
import fs from "node:fs";
import { CONEXIONES, variablesDe, analizarVariable, decodificarSesion } from "../src/sesiones-env.js";

const AYUDA = {
  youtube: "Faltan las cookies de inicio de sesión de Google. Entra a youtube.com con la sesión iniciada (ventana de incógnito, abre youtube.com/robots.txt en la misma pestaña) y exporta de nuevo.",
  facebook: "Faltan c_user y xs. Exporta estando DENTRO de facebook.com (con el feed abierto), no desde la pantalla de login.",
  tiktok: "Falta sessionid. Exporta estando dentro de tiktok.com con la sesión iniciada.",
  instagram: "Falta sessionid. Exporta estando dentro de instagram.com con la sesión iniciada."
};

const [plat, ruta, salida] = process.argv.slice(2);
const fallar = m => { console.error(m); process.exit(1); };
if (!CONEXIONES.includes(plat) || !ruta) fallar(`Uso: node scripts/verificar-sesion.js <${CONEXIONES.join("|")}> <archivo> [salida.b64]`);

let texto;
try { texto = fs.readFileSync(ruta, "utf8").replace(/^﻿/, "").trim(); } catch (e) { fallar(`No pude leer ${ruta}: ${e.message}`); }
if (!texto) fallar("✗ El archivo está vacío.");

const compacto = texto.replace(/\s+/g, "");
const yaB64 = !/^[[{#]/.test(texto) && /^[A-Za-z0-9+/_-]+={0,2}$/.test(compacto);
let b64;
if (yaB64) b64 = compacto;
else {
  if (/^[[{]/.test(texto)) {
    try { JSON.parse(texto); } catch (e) {
      fallar(`✗ JSON dañado: ${e.message.replace(/\s+/g, " ")}\n  El archivo tiene ${texto.length} caracteres y termina en «${texto.slice(-1)}». ` +
        (/[\]}]$/.test(texto) ? "Termina bien, así que hay un salto de línea o un carácter de más a mitad del texto: vuelve a exportar y pega el contenido completo sin editarlo." : "Parece cortado: se copió incompleto. Vuelve a exportar y pega todo."));
    }
  }
  b64 = Buffer.from(texto, "utf8").toString("base64");
}

let estado = null, errDecod = null;
try { estado = decodificarSesion(b64); } catch (e) { errDecod = e.message; }
const variable = variablesDe(plat)[0];
const { info } = analizarVariable(plat, { [variable]: b64 });

console.log(`Plataforma: ${plat} · variable de Railway: ${variable}`);
if (estado) console.log(`Cookies leídas: ${estado.cookies.length}\nNombres: ${[...new Set(estado.cookies.map(c => c.name))].sort().join(", ")}`);
if (!info.valida) fallar(`\n✗ El panel la rechazaría: ${info.motivo || errDecod}\n  ${AYUDA[plat]}`);

console.log(`\n✓ Válida para el panel · expira ${info.expira ? info.expira.toISOString().slice(0, 10) : "sin fecha"}`);
for (const a of info.avisos) console.log(`  aviso: ${a}`);
const destino = salida || `${plat}.b64`;
fs.writeFileSync(destino, b64 + "\n", { mode: 0o600 });
console.log(`\nBase64 de ${b64.length} caracteres guardado en ${destino}`);
console.log(`1) Ábrelo, selecciona todo (Ctrl+A), copia (Ctrl+C) y pégalo COMPLETO en Railway → variable ${variable}.`);
console.log(`   (o con la CLI de Railway:  railway variables --set "${variable}=$(cat ${destino})" )`);
console.log("2) Espera el redespliegue y pulsa «Activar sesión» en la pestaña Conexiones.");
console.log("3) Borra el .b64 y el JSON de tu equipo y no los subas a Git.");
