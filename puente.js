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
    if (SX.credsRestaurar(sl.auth)) log(sl.email, "credenciales dañadas: restauradas del respaldo (no hace falta QR)");
    const { state, saveCreds } = await B.useMultiFileAuthState(sl.auth);
    let version; try { version = (await B.fetchLatestBaileysVersion()).version; } catch { }
    sl.st.state = "connecting";
    const sock = sl.sock = makeWASocket({ auth: { creds: state.creds, keys: B.makeCacheableSignalKeyStore ? B.makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) : state.keys }, version, logger: pino({ level: "silent" }), printQRInTerminal: false, browser: SX.navegador(sl.auth) /* fijo por sesión: nunca cambia a mitad de una vinculación */, markOnlineOnConnect: false, syncFullHistory: true });
    sock.ev.on("creds.update", async () => { await saveCreds(); SX.credsRespaldar(sl.auth); persist(sl); });
    sock.ev.on("connection.update", async u => {
      if (gen !== sl.gen) return;
      if (u.qr && SX.credsValidas(path.join(sl.auth, "creds.respaldo.json")) && (!sl.rq || Date.now() - sl.rq > 10 * 60000)) {
        /* Capa 2 (25/11): pidió QR pero este vendedor YA estaba vinculado → las credenciales se dañaron en la PC. Se restauran y se reconecta sin QR. */
        sl.rq = Date.now(); sl.gen++; sl.started = false; try { sock.end(undefined); } catch { } log(sl.email, "pidió QR estando vinculado: restauro credenciales y reintento");
        setTimeout(() => { SX.credsRestaurar(sl.auth, true); startWA(sl); }, 3000); return; }
      if (u.qr) { sl.qrVisto = true; sl.st.state = "qr"; sl.st.qr = await QRCode.toDataURL(u.qr, { margin: 2, scale: 6, errorCorrectionLevel: "M" }); log(sl.email, "espera que escaneen el QR"); }
      if (u.connection === "open") { sl.retry = 0; sl.r500 = 0; sl.qrRondas = 0; sl.qrVisto = false; SX.credsRespaldar(sl.auth); if (!sl.DATA.vinculadoTs) { sl.DATA.vinculadoTs = Date.now(); saveData(sl); } sl.DATA.desvinculado = null; sl.st.state = "open"; sl.st.qr = null; sl.st.err = ""; sl.st.me = digits((sock.user && sock.user.id || "").split(":")[0].split("@")[0]); log(sl.email, "WhatsApp conectado:", sl.st.me); if (sl.queue.length) worker(sl); }
      if (u.connection === "close") {
        const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
        log(sl.email, "conexión cerrada, código", code, String(u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.message || "").slice(0, 120));
        const eraQR = sl.qrVisto && code !== 515; sl.qrVisto = false;
        if (code === 515) sl.t515 = Date.now();
        if (eraQR) { /* Capa 3 (25/11): el QR venció sin que lo escaneen. NO es un corte (no frena el escudo ni ensucia el diagnóstico) y no se queda generando QR para siempre. */
          sl.started = false; sl.st.qr = null; sl.st.state = "qr"; sl.qrRondas = (sl.qrRondas || 0) + 1;
          if (sl.qrRondas < 3) setTimeout(() => startWA(sl), 3000); else { sl.st.err = "WhatsApp desvinculado: hay que escanear el QR."; log(sl.email, "QR sin escanear: espero a que abran Sigo"); }
          return; }
        sl.st.state = "off"; sl.st.qr = null; sl.st.me = ""; sl.started = false;
        /* Capa 4 (25/11): un 401 que llega justo después de un 515 (reinicio normal) es limpieza de WhatsApp multi-dispositivo, no una expulsión. */
        if (code === B.DisconnectReason.loggedOut && sl.t515 && Date.now() - sl.t515 < 90000) { log(sl.email, "401 tras 515: no es expulsión, reconecto"); sl.st.err = "Reconectando…"; setTimeout(() => startWA(sl), 5000); return; }
        SX.vigiaCierre(sl, code);
        if (code === 403) { sl.st.err = "WhatsApp restringió este número. No envíe más por ahora y revise el teléfono."; log(sl.email, "NÚMERO RESTRINGIDO por WhatsApp"); sl.paused = true; sl.pausa = { por: "WhatsApp restringió el número (código 403)", ts: Date.now() }; return; }
        if (code === B.DisconnectReason.loggedOut && (!sl.r401 || Date.now() - sl.r401 > 10 * 60000)) { sl.r401 = Date.now(); log(sl.email, "401: reintento una vez antes de pedir QR"); sl.st.err = "Reconectando…"; setTimeout(() => startWA(sl), 20000); }
        else if (code === B.DisconnectReason.loggedOut) { sl.r401 = 0; SX.sesionArchivar(sl.auth); log(sl.email, "sesión cerrada desde el teléfono"); sl.st.err = "Se cerró la sesión desde el teléfono. Escanee otra vez."; }
        else if (code === 500 && !sl.r500) { sl.r500 = Date.now(); SX.credsRestaurar(sl.auth, true); log(sl.email, "sesión dañada (500): restauro credenciales del respaldo"); sl.st.err = "Reconectando…"; setTimeout(() => startWA(sl), 5000); }
        else if (code === 440) { sl.st.err = "Esta cuenta se abrió en otro puente u otra PC. Reintento en 2 min."; log(sl.email, "conflicto 440: otra sesión abierta"); setTimeout(() => startWA(sl), 120000); }
        else { /* internet u otro corte: reintenta solo, cada vez con más espera (3 s → 1 min) para no saturar a WhatsApp */
          sl.retry = (sl.retry || 0) + 1; const ms = Math.min(60000, 3000 * Math.pow(2, Math.min(sl.retry - 1, 5)));
          sl.st.err = "Reconectando…"; setTimeout(() => startWA(sl), ms); }
      }
    });
    SX.bandeja(sl, sock, B);
    SX.atencion(sl, sock);
    SX.escudoEscuchar(sl, sock);
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
  } catch (e) { sl.started = false; sl.st.err = String(e.message || e); console.error(e); setTimeout(() => startWA(sl), 30000); }
}
/* Guardián: si un WhatsApp quedó sin conexión y nadie lo está reconectando (p. ej. tras suspender la PC o sin internet), lo vuelve a iniciar */
if (!MOCK) setInterval(() => { for (const sl of sellers.values()) { try {
  if (sl.started || sl.st.state === "open" || sl.st.state === "qr") continue;
  if (/cerró la sesión|restringió|otro puente/i.test(sl.st.err || "")) continue;
  SX.credsRestaurar(sl.auth); if (fs.existsSync(path.join(sl.auth, "creds.json"))) { log(sl.email, "guardián: reconectando"); startWA(sl); }
} catch { } } }, 90000);

