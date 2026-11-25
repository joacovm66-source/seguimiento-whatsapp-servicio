/* Sigo · extras del puente (19/11/2026)
   1. Números ocultos de WhatsApp (LID): busca el número real; si no existe, guarda el identificador para poder responder.
   2. Archivos y audios recibidos: los descarga y los sirve en /m/<archivo> (nombre aleatorio, no adivinable).
   3. Respuestas desde la Bandeja (id "m:..."): pasan primero en la cola y sin la espera larga de campañas.
   4. /archivo: el vendedor envía fotos, PDF, audios o videos desde la Bandeja. */
import fs from "node:fs";
import os from "node:os";
import { Buffer } from "node:buffer";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STORE = process.env.DATA_DIR || DIR;
const MDIR = path.join(STORE, "media"); fs.mkdirSync(MDIR, { recursive: true });
const F_LID = path.join(STORE, "lids.json");
export const VERSION = "2026-11-25h";
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

/* ======================= Vigía: avisa al dueño por Telegram y WhatsApp =======================
   Revisa cada minuto el estado de cada vendedor y avisa ANTES de que algo se rompa
   (reconexiones seguidas, fallos que suben, tope cerca, poca memoria) y cuando algo ya falló.
   Configuración (opcional) en "alertas.txt" junto a INICIAR.bat:
     línea 1: token del bot de Telegram (de @BotFather)
     línea 2: número de WhatsApp que recibe los avisos (por defecto el del dueño)
   El chat de Telegram se detecta solo: basta escribirle /start al bot. */
