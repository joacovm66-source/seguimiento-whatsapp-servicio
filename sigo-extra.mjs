/* Sigo · extras del puente (19/11/2026)
   1. Números ocultos de WhatsApp (LID): busca el número real; si no existe, guarda el identificador para poder responder.
   2. Archivos y audios recibidos: los descarga y los sirve en /m/<archivo> (nombre aleatorio, no adivinable).
   3. Respuestas desde la Bandeja (id "m:..."): pasan primero en la cola y sin la espera larga de campañas.
   4. /archivo: el vendedor envía fotos, PDF, audios o videos desde la Bandeja. */
import fs from "node:fs";
import { Buffer } from "node:buffer";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STORE = process.env.DATA_DIR || DIR;
const MDIR = path.join(STORE, "media"); fs.mkdirSync(MDIR, { recursive: true });
const F_LID = path.join(STORE, "lids.json");
const digits = s => String(s || "").replace(/\D/g, "");
let LIDS = {}; try { LIDS = JSON.parse(fs.readFileSync(F_LID, "utf8")) || {}; } catch { }
let tLid = null; const guardarLids = () => { clearTimeout(tLid); tLid = setTimeout(() => { try { fs.writeFileSync(F_LID, JSON.stringify(LIDS)); } catch { } }, 1500); };

// Limpieza: archivos de más de 45 días
try { const lim = Date.now() - 45 * 864e5; for (const f of fs.readdirSync(MDIR)) { const p = path.join(MDIR, f); if (fs.statSync(p).mtimeMs < lim) fs.rmSync(p, { force: true }); } } catch { }

/* Número del cliente a partir del mensaje */
export async function numero(sl, sock, m, jid) {
  const k = m.key || {};
  let pn = k.senderPn || k.remoteJidAlt || k.participantPn || k.participantAlt || "";
  if (String(pn).includes("@lid")) pn = "";
  if (!pn && String(jid).endsWith("@lid")) {
    try { const lm = sock.signalRepository && sock.signalRepository.lidMapping; if (lm && lm.getPNForLID) pn = (await lm.getPNForLID(jid)) || ""; } catch { }
  }
  const real = digits(String(pn).split("@")[0].split(":")[0]);
  if (String(jid).endsWith("@lid")) {
    const lid = digits(String(jid).split("@")[0]);
    if (real) { LIDS[lid] = jid; LIDS["r" + lid] = real; guardarLids(); return real; }
    LIDS[lid] = jid; guardarLids(); return lid; // sin número real: se responde por el identificador
  }
  return real || digits(String(jid).split("@")[0]);
}

/* Número para mostrar a partir de un jid (normal u oculto) */
export function numeroDeJid(jid) {
  const j = String(jid || ""), d = digits(j.split("@")[0].split(":")[0]);
  if (j.endsWith("@lid")) return LIDS["r" + d] || d;
  return d;
}

/* Lo que el vendedor lee en su celular se marca como leído en Sigo */
export function escucharLeidos(sl, sock, avisar) {
  const ult = new Map();
  const leer = (jid) => {
    if (!jid || /@g\.us$|status@|@newsletter$/.test(jid)) return;
    const num = numeroDeJid(jid); if (!num) return;
    const t = Date.now(); if (t - (ult.get(num) || 0) < 4000) return; ult.set(num, t);
    avisar(num, new Date().toISOString());
  };
  sock.ev.on("chats.update", (lista) => { for (const c of lista || []) if (c && c.unreadCount === 0) leer(c.id); });
  sock.ev.on("message-receipt.update", (lista) => { for (const u of lista || []) { const k = u.key || {}; if (!k.fromMe && u.receipt && u.receipt.readTimestamp) leer(k.remoteJid); } });
  sock.ev.on("messages.update", (lista) => { for (const u of lista || []) { const k = u.key || {}; if (!k.fromMe && u.update && u.update.status === 4) leer(k.remoteJid); } });
}

