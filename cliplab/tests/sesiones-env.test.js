// Sesiones desde variables Base64 (Railway): decodificación, validación, estado de conexión y activación. Sin base de datos.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cliplab-se-"));
Object.assign(process.env, { DATA_DIR: dir, MASTER_KEY: "k".repeat(20) });
delete process.env.YT_COOKIES;
const S = await import("../src/sesiones-env.js");
const { cfg } = await import("../src/config.js");

const AHORA = Date.parse("2026-11-08T12:00:00Z");
const seg = AHORA / 1000;
const b64 = o => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64");
const ck = (name, domain, expires = seg + 30 * 86400) => ({ name, value: "SECRETO-" + name, domain, path: "/", expires, httpOnly: true, secure: true, sameSite: "Lax" });
const tiktok = (extra = {}) => ({ SESION_TIKTOK_B64: b64([ck("sessionid", ".tiktok.com")]), ...extra });

test("variablesDe: nombres aceptados", () => {
  assert.deepEqual(S.variablesDe("tiktok"), ["SESION_TIKTOK_B64", "TIKTOK_SESSION_B64", "TIKTOK_COOKIES_B64"]);
  assert.equal(S.variablesDe("youtube")[0], "SESION_YOUTUBE_B64");
});

test("decodificarSesion: JSON, Base64 en una línea o con saltos, base64url y cookies.txt", () => {
  const cookies = [ck("sessionid", ".tiktok.com")];
  assert.equal(S.decodificarSesion(b64(cookies)).cookies[0].name, "sessionid");
  assert.equal(S.decodificarSesion(b64({ cookies, origins: [] })).cookies.length, 1);
  assert.equal(S.decodificarSesion(b64(cookies).replace(/(.{20})/g, "$1\n")).cookies.length, 1, "los saltos de línea al pegar se toleran");
  assert.equal(S.decodificarSesion(`"${b64(cookies)}"`).cookies.length, 1, "comillas alrededor");
  assert.equal(S.decodificarSesion(b64(cookies).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")).cookies.length, 1, "base64url");
  const txt = `# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t${Math.floor(seg + 1e6)}\tSID\tabc\n.youtube.com\tTRUE\t/\tFALSE\t0\tPREF\tx\n`;
  const ns = S.decodificarSesion(b64(txt));
  assert.deepEqual(ns.cookies.map(c => [c.name, c.httpOnly, c.secure]), [["SID", true, true], ["PREF", false, false]]);
});

test("decodificarSesion: errores claros y sin filtrar datos", () => {
  assert.throws(() => S.decodificarSesion("   "), /vacía/);
  assert.throws(() => S.decodificarSesion("esto no es base64!!"), /no es Base64 válido/);
  assert.throws(() => S.decodificarSesion(b64("{ roto")), /dañado/);
  assert.throws(() => S.decodificarSesion(b64("hola mundo")), /ni un cookies\.txt/);
  assert.throws(() => S.decodificarSesion(b64({ cosa: 1 })), /no parece una sesión/);
  assert.throws(() => S.decodificarSesion("A".repeat(10 * 1024 * 1024)), /demasiado grande/);
});

test("analizarVariable: válida, inválida y ausente (nunca devuelve valores de cookies)", () => {
  const ok = S.analizarVariable("tiktok", tiktok(), seg);
  assert.deepEqual([ok.info.presente, ok.info.valida, ok.info.cookies, ok.info.variable], [true, true, 1, "SESION_TIKTOK_B64"]);
  assert.ok(ok.estado.cookies.length === 1);
  assert.ok(!JSON.stringify(ok.info).includes("SECRETO"));

  const sinAuth = S.analizarVariable("tiktok", { SESION_TIKTOK_B64: b64([ck("otra", ".tiktok.com")]) }, seg);
  assert.ok(sinAuth.info.presente && !sinAuth.info.valida); assert.match(sinAuth.info.motivo, /Falta la cookie "sessionid"/); assert.equal(sinAuth.estado, null);

  const vencida = S.analizarVariable("tiktok", { SESION_TIKTOK_B64: b64([ck("sessionid", ".tiktok.com", seg - 10)]) }, seg);
  assert.ok(!vencida.info.valida); assert.match(vencida.info.motivo, /ya venció/);

  const rota = S.analizarVariable("tiktok", { SESION_TIKTOK_B64: "%%%" }, seg);
  assert.ok(rota.info.presente && !rota.info.valida); assert.match(rota.info.motivo, /Base64/);

  const ausente = S.analizarVariable("facebook", {}, seg);
  assert.ok(!ausente.info.presente); assert.match(ausente.info.motivo, /SESION_FACEBOOK_B64/);

  const alias = S.analizarVariable("tiktok", { TIKTOK_COOKIES_B64: b64([ck("sessionid", ".tiktok.com")]) }, seg);
  assert.ok(alias.info.valida); assert.equal(alias.info.variable, "TIKTOK_COOKIES_B64");

  const porVencer = S.analizarVariable("tiktok", { SESION_TIKTOK_B64: b64([ck("sessionid", ".tiktok.com", seg + 86400)]) }, seg);
  assert.ok(porVencer.info.valida); assert.match(porVencer.info.avisos[0], /menos de 3 días/);
});

test("analizarVariable: cambiar la variable se nota (no se queda con la caché)", () => {
  assert.ok(S.analizarVariable("tiktok", tiktok(), seg).info.valida);
  assert.ok(!S.analizarVariable("tiktok", { SESION_TIKTOK_B64: b64([ck("x", ".tiktok.com")]) }, seg).info.valida);
  assert.ok(S.analizarVariable("tiktok", tiktok(), seg).info.valida);
});

test("analizarVariable: Facebook (c_user + xs) y YouTube (SID / __Secure-3PSID)", () => {
  assert.ok(S.analizarVariable("facebook", { SESION_FACEBOOK_B64: b64([ck("c_user", ".facebook.com"), ck("xs", ".facebook.com")]) }, seg).info.valida);
  assert.ok(!S.analizarVariable("facebook", { SESION_FACEBOOK_B64: b64([ck("c_user", ".facebook.com")]) }, seg).info.valida);
  assert.ok(S.analizarVariable("youtube", { SESION_YOUTUBE_B64: b64([ck("__Secure-3PSID", ".google.com")]) }, seg).info.valida);
  const mala = S.analizarVariable("youtube", { SESION_YOUTUBE_B64: b64([ck("PREF", ".youtube.com")]) }, seg);
  assert.ok(!mala.info.valida); assert.match(mala.info.motivo, /SID/);
});

test("conexion: semáforo valida / invalida / sin_variable y sesión guardada", () => {
  const c = o => S.conexion({ plataforma: "tiktok", ahora: AHORA, ...o });
  assert.equal(c({ env: tiktok() }).estado, "valida");
  assert.equal(c({ env: tiktok() }).fuente, "variable");
  assert.equal(c({ env: {} }).estado, "sin_variable");
  assert.equal(c({ env: { SESION_TIKTOK_B64: "%%%" } }).estado, "invalida");
  const fallo = c({ env: tiktok(), sesionDb: { actualizado_en: "x", test_ok: false, test_detalle: "pide login" } });
  assert.equal(fallo.estado, "invalida"); assert.match(fallo.motivo, /prueba en el navegador falló: pide login/);
  const guardada = c({ env: {}, sesionDb: { actualizado_en: "x", expira_en: new Date(AHORA + 1e9).toISOString(), test_ok: null } });
  assert.deepEqual([guardada.estado, guardada.fuente, guardada.activa], ["valida", "guardada", true]);
  assert.match(guardada.avisos[0], /se usa la sesión guardada/);
  assert.equal(c({ env: {}, sesionDb: { expira_en: new Date(AHORA - 1000).toISOString() } }).estado, "invalida");
  assert.equal(S.conexion({ plataforma: "youtube", env: {}, ahora: AHORA }).publicable, false);
  assert.ok(!JSON.stringify(c({ env: tiktok() })).includes("SECRETO"));
});

test("listarConexiones: las 4 plataformas en orden", () => {
  const l = S.listarConexiones({ filas: [], env: tiktok(), ahora: AHORA });
  assert.deepEqual(l.map(x => x.plataforma), ["tiktok", "instagram", "facebook", "youtube"]);
  assert.deepEqual(l.map(x => x.estado), ["valida", "sin_variable", "sin_variable", "sin_variable"]);
});

test("activarSesion: guarda cifrado vía el guardador, rechaza lo inválido y prepara yt-dlp", async () => {
  const guardadas = [];
  const guardar = async (p, estado, o) => guardadas.push([p, estado.cookies.length, o]);
  const r = await S.activarSesion("tiktok", { env: tiktok(), ahora: AHORA, guardar });
  assert.deepEqual([r.ok, r.destino, r.cookies], [true, "agente", 1]);
  assert.deepEqual(guardadas, [["tiktok", 1, { nueva: true }]]);

  await assert.rejects(() => S.activarSesion("facebook", { env: {}, ahora: AHORA, guardar }), e => e.status === 400 && /SESION_FACEBOOK_B64/.test(e.message));
  await assert.rejects(() => S.activarSesion("tiktok", { env: { SESION_TIKTOK_B64: b64([ck("x", ".tiktok.com")]) }, ahora: AHORA, guardar }), e => e.status === 400 && /no es válida/.test(e.message));
  await assert.rejects(() => S.activarSesion("myspace", { env: {}, guardar }), e => e.status === 404);
  assert.equal(guardadas.length, 1, "lo inválido no se guarda");

  const yt = await S.activarSesion("youtube", { env: { SESION_YOUTUBE_B64: b64([ck("SID", ".youtube.com")]) }, ahora: AHORA, guardar });
  assert.equal(yt.destino, "yt-dlp");
  const archivo = path.join(dir, "youtube-cookies.txt");
  assert.equal(cfg.ytCookies, archivo);
  assert.match(fs.readFileSync(archivo, "utf8"), /^# Netscape HTTP Cookie File/);
  assert.equal(fs.statSync(archivo).mode & 0o077, 0, "solo el dueño puede leer el archivo");
  assert.equal(S.parsearNetscape(fs.readFileSync(archivo, "utf8"))[0].name, "SID", "ida y vuelta Netscape");
});