const VG = { tok: "", chat: "", wa: "51967664627", from: "ajvillal@trener.edu.pe", ult: new Map(), hist: [], silencioHasta: 0, errores: [], s: new Map(), offset: 0, sinUrl: 0, resumen: "" };
const F_ALE = path.join(DIR, "alertas.txt"), F_CHAT = path.join(STORE, "datos-alertas-chat.txt");
function vgLeer() {
  let local = false;
  try { const l = fs.readFileSync(F_ALE, "utf8").split(/\r?\n/).map(x => x.trim()); if (l[0]) { VG.tok = l[0]; local = true; } if (/^\+?\d{9,15}$/.test((l[1] || "").replace(/\s/g, ""))) VG.wa = l[1].replace(/\D/g, ""); } catch { }
  try { const c = fs.readFileSync(F_CHAT, "utf8").trim(); if (c) VG.chat = c; } catch { }
  if (!local) vgNube(); /* sin alertas.txt: la configuración se lee de Supabase (la pone Claude) */
}
async function vgNube(chat) {
  const S = VCTX && VCTX.supa; if (!S || !S.url || !S.key) return;
  try {
    const r = await fetch(S.url + "/rest/v1/rpc/puente_alertas", { method: "POST", headers: { apikey: S.key, Authorization: "Bearer " + S.key, "Content-Type": "application/json" }, body: JSON.stringify({ secret: S.secret, p_chat: chat || null }) });
    if (!r.ok) return; const j = await r.json(); if (!j) return;
    if (j.tok && j.tok !== VG.tok) { VG.tok = j.tok; VG.offset = 0; }
    if (j.chat && !VG.chat) VG.chat = String(j.chat);
    if (/^\d{9,15}$/.test(j.wa || "")) VG.wa = j.wa;
  } catch { }
}
async function tg(metodo, datos) {
  if (!VG.tok) return null;
  try { const r = await fetch("https://api.telegram.org/bot" + VG.tok + "/" + metodo, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(datos || {}) }); return await r.json(); } catch { return null; }
}
async function vgChat() { /* lee lo que el dueño le escribe al bot: /start conecta el chat; /estado o "estado" responde cómo va el puente */
  if (!VG.tok) return;
  const r = await tg("getUpdates", { offset: VG.offset, timeout: 0 });
  for (const u of (r && r.result) || []) {
    VG.offset = u.update_id + 1; const c = u.message && u.message.chat; if (!c || !c.id) continue;
    if (!VG.chat) { VG.chat = String(c.id); try { fs.writeFileSync(F_CHAT, VG.chat); } catch { } vgNube(VG.chat); await tg("sendMessage", { chat_id: VG.chat, text: "✅ Listo. Desde ahora el puente de Sigo te avisa aquí si algo falla o está por fallar.\nEscribe estado cuando quieras ver cómo va." }); continue; }
    if (String(c.id) !== VG.chat) continue;
    const txt = String(u.message.text || "").trim(); if (!txt) continue;
    if (/^\/?(estado|status)$/i.test(txt)) { await tg("sendMessage", { chat_id: VG.chat, text: vgEstado() }); continue; }
    if (/^\/?(ayuda|help|start|comandos)$/i.test(txt)) { await tg("sendMessage", { chat_id: VG.chat, text: AYUDA }); continue; }
    if (/^\/?avisos$/i.test(txt)) { await tg("sendMessage", { chat_id: VG.chat, text: VG.hist.length ? "🗒️ Avisos de hoy:\n" + VG.hist.slice(-25).map(a => a.h + " " + a.t).join("\n") : "Hoy no hubo avisos." }); continue; }
    vgPreguntar(txt);
  }
}
const AYUDA = "🤖 Puedes escribirme normal, como a una persona. Ejemplos:\n• ¿cómo van los envíos de Nadia?\n• ¿quién está desconectado y por qué?\n• ¿cuántos clientes respondieron hoy?\n• ¿hay chats esperando asesor?\n• ¿por qué fallaron los mensajes de ecuno?\n• pausa a todos / reanuda a Nadia\n• silencia los avisos 3 horas / vuelve a avisar\n• reinicia el puente\nAtajos: estado · avisos · ayuda\n\n🔔 Solo suenan los problemas (desvinculado, número restringido, cola trabada, sin conexión con mensajes pendientes, puente caído). Lo demás llega en silencio.";
/* Preguntas en lenguaje natural: el puente manda la foto del estado a la función "vigia-ia" (Gemini) y ejecuta las acciones permitidas */
const VHIST = [];
const hLima = t => { if (!t) return ""; const d = new Date((typeof t === "number" ? t : Date.parse(t)) - 5 * 3600000); return d.toISOString().slice(11, 16); };
export function vgFoto() {
  const L = limaHora(), hoy = r => new Date(Date.parse(r.ts) - 5 * 3600000).toISOString().slice(0, 10) === L.dia, ahora = Date.now();
  const vendedores = [...VCTX.sellers()].map(sl => { const R = sl.DATA.results.filter(hoy), malos = R.filter(r => !r.ok), ult = sl.DATA.results[sl.DATA.results.length - 1];
    return { vendedor: vgNom(sl.email), email: sl.email, whatsapp: sl.st.me || "", estado: sl.st.state, aviso: sl.st.err || "", pausado: !!sl.paused, pausado_por: sl.paused ? (sl.pausa ? sl.pausa.por + " a las " + hLima(sl.pausa.ts) : "no se sabe (se pausó antes de que el puente guardara quién)") : "",
      descanso_hasta: sl.breakUntil > ahora ? hLima(sl.breakUntil) : "", en_cola: sl.queue.length, enviando_ahora: !!sl.running && sl.queue.length > 0,
      enviados_hoy_ok: R.length - malos.length, fallidos_hoy: malos.length, ultimo_envio: ult ? hLima(ult.ts) + (ult.ok ? " ok" : " falló") : "",
      ultimos_fallos: malos.slice(-5).map(r => hLima(r.ts) + " " + String(r.to || "").slice(-9) + ": " + (r.err || "?")),
      escudo: (() => { const x = escudoEstado(sl); return { nivel: ["normal", "cuidado (ritmo x2)", "freno"][x.nivel], motivo: x.motivo, llegan_pct: x.entrega, sin_whatsapp_pct: x.sin_whatsapp, cortes_30min: x.cortes_30min }; })(), contador_tope_hoy: sl.DATA.sentToday || 0, cortes_guardados: (sl.DATA.cortes || []).slice(-8), desvinculado_desde: sl.DATA.desvinculado || (sl.st.state === "qr" || /cerró la sesión/i.test(sl.st.err || "") ? "antes de que el puente guardara motivos (22/11)" : ""), tope_dia: Math.min(VCTX.cfg.dailyCap, (sl.acc && sl.acc.tope_dia) || Infinity) };
  });
  let memoria = ""; try { memoria = Math.round(os.freemem() / os.totalmem() * 100) + "% libre"; } catch { }
  return { hora_lima: String(L.h).padStart(2, "0") + ":" + String(L.m).padStart(2, "0"), fecha: L.dia, tunel: VCTX.publicUrl() ? "ok" : "caído", memoria_pc: memoria,
    puente_encendido_hace_min: Math.round(process.uptime() / 60), ritmo: { seg_min: VCTX.cfg.minDelay, seg_max: VCTX.cfg.maxDelay, descanso_cada: VCTX.cfg.batch, descanso_min: VCTX.cfg.pauseMin }, vendedores };
}
function vgBuscar(email) { email = String(email || "").toLowerCase(); const l = [...VCTX.sellers()]; return l.find(x => x.email === email) || l.find(x => email && (x.email.startsWith(email.split("@")[0]) || email.startsWith(vgNom(x.email)))); }
async function vgPreguntar(txt) {
  const S = VCTX.supa; try { await tg("sendChatAction", { chat_id: VG.chat, action: "typing" }); } catch { }
  let j = null;
  try { const r = await fetch(S.url + "/functions/v1/vigia-ia", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: S.secret, pregunta: txt, estado: vgFoto(), avisos: VG.hist.slice(-30), historial: VHIST }) }); j = await r.json(); } catch { }
  if (!j || !j.ok) { await tg("sendMessage", { chat_id: VG.chat, text: "No pude pensar la respuesta ahora (" + ((j && j.error) || "sin conexión") + "). Te paso el estado:\n\n" + vgEstado() }); return; }
  const hechos = [];
  for (const a of j.acciones || []) {
    if (a.tipo === "silenciar") { const h = Math.max(0.5, Math.min(24, Number(a.horas) || 2)); VG.silencioHasta = Date.now() + h * 3600000; hechos.push("🔕 Avisos en silencio por " + h + " h (los muy graves igual suenan)."); continue; }
    if (a.tipo === "sonido") { VG.silencioHasta = 0; hechos.push("🔔 Avisos con sonido otra vez."); continue; }
    if (a.tipo === "reiniciar") { hechos.push("🔄 Reiniciando el puente (vuelve en ~1 min, la cola se guarda)."); setTimeout(() => process.exit(0), 3000); continue; }
    const sl = vgBuscar(a.email); if (!sl) { hechos.push("⚠️ No encontré al vendedor " + (a.email || "?") + "."); continue; }
    if (a.tipo === "pausar") { sl.paused = true; sl.pausa = { por: "tú (Joaquin) desde Telegram", ts: Date.now() }; hechos.push("⏸️ Pausé los envíos de " + vgNom(sl.email) + "."); VCTX.log("Telegram: pausado", sl.email); }
    if (a.tipo === "reanudar") { sl.paused = false; sl.pausa = null; if (/restringió/i.test(sl.st.err || "")) sl.st.err = ""; if (VCTX.worker) VCTX.worker(sl); hechos.push("▶️ Reanudé los envíos de " + vgNom(sl.email) + "."); VCTX.log("Telegram: reanudado", sl.email); }
  }
  const resp = j.respuesta + (hechos.length ? "\n\n" + hechos.join("\n") : "");
  VHIST.push({ quien: "yo", t: txt }, { quien: "bot", t: resp }); while (VHIST.length > 10) VHIST.shift();
  await tg("sendMessage", { chat_id: VG.chat, text: resp });
}
export function vgEstado() {
  const L = limaHora(), hoy = r => new Date(Date.parse(r.ts) - 5 * 3600000).toISOString().slice(0, 10) === L.dia;
  const est = { open: "✅ conectado", qr: "🔴 desvinculado (pide QR)", connecting: "🟡 conectando", off: "🔴 sin conexión" };
  const lineas = [...VCTX.sellers()].map(sl => { const R = sl.DATA.results.filter(hoy), ok = R.filter(r => r.ok).length, q = sl.queue.length;
    return "• " + vgNom(sl.email) + ": " + (est[sl.st.state] || sl.st.state) + " · hoy " + ok + " enviados" + (R.length - ok ? ", " + (R.length - ok) + " fallidos" : "") + (q ? " · " + q + " en cola" : "") + (() => { const x = escudoEstado(sl); return x.nivel ? " · 🛡️ escudo " + (x.nivel === 2 ? "FRENO" : "lento") + " (" + x.motivo + ")" : ""; })() + (sl.paused ? " · PAUSADO" + (sl.pausa ? " (por " + sl.pausa.por + ", " + hLima(sl.pausa.ts) + ")" : "") : ""); });
  let mem = ""; try { mem = " · memoria libre " + Math.round(os.freemem() / os.totalmem() * 100) + "%"; } catch { }
  return "📊 Puente de Sigo (" + String(L.h).padStart(2, "0") + ":" + String(L.m).padStart(2, "0") + ")\n" + (lineas.join("\n") || "Sin vendedores conectados") + "\n" + (VCTX.publicUrl() ? "🌐 túnel ok" : "🔴 túnel caído") + mem;
}
let VCTX = null;
async function enviarAviso(texto, fuerte) {
  if (VG.tok && VG.chat) await tg("sendMessage", { chat_id: VG.chat, text: texto, disable_notification: !fuerte });
  if (!fuerte) return; /* lo rutinario solo queda en Telegram, sin sonido y sin WhatsApp */
  try { /* por WhatsApp, desde la línea del dueño (si está conectada) */
    const sl = VCTX && [...VCTX.sellers()].find(x => x.email === VG.from && x.st.state === "open" && x.sock);
    if (sl && VG.wa) { const m = await sl.sock.sendMessage(VG.wa + "@s.whatsapp.net", { text: "🤖 Sigo · " + texto }); try { (sl.mine = sl.mine || new Set()).add(m.key.id); } catch { } }
  } catch { }
}
/* Enviar un WhatsApp desde la línea del dueño (Sigo) a cualquier número. Devuelve true si salió. */
async function waSigo(numero, texto) {
  try {
    const n = String(numero || "").replace(/\D/g, ""); if (n.length < 9) return false;
    const sl = VCTX && [...VCTX.sellers()].find(x => x.email === VG.from && x.st.state === "open" && x.sock);
    if (!sl) return false;
    const m = await sl.sock.sendMessage(n + "@s.whatsapp.net", { text: texto });
    try { (sl.mine = sl.mine || new Set()).add(m.key.id); } catch { }
    return true;
  } catch { return false; }
}
/* key: evita repetir el mismo aviso; cada: minutos mínimos entre avisos iguales */
/* Suenan solo los problemas (🔴). Preventivos 🟡, avisos ✅/🟢 y el resumen llegan en silencio. "silenciar" calla todo salvo lo muy grave. */
const GRAVE = /^(restr|dup|tunel|trabado|plan0)/;
export function avisar(key, texto, cada = 60, fuerte) {
  const t = VG.ult.get(key) || 0; if (Date.now() - t < cada * 60000) return;
  VG.ult.set(key, Date.now()); (VCTX && VCTX.log || console.log)("AVISO:", texto);
  if (fuerte === undefined) fuerte = /^🔴/.test(texto);
  if (fuerte && VG.silencioHasta > Date.now() && !GRAVE.test(key)) fuerte = false;
  const L = limaHora(); VG.hist = VG.hist.filter(a => a.d === L.dia);
  VG.hist.push({ d: L.dia, h: String(L.h).padStart(2, "0") + ":" + String(L.m).padStart(2, "0"), t: texto.slice(0, 200), sono: !!fuerte }); if (VG.hist.length > 60) VG.hist.shift();
  enviarAviso(texto, fuerte);
}
const vgNom = e => String(e || "").split("@")[0];
const limaHora = () => { const d = new Date(Date.now() - 5 * 3600000); return { h: d.getUTCHours(), m: d.getUTCMinutes(), dia: d.toISOString().slice(0, 10) }; };
export function vigiaError(e) { VG.errores.push(Date.now()); VG.ultErr = String(e && e.message || e).slice(0, 150); }
const MOTIVO = { 401: "cerraron la sesión desde el teléfono o WhatsApp la expulsó", 403: "WhatsApp restringió el número", 408: "se cortó la conexión (internet)", 428: "WhatsApp cerró la conexión", 440: "la misma cuenta se abrió en otro lugar (otro puente o otro QR)", 500: "sesión dañada", 515: "reinicio normal tras vincular" };
export const vgMotivo = c => c ? (MOTIVO[c] || "código " + c) + " [" + c + "]" : "";
/* Diagnóstico de una caída: un solo mensaje con todo lo que importa, sin rodeos. */
export function diagCaida(sl, code) {
  const ahora = Date.now(), R = sl.DATA.results || [], st = escudoEstado(sl);
  const h1 = R.filter(r => r.ok && ahora - Date.parse(r.ts) < 60 * 60000).length;
  const m5 = R.filter(r => ahora - Date.parse(r.ts) < 5 * 60000).length;
  const minsVinc = sl.DATA.vinculadoTs ? Math.round((ahora - sl.DATA.vinculadoTs) / 60000) : null;
  const L = [];
  L.push("cola: " + (sl.queue.length || 0));
  L.push("enviados: " + h1 + "/h, " + m5 + " en los últimos 5 min");
  if (st.entrega < 100) L.push("llegaban: " + st.entrega + "%");
  if (st.sin_whatsapp > 0) L.push("sin WhatsApp: " + st.sin_whatsapp + "%");
  if (minsVinc != null && minsVinc < 24 * 60) L.push("vinculado hace " + (minsVinc < 60 ? minsVinc + " min" : Math.round(minsVinc / 60) + " h"));
  const causa = code === 401 ? (h1 >= 30 || m5 >= 5 ? "Causa probable: WhatsApp sospechó spam por el ritmo/volumen." : minsVinc != null && minsVinc < 120 ? "Causa probable: número recién vinculado enviando mucho." : h1 === 0 ? "Causa probable: lo cerraron desde el teléfono o pasó de 4 dispositivos." : "Causa probable: reputación del número.")
    : code === 403 ? "WhatsApp restringió el número (no es un corte normal)."
    : code === 440 ? "La misma cuenta está abierta en otro puente u otra PC." : "";
  return L.join(" · ") + (causa ? "\n" + causa : "");
}
export function vigiaCierre(sl, code) {
  escudoCorte(sl, code);
  if (code === 401) avisar("d401:" + sl.email, "🔴 Se desvinculó " + vgNom(sl.email) + " [401]\n" + diagCaida(sl, 401) + "\nAcción: el vendedor debe escanear el QR en Sigo. La cola no se pierde.", 30);
  const v = vgS(sl); v.cierres.push(Date.now()); v.ultCod = code; v.motivos = (v.motivos || []).concat(vgMotivo(code) + " " + hLima(Date.now())).slice(-5); sl.motivosCierre = v.motivos;
  if (code === 401 || code === 403) registrarDesvinc(sl, code);   /* guardar el patrón de cada desvinculación real */
  try { /* se guarda en datos.json: el motivo no se pierde aunque el puente se reinicie */
    const L = limaHora(); sl.DATA.cortes = (sl.DATA.cortes || []).concat({ fecha: L.dia, hora: hLima(Date.now()), codigo: code || 0, motivo: vgMotivo(code) || "sin código" }).slice(-15);
    if (code === 401) sl.DATA.desvinculado = { fecha: L.dia, hora: hLima(Date.now()), motivo: vgMotivo(code) }; } catch { }
  if (code === 440) avisar("dup:" + sl.email, "🔴 El WhatsApp de " + vgNom(sl.email) + " se abrió en OTRO puente u otra PC al mismo tiempo. Deja un solo INICIAR.bat abierto (si hay dos, se botan entre ellos y WhatsApp termina desvinculando).", 120);
  if (code === 403) avisar("restr:" + sl.email, "🔴 WhatsApp RESTRINGIÓ el número de " + vgNom(sl.email) + ". Se pausaron sus envíos. Revisar su teléfono.", 360);
}
async function registrarDesvinc(sl, code) {
  try {
    const S = VCTX && VCTX.supa; if (!S) return;
    const ahora = Date.now(), R = sl.DATA.results || [], st = escudoEstado(sl);
    const p = {
      email: sl.email, codigo: code, motivo: vgMotivo(code),
      enviados_1h: R.filter(r => r.ok && ahora - Date.parse(r.ts) < 3600000).length,
      enviados_5min: R.filter(r => ahora - Date.parse(r.ts) < 5 * 60000).length,
      min_vinculado: sl.DATA.vinculadoTs ? Math.round((ahora - sl.DATA.vinculadoTs) / 60000) : null,
      cola: sl.queue.length, entrega: st.entrega, sin_whatsapp: st.sin_whatsapp,
      detalle: { dia_calentamiento: diasVinculado(sl) + 1, cortes_30min: st.cortes_30min }
    };
    await fetch(S.url + "/functions/v1/puente", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fn: "puente_desvinculacion", args: { secret: S.secret, p } }) });
  } catch { }
}
function vgS(sl) { let v = VG.s.get(sl.email); if (!v) { v = { cierres: [], offDesde: 0, qrDesde: 0, colaAntes: 0, ini: 0, ultRes: Date.now(), ultSeq: 0, total: 0, alertado: false, arranque: true }; VG.s.set(sl.email, v); } return v; }
export function vigiaRevisar() { return revisar(); }
function revisar() {
  const ahora = Date.now(), L = limaHora();
  for (const sl of VCTX.sellers()) {
    const v = vgS(sl), st = sl.st, q = sl.queue.length, n = vgNom(sl.email), R = sl.DATA.results;
    v.cierres = v.cierres.filter(t => ahora - t < 15 * 60000);
    /* --- conexión --- */
    if (st.state === "open") {
      if (v.alertado) { avisar("ok:" + sl.email, "✅ El WhatsApp de " + n + " volvió a conectarse" + (v.ultCod ? " (último corte: " + vgMotivo(v.ultCod) + ")" : "") + "." + (q ? " Sigue con " + q + " pendientes." : ""), 5); v.alertado = false; }
      if (sl.DATA.avisadoCaida) { sl.DATA.avisadoCaida = false; const mi = sl.DATA.miNumero; if (mi && mi !== VG.wa) waSigo(mi, "✅ Sigo: ¡Listo, " + n + "! Tu WhatsApp ya está conectado" + (q ? " y tu difusión se reanudó sola: salen " + q + " mensajes que estaban esperando" : " y todo quedó al día") + ". No tienes que hacer nada más. 🙌"); }
      v.offDesde = 0; v.qrDesde = 0; v.vivo = true;
    } else if (st.state === "qr") {
      v.qrDesde = v.qrDesde || ahora;
      if (q && ahora - v.qrDesde > 5 * 60000) avisarVendedor(sl, q, vgMotivo(v.ultCod));
      if (q && ahora - v.qrDesde > 5 * 60000) { avisar("qr:" + sl.email, "🟡 Recordatorio: " + n + " sigue desvinculado con " + q + " en cola (" + Math.round((ahora - v.qrDesde) / 60000) + " min). Debe escanear el QR en Sigo.", 120, false); v.alertado = true; }
    } else {
      v.offDesde = v.offDesde || ahora;
      if (/cerró la sesión/i.test(st.err || "")) { avisar("out:" + sl.email, "🔴 Se desvinculó el WhatsApp de " + n + " (" + (vgMotivo(v.ultCod) || "cerraron la sesión desde el teléfono") + ")." + (q ? " Tiene " + q + " pendientes." : "") + " Debe escanear el QR otra vez.", q || v.vivo ? 180 : 1440); v.alertado = true; }
      else if ((q || v.vivo) && ahora - v.offDesde > 10 * 60000 && !/restringió|otro puente/i.test(st.err || "")) { avisar("off:" + sl.email, (q ? "🔴" : "🟡") + " El WhatsApp de " + n + " lleva " + Math.round((ahora - v.offDesde) / 60000) + " min sin conexión (el puente sigue reintentando solo)." + (q ? " Tiene " + q + " pendientes; salen solos al volver." : ""), 60); v.alertado = true; }
    }
    if (v.cierres.length >= 6) avisar("loop:" + sl.email, "🟡 " + n + " se reconectó " + v.cierres.length + " veces en 15 min (suele ser internet de la PC, no WhatsApp).", 120, false);
    /* --- avance de la cola --- */
    const ult = R.length ? R[R.length - 1] : null;
    if (ult && ult.seq !== v.ultSeq) { v.ultSeq = ult.seq; v.ultRes = ahora; }
    if (q && !v.colaAntes) { v.ini = ult ? ult.seq : 0; v.total = q; v.ultRes = ahora; if (q >= 10 && st.state === "open" && !v.arranque) avisar("ini:" + sl.email + v.ini, "🟢 " + n + " empezó una difusión de " + q + " mensajes.", 1); v.arranque = false; }
    if (q > v.colaAntes) v.total = Math.max(v.total, q + R.filter(r => r.seq > v.ini).length);
    if (!q && v.colaAntes) {
      const lote = R.filter(r => r.seq > v.ini), ok = lote.filter(r => r.ok).length, mal = lote.length - ok;
      if (lote.length >= 5) { const errs = {}; lote.filter(r => !r.ok).forEach(r => { errs[r.err] = (errs[r.err] || 0) + 1; }); const top = Object.entries(errs).sort((a, b) => b[1] - a[1])[0];
        avisar("fin:" + sl.email + v.ini, (mal ? "🟡" : "✅") + " Terminó la difusión de " + n + ": " + ok + " enviados" + (mal ? ", " + mal + " no enviados" + (top ? " (más común: " + top[0] + ")" : "") : ", sin fallos") + ".", 1); }
    }
    v.colaAntes = q;
    const trabajando = q && st.state === "open" && !sl.paused && !(sl.breakUntil > ahora) && !/tope|plan/i.test(st.err || "");
    if (trabajando && ahora - v.ultRes > 12 * 60000) avisar("trabado:" + sl.email, "🔴 La cola de " + n + " está TRABADA: " + q + " pendientes y ningún envío en " + Math.round((ahora - v.ultRes) / 60000) + " min. Reiniciar INICIAR.bat (la cola se guarda).", 45);
    /* --- fallos que suben (preventivo) --- */
    const rec = R.filter(r => ahora - Date.parse(r.ts) < 30 * 60000), malos = rec.filter(r => !r.ok);
    if (rec.length >= 10 && malos.length / rec.length >= 0.3) avisar("fallos:" + sl.email, "🟡 PREVENTIVO: " + malos.length + " de " + rec.length + " envíos de " + n + " fallaron en 30 min. Último error: " + (malos[malos.length - 1].err || "?") + ". Si sigue así puede ser señal de bloqueo.", 60);
    /* --- topes --- */
    const cap = Math.min(VCTX.cfg.dailyCap, (sl.acc && sl.acc.tope_dia) || Infinity);
    if (/tope diario/i.test(st.err || "") && q) avisar("tope:" + sl.email + L.dia, "🟡 " + n + " llegó al tope del día (" + cap + "). Quedan " + q + " para mañana.", 1440);
    else if (isFinite(cap) && sl.DATA.sentToday >= cap * 0.8 && sl.DATA.day === new Date().toISOString().slice(0, 10)) avisar("tope80:" + sl.email + L.dia, "🟡 PREVENTIVO: " + n + " ya usó " + sl.DATA.sentToday + " de " + cap + " envíos de hoy.", 1440);
    const rest = VCTX.restantes(sl.acc);
    if (isFinite(rest) && rest <= 0 && /plan/i.test(st.err || "")) avisar("plan0:" + sl.email, "🔴 " + n + " se quedó sin envíos de su plan.", 1440);
    else if (isFinite(rest) && rest < 50) avisar("plan:" + sl.email, "🟡 PREVENTIVO: a " + n + " le quedan " + rest + " envíos de su plan.", 1440);
  }
  /* --- puente en general --- */
  if (!VCTX.publicUrl()) { VG.sinUrl = VG.sinUrl || ahora; if (ahora - VG.sinUrl > 3 * 60000) avisar("tunel", "🔴 El puente no tiene dirección pública hace " + Math.round((ahora - VG.sinUrl) / 60000) + " min: la app no puede conectarse. Revisar el internet de la PC.", 30); }
  else VG.sinUrl = 0;
  VG.errores = VG.errores.filter(t => ahora - t < 10 * 60000);
  if (VG.errores.length >= 5) avisar("errores", "🟡 PREVENTIVO: el puente tuvo " + VG.errores.length + " errores en 10 min. Último: " + VG.ultErr, 60);
  try { const libre = os.freemem() / os.totalmem(), rss = process.memoryUsage().rss / 1048576;
    if (libre < 0.08) avisar("ram", "🟡 PREVENTIVO: la PC del puente tiene poca memoria libre (" + Math.round(libre * 100) + "%). Cerrar programas o reiniciar la PC cuando no haya envíos.", 120);
    if (rss > 1500) avisar("rss", "🟡 PREVENTIVO: el puente usa " + Math.round(rss) + " MB de memoria. Conviene reiniciar INICIAR.bat cuando no haya envíos.", 180); } catch { }
  /* --- resumen del día (20:05 Lima) --- */
  if (L.h === 20 && L.m >= 5 && VG.resumen !== L.dia) { VG.resumen = L.dia;
    const lineas = [...VCTX.sellers()].map(sl => { const hoy = sl.DATA.results.filter(r => new Date(Date.parse(r.ts) - 5 * 3600000).toISOString().slice(0, 10) === L.dia); const ok = hoy.filter(r => r.ok).length; return "• " + vgNom(sl.email) + ": " + (sl.st.state === "open" ? "conectado" : "SIN conexión") + ", " + ok + " enviados" + (hoy.length - ok ? ", " + (hoy.length - ok) + " fallidos" : "") + (sl.queue.length ? ", " + sl.queue.length + " pendientes" : ""); });
    avisar("resumen" + L.dia, "📋 Resumen de hoy en Sigo:\n" + lineas.join("\n"), 1); }
}
export function vigia(ctx) {
  VCTX = ctx; vgLeer();
  setTimeout(vgChat, 5000);
  setInterval(vgLeer, 60000);
  setInterval(() => { vgChat(); }, 20000);
  setTimeout(() => avisar("inicio", "🟢 El puente de Sigo se inició" + (VG.tok ? "" : " (Telegram aún sin configurar)") + ". Si no esperabas esto, la PC o el puente se reiniciaron.", 10), 90000);
  setInterval(() => { try { revisar(); } catch (e) { ctx.log("Vigía:", e.message); } }, 60000);
}