/* Destino para enviar: número normal, identificador oculto o jid directo */
export async function destino(sl, sock, to) {
  const raw = String(to || "");
  if (raw.includes("@")) return [{ exists: true, jid: raw }];
  const d = digits(raw);
  if (LIDS[d]) return [{ exists: true, jid: LIDS[d] }];
  // onWhatsApp a veces dice "no existe" para números que sí tienen WhatsApp (cambio de WhatsApp a LID). Si falla, se envía igual al número.
  try { const r = await sock.onWhatsApp(d + "@s.whatsapp.net"); if (r && r[0] && r[0].exists) return r; } catch { }
  return d.length >= 10 ? [{ exists: true, jid: d + "@s.whatsapp.net" }] : [];
}

/* Prioridad para lo que escribe el vendedor en la Bandeja */
export const esManual = it => !!(it && /^m:/.test(String(it.id || "")));
export function priorizar(queue) {
  const i = queue.findIndex(esManual);
  if (i > 0) { const [it] = queue.splice(i, 1); queue.unshift(it); }
}

/* Archivos recibidos */
const TIPOS = { imageMessage: "imagen", audioMessage: "audio", videoMessage: "video", documentMessage: "documento", stickerMessage: "sticker" };
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "video/mp4": "mp4", "video/3gpp": "3gp", "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "application/msword": "doc", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "application/vnd.ms-excel": "xls", "text/plain": "txt", "application/zip": "zip" };
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
function desenvolver(msg) {
  for (let i = 0; i < 4 && msg; i++) {
    const w = msg.ephemeralMessage || msg.viewOnceMessage || msg.viewOnceMessageV2 || msg.viewOnceMessageV2Extension || msg.documentWithCaptionMessage;
    if (!w || !w.message) break; msg = w.message;
  }
  return msg || {};
}
export async function media(sl, m, B) {
  try {
    const msg = desenvolver(m.message);
    const k = Object.keys(TIPOS).find(x => msg[x]); if (!k) return "";
    const info = msg[k], tipo = TIPOS[k], mime = String(info.mimetype || "").split(";")[0] || "application/octet-stream";
    const extra = (info.caption ? " " + info.caption : "") + (k === "documentMessage" && info.fileName ? " " + info.fileName : "");
    if (Number(info.fileLength || 0) > 30e6) return `[${tipo} muy pesado para descargar]${extra}`;
    const buf = await B.downloadMediaMessage({ key: m.key, message: msg }, "buffer", {});
    const name = crypto.randomBytes(12).toString("hex") + "." + (EXT[mime] || (k === "audioMessage" ? "ogg" : "bin"));
    fs.writeFileSync(path.join(MDIR, name), buf);
    return `[[sigo:${tipo}:${name}:${mime}]]${extra}`;
  } catch (e) { return "[archivo o audio]"; }
}

/* GET /m/<archivo> */
export function servir(req, res, u) {
  const name = decodeURIComponent(u.pathname.slice(3));
  if (!/^[a-f0-9]{24}\.[a-z0-9]{2,4}$/.test(name)) { res.writeHead(404); return res.end(); }
  const p = path.join(MDIR, name);
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  const st = fs.statSync(p), ext = name.split(".").pop();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": "private, max-age=604800" });
  fs.createReadStream(p).pipe(res);
}

