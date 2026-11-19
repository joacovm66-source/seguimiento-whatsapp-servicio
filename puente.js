/* Puente WhatsApp para "Seguimiento Comercial" (varios vendedores, cada uno con su propio número).
   - Cada vendedor escanea SU QR desde la app y queda enlazado (como WhatsApp Web).
   - La app se identifica con la sesión de su correo (Supabase); solo entran correos permitidos.
   - Crea un túnel gratis (Cloudflare) y publica su dirección en Supabase: nadie pega links ni códigos.
   AVISO: conexión NO oficial de WhatsApp. Usar números dedicados y con moderación. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pino from "pino";
import QRCode from "qrcode";
import * as SX from "./sigo-extra.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MOCK = process.env.MOCK === "1", FAST = process.env.FAST === "1";
const PORT = +process.env.PORT || 3737, HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const STORE = process.env.DATA_DIR || DIR; fs.mkdirSync(STORE, { recursive: true });
const F_CFG = path.join(STORE, "config.json"), VEND = path.join(STORE, "vendedores"), APP = [path.join(DIR, "index.html"), path.join(DIR, "app", "index.html")].find(f => fs.existsSync(f)) || path.join(DIR, "app", "index.html");
fs.mkdirSync(VEND, { recursive: true });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const CFG = Object.assign({
  minDelay: 8, maxDelay: 25, batch: 20, pauseMin: 5, dailyCap: 1000,
  supabaseUrl: "https://mhhthbcmtyifyrutghud.supabase.co",
  supabaseKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1oaHRoYmNtdHlpZnlydXRnaHVkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0NTc4NTQsImV4cCI6MjA5OTAzMzg1NH0.3-2sOb4W3xx52QHEd3B-2vCCN79Z0vk2cQoU0Hx_a9k",
  secret: process.env.BRIDGE_SECRET || (() => { try { return fs.readFileSync(path.join(DIR, "clave-puente.txt"), "utf8").trim(); } catch { return ""; } })(),
  allowed: ["*"]
}, readJson(F_CFG, {}));
if (process.env.ALLOWED) CFG.allowed = process.env.ALLOWED.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
CFG.allowed = CFG.allowed.map(s => String(s).toLowerCase().replace(/^@/, ""));
/* Llave de servicio (service_role): se lee de la variable SUPABASE_SERVICE_KEY o del archivo llave-servicio.txt junto a este programa. Sin ella usa la llave pública (modo antiguo). */
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || (() => { try { return fs.readFileSync(path.join(DIR, "llave-servicio.txt"), "utf8"); } catch { return ""; } })()).trim();
const DB_KEY = SERVICE_KEY || CFG.supabaseKey;
const DB_HEADERS = Object.assign({ apikey: DB_KEY, "Content-Type": "application/json" }, DB_KEY.startsWith("sb_") ? {} : { Authorization: "Bearer " + DB_KEY });
const saveCfg = () => { const { supabaseKey, secret, ...pub } = CFG; fs.writeFileSync(F_CFG, JSON.stringify(pub, null, 2)); };
saveCfg();

const today = () => new Date().toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, FAST ? Math.min(ms, 40) : ms));
const rand = (a, b) => a + Math.random() * (b - a);
const digits = s => String(s || "").replace(/\D/g, "");
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const allowedEmail = e => { e = String(e || "").toLowerCase(); if (CFG.allowed.includes("*")) return !!e; const d = e.split("@")[1] || ""; return CFG.allowed.includes(e) || CFG.allowed.includes(d); };