/* ===== Escudo de reputación (23/11) =====
   Cuida que WhatsApp no bote la sesión (401) ni restrinja el número (403) SIN bajar el tope diario.
   Mira en vivo 3 señales que WhatsApp usa para detectar spam y ajusta solo el ritmo:
   1) números sin WhatsApp (no se les envía), 2) mensajes que no llegan (1 check), 3) cortes seguidos.
   Nivel 0 normal · 1 cuidado (ritmo x2) · 2 freno (pausa 20 min y luego ritmo x2). Vuelve solo a 0. */
const ESC = new Map();
export function escudo(sl) {
  let e = ESC.get(sl.email);
  if (!e) { e = { checks: [], env: new Map(), cortes: [], nivel: 0, frenoHasta: 0, motivo: "", desde: 0 }; ESC.set(sl.email, e); }
  return e;
}
/* ¿El número existe? Para difusiones no se envía a números que WhatsApp dice que no existen
   (enviar a números sin WhatsApp es de las señales de spam más fuertes).
   Si WhatsApp falla al responder, o si dice "no existe" a casi todos (falla de WhatsApp con LID), se envía igual. */
export async function destinoSeguro(sl, sock, to, masivo) {
  const raw = String(to || ""); if (!masivo || raw.includes("@")) return destino(sl, sock, to);
  const d = digits(raw); if (LIDS[d]) return [{ exists: true, jid: LIDS[d] }];
  const e = escudo(sl); let r = null, fallo = false;
  try { r = await sock.onWhatsApp(d + "@s.whatsapp.net"); } catch { fallo = true; }
  const existe = !!(r && r[0] && r[0].exists);
  if (!fallo) { e.checks.push({ t: Date.now(), ok: existe }); if (e.checks.length > 40) e.checks.shift(); }
  if (existe) return r;
  if (fallo) return d.length >= 10 ? [{ exists: true, jid: d + "@s.whatsapp.net" }] : [];
  const ult = e.checks.slice(-20), malos = ult.filter(c => !c.ok).length;
  if (ult.length >= 15 && malos / ult.length > 0.8) return d.length >= 10 ? [{ exists: true, jid: d + "@s.whatsapp.net" }] : []; /* WhatsApp está fallando, no la lista */
  return [];
}
/* Variación: cada cliente recibe un texto distinto (WhatsApp detecta el mismo texto repetido a muchos).
   - {opción a|opción b|opción c}: el vendedor puede escribir variantes y se elige una al azar.
   - El saludo inicial cambia solo (¡Hola / Hola / ¡Qué tal / ¡Buenas).
   - Detalles invisibles para el cliente: espacios y saltos de línea al final de algunas líneas. */
