/* Sigo · extras del puente (19/11/2026)
   1. Números ocultos de WhatsApp (LID): busca el número real; si no existe, guarda el identificador para poder responder.
   2. Archivos y audios recibidos: los descarga y los sirve en /m/<archivo> (nombre aleatorio, no adivinable).
   3. Respuestas desde la Bandeja (id "m:..."): pasan primero en la cola y sin la espera larga de campañas.
   4. /archivo: el vendedor envía fotos, PDF, audios o videos desde la Bandeja. */
import fs from "node:fs";
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
  return sock.onWhatsApp(d + "@s.whatsapp.net");
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
    try { (sl.mine = sl.mine || new Set()).add(sent.key.id); } catch { }
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