/* ----- Respaldo en Supabase (para servidores gratis que borran los archivos al reiniciar) ----- */
const CLOUD_STATE = process.env.CLOUD_STATE === "1" || !!process.env.RENDER;
async function rpc(name, args) {
  const full = Object.assign({ secret: CFG.secret }, args);
  /* Sin llave de servicio en la PC: pasa por la función "puente" de Supabase (solo funciones permitidas; la clave se revisa en la base). */
  const r = SERVICE_KEY ? await fetch(CFG.supabaseUrl + "/rest/v1/rpc/" + name, { method: "POST", headers: DB_HEADERS, body: JSON.stringify(full) })
    : await fetch(CFG.supabaseUrl + "/functions/v1/puente", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fn: name, args: full }) });
  if (!r.ok) throw new Error(name + " " + r.status); const t = await r.text(); try { return t ? JSON.parse(t) : null; } catch { return null; }
}
const walk = (d, base = "") => { let o = {}; if (!fs.existsSync(d)) return o; for (const f of fs.readdirSync(d, { withFileTypes: true })) { const rel = base ? base + "/" + f.name : f.name, fp = path.join(d, f.name); if (f.isDirectory()) Object.assign(o, walk(fp, rel)); else if (/\.(json)$/.test(f.name)) { try { o[rel] = fs.readFileSync(fp, "utf8"); } catch { } } } return o; };
const timers = new Map();
function persist(sl, now) {
  if (!CLOUD_STATE || MOCK) return Promise.resolve();
  const go = async () => { timers.delete(sl.email); try { const files = walk(sl.dir); delete files["email.json"]; await rpc("wa_state_set", { p_email: sl.email, p_files: files }); } catch (e) { log("No pude respaldar", sl.email, e.message); } };
  if (now) { clearTimeout(timers.get(sl.email)); return go(); }
  if (!timers.has(sl.email)) timers.set(sl.email, setTimeout(go, 15000));
  return Promise.resolve();
}
async function restoreAll() {
  if (!CLOUD_STATE || MOCK) return [];
  try {
    const list = await rpc("wa_state_list", {}); const out = [];
    for (const e of list || []) {
      try {
        const files = await rpc("wa_state_get", { p_email: e }); const dir = path.join(VEND, e.replace(/[^a-z0-9]+/g, "_"));
        for (const [rel, txt] of Object.entries(files || {})) { const fp = path.join(dir, rel); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, txt); }
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "email.json"), JSON.stringify({ email: e })); out.push(e);
      } catch (x) { log("No pude restaurar", e, x.message); }
    }
    log("Sesiones restauradas:", out.length); return out;
  } catch (e) { log("No pude restaurar sesiones:", e.message); return []; }
}
async function flushAll() { await Promise.all([...sellers.values()].map(sl => persist(sl, true))); }
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => { try { await flushAll(); } catch { } process.exit(0); });