/* ----- Cola de envío con pausas (cuida cada número) ----- */
/* foto o video de una difusión (se descarga una vez y se reutiliza) */
const MEDIA_CACHE = new Map();
async function mediaMsg(it, txt = it.text) {
  let buf = MEDIA_CACHE.get(it.media.url);
  if (!buf) { const r = await fetch(it.media.url); if (!r.ok) throw new Error("No se pudo bajar el archivo de la difusión"); buf = Buffer.from(await r.arrayBuffer()); if (MEDIA_CACHE.size > 5) MEDIA_CACHE.clear(); MEDIA_CACHE.set(it.media.url, buf); }
  return /^video\//.test(it.media.mime) ? { video: buf, mimetype: it.media.mime, caption: txt } : { image: buf, mimetype: it.media.mime, caption: txt };
}
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
    SX.priorizar(queue); const it = queue[0], masivo = !SX.esManual(it), esc = masivo ? SX.escudoEstado(sl) : null;
    if (esc && esc.frenoMs > 0) { sl.breakUntil = Date.now() + esc.frenoMs; st.err = "Escudo: pausa corta para cuidar el número (" + esc.motivo + ")."; await sleep(Math.min(esc.frenoMs, 30000)); continue; }
    await sleep(masivo ? rand(CFG.minDelay, CFG.maxDelay) * 1000 * (esc ? esc.ritmo : 1) * SX.escudoABS(sl).ritmo : 1500);
    if (queue[0] !== it) continue;
    let ok = false, err = "";
    try {
      const to = digits(it.to);
      if (MOCK) { ok = true; }
      else {
        const sock = sl.sock, r = await SX.destinoSeguro(sl, sock, it.to, masivo), txt = masivo ? SX.variar(it.text) : it.text;
        if (!r || !r[0] || !r[0].exists) err = "Ese número no tiene WhatsApp.";
        else {
          try { await sock.presenceSubscribe(r[0].jid); await sock.sendPresenceUpdate("composing", r[0].jid); await sleep(rand(1200, 3500) + Math.min(txt.length, 400) * 25); await sock.sendPresenceUpdate("paused", r[0].jid); } catch { }
          const sent = await sock.sendMessage(r[0].jid, it.media ? await mediaMsg(it, txt) : { text: txt }); ok = true; if (masivo) SX.escudoEnviado(sl, sent.key.id); try { (sl.mine = sl.mine || new Set()).add(sent.key.id); if (sl.mine.size > 2000) sl.mine.clear(); } catch { }
        }
      }
    } catch (e) { err = String(e.message || e).slice(0, 120); }
    /* si falló porque se cayó la conexión (internet, WhatsApp reconectando), NO se pierde: queda en la cola y sale al reconectar */
    if (!ok && (st.state !== "open" || /connection (closed|lost)|timed? ?out|not open|socket|stream errored|precondition|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed/i.test(err)) && (it.tries = (it.tries || 0) + 1) <= 5) {
      log(sl.email, "corte al enviar a", it.to, "→ queda en cola (", err, ")"); await sleep(5000); continue; }
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
    if (u.pathname.startsWith("/bx/")) { startWA(sl); if (await SX.rutasBandeja(u, req, res, sl, send, body)) return; }
    if (u.pathname === "/archivo" && req.method === "POST") return SX.enviarArchivo(req, res, sl, send);
    if (u.pathname === "/sync") {
      startWA(sl);
      let r = +u.searchParams.get("r") || 0, p = +u.searchParams.get("p") || 0;
      if (p > DATA.rseq) p = 0; if (r > DATA.seq) r = 0; /* la app va adelantada (puente reinstalado): mandarle todo */
      if (p > 0) { const n0 = DATA.replies.length; DATA.replies = DATA.replies.filter(x => x.seq > p || Date.now() - Date.parse(x.ts) < 3600000); if (DATA.replies.length !== n0) saveData(sl); } /* privacidad: no se guardan respuestas ya recibidas por la app */
      return send(res, 200, { state: st.state, qr: st.qr, me: st.me, err: st.err, pending: queue.length, sentToday: DATA.sentToday, cap: CFG.dailyCap, paused: sl.paused, pausedBy: sl.pausa ? sl.pausa.por : "", breakIn: sl.breakUntil ? Math.max(0, Math.round((sl.breakUntil - Date.now()) / 1000)) : 0, cfg: { minDelay: CFG.minDelay, maxDelay: CFG.maxDelay, batch: CFG.batch, pauseMin: CFG.pauseMin }, results: DATA.results.filter(x => x.seq > r), replies: DATA.replies.filter(x => x.seq > p && (!x.me || u.searchParams.get("me") === "1")), seq: DATA.seq, rseq: DATA.rseq });
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
      for (const it of (b.items || [])) { if (n >= libre) { cortados++; continue; } if (!it || !it.id || !it.to || !it.text || sl.seen.has(it.id) || queue.some(q => q.id === it.id)) continue; const med = it.media && /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\/difusion\//.test(String(it.media.url || "")) && /^(image|video)\//.test(String(it.media.mime || "")) ? { url: String(it.media.url), mime: String(it.media.mime) } : undefined; queue.push({ id: String(it.id), to: digits(it.to), text: String(it.text).slice(0, 3500), media: med }); n++; }
      worker(sl); return send(res, 200, { queued: n, pending: queue.length, tope: cortados ? "Su plan permite " + acc.tope_total + " envíos en total; " + cortados + " quedaron fuera." : undefined });
    }
    if (u.pathname === "/cancel" && req.method === "POST") { const b = await body(req); const before = queue.length; if (b.all) queue.length = 0; else { const ids = new Set(b.ids || []); for (let i = queue.length - 1; i >= 0; i--) if (ids.has(queue[i].id)) queue.splice(i, 1); } return send(res, 200, { removed: before - queue.length }); }
    if (u.pathname === "/pause" && req.method === "POST") { const b = await body(req); sl.paused = !!b.paused; sl.pausa = sl.paused ? { por: "el vendedor desde la app de Sigo (botón Pausar)", ts: Date.now() } : null; log(sl.email, sl.paused ? "pausado desde la app" : "reanudado desde la app"); if (!sl.paused) worker(sl); return send(res, 200, { paused: sl.paused }); }
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
/* Presencia: cada 30 s avisa a Sigo qué vendedores tienen su WhatsApp conectado (el jefe lo ve en tiempo real). */
setInterval(async () => { if (MOCK) return; const l = [...sellers.values()].map(sl => { let esc = ""; try { const x = SX.escudoEstado(sl); esc = x.nivel ? (x.nivel === 2 ? "freno: " : "lento: ") + x.motivo : ""; } catch { } return { email: sl.email, state: sl.st.state, me: sl.st.me || "", err: sl.st.err || "", cola: sl.queue.length, cortes: (sl.DATA.cortes || []).slice(-6), escudo: esc, ver: SX.VERSION }; }); if (l.length) { try { await rpc("puente_presencia", { p_lista: l }); } catch { } } }, 30000);

server.listen(PORT, HOST, () => {
  console.log("\n==============================================");
  console.log(" Puente de WhatsApp activo" + (MOCK ? " (MODO PRUEBA, sin WhatsApp real)" : ""));
  console.log(" Conexión con Sigo: " + (CFG.secret ? "lista" : "FALTA clave-puente.txt (pídela a Claude)"));
  console.log(" Correos permitidos: " + (CFG.allowed.includes("*") ? "cualquier correo con cuenta en la app" : CFG.allowed.join(", ")));
  console.log(" Deje esta ventana abierta durante el horario de trabajo.");
  console.log(" Los vendedores solo abren la app y pulsan «Conectar WhatsApp».");
  console.log("==============================================\n");
  SX.config({ url: CFG.supabaseUrl, secret: CFG.secret });
  openTunnel(); publish();
  if (!MOCK) SX.vigia({ supa: { url: CFG.supabaseUrl, key: CFG.supabaseKey, secret: CFG.secret }, sellers: () => sellers.values(), cfg: CFG, publicUrl: () => publicUrl, restantes, log, worker: sl => worker(sl) });
  if (!MOCK) SX.autoActualizar(() => [...sellers.values()].some(x => x.running && x.queue.length && x.st.state === "open" && !x.paused), (...a) => log(...a));
  (async () => { await restoreAll(); if (!MOCK) for (const d of fs.readdirSync(VEND)) { try { SX.credsRestaurar(path.join(VEND, d, "sesion")); if (fs.existsSync(path.join(VEND, d, "sesion", "creds.json"))) { const m = readJson(path.join(VEND, d, "email.json"), null); if (m && m.email) startWA(seller(m.email)); } else { /* desvinculado pero con mensajes esperando: se carga igual para que el Vigía lo vea y le avise al vendedor */ const m = readJson(path.join(VEND, d, "email.json"), null), dt = readJson(path.join(VEND, d, "datos.json"), {}); if (m && m.email && Array.isArray(dt.queue) && dt.queue.length) { const sl = seller(m.email); sl.st.state = "qr"; sl.st.err = "WhatsApp desvinculado: hay que escanear el QR."; log(m.email, "desvinculado con", sl.queue.length, "en cola"); } } } catch { } } })();
});
/* recordar el correo de cada carpeta para reconectar al reiniciar */
setInterval(() => { for (const sl of sellers.values()) { try { fs.writeFileSync(path.join(sl.dir, "email.json"), JSON.stringify({ email: sl.email })); sl.DATA.queue = sl.queue.slice(0, 5000); fs.writeFileSync(sl.fdata, JSON.stringify(sl.DATA)); } catch { } } }, 5000);
process.on("uncaughtException", e => { console.error("Error:", e.message); SX.vigiaError(e); });
process.on("unhandledRejection", e => { console.error("Aviso:", e && e.message); SX.vigiaError(e); });