/* POST /archivo {to, nombre, mime, base64, caption, id} — envío inmediato desde la Bandeja */
function leer(req, max) {
  return new Promise((ok, bad) => { let n = 0; const ch = []; req.on("data", c => { n += c.length; if (n > max) { bad(new Error("grande")); req.destroy(); } else ch.push(c); }); req.on("end", () => ok(Buffer.concat(ch))); req.on("error", bad); });
}
export async function enviarArchivo(req, res, sl, send) {
  try {
    const b = JSON.parse((await leer(req, 22e6)).toString("utf8"));
    if (!sl.sock || !sl.st || sl.st.state !== "open") return send(res, 200, { ok: false, error: "WhatsApp no está conectado" });
    const buf = Buffer.from(String(b.base64 || ""), "base64"); if (!buf.length || buf.length > 16e6) return send(res, 200, { ok: false, error: "El archivo debe pesar menos de 16 MB" });
    const r = await destino(sl, sl.sock, b.to); if (!r || !r[0] || !r[0].exists) return send(res, 200, { ok: false, error: "Ese número no tiene WhatsApp" });
    const mime = String(b.mime || "application/octet-stream"), cap = String(b.caption || "").slice(0, 1000);
    const content = /^image\//.test(mime) ? { image: buf, caption: cap, mimetype: mime }
      : /^video\//.test(mime) ? { video: buf, caption: cap, mimetype: mime }
      : /^audio\//.test(mime) ? { audio: buf, mimetype: mime, ptt: /ogg|opus|webm/.test(mime) }
      : { document: buf, mimetype: mime, fileName: String(b.nombre || "archivo").slice(0, 100), caption: cap };
    const sent = await sl.sock.sendMessage(r[0].jid, content);
    try { (sl.mine = sl.mine || new Set()).add(sent.key.id); (sl.manualIds = sl.manualIds || new Set()).add(sent.key.id); } catch { }
    try { const st = bxStore(sl), r2 = agregar(st, sent, false); if (r2) { const name0 = crypto.randomBytes(12).toString("hex") + "." + (EXT[mime] || "bin"); fs.writeFileSync(path.join(MDIR, name0), buf); r2.o.f = name0; bxSave(st); } } catch { }
    const name = crypto.randomBytes(12).toString("hex") + "." + (EXT[mime] || "bin");
    try { fs.writeFileSync(path.join(MDIR, name), buf); } catch { }
    return send(res, 200, { ok: true, archivo: name, ts: new Date().toISOString() });
  } catch (e) { return send(res, 200, { ok: false, error: String(e.message || e).slice(0, 120) }); }
}

/* Actualización sola: cada 10 min revisa GitHub; si hay versión nueva y no hay envíos en curso, se cierra y INICIAR.bat la descarga y vuelve a abrir */
export function autoActualizar(ocupado, log) {
  const base = "https://raw.githubusercontent.com/joacovm66-source/seguimiento-whatsapp-servicio/main/";
  const local = f => { try { return fs.readFileSync(path.join(DIR, f), "utf8").replace(/\r/g, ""); } catch { return ""; } };
  setInterval(async () => {
    try {
      for (const f of ["puente.js", "sigo-extra.mjs"]) {
        const r = await fetch(base + f + "?t=" + Date.now()); if (!r.ok) return;
        const t = (await r.text()).replace(/\r/g, "");
        if (t.length > 1000 && t !== local(f)) {
          if (ocupado()) return;
          log("Hay una versión nueva del puente. Reiniciando para actualizar…"); setTimeout(() => process.exit(0), 1500); return;
        }
      }
    } catch { }
  }, 10 * 60 * 1000);
}

/* ======================= Bandeja tipo WhatsApp =======================
   El puente guarda los chats y mensajes de cada vendedor (historial, contactos, archivos)
   y la app los muestra como WhatsApp Web. Rutas /bx/* (requieren sesión de la app). */