const SALUDOS = ["¡Hola", "Hola", "¡Qué tal", "¡Buenas", "¡Hola"];
const pick = a => a[Math.floor(Math.random() * a.length)];
export function variar(t) {
  t = String(t || ""); if (!t) return t;
  for (let i = 0; i < 5 && /\{[^{}]*\|[^{}]*\}/.test(t); i++) t = t.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, o) => pick(o.split("|")));
  t = t.replace(/^([^\p{L}¡]*)¡?Hola\b/u, (_, pre) => pre + pick(SALUDOS));
  const lineas = t.split("\n");
  if (lineas.length > 2) { const n = 1 + Math.floor(Math.random() * Math.min(3, lineas.length - 1)); for (let k = 0; k < n; k++) { const i = Math.floor(Math.random() * (lineas.length - 1)); if (lineas[i].trim()) lineas[i] = lineas[i].replace(/\s*$/, " "); } t = lineas.join("\n"); }
  return t;
}
/* Registro de envíos de difusión y de su entrega (checks) */
export function escudoEnviado(sl, id) { const e = escudo(sl); e.env.set(id, { t: Date.now(), ok: false }); if (e.env.size > 120) e.env.delete(e.env.keys().next().value); }
export function escudoEscuchar(sl, sock) {
  sock.ev.on("messages.update", (lista) => { const e = escudo(sl); for (const u of lista || []) { const k = u.key || {}; if (!k.fromMe || !u.update || u.update.status == null) continue; const x = e.env.get(k.id); if (x && u.update.status >= 3) x.ok = true; } });
}
export function escudoCorte(sl, code) { if (code === 515) return; const e = escudo(sl); e.cortes.push(Date.now()); e.cortes = e.cortes.filter(t => Date.now() - t < 30 * 60000); }
/* Estado del escudo: calcula el nivel y devuelve el multiplicador del ritmo y si hay que frenar */
export function escudoEstado(sl) {
  const e = escudo(sl), ahora = Date.now();
  const ult = e.checks.filter(c => ahora - c.t < 60 * 60000).slice(-20), noEx = ult.length >= 8 ? ult.filter(c => !c.ok).length / ult.length : 0;
  const viejos = [...e.env.values()].filter(x => ahora - x.t > 10 * 60000 && ahora - x.t < 3 * 3600000).slice(-30), entrega = viejos.length >= 10 ? viejos.filter(x => x.ok).length / viejos.length : 1;
  const cortes = e.cortes.filter(t => ahora - t < 30 * 60000).length;
  let nivel = 0, motivo = "";
  if (entrega < 0.4 || noEx > 0.5 || cortes >= 4) { nivel = 2; motivo = entrega < 0.4 ? "solo llegan " + Math.round(entrega * 100) + "% de los mensajes" : noEx > 0.5 ? Math.round(noEx * 100) + "% de los números no tienen WhatsApp" : cortes + " cortes en 30 min"; }
  else if (entrega < 0.7 || noEx > 0.25 || cortes >= 2) { nivel = 1; motivo = entrega < 0.7 ? "llegan " + Math.round(entrega * 100) + "% de los mensajes" : noEx > 0.25 ? Math.round(noEx * 100) + "% de números sin WhatsApp" : cortes + " cortes en 30 min"; }
  const n = vgNom(sl.email);
  if (nivel === 2 && e.nivel < 2) { e.frenoHasta = ahora + 20 * 60000; avisar("esc2:" + sl.email, "🔴 Escudo: frené 20 min los envíos de " + n + " porque " + motivo + ". WhatsApp podría desvincularlo. Luego sigue solo, más lento. Revisa que su lista tenga números correctos.", 60); }
  else if (nivel === 1 && e.nivel === 0) avisar("esc1:" + sl.email, "🟡 Escudo: " + n + " envía más lento por ahora (" + motivo + ").", 60);
  else if (nivel === 0 && e.nivel > 0) avisar("esc0:" + sl.email, "✅ Escudo: " + n + " volvió al ritmo normal.", 30);
  if (nivel !== e.nivel) { e.nivel = nivel; e.motivo = motivo; e.desde = ahora; }
  return { nivel, motivo, ritmo: nivel ? 2 : 1, frenoMs: Math.max(0, e.frenoHasta - ahora), entrega: Math.round(entrega * 100), sin_whatsapp: Math.round(noEx * 100), cortes_30min: cortes };
}
/* Resumen para el aviso de desvinculado: qué pasaba justo antes del corte */
/* ===== Freno ABS (25/11): en vez de parar del todo, baja el tope del día del número según su salud =====
   Arranca en 1000/día. Si hay malas señales (poca entrega, números sin WhatsApp, cortes, o recién vinculado)
   el tope baja de forma suave; si todo va bien vuelve a subir. Nunca frena en seco: siempre deja pasar algo.
   Devuelve { tope, salud (0-100), motivo }. */
