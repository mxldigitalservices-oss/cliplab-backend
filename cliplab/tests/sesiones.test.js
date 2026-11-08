import test from "node:test";
import assert from "node:assert/strict";

process.env.MASTER_KEY = "clave-maestra-de-prueba-123";
const { normalizarSesion, validarSesion } = await import("../src/sesiones.js");
const { cifrar, descifrar } = await import("../src/crypto.js");

const AHORA = 1_800_000_000;   // segundos
const ck = (name, domain, extra = {}) => ({ name, value: "v-" + name, domain, path: "/", ...extra });

test("normaliza el formato de Cookie-Editor / EditThisCookie a storageState de Playwright", () => {
  const e = normalizarSesion([
    { name: "sessionid", value: "abc", domain: ".tiktok.com", path: "/", expirationDate: AHORA + 1000.7, httpOnly: true, secure: true, sameSite: "no_restriction", hostOnly: false },
    { name: "tt", value: "1", domain: "www.tiktok.com", session: true, sameSite: "unspecified" },
    { name: "malo", value: "x" }, null
  ]);
  assert.equal(e.cookies.length, 2);
  assert.deepEqual(e.cookies[0], { name: "sessionid", value: "abc", domain: ".tiktok.com", path: "/", expires: AHORA + 1000, httpOnly: true, secure: true, sameSite: "None" });
  assert.equal(e.cookies[1].expires, -1); assert.equal(e.cookies[1].sameSite, "Lax"); assert.equal(e.cookies[1].path, "/");
  assert.deepEqual(e.origins, []);
});

test("acepta storageState de Playwright, { estado } y rechaza basura", () => {
  const ss = { cookies: [ck("sessionid", ".instagram.com", { expires: AHORA + 5, sameSite: "Lax" })], origins: [{ origin: "https://www.instagram.com", localStorage: [{ name: "a", value: "b" }] }, { origin: 3 }] };
  assert.equal(normalizarSesion(ss).origins.length, 1);
  assert.equal(normalizarSesion({ estado: ss }).cookies.length, 1);
  assert.throws(() => normalizarSesion({ hola: 1 }), /no parece una sesión/);
  assert.throws(() => normalizarSesion([{ name: "x" }]), /no trae cookies/);
  assert.throws(() => normalizarSesion(null), /no parece una sesión/);
});

test("validar: exige cookies de autenticación vigentes y calcula la caducidad", () => {
  const ok = { cookies: [ck("sessionid", ".tiktok.com", { expires: AHORA + 30 * 86400 }), ck("otra", ".tiktok.com", { expires: AHORA + 100 })] };
  const v = validarSesion("tiktok", ok, AHORA);
  assert.equal(v.ok, true); assert.equal(v.expira.getTime(), (AHORA + 30 * 86400) * 1000); assert.deepEqual(v.avisos, []);

  assert.match(validarSesion("tiktok", { cookies: [ck("x", ".tiktok.com")] }, AHORA).errores[0], /Falta la cookie "sessionid"/);
  assert.match(validarSesion("tiktok", { cookies: [ck("x", ".instagram.com")] }, AHORA).errores[0], /No hay cookies de tiktok/);
  assert.match(validarSesion("tiktok", { cookies: [ck("sessionid", ".tiktok.com", { expires: AHORA - 5 })] }, AHORA).errores[0], /venció/);
  assert.match(validarSesion("tiktok", { cookies: [ck("sessionid", ".tiktok.com", { expires: AHORA + 86400 })] }, AHORA).avisos[0], /menos de 3 días/);
  assert.equal(validarSesion("tiktok", { cookies: [ck("sessionid", ".tiktok.com", { expires: -1 })] }, AHORA).ok, true, "cookie de sesión sin caducidad");
  assert.equal(validarSesion("facebook", { cookies: [ck("c_user", ".facebook.com", { expires: AHORA + 9e6 })] }, AHORA).errores.length, 1, "falta xs");
  assert.equal(validarSesion("facebook", { cookies: [ck("c_user", ".facebook.com", { expires: AHORA + 9e6 }), ck("xs", "www.facebook.com", { expires: AHORA + 8e6 })] }, AHORA).ok, true);
  assert.equal(validarSesion("youtube", {}, AHORA).ok, false);
  // un dominio que solo "termina parecido" no cuenta
  assert.equal(validarSesion("tiktok", { cookies: [ck("sessionid", "faketiktok.com")] }, AHORA).ok, false);
});

test("cifrado: ida y vuelta, aleatorio y a prueba de manipulación", () => {
  const estado = JSON.stringify({ cookies: [ck("sessionid", ".tiktok.com")] });
  const a = cifrar(estado), b = cifrar(estado);
  assert.notEqual(a, b);
  assert.ok(!a.includes("sessionid"));
  assert.equal(descifrar(a), estado);
  const raw = Buffer.from(a, "base64"); raw[raw.length - 1] ^= 1;
  assert.throws(() => descifrar(raw.toString("base64")));
});