let BJ = null; // BufferJSON de Baileys (para guardar los datos de los archivos)
const BX = new Map();
const nOf = x => { if (x == null) return 0; if (typeof x === "object") return Number(x.toNumber ? x.toNumber() : x.low) || 0; return Number(x) || 0; };
function bxStore(sl) {
  let s = BX.get(sl.email); if (s) return s;
  s = { f: path.join(sl.dir, "bandeja.json"), fr: path.join(sl.dir, "bandeja-archivos.json"), chats: {}, msgs: {}, names: {}, raws: null, v: 1, t: null };
  try { Object.assign(s, JSON.parse(fs.readFileSync(s.f, "utf8"))); } catch { }
  BX.set(sl.email, s); return s;
}
function bxRaws(s) {
  if (s.raws) return s.raws;
  try { s.raws = JSON.parse(fs.readFileSync(s.fr, "utf8"), BJ ? BJ.reviver : undefined) || {}; } catch { s.raws = {}; }
  return s.raws;
}
function bxSave(s) {
  s.v++; clearTimeout(s.t);
  s.t = setTimeout(() => {
    try { fs.writeFileSync(s.f, JSON.stringify({ chats: s.chats, msgs: s.msgs, names: s.names, v: s.v })); } catch { }
    if (s.raws) try { fs.writeFileSync(s.fr, JSON.stringify(s.raws, BJ ? BJ.replacer : undefined)); } catch { }
  }, 3000);
}
const ignorar = j => !j || /@g\.us$|^status@|@newsletter$|@broadcast$/.test(j);
function canon(s, jid, k = {}) {
  jid = String(jid || "").replace(/:\d+@/, "@");
  if (!jid.endsWith("@lid")) return jid;
  const d = digits(jid.split("@")[0]);
  const alt = [k.remoteJidAlt, k.senderPn, k.participantAlt].find(x => x && !String(x).includes("@lid"));
  if (alt) { const r = digits(String(alt).split("@")[0].split(":")[0]); if (r) { LIDS[d] = jid; LIDS["r" + d] = r; guardarLids(); fusionar(s, jid, r + "@s.whatsapp.net"); return r + "@s.whatsapp.net"; } }
  return LIDS["r" + d] ? LIDS["r" + d] + "@s.whatsapp.net" : jid;
}
function fusionar(s, de, a) {
  if (!s.chats[de] || de === a) return;
  const m = (s.msgs[a] || []).concat(s.msgs[de] || []), vistos = new Set();
  s.msgs[a] = m.filter(x => !vistos.has(x.id) && vistos.add(x.id)).sort((x, y) => x.ts - y.ts).slice(-400);
  const c = s.chats[a] || { id: a, unread: 0, ts: 0 }, o = s.chats[de];
  s.chats[a] = Object.assign(c, { unread: (c.unread || 0) + (o.unread || 0) }, o.ts > (c.ts || 0) ? { ts: o.ts, last: o.last, lastMe: o.lastMe } : {});
  if (!s.names[a] && s.names[de]) s.names[a] = s.names[de];
  delete s.chats[de]; delete s.msgs[de];
}
function parse(m) {
  const msg = desenvolver(m.message); if (!msg || !Object.keys(msg).length) return null;
  if (msg.protocolMessage || msg.reactionMessage || msg.pollUpdateMessage) return null;
  const k = Object.keys(TIPOS).find(x => msg[x]);
  let tipo = "texto", t = msg.conversation || (msg.extendedTextMessage && msg.extendedTextMessage.text) || "";
  if (k) { tipo = TIPOS[k]; t = msg[k].caption || ""; }
  else if (msg.locationMessage || msg.liveLocationMessage) t = "📍 Ubicación";
  else if (msg.contactMessage) t = "👤 " + (msg.contactMessage.displayName || "Contacto");
  else if (msg.contactsArrayMessage) t = "👥 Contactos";
  else if (msg.buttonsResponseMessage) t = msg.buttonsResponseMessage.selectedDisplayText || "";
  else if (msg.listResponseMessage) t = msg.listResponseMessage.title || "";
  else if (msg.templateButtonReplyMessage) t = msg.templateButtonReplyMessage.selectedDisplayText || "";
  else if (msg.pollCreationMessage || msg.pollCreationMessageV3) t = "📊 Encuesta";
  if (!t && tipo === "texto") return null;
  const o = { id: m.key.id, me: !!m.key.fromMe, ts: nOf(m.messageTimestamp) || Math.floor(Date.now() / 1000), t: String(t).slice(0, 4000), tipo, j: m.key.remoteJid };
  if (k) { const i = msg[k]; o.mime = String(i.mimetype || "").split(";")[0]; if (k === "documentMessage") o.n = i.fileName || "Documento"; if (i.seconds) o.dur = i.seconds; if (k === "audioMessage" && i.ptt) o.ptt = 1; }
  if (m.status != null && o.me) o.st = m.status;
  return o;
}
const PREV = { imagen: "📷 Foto", audio: "🎤 Audio", video: "🎬 Video", documento: "📄 Documento", sticker: "Sticker" };
const quitarMiniaturas = obj => JSON.parse(JSON.stringify(obj, (k, v) => (k === "jpegThumbnail" ? undefined : BJ ? BJ.replacer(k, v) : v)), BJ ? BJ.reviver : undefined);
function agregar(s, m, nuevo) {
  const j0 = m.key && m.key.remoteJid; if (ignorar(j0)) return null;
  const c = canon(s, j0, m.key), o = parse(m); if (!o) return null;
  const arr = s.msgs[c] || (s.msgs[c] = []);
  const ya = arr.find(x => x.id === o.id); if (ya) { if (o.st != null) ya.st = o.st; return null; }
  arr.push(o); if (arr.length > 1 && arr[arr.length - 2].ts > o.ts) arr.sort((a, b) => a.ts - b.ts); if (arr.length > 400) arr.splice(0, arr.length - 400);
  const ch = s.chats[c] || (s.chats[c] = { id: c, unread: 0, ts: 0 });
  if (o.ts >= (ch.ts || 0)) { ch.ts = o.ts; ch.last = o.t || PREV[o.tipo] || ""; ch.lastTipo = o.tipo; ch.lastMe = o.me; }
  if (nuevo && !o.me) ch.unread = (ch.unread || 0) + 1;
  if (!o.me && m.pushName && !(s.names[c] && s.names[c].g)) s.names[c] = { n: m.pushName };
  if (o.tipo !== "texto") { try { bxRaws(s)[c + "|" + o.id] = { key: m.key, message: quitarMiniaturas(m.message) }; } catch { } }
  bxSave(s); return { c, o };
}
function nombre(s, c) {
  const x = s.names[c]; if (x && x.n) return { n: x.n, g: !!x.g };
  if (c.endsWith("@s.whatsapp.net")) { const d = digits(c.split("@")[0]); return { n: d.startsWith("51") && d.length === 11 ? `+51 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : "+" + d, g: false }; }
  return { n: "Contacto de WhatsApp", g: false };
}
async function bajar(sl, s, c, id) {
  const o = (s.msgs[c] || []).find(x => x.id === id); if (!o) throw new Error("no existe");
  if (o.f && fs.existsSync(path.join(MDIR, o.f))) return o.f;
  const raw = bxRaws(s)[c + "|" + id]; if (!raw || !BX_B) throw new Error("sin datos del archivo");
  const buf = await BX_B.downloadMediaMessage(raw, "buffer", {}, { reuploadRequest: sl.sock && sl.sock.updateMediaMessage, logger: undefined });
  const name = crypto.randomBytes(12).toString("hex") + "." + (EXT[o.mime] || (o.tipo === "audio" ? "ogg" : "bin"));
  fs.writeFileSync(path.join(MDIR, name), buf); o.f = name; bxSave(s); return name;
}
let BX_B = null;
/* Se llama al crear el WhatsApp de un vendedor */
export function bandeja(sl, sock, B) {
  BX_B = B; BJ = B.BufferJSON || BJ;
  const s = bxStore(sl);
  const contactos = (lista) => { for (const k of lista || []) { if (!k || ignorar(k.id)) continue; const c = canon(s, k.id, { remoteJidAlt: k.phoneNumber || k.jid }); if (k.name) s.names[c] = { n: k.name, g: 1 }; else if ((k.notify || k.verifiedName) && !(s.names[c] && s.names[c].g)) s.names[c] = { n: k.notify || k.verifiedName }; } bxSave(s); };
  sock.ev.on("contacts.upsert", contactos);
  sock.ev.on("contacts.update", contactos);
  sock.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
    contactos(contacts);
    for (const ch of chats || []) { if (!ch || ignorar(ch.id)) continue; const c = canon(s, ch.id, { remoteJidAlt: ch.pnJid }); const x = s.chats[c] || (s.chats[c] = { id: c, unread: 0, ts: 0 }); if (ch.unreadCount != null) x.unread = ch.unreadCount; const t = nOf(ch.conversationTimestamp); if (t > (x.ts || 0)) x.ts = t; if (ch.name && !(s.names[c] && s.names[c].g)) s.names[c] = { n: ch.name, g: 1 }; }
    for (const m of messages || []) { try { agregar(s, m, false); } catch { } }
    bxSave(s);
  });
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    for (const m of messages || []) {
      try {
        const r = agregar(s, m, type === "notify");
        if (r && type === "notify" && !r.o.me && /^(audio|imagen)$/.test(r.o.tipo)) bajar(sl, s, r.c, r.o.id).catch(() => { });
      } catch { }
    }
  });
  sock.ev.on("messages.update", (lista) => { for (const u of lista || []) { const k = u.key || {}; if (ignorar(k.remoteJid) || !u.update || u.update.status == null) continue; const c = canon(s, k.remoteJid, k), o = (s.msgs[c] || []).find(x => x.id === k.id); if (o && o.me) { o.st = u.update.status; bxSave(s); } } });
  sock.ev.on("chats.update", (lista) => { for (const ch of lista || []) { if (!ch || ignorar(ch.id) || ch.unreadCount == null) continue; const c = canon(s, ch.id), x = s.chats[c]; if (x) { x.unread = ch.unreadCount; bxSave(s); } } });
}

/* Rutas /bx/* — devuelve true si atendió la petición */
export async function rutasBandeja(u, req, res, sl, send, leerBody) {
  if (!u.pathname.startsWith("/bx/")) return false;
  const s = bxStore(sl), sock = sl.sock, conectado = sl.st && sl.st.state === "open";
  try {
    if (u.pathname === "/bx/chats") {
      const lista = Object.values(s.chats).filter(c => c.ts).sort((a, b) => b.ts - a.ts).slice(0, 500)
        .map(c => { const nm = nombre(s, c.id); return { id: c.id, nombre: nm.n, guardado: nm.g, num: c.id.endsWith("@s.whatsapp.net") ? digits(c.id.split("@")[0]) : "", last: c.last || "", lastTipo: c.lastTipo || "texto", lastMe: !!c.lastMe, ts: c.ts, unread: c.unread || 0 }; });
      send(res, 200, { conectado, v: s.v, me: sl.st && sl.st.me, chats: lista }); return true;
    }
    if (u.pathname === "/bx/mensajes") {
      const c = u.searchParams.get("c") || "", antes = +u.searchParams.get("antes") || Infinity;
      const arr = (s.msgs[c] || []).filter(x => x.ts < antes || antes === Infinity);
      send(res, 200, { v: s.v, nombre: nombre(s, c), mensajes: arr.slice(-80).map(({ j, ...x }) => x), mas: arr.length > 80 }); return true;
    }
    if (u.pathname === "/bx/media") {
      const f = await bajar(sl, s, u.searchParams.get("c") || "", u.searchParams.get("id") || "");
      send(res, 200, { f }); return true;
    }
    if (u.pathname === "/bx/leer" && req.method === "POST") {
      const b = await leerBody(req), c = String(b.c || ""), ch = s.chats[c];
      if (ch) { ch.unread = 0; bxSave(s); }
      if (conectado) { const keys = (s.msgs[c] || []).filter(x => !x.me).slice(-15).map(x => ({ remoteJid: x.j || c, id: x.id, fromMe: false })); if (keys.length) sock.readMessages(keys).catch(() => { }); }
      send(res, 200, { ok: true }); return true;
    }
    if (u.pathname === "/bx/enviar" && req.method === "POST") {
      const b = await leerBody(req), c = String(b.c || ""), t = String(b.t || "").trim().slice(0, 4000);
      if (!conectado) { send(res, 200, { ok: false, error: "Tu WhatsApp no está conectado" }); return true; }
      if (!c || !t) { send(res, 200, { ok: false, error: "Mensaje vacío" }); return true; }
      const sent = await sock.sendMessage(c, { text: t });
      try { (sl.mine = sl.mine || new Set()).add(sent.key.id); (sl.manualIds = sl.manualIds || new Set()).add(sent.key.id); } catch { }
      agregar(s, sent, false);
      send(res, 200, { ok: true, id: sent.key.id }); return true;
    }
  } catch (e) { send(res, 200, { ok: false, error: String(e.message || e).slice(0, 120) }); return true; }
  return false;
}

/* ======================= IA por WhatsApp y avisos a asesores ======================= */
let CONF = { url: "", secret: "" };
export function config(c) { CONF = Object.assign(CONF, c); }
const noEsLinea = new Map(); // email -> hasta cuándo sabemos que no es la línea de la IA
async function llamarBot(cuerpo) {
  const r = await fetch(CONF.url + "/functions/v1/bot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ secret: CONF.secret }, cuerpo)) });
  return r.json();
}
async function botWA(sl, sock, c, o) {
  if (!CONF.url || !CONF.secret || (noEsLinea.get(sl.email) || 0) > Date.now()) return;
  try {
    try { await sock.sendPresenceUpdate("composing", c); } catch { }
    const j = await llamarBot({ accion: "wa", email: sl.email, jid: c, texto: o.t || `[El cliente envió ${o.tipo === "audio" ? "un audio" : o.tipo === "imagen" ? "una foto" : "un archivo"}]` });
    if (j.ignorar) { noEsLinea.set(sl.email, Date.now() + 10 * 60 * 1000); return; }
    sl.botIds = sl.botIds || new Set();
    for (const m of j.mensajes || []) {
      if (m.texto) { const s1 = await sock.sendMessage(c, { text: m.texto }); sl.botIds.add(s1.key.id); }
      for (const f of m.media || []) {
        try { const r = await fetch(f.url); const buf = Buffer.from(await r.arrayBuffer()); const mime = f.mime || r.headers.get("content-type") || "";
          const s2 = await sock.sendMessage(c, /^image\//.test(mime) ? { image: buf, mimetype: mime } : /^video\//.test(mime) ? { video: buf, mimetype: mime } : { document: buf, mimetype: mime, fileName: f.titulo || "archivo" });
          sl.botIds.add(s2.key.id); } catch { }
      }
    }
    try { await sock.sendPresenceUpdate("paused", c); } catch { }
  } catch (e) { }
}
function humano(sl, c, id) {
  if (!CONF.url || (noEsLinea.get(sl.email) || 0) > Date.now()) return;
  if (sl.botIds && sl.botIds.has(id)) return;
  if (sl.mine && sl.mine.has(id) && !(sl.manualIds && sl.manualIds.has(id))) return; // campañas automáticas no pausan la IA
  llamarBot({ accion: "wa_humano", email: sl.email, jid: c }).catch(() => { });
}
async function enviarAvisos(sl) {
  if (!CONF.url || !sl.sock || !sl.st || sl.st.state !== "open") return;
  try {
    const r = await fetch(CONF.url + "/functions/v1/puente", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fn: "puente_avisos", args: { secret: CONF.secret, p_email: sl.email } }) });
    const lista = await r.json(); if (!Array.isArray(lista)) return;
    for (const a of lista) {
      let ok = false; try { await sl.sock.sendMessage(String(a.para).replace(/\D/g, "") + "@s.whatsapp.net", { text: a.texto }); ok = true; } catch { }
      fetch(CONF.url + "/functions/v1/puente", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fn: "puente_aviso_hecho", args: { secret: CONF.secret, p_id: a.id, p_ok: ok } }) }).catch(() => { });
    }
  } catch { }
}
export function atencion(sl, sock) {
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    for (const m of messages || []) {
      try {
        const k = m.key || {}; if (ignorar(k.remoteJid)) continue;
        const s = bxStore(sl), c = canon(s, k.remoteJid, k);
        if (k.fromMe) { if (type === "notify" || type === "append") humano(sl, c, k.id); continue; }
        if (type !== "notify") continue;
        const o = parse(m); if (!o) continue;
        if (Date.now() / 1000 - o.ts > 120) continue; // no responder mensajes viejos al reconectar
        botWA(sl, sock, c, o);
      } catch { }
    }
  });
  if (!sl.avisosT) sl.avisosT = setInterval(() => enviarAvisos(sl), 60000);
}
