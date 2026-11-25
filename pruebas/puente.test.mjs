/* Pruebas automáticas del puente. Correr: npm test
   Regla: todo cambio nuevo del puente agrega aquí su prueba antes de publicarse. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const SX = await import("../sigo-extra.mjs");
const fuente = fs.readFileSync(new URL("../puente.js", import.meta.url), "utf8");
const vend = (email = "prueba" + Math.random() + "@x.com") => ({ email, DATA: { results: [] }, queue: [], st: {} });

test("variar: expande {a|b}, cambia saludo y no toca el resto", () => {
  const t = "🇵🇪 ¡Hola, Ana!\n{Te escribo|Te cuento} por el {condominio|proyecto}.\nPrecio: S/ 100\nFin";
  const saludos = new Set();
  for (let i = 0; i < 60; i++) {
    const v = SX.variar(t);
    assert.ok(!/\{[^}]*\|[^}]*\}/.test(v), "quedó un {a|b} sin expandir");
    assert.ok(v.includes("Precio: S/ 100"), "cambió un dato del mensaje");
    assert.ok(/(Te escribo|Te cuento) por el (condominio|proyecto)/.test(v));
    saludos.add(v.split(",")[0]);
  }
  assert.ok(saludos.size >= 2, "el saludo no varía");
  assert.ok(SX.variar("Hola {nombre}").endsWith("{nombre}"), "tocó una llave sin opciones");
});

test("destinoSeguro: no envía a números sin WhatsApp (difusión)", async () => {
  const sl = vend();
  const no = { onWhatsApp: async () => [] }, si = { onWhatsApp: async () => [{ exists: true, jid: "51999@s.whatsapp.net" }] };
  assert.equal((await SX.destinoSeguro(sl, no, "51999888777", true)).length, 0);
  assert.equal((await SX.destinoSeguro(sl, si, "51999888777", true))[0].jid, "51999@s.whatsapp.net");
});
test("destinoSeguro: si WhatsApp falla, envía igual (no se pierden clientes)", async () => {
  const r = await SX.destinoSeguro(vend(), { onWhatsApp: async () => { throw new Error("timeout"); } }, "51999888777", true);
  assert.equal(r[0].jid, "51999888777@s.whatsapp.net");
});
test("destinoSeguro: si casi todos 'no existen' es falla de WhatsApp → envía igual", async () => {
  const sl = vend(), no = { onWhatsApp: async () => [] };
  for (let i = 0; i < 16; i++) await SX.destinoSeguro(sl, no, "5199988877" + (i % 10), true);
  assert.equal((await SX.destinoSeguro(sl, no, "51999888777", true)).length, 1);
});
test("destinoSeguro: mensajes manuales siguen enviándose aunque no 'exista'", async () => {
  const r = await SX.destinoSeguro(vend(), { onWhatsApp: async () => [] }, "51999888777", false);
  assert.equal(r.length, 1);
});

test("escudo: normal → cuidado → freno según números sin WhatsApp", async () => {
  SX._probarCon({ sellers: () => [], log: () => { } });
  const sl = vend(), no = { onWhatsApp: async () => [] }, si = { onWhatsApp: async () => [{ exists: true, jid: "j" }] };
  for (let i = 0; i < 10; i++) await SX.destinoSeguro(sl, si, "51999888777", true);
  assert.equal(SX.escudoEstado(sl).nivel, 0);
  for (let i = 0; i < 4; i++) await SX.destinoSeguro(sl, no, "51999888777", true);
  assert.equal(SX.escudoEstado(sl).nivel, 1);
  for (let i = 0; i < 8; i++) await SX.destinoSeguro(sl, no, "51999888777", true);
  const e = SX.escudoEstado(sl); assert.equal(e.nivel, 2); assert.ok(e.frenoMs > 0, "no frenó");
});

test("navegador: vinculación nueva = Windows y NO cambia aunque ya exista creds.json", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nav-"));
  assert.equal(SX.navegador(d)[0], "Windows");
  fs.writeFileSync(path.join(d, "creds.json"), "{}");
  assert.equal(SX.navegador(d)[0], "Windows", "cambió de nombre a mitad de la vinculación");
});
test("navegador: sesiones que ya existían siguen como Ubuntu", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nav-"));
  fs.writeFileSync(path.join(d, "creds.json"), "{}");
  assert.equal(SX.navegador(d)[0], "Ubuntu");
});

test("aviso al vendedor: llama a aviso-vendedor con la cola y no repite en 30 min", async () => {
  const llamadas = []; const orig = globalThis.fetch;
  globalThis.fetch = async (u, o) => { llamadas.push({ u, b: JSON.parse(o.body) }); return { json: async () => ({ ok: true, notificacion: true, correo: "ok" }) }; };
  SX._probarCon({ supa: { url: "https://x.supabase.co", secret: "s" }, sellers: () => [], log: () => { } });
  const sl = vend("jp@x.com");
  await SX.avisarVendedor(sl, 585, "401", true);
  assert.equal(llamadas.length, 1); assert.match(llamadas[0].u, /aviso-vendedor$/); assert.equal(llamadas[0].b.cola, 585);
  await SX.avisarVendedor(sl, 585, "401", false);
  assert.equal(llamadas.length, 1, "repitió el aviso antes de 30 min");
  globalThis.fetch = orig;
});

test("puente.js: usa nombre fijo por sesión, reintenta el 401 y reporta diagnóstico", () => {
  assert.match(fuente, /browser: SX\.navegador\(sl\.auth\)/);
  assert.match(fuente, /401: reintento una vez antes de pedir QR/);
  for (const k of ["err:", "cola:", "cortes:", "escudo:", "ver: SX.VERSION"]) assert.ok(fuente.includes(k), "presencia sin " + k);
  assert.match(fuente, /destinoSeguro\(sl, sock, it\.to, masivo\)/);
});

test("puente.js: al arrancar carga a los desvinculados que tienen cola (para avisarles)", () => {
  assert.match(fuente, /desvinculado pero con mensajes esperando/);
  assert.match(fuente, /dt\.queue\.length\) \{ const sl = seller\(m\.email\); sl\.st\.state = "qr"/);
});

/* ===== 25/11: sesión blindada ===== */
const credsOk = JSON.stringify({ noiseKey: { a: 1 }, me: { id: "51999888777:3@s.whatsapp.net" }, registered: true });
test("credenciales: respaldo y restauración si creds.json se daña (corte de luz)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ses-")), f = path.join(d, "creds.json");
  fs.writeFileSync(f, credsOk); assert.ok(SX.credsRespaldar(d));
  fs.writeFileSync(f, '{"noiseKey":{"a":1},"me":{"id":"519'); // escritura cortada a la mitad
  assert.ok(SX.credsRestaurar(d)); assert.equal(SX.credsValidas(f).me.id, "51999888777:3@s.whatsapp.net");
  assert.ok(fs.existsSync(f + ".danado"), "no guardó el archivo dañado para revisar");
  fs.rmSync(f); assert.ok(SX.credsRestaurar(d), "no restauró cuando creds.json desapareció");
  assert.equal(SX.credsRestaurar(d), false, "restauró sin necesidad");
});
test("credenciales: nunca respalda unas credenciales sin vincular (QR nuevo)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ses-")), f = path.join(d, "creds.json");
  fs.writeFileSync(f, credsOk); SX.credsRespaldar(d);
  fs.writeFileSync(f, JSON.stringify({ noiseKey: { a: 2 }, registered: false })); // Baileys generó credenciales nuevas
  assert.equal(SX.credsRespaldar(d), false);
  assert.equal(SX.credsValidas(path.join(d, "creds.respaldo.json")).me.id, "51999888777:3@s.whatsapp.net");
});
test("401 real: archiva la sesión (no la borra) y guarda solo las 2 últimas", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vend-")), a = path.join(base, "sesion");
  for (let i = 0; i < 4; i++) { fs.mkdirSync(a, { recursive: true }); fs.writeFileSync(path.join(a, "creds.json"), credsOk); SX.sesionArchivar(a); }
  assert.ok(!fs.existsSync(a)); assert.equal(fs.readdirSync(base).filter(n => n.startsWith("sesion_baja_")).length, 2);
  assert.equal(SX.credsRestaurar(a), false, "no debe revivir una sesión expulsada");
});
test("puente: QR vencido no cuenta como corte, 401 tras 515 no es expulsión, llaves en caché", () => {
  assert.match(fuente, /const eraQR = sl\.qrVisto && code !== 515/);
  assert.ok(fuente.indexOf("if (eraQR)") < fuente.indexOf("SX.vigiaCierre(sl, code)"), "el QR vencido llega al escudo");
  assert.match(fuente, /sl\.t515 && Date\.now\(\) - sl\.t515 < 90000/);
  assert.match(fuente, /makeCacheableSignalKeyStore/);
  assert.match(fuente, /SX\.sesionArchivar\(sl\.auth\)/);
  assert.ok(!/loggedOut\) \{ sl\.r401 = 0; try \{ fs\.rmSync/.test(fuente));
});

/* ===== 25/11b: freno ABS y Telegram informativo ===== */
test("ABS: número sano = ritmo normal; número en riesgo = más lento pero NUNCA envía menos (sin tope)", () => {
  const sano = { email: "s@x.com", DATA: { results: [], vinculadoTs: Date.now() - 48 * 3600000 }, queue: [], st: {} };
  const a = SX.escudoABS(sano);
  assert.equal(a.ritmo, 1); assert.equal(a.salud, 100);
  assert.equal(a.tope, undefined, "el ABS no debe tener tope: no baja cuántos se envían");
  const nuevo = { email: "n@x.com", DATA: { results: [], vinculadoTs: Date.now() - 5 * 60000 }, queue: [], st: {} };
  const b = SX.escudoABS(nuevo);
  assert.ok(b.ritmo > 1 && b.ritmo <= 3.5, "ritmo fuera de rango: " + b.ritmo);
  assert.ok(b.salud < 100 && b.motivo.includes("recién"), "no detectó número nuevo");
});
test("diagCaida: 401 con mucho envío culpa al volumen, sin envío culpa al teléfono", () => {
  const now = Date.now(), r = n => Array.from({ length: n }, () => ({ ok: true, ts: new Date(now - 60000).toISOString() }));
  const alto = { email: "a@x.com", DATA: { results: r(40), vinculadoTs: now - 10 * 60000 }, queue: [120], st: {} };
  const d1 = SX.diagCaida(alto, 401);
  assert.ok(/spam|ritmo|volumen|recién/.test(d1), d1);
  assert.ok(d1.includes("cola: 1"));
  const cero = { email: "b@x.com", DATA: { results: [], vinculadoTs: now - 10 * 3600000 }, queue: [], st: {} };
  assert.ok(/teléfono|4 dispositivos|reputación/.test(SX.diagCaida(cero, 401)));
});