/* ===== Freno ABS (25/11c): NO baja cuántos se envían, solo el TIEMPO entre mensajes =====
   Para el cliente no cambia nada (salen todos), pero cuando el número está en riesgo van más lentos.
   Devuelve { ritmo, salud (0-100), motivo }. ritmo 1 = normal; hasta ~3.5 cuando la salud está baja.
   Trabaja en silencio: no avisa al vendedor ni muestra nada en la app (no asustar). */
/* ===== Calentamiento de números nuevos (25/11f) =====
   Pedido de Joaquin: un número recién vinculado NO debe estrenarse con una campaña grande.
   Las primeras difusiones van en tandas que crecen día a día, mientras el número se "calienta".
   Solo aplica a números NUEVOS (primeros días). Un número ya establecido NO tiene techo.
   El resto NO se pierde: queda en cola y sale en la siguiente tanda (al día siguiente). Es gradual, nunca un frenazo.
   Si el número tuvo un 401/403 hace poco, baja un escalón (más cuidado). */
/* Curva de calentamiento POR HORAS desde que se vinculó (más rápido y suave que por día).
   El techo SUBE solo con las horas, así en el mismo día van saliendo más (no se espera a mañana).
   [horas desde el vínculo, techo acumulado del día]. A las 48 h ya está caliente (sin techo). */