/* ----- Un vendedor = una sesión de WhatsApp propia ----- */
const sellers = new Map();
function seller(email) {
  email = String(email).toLowerCase();
  let sl = sellers.get(email); if (sl) return sl;
  const key = email.replace(/[^a-z0-9]+/g, "_"), dir = path.join(VEND, key); fs.mkdirSync(dir, { recursive: true });
  sl = { email, dir, auth: path.join(dir, "sesion"), fdata: path.join(dir, "datos.json"), queue: [], running: false, sinceBreak: 0, breakUntil: 0, paused: false, sock: null, started: false, gen: 0,
    st: { state: MOCK ? "open" : "off", qr: null, me: MOCK ? "51900" + String(Math.abs([...email].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 1000000).padStart(6, "0") : "", err: "" } };
  sl.DATA = Object.assign({ seq: 0, rseq: 0, results: [], replies: [], day: "", sentToday: 0 }, readJson(sl.fdata, {}));
  sl.seen = new Set(sl.DATA.results.map(r => r.id));
  if (Array.isArray(sl.DATA.queue)) sl.queue = sl.DATA.queue; /* la cola se recupera si el puente se reinicia */
  /* Números de mensaje basados en la hora: si el puente se reinstala, la app no se queda esperando números viejos */
  if (sl.DATA.rseq < 1e9 || sl.DATA.seq < 1e9) { const base = Math.floor(Date.now() / 1000); sl.DATA.replies.forEach(x => { x.seq += base; }); sl.DATA.results.forEach(x => { x.seq += base; }); sl.DATA.rseq += base; sl.DATA.seq += base; }
  sellers.set(email, sl);
  if (MOCK && process.env.MOCKQR) { sl.st.state = "qr"; sl.st.me = ""; QRCode.toDataURL("demo-qr", { margin: 1, width: 320 }).then(q => { sl.st.qr = q; }); setTimeout(() => { sl.st.state = "open"; sl.st.qr = null; sl.st.me = "51900000000"; }, 9000); }
  return sl;
}
const saveData = sl => { sl.DATA.queue = sl.queue.slice(0, 5000); persist(sl); sl.DATA.results = sl.DATA.results.slice(-3000); sl.DATA.replies = sl.DATA.replies.slice(-3000); try { fs.writeFileSync(sl.fdata, JSON.stringify(sl.DATA)); } catch { } };
function addReply(sl, from, text, jid) { sl.DATA.replies.push({ seq: ++sl.DATA.rseq, from, jid: jid || "", text: String(text).slice(0, 500), ts: new Date().toISOString() }); saveData(sl); log(sl.email, "← respuesta de", from); }

async function startWA(sl) {
  if (MOCK || sl.started) return; sl.started = true; const gen = ++sl.gen;
  try {
    const B = await import("@whiskeysockets/baileys");
    const makeWASocket = B.default || B.makeWASocket;
    const { state, saveCreds } = await B.useMultiFileAuthState(sl.auth);
    let version; try { version = (await B.fetchLatestBaileysVersion()).version; } catch { }
    sl.st.state = "connecting";
    const sock = sl.sock = makeWASocket({ auth: state, version, logger: pino({ level: "silent" }), printQRInTerminal: false, browser: B.Browsers ? B.Browsers.ubuntu("Chrome") : ["Ubuntu", "Chrome", "22.04.4"], markOnlineOnConnect: false, syncFullHistory: false });
    sock.ev.on("creds.update", async () => { await saveCreds(); persist(sl); });
    sock.ev.on("connection.update", async u => {
      if (gen !== sl.gen) return;
      if (u.qr) { sl.st.state = "qr"; sl.st.qr = await QRCode.toDataURL(u.qr, { margin: 2, scale: 6, errorCorrectionLevel: "M" }); log(sl.email, "espera que escaneen el QR"); }
      if (u.connection === "open") { sl.st.state = "open"; sl.st.qr = null; sl.st.err = ""; sl.st.me = digits((sock.user && sock.user.id || "").split(":")[0].split("@")[0]); log(sl.email, "WhatsApp conectado:", sl.st.me); if (sl.queue.length) worker(sl); }
      if (u.connection === "close") {
        const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
        log(sl.email, "conexión cerrada, código", code, String(u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.message || "").slice(0, 120));
        sl.st.state = "off"; sl.st.qr = null; sl.st.me = ""; sl.started = false;
        if (code === 403) { sl.st.err = "WhatsApp restringió este número. No envíe más por ahora y revise el teléfono."; log(sl.email, "NÚMERO RESTRINGIDO por WhatsApp"); sl.paused = true; return; }
        if (code === B.DisconnectReason.loggedOut) { try { fs.rmSync(sl.auth, { recursive: true, force: true }); } catch { } log(sl.email, "sesión cerrada desde el teléfono"); sl.st.err = "Se cerró la sesión desde el teléfono. Escanee otra vez."; }
        else { sl.st.err = "Reconectando…"; setTimeout(() => startWA(sl), 3000); }
      }
    });
    SX.escucharLeidos(sl, sock, (num, ts) => { sl.DATA.replies.push({ seq: ++sl.DATA.rseq, from: num, read: true, text: "", ts }); saveData(sl); });
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        if (!m.message) continue;
        const jid = m.key.remoteJid || ""; if (jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;
        const num = await SX.numero(sl, sock, m, jid);
        const msg = m.message, __sx = await SX.media(sl, m, B), text = __sx || msg.conversation || (msg.extendedTextMessage && msg.extendedTextMessage.text) || (msg.imageMessage && msg.imageMessage.caption) || (msg.buttonsResponseMessage && msg.buttonsResponseMessage.selectedDisplayText) || "[archivo o audio]";
        if (m.key.fromMe) { /* lo que el vendedor escribe desde su teléfono: solo para la bandeja de la app nueva (la pide con me=1) */
          try { if (text && text !== "[archivo o audio]" && num && !(sl.mine && sl.mine.has(m.key.id))) { sl.DATA.replies.push({ seq: ++sl.DATA.rseq, from: num, jid, text: String(text).slice(0, 500), ts: new Date().toISOString(), me: true }); saveData(sl); } } catch { }
          continue;
        }
        addReply(sl, num, text, jid);
      }
    });
  } catch (e) { sl.started = false; sl.st.err = String(e.message || e); console.error(e); }
}