const CALENTAR = [[0, 40], [2, 120], [4, 220], [8, 400], [12, 600], [18, 850], [24, 1200], [36, 1800], [48, Infinity]];
export function horasVinculado(sl) { return sl.DATA && sl.DATA.vinculadoTs ? (Date.now() - sl.DATA.vinculadoTs) / 3600000 : 1e9; }
export function diasVinculado(sl) { return Math.floor(horasVinculado(sl) / 24); }
const CALAV = new Map();
export function calAviso(sl, cal) {
  const hoy = limaHora().dia, k = sl.email + hoy; if (CALAV.get(k)) return; CALAV.set(k, 1);
  avisar("cal:" + sl.email + hoy, "🌡️ Calentando el número NUEVO de " + vgNom(sl.email) + " (lleva " + cal.horas + " h): va más lento a propósito para que WhatsApp no lo desvincule. El techo sube solo con las horas; el resto sale en un rato, no se pierde.", 600);
}
export function calentamiento(sl) {
  const h = horasVinculado(sl);
  let techo = Infinity; for (const [hh, t] of CALENTAR) { if (h >= hh) techo = t; else break; }
  const nuevo = techo !== Infinity;
  if (!nuevo) return { techo: Infinity, horas: h, nuevo: false };
  /* si se desvinculó (401/403) en las últimas 24 h, baja el techo a la mitad (más cuidado) */
  const d = sl.DATA && sl.DATA.desvinculado;
  if (d && d.fecha) { try { if (Date.now() - new Date(d.fecha + "T" + (d.hora || "00:00") + ":00-05:00").getTime() < 24 * 3600000) techo = Math.round(techo / 2); } catch { } }
  return { techo, horas: Math.round(h), nuevo: true };
}
export function escudoABS(sl) {
  const ahora = Date.now(), st = escudoEstado(sl);
  const minsVinc = sl.DATA && sl.DATA.vinculadoTs ? (ahora - sl.DATA.vinculadoTs) / 60000 : 999999;
  let salud = 100, razones = [];
  if (st.entrega < 70) { salud -= (70 - st.entrega) * 1.2; razones.push("llega " + st.entrega + "%"); }
  if (st.sin_whatsapp > 15) { salud -= (st.sin_whatsapp - 15); razones.push(st.sin_whatsapp + "% sin WhatsApp"); }
  if (st.cortes_30min >= 1) { salud -= st.cortes_30min * 12; razones.push(st.cortes_30min + " cortes"); }
  if (minsVinc < 60) { salud -= 35; razones.push("recién vinculado"); }   /* número nuevo = el de mayor riesgo */
  else if (minsVinc < 24 * 60) { salud -= 15; razones.push("vinculado hoy"); }
  salud = Math.max(0, Math.min(100, Math.round(salud)));
  /* salud 100 → ritmo 1 (normal); salud 0 → ritmo 3.5 (más lento, pero sigue enviando todo) */
  const ritmo = Math.round((1 + (100 - salud) / 100 * 2.5) * 100) / 100;
  return { ritmo, salud, motivo: razones.join(", ") };
}
export function escudoResumen(sl) {
  const ahora = Date.now(), R = sl.DATA.results || [], hora = R.filter(r => r.ok && ahora - Date.parse(r.ts) < 60 * 60000).length;
  const s = escudoEstado(sl);
  return "Antes del corte: " + hora + " enviados en la última hora, llegaban " + s.entrega + "%, " + s.sin_whatsapp + "% de números sin WhatsApp." + (hora >= 40 ? " Lo más probable: WhatsApp sospechó spam por la difusión." : hora === 0 ? " No estaba enviando: probablemente lo cerraron desde el teléfono o se pasó de 4 dispositivos." : "");
}

/* ===== Nombre del dispositivo (24/11) =====
   Se decide UNA vez por sesión y se guarda en navegador.json, así nunca cambia a mitad de una vinculación.
   Sesiones que ya existían → Ubuntu Chrome (no se tocan). Vinculaciones nuevas → Windows Chrome. */
export function navegador(authDir) {
  const f = path.join(authDir, "navegador.json");
  try { const x = JSON.parse(fs.readFileSync(f, "utf8")); if (Array.isArray(x) && x.length === 3) return x; } catch { }
  const nuevo = !fs.existsSync(path.join(authDir, "creds.json"));
  const b = nuevo ? ["Windows", "Chrome", "10.0.22631"] : ["Ubuntu", "Chrome", "22.04.4"];
  try { fs.mkdirSync(authDir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(b)); } catch { }
  return b;
}
/* ===== Aviso al propio vendedor (24/11) =====
   Si su WhatsApp está desvinculado y tiene mensajes esperando, le llega una notificación en la app y un correo
   (la base limita a 1 cada 6 h). Solo de 8:00 a 21:00 Lima. */
const AVV = new Map();
export async function avisarVendedor(sl, q, motivo, forzar) {
  const L = limaHora(); if (!forzar && (L.h < 8 || L.h >= 21)) return null;
  if (sl.DATA.avisoEpisodio && !forzar) return null;   /* ya se le avisó de ESTA caída: no repetir hasta que vuelva y caiga de nuevo */
  sl.DATA.avisoEpisodio = true; AVV.set(sl.email, Date.now());
  try {
    const S = VCTX.supa;
    const r = await fetch(S.url + "/functions/v1/aviso-vendedor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: S.secret, email: sl.email, cola: q, motivo: motivo || "" }) });
    /* WhatsApp a su propio número: su teléfono sigue con WhatsApp normal (solo cayó la sesión vinculada), así que SÍ lo recibe. Sale desde la línea de Sigo. */
    let wa = false; const mi = sl.DATA && sl.DATA.miNumero;
    if (mi && mi !== VG.wa) { wa = await waSigo(mi, "🤖 Sigo: Hola " + vgNom(sl.email) + ", tu WhatsApp se desconectó de Sigo" + (q ? " y tienes " + q + " mensajes esperando" : "") + ". Para reconectarlo en un toque entra aquí: https://sigo-pe.vercel.app/app/\nApenas lo conectes, los mensajes salen solos."); if (wa) sl.DATA.avisadoCaida = true; }
    const j = await r.json(); if ((j && j.notificacion) || wa) avisar("avv:" + sl.email, "📨 Le avisé a " + vgNom(sl.email) + " que su WhatsApp está desconectado" + (q ? " (" + q + " pendientes)" : "") + ": " + [wa ? "WhatsApp" : "", j && j.notificacion ? "app" : "", j && j.correo === "ok" ? "correo" : ""].filter(Boolean).join(" + ") + ".", 300, false);
    return j;
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
/* ===== Sesión blindada (25/11) =====
   Si Windows se apaga, se suspende o se corta la luz justo cuando Baileys escribe creds.json, el archivo queda dañado
   y WhatsApp pide QR otra vez (parece una desvinculación, pero el teléfono sigue vinculado). Por eso:
   - cada vez que las credenciales cambian y están sanas, se copian a creds.respaldo.json (escritura atómica)
   - si creds.json falta o está dañado, se restaura del respaldo antes de conectar
   - una expulsión real (401 confirmado) no borra la carpeta: la archiva (se guardan las 2 últimas) para poder revisar */
export function credsValidas(f) { try { const c = JSON.parse(fs.readFileSync(f, "utf8")); return c && c.me && c.me.id && c.noiseKey ? c : null; } catch { return null; } }
export function credsRespaldar(authDir) {
  const f = path.join(authDir, "creds.json"), b = path.join(authDir, "creds.respaldo.json");
  if (!credsValidas(f)) return false;
  try { fs.copyFileSync(f, b + ".tmp"); if (!credsValidas(b + ".tmp")) return false; fs.renameSync(b + ".tmp", b); return true; } catch { return false; }
}
export function credsRestaurar(authDir, forzar) {
  const f = path.join(authDir, "creds.json"), b = path.join(authDir, "creds.respaldo.json");
  if (!forzar && credsValidas(f)) return false;
  if (!credsValidas(b)) return false;
  try { if (fs.existsSync(f) && !credsValidas(f)) fs.copyFileSync(f, f + ".danado"); fs.copyFileSync(b, f + ".tmp"); fs.renameSync(f + ".tmp", f); return true; } catch { return false; }
}
export function sesionArchivar(authDir) {
  try {
    if (!fs.existsSync(authDir)) return;
    fs.renameSync(authDir, authDir + "_baja_" + Date.now());
    const dir = path.dirname(authDir), base = path.basename(authDir) + "_baja_";
    const viejas = fs.readdirSync(dir).filter(n => n.startsWith(base)).sort().slice(0, -2);
    for (const n of viejas) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  } catch { try { fs.rmSync(authDir, { recursive: true, force: true }); } catch { } }
}
/* solo para pruebas automáticas (pruebas/*.test.mjs) */
export function _probarCon(ctx) { VCTX = ctx; }