/* ----- Cola de envío con pausas (cuida cada número) ----- */
async function worker(sl) {
  if (sl.running) return; sl.running = true;
  const { st, queue, DATA } = sl;
  while (queue.length) {
    if (sl.paused || st.state !== "open") { await sleep(3000); continue; }
    if (DATA.day !== today()) { DATA.day = today(); DATA.sentToday = 0; }
    const capHoy = Math.min(CFG.dailyCap, (sl.acc && sl.acc.tope_dia) || Infinity);
    if (restantes(sl.acc) <= 0) { st.err = "Se acabaron los envíos de su plan."; queue.length = 0; break; }
    if (DATA.sentToday >= capHoy) { st.err = "Se alcanzó el tope diario (" + capHoy + "). Continúa mañana."; await sleep(60000); continue; }
    st.err = "";
    if (sl.sinceBreak >= CFG.batch) { sl.breakUntil = Date.now() + CFG.pauseMin * 60000; log(sl.email, "descanso", CFG.pauseMin, "min"); await sleep(CFG.pauseMin * 60000); sl.sinceBreak = 0; sl.breakUntil = 0; continue; }
    SX.priorizar(queue); const it = queue[0]; await sleep(SX.esManual(queue[0]) ? 1500 : rand(CFG.minDelay, CFG.maxDelay) * 1000);
    if (queue[0] !== it) continue;
    let ok = false, err = "";
    try {
      const to = digits(it.to);
      if (MOCK) { ok = true; }
      else {
        const sock = sl.sock, r = await SX.destino(sl, sock, it.to);
        if (!r || !r[0] || !r[0].exists) err = "Ese número no tiene WhatsApp.";
        else {
          try { await sock.presenceSubscribe(r[0].jid); await sock.sendPresenceUpdate("composing", r[0].jid); await sleep(rand(1200, 3500) + it.text.length * 25); await sock.sendPresenceUpdate("paused", r[0].jid); } catch { }
          const sent = await sock.sendMessage(r[0].jid, { text: it.text }); ok = true; try { (sl.mine = sl.mine || new Set()).add(sent.key.id); if (sl.mine.size > 2000) sl.mine.clear(); } catch { }
        }
      }
    } catch (e) { err = String(e.message || e).slice(0, 120); }
    queue.shift();
    DATA.results.push({ seq: ++DATA.seq, id: it.id, to: it.to, ok, err, ts: new Date().toISOString() }); sl.seen.add(it.id);
    if (ok) { DATA.sentToday++; sl.sinceBreak++; contarEnvio(sl.email); }
    saveData(sl); log(sl.email, ok ? "enviado a" : "NO enviado a", it.to, err);
  }
  sl.running = false;
}

/* ----- Identidad: la sesión de Supabase del vendedor ----- */
const tokCache = new Map();
async function whoIs(req) {
  const h = String(req.headers.authorization || ""); if (!/^Bearer /i.test(h)) return null;
  const jwt = h.slice(7).trim(); if (!jwt) return null;
  if (MOCK && jwt.startsWith("mock:")) { const e = jwt.slice(5).toLowerCase(); return allowedEmail(e) ? e : null; }
  const c = tokCache.get(jwt); if (c && c.exp > Date.now()) return c.email;
  try {
    const r = await fetch(CFG.supabaseUrl + "/auth/v1/user", { headers: { apikey: CFG.supabaseKey, Authorization: "Bearer " + jwt } });
    if (!r.ok) return null; const u = await r.json(); const e = String(u && u.email || "").toLowerCase();
    if (!e || !allowedEmail(e)) return null;
    tokCache.set(jwt, { email: e, exp: Date.now() + 300000 }); if (tokCache.size > 500) tokCache.clear();
    return e;
  } catch { return null; }
}

/* ----- Empresa del vendedor: pausa, topes y conteo (Supabase) ----- */
const accCache = new Map();
async function acceso(email) {
  if (MOCK && !process.env.ACCESO) return { permitido: true, sin_empresa: true };
  const c = accCache.get(email); if (c && c.exp > Date.now()) return c.v;
  let v;
  try { v = await rpc("puente_acceso", { p_email: email }); }
  catch (e) { v = c ? c.v : { permitido: true, sin_empresa: true }; log("No pude revisar la empresa de", email, e.message); } /* si Supabase falla, no corta el servicio */
  accCache.set(email, { v, exp: Date.now() + 60000 }); return v || { permitido: true, sin_empresa: true };
}
const porContar = new Map();
function contarEnvio(email) {
  porContar.set(email, (porContar.get(email) || 0) + 1);
  const a = accCache.get(email); if (a && a.v) { a.v.usados_total = (a.v.usados_total || 0) + 1; a.v.usados_hoy = (a.v.usados_hoy || 0) + 1; }
}
setInterval(async () => { for (const [email, n] of porContar) { porContar.delete(email); try { await rpc("puente_contar_envios", { p_email: email, p_n: n }); } catch (e) { porContar.set(email, (porContar.get(email) || 0) + n); } } }, 15000);
const restantes = a => a && a.tope_total ? Math.max(0, a.tope_total - (a.usados_total || 0)) : Infinity;

/* ----- API para la app ----- */
const FAILS = {};
const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) }); res.end(b); };
const body = req => new Promise(r => { let d = ""; req.on("data", c => { d += c; if (d.length > 5e6) req.destroy(); }); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); });
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/ping") return send(res, 200, { ok: true, app: "puente-whatsapp", v: 2, mock: MOCK });
  if (u.pathname.startsWith("/m/")) return SX.servir(req, res, u);
  if ((u.pathname === "/" || u.pathname === "/index.html") && fs.existsSync(APP)) { const b = fs.readFileSync(APP); res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": b.length, "Cache-Control": "no-cache" }); return res.end(b); }
  const ip = (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(), now = Date.now(), fl = (FAILS[ip] = (FAILS[ip] || []).filter(t => now - t < 60000));
  if (fl.length >= 20) return send(res, 429, { error: "demasiados intentos" });
  const email = await whoIs(req);
  if (!email) { fl.push(now); return send(res, 401, { error: "sesion" }); }
  const acc = await acceso(email);
  if (!acc.permitido) return send(res, 403, { error: "pausado", motivo: acc.motivo || "Cuenta pausada" });
  const sl = seller(email); sl.acc = acc; const { st, DATA, queue } = sl;
  try {
    if (u.pathname === "/archivo" && req.method === "POST") return SX.enviarArchivo(req, res, sl, send);
    if (u.pathname === "/sync") {
      startWA(sl);
      let r = +u.searchParams.get("r") || 0, p = +u.searchParams.get("p") || 0;
      if (p > DATA.rseq) p = 0; if (r > DATA.seq) r = 0; /* la app va adelantada (puente reinstalado): mandarle todo */
      if (p > 0) { const n0 = DATA.replies.length; DATA.replies = DATA.replies.filter(x => x.seq > p || Date.now() - Date.parse(x.ts) < 3600000); if (DATA.replies.length !== n0) saveData(sl); } /* privacidad: no se guardan respuestas ya recibidas por la app */
      return send(res, 200, { state: st.state, qr: st.qr, me: st.me, err: st.err, pending: queue.length, sentToday: DATA.sentToday, cap: CFG.dailyCap, paused: sl.paused, breakIn: sl.breakUntil ? Math.max(0, Math.round((sl.breakUntil - Date.now()) / 1000)) : 0, cfg: { minDelay: CFG.minDelay, maxDelay: CFG.maxDelay, batch: CFG.batch, pauseMin: CFG.pauseMin }, results: DATA.results.filter(x => x.seq > r), replies: DATA.replies.filter(x => x.seq > p && (!x.me || u.searchParams.get("me") === "1")), seq: DATA.seq, rseq: DATA.rseq });
    }
    if (u.pathname === "/pair" && req.method === "POST") {
      const b = await body(req), phone = digits(b.phone || "");
      if (phone.length < 8 || phone.length > 15) return send(res, 200, { error: "Escriba el número con código de país, por ejemplo 51987654321." });
      if (MOCK) return send(res, 200, { code: "ABCD-1234" });
      startWA(sl);
      for (let i = 0; i < 20 && !(sl.sock && (st.state === "qr" || st.state === "connecting")); i++) await new Promise(r => setTimeout(r, 500));
      if (st.state === "open") return send(res, 200, { error: "Ya está conectado." });
      if (!sl.sock || (sl.sock.authState && sl.sock.authState.creds && sl.sock.authState.creds.registered)) return send(res, 200, { error: "Todavía no está listo. Intente en unos segundos." });
      try { await new Promise(r => setTimeout(r, 1500)); const c = await sl.sock.requestPairingCode(phone); log(sl.email, "código de vinculación generado"); return send(res, 200, { code: String(c).replace(/(.{4})(.{4})/, "$1-$2") }); }
      catch (e) { log(sl.email, "pair error", e.message); return send(res, 200, { error: "No se pudo generar el código. Pulse Reintentar." }); }
    }
    if (u.pathname === "/send" && req.method === "POST") {
      const b = await body(req); let n = 0, libre = restantes(acc) - queue.length, cortados = 0;
      for (const it of (b.items || [])) { if (n >= libre) { cortados++; continue; } if (!it || !it.id || !it.to || !it.text || sl.seen.has(it.id) || queue.some(q => q.id === it.id)) continue; queue.push({ id: String(it.id), to: digits(it.to), text: String(it.text).slice(0, 3500) }); n++; }
      worker(sl); return send(res, 200, { queued: n, pending: queue.length, tope: cortados ? "Su plan permite " + acc.tope_total + " envíos en total; " + cortados + " quedaron fuera." : undefined });
    }
    if (u.pathname === "/cancel" && req.method === "POST") { const b = await body(req); const before = queue.length; if (b.all) queue.length = 0; else { const ids = new Set(b.ids || []); for (let i = queue.length - 1; i >= 0; i--) if (ids.has(queue[i].id)) queue.splice(i, 1); } return send(res, 200, { removed: before - queue.length }); }
    if (u.pathname === "/pause" && req.method === "POST") { const b = await body(req); sl.paused = !!b.paused; return send(res, 200, { paused: sl.paused }); }
    if (u.pathname === "/config" && req.method === "POST") { if (acc.rol && acc.rol !== "admin") return send(res, 403, { error: "Solo el administrador puede cambiar esto." }); const b = await body(req); for (const k of ["minDelay", "maxDelay", "batch", "pauseMin", "dailyCap"]) if (+b[k] > 0) CFG[k] = Math.min(+b[k], k === "dailyCap" ? 1000 : 600); if (CFG.maxDelay < CFG.minDelay) CFG.maxDelay = CFG.minDelay; saveCfg(); return send(res, 200, { ok: true }); }
    if (u.pathname === "/logout" && req.method === "POST") { sl.gen++; try { if (sl.sock) await sl.sock.logout(); } catch { } try { fs.rmSync(sl.auth, { recursive: true, force: true }); } catch { } sl.started = false; sl.st.state = "off"; sl.st.me = ""; sl.st.qr = null; persist(sl, true); if (!MOCK) setTimeout(() => startWA(sl), 500); return send(res, 200, { ok: true }); }
    if (MOCK && u.pathname === "/mock/reply" && req.method === "POST") { const b = await body(req); addReply(sl, digits(b.from), b.text || "Hola, me interesa", ""); return send(res, 200, { ok: true }); }
    send(res, 404, { error: "no" });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
});

/* ----- Dirección pública (túnel gratis) publicada en Supabase ----- */
let publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
async function publish() {
  if (!publicUrl || MOCK && !process.env.PUBLISH) return;
  try {
    await rpc("set_bridge_url", { url: publicUrl });
  } catch (e) { log("Sin internet para publicar la dirección"); }
}
async function openTunnel() {
  if (MOCK || publicUrl || process.env.TUNNEL === "0") return;
  try {
    const cf = await import("cloudflared");
    if (!fs.existsSync(cf.bin)) { log("Descargando el túnel gratis (solo la primera vez)…"); await cf.install(cf.bin); }
    const t = cf.Tunnel.quick("http://localhost:" + PORT);
    t.on("url", u => { publicUrl = u.replace(/\/+$/, ""); log("Túnel listo:", publicUrl); publish(); });
    t.on("exit", () => { log("El túnel se cerró; reintentando…"); publicUrl = ""; setTimeout(openTunnel, 5000); });
    t.on("error", e => log("Túnel:", e.message));
  } catch (e) { log("No pude abrir el túnel:", e.message); setTimeout(openTunnel, 30000); }
}
setInterval(publish, 60000);

server.listen(PORT, HOST, () => {
  console.log("\n==============================================");
  console.log(" Puente de WhatsApp activo" + (MOCK ? " (MODO PRUEBA, sin WhatsApp real)" : ""));
  console.log(" Conexión con Sigo: " + (CFG.secret ? "lista" : "FALTA clave-puente.txt (pídela a Claude)"));
  console.log(" Correos permitidos: " + (CFG.allowed.includes("*") ? "cualquier correo con cuenta en la app" : CFG.allowed.join(", ")));
  console.log(" Deje esta ventana abierta durante el horario de trabajo.");
  console.log(" Los vendedores solo abren la app y pulsan «Conectar WhatsApp».");
  console.log("==============================================\n");
  openTunnel(); publish();
  if (!MOCK) SX.autoActualizar(() => [...sellers.values()].some(x => x.running && x.queue.length), (...a) => log(...a));
  (async () => { await restoreAll(); if (!MOCK) for (const d of fs.readdirSync(VEND)) { try { if (fs.existsSync(path.join(VEND, d, "sesion", "creds.json"))) { const m = readJson(path.join(VEND, d, "email.json"), null); if (m && m.email) startWA(seller(m.email)); } } catch { } } })();
});
/* recordar el correo de cada carpeta para reconectar al reiniciar */
setInterval(() => { for (const sl of sellers.values()) { try { fs.writeFileSync(path.join(sl.dir, "email.json"), JSON.stringify({ email: sl.email })); sl.DATA.queue = sl.queue.slice(0, 5000); fs.writeFileSync(sl.fdata, JSON.stringify(sl.DATA)); } catch { } } }, 5000);
process.on("uncaughtException", e => console.error("Error:", e.message));
process.on("unhandledRejection", e => console.error("Aviso:", e && e.message));
