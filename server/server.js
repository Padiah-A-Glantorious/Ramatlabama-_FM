/* ============================================================
   Ramatlabama FM — server
   - Serves the website over HTTP.
   - WebSocket chat relay (shared live chat).
   - Accounts & auth (God Admin / Elevated / Presenter).
   - Content API: shows (weekday/weekend) + news, stored in JSON.
   Run:  npm install  &&  npm start   ->  http://localhost:3001
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3001;
const SITE_DIR = path.join(__dirname, "..");

// Where editable data (members, news, shows) is stored. On Render, set
// DATA_DIR to a mounted persistent Disk (e.g. /var/data) so portal edits
// survive restarts and redeploys. Defaults to this folder for local dev.
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const CONTENT_FILE = path.join(DATA_DIR, "content.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const CHAT_FILE = path.join(DATA_DIR, "chat.json");
const ADVERTS_FILE = path.join(DATA_DIR, "promos.json");
const ADVERTS_DIR = path.join(DATA_DIR, "promos");   // uploaded image files live here
try { fs.mkdirSync(ADVERTS_DIR, { recursive: true }); } catch (_) {}

// How many recent chat messages to keep and show to anyone who joins.
const CHAT_HISTORY_MAX = 200;

// Advert upload limits.
const ADVERT_MAX_BYTES = 3 * 1024 * 1024;   // ~3MB per image
const ADVERT_MAX_COUNT = 20;                // keep the rotation sane
const ADVERT_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };

// Default passwords — override in production via environment variables.
const PRESENTER_PASSWORD_DEFAULT = process.env.PRESENTER_PASSWORD || "presenter2026";
const GOD_PASSWORD_DEFAULT = process.env.GOD_PASSWORD || "admin2026";
const CEO_PASSWORD_DEFAULT = process.env.CEO_PASSWORD || "admin2026";

/* ================= CONTENT (shows + news) ================= */
const DEFAULT_CONTENT = {
  // Separate schedules for weekdays and weekends.
  showsWeekday: [
    { start: "06:00", end: "09:00", show: "The Morning Drive",       host: "The Breakfast Crew" },
    { start: "09:00", end: "12:00", show: "Mid-Morning Mix",         host: "DJ Kagiso" },
    { start: "12:00", end: "15:00", show: "Lunchtime Setswana Hits", host: "MC Boitumelo" },
    { start: "15:00", end: "18:00", show: "Afternoon Request Show",  host: "DJ Kagiso" },
    { start: "18:00", end: "20:00", show: "Evening News & Talk",     host: "Station Desk" },
    { start: "20:00", end: "23:00", show: "Gospel & Soul",           host: "MC Boitumelo" },
    { start: "23:00", end: "06:00", show: "Overnight Mix",           host: "Auto DJ" },
  ],
  showsSaturday: [
    { start: "07:00", end: "10:00", show: "Saturday Wake-Up",     host: "DJ Kagiso" },
    { start: "10:00", end: "13:00", show: "Saturday Jams",        host: "MC Boitumelo" },
    { start: "13:00", end: "16:00", show: "The Big Request Show", host: "The Breakfast Crew" },
    { start: "16:00", end: "19:00", show: "Saturday Sundowner",   host: "Station Desk" },
    { start: "19:00", end: "23:00", show: "Saturday Party Mix",   host: "DJ Kagiso" },
    { start: "23:00", end: "07:00", show: "Overnight Mix",        host: "Auto DJ" },
  ],
  showsSunday: [
    { start: "07:00", end: "10:00", show: "Sunday Gospel",        host: "Station Desk" },
    { start: "10:00", end: "13:00", show: "Sunday Worship Hour",  host: "MC Boitumelo" },
    { start: "13:00", end: "16:00", show: "Sunday Easy Listening", host: "DJ Kagiso" },
    { start: "16:00", end: "19:00", show: "Sunday Reflections",   host: "Station Desk" },
    { start: "19:00", end: "23:00", show: "Sunday Chill",         host: "DJ Kagiso" },
    { start: "23:00", end: "07:00", show: "Overnight Mix",        host: "Auto DJ" },
  ],
  news: [
    { tag: "LIVE",      title: "Now streaming worldwide",  body: "Listen live from anywhere. Tell family across the border in Botswana to tune in.", date: "25 Oct 2026" },
    { tag: "COMMUNITY", title: "Dedications line is open", body: "Send a shout-out during The Morning Drive — drop it in the chat to reach the studio.", date: "24 Oct 2026" },
    { tag: "EVENTS",    title: "Miga cycling & aerobics day", body: "Supporting young talent in Ramatlabama & Miga. Come cheer the kids on this weekend.", date: "22 Oct 2026" },
  ],
};

function loadJson(file, def) {
  // No file yet: create it with defaults.
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(def, null, 2));
    return JSON.parse(JSON.stringify(def));
  }
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (_) { return JSON.parse(JSON.stringify(def)); }   // unreadable: use defaults in memory, don't touch the file
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);   // strip BOM
  try {
    return JSON.parse(raw);
  } catch (_) {
    // The file exists but is corrupt. Preserve it (don't overwrite real data)
    // by backing it up, then fall back to defaults in memory.
    try { fs.copyFileSync(file, file + ".corrupt-" + Date.now() + ".bak"); } catch (_) {}
    console.error("WARNING: " + file + " was unreadable JSON; backed up and using defaults in memory.");
    return JSON.parse(JSON.stringify(def));
  }
}
function saveJson(file, obj) {
  // Atomic write: write to a temp file, then rename, so a crash mid-write
  // can never leave a half-written (corrupt) data file on the Disk.
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

let content = loadJson(CONTENT_FILE, DEFAULT_CONTENT);
// Migrate older shapes to weekday / saturday / sunday.
let migrated = false;
if (content.shows && !content.showsWeekday) { content.showsWeekday = content.shows; delete content.shows; migrated = true; }
if (content.showsWeekend && !content.showsSaturday) {
  content.showsSaturday = content.showsWeekend;
  content.showsSunday = JSON.parse(JSON.stringify(content.showsWeekend));
  delete content.showsWeekend; migrated = true;
}
if (!content.showsSaturday) { content.showsSaturday = DEFAULT_CONTENT.showsSaturday; migrated = true; }
if (!content.showsSunday)   { content.showsSunday = DEFAULT_CONTENT.showsSunday; migrated = true; }
if (content.announcement !== undefined) { delete content.announcement; migrated = true; }
if (migrated) saveJson(CONTENT_FILE, content);

/* ================= USERS / ACCOUNTS ================= */
/* Roles: "god" (Padiah, top authority), "elevated" (CEO + granted), "presenter".
   Permission rules (see canActOn):
     - Only a god may act on a god account.
     - A god account can never be deleted (and a god cannot delete themselves).
     - Everyone else (elevated) can manage any non-god account.            */
const DEFAULT_USERS = {
  users: [
    {
      id: "god",
      login: "GOD_Admin",
      email: "",
      name: "Padiah Glantorious",
      title: "Operations Manager",
      role: "god",
      password: GOD_PASSWORD_DEFAULT,
    },
    {
      id: "ceo",
      login: "CEO_Kutlwano_Nqaba",
      email: "",
      name: "Kutlwano Nqaba",
      title: "CEO",
      role: "elevated",
      password: CEO_PASSWORD_DEFAULT,
    },
  ],
};
let db = loadJson(USERS_FILE, DEFAULT_USERS);
if (!Array.isArray(db.users)) db = JSON.parse(JSON.stringify(DEFAULT_USERS));

/* ================= CALL-IN ICE SERVERS ================= */
// STUN alone fails for many callers on mobile data. Add a TURN relay by setting
// the ICE_SERVERS env var on Render to a JSON array, e.g.
// [{"urls":"turn:host:443","username":"u","credential":"p"}]
let ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
try {
  const raw = process.env.ICE_SERVERS;
  if (raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) ICE_SERVERS = parsed;
  }
} catch (_) { console.warn("ICE_SERVERS env var is not valid JSON; using default STUN."); }

/* ================= CHAT HISTORY ================= */
// Recent chat messages, persisted so listeners/presenters see the
// conversation so far when they join. Capped at CHAT_HISTORY_MAX.
let chatLog = loadJson(CHAT_FILE, { messages: [] });
if (!Array.isArray(chatLog.messages)) chatLog = { messages: [] };
// Messages vanish after CHAT_TTL_MS (7 hours), for everyone.
const CHAT_TTL_MS = 7 * 60 * 60 * 1000;
function pruneChat() {
  const cutoff = Date.now() - CHAT_TTL_MS;
  const before = chatLog.messages.length;
  // Messages saved before timestamps existed (no ts) are treated as expired.
  chatLog.messages = chatLog.messages.filter((m) => m && Number(m.ts) > cutoff);
  return chatLog.messages.length !== before;
}
pruneChat();
let chatSaveTimer = null;
function saveChatSoon() {
  // Debounce disk writes so a burst of messages doesn't thrash the Disk.
  if (chatSaveTimer) return;
  chatSaveTimer = setTimeout(() => {
    chatSaveTimer = null;
    try { saveJson(CHAT_FILE, chatLog); } catch (_) {}
  }, 1000);
}
function pushChat(msg) {
  chatLog.messages.push(msg);
  if (chatLog.messages.length > CHAT_HISTORY_MAX) {
    chatLog.messages = chatLog.messages.slice(-CHAT_HISTORY_MAX);
  }
  saveChatSoon();
}

/* ================= ADVERTS ================= */
// Each advert: { id, file, name, ts }. The image bytes live in ADVERTS_DIR/<file>.
let adverts = loadJson(ADVERTS_FILE, { items: [] });
if (!Array.isArray(adverts.items)) adverts = { items: [] };
// Self-heal: drop records whose image file is missing (e.g. after a wipe).
adverts.items = adverts.items.filter((a) => {
  try { return fs.existsSync(path.join(ADVERTS_DIR, a.file)); } catch (_) { return false; }
});
function saveAdverts() { try { saveJson(ADVERTS_FILE, adverts); } catch (_) {} }
// show === "" means "All shows"; otherwise it's a specific show name.
function advertView(a) { return { id: a.id, name: a.name, show: a.show || "", url: "/promos/" + a.file, ts: a.ts }; }

/* Can actor manage/act on target?
   - Only a god may touch a god account.
   - A god may act on anyone else.
   - An elevated user may act on any non-god account.                      */
function canActOn(actor, target) {
  if (target.role === "god") return actor.role === "god";
  return actor.role === "god" || actor.role === "elevated";
}

// In-memory session tokens -> user id
const sessions = new Map();
function newToken(userId) {
  const t = crypto.randomBytes(24).toString("hex");
  sessions.set(t, userId);
  return t;
}
function userFromToken(token) {
  const id = sessions.get(token);
  if (!id) return null;
  return db.users.find((u) => u.id === id) || null;
}
function publicUser(u) {   // for the logged-in user's own identity
  return { id: u.id, login: u.login, email: u.email, name: u.name, title: u.title, role: u.role };
}
function memberView(u) {   // for the Members list — NO email shown
  return { id: u.id, name: u.name, title: u.title, role: u.role };
}
function accessLabel(role) {
  return role === "god" ? "God Admin" : role === "elevated" ? "Elevated Access" : "Presenter";
}
function canManage(role) { return role === "god" || role === "elevated"; }

/* ================= helpers ================= */
function sanitize(s, max) { return String(s == null ? "" : s).replace(/[\u0000-\u001F\u007F]/g, "").slice(0, max); }
function cleanShows(arr, fallback) {
  if (!Array.isArray(arr)) return fallback;
  return arr.slice(0, 60).map((s) => ({
    start: sanitize(s.start, 5), end: sanitize(s.end, 5),
    show: sanitize(s.show, 60), host: sanitize(s.host, 40),
  })).filter((s) => s.show);
}
function cleanNews(arr, fallback) {
  if (!Array.isArray(arr)) return fallback;
  return arr.slice(0, 60).map((n) => ({
    tag: sanitize(n.tag, 16) || "NEWS", title: sanitize(n.title, 120),
    body: sanitize(n.body, 300), date: sanitize(n.date, 24),
  })).filter((n) => n.title);
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ""; req.on("data", (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve(null); } });
  });
}
// Like readBody but allows a larger payload (for base64 image uploads).
function readBodyLarge(req, maxBytes) {
  return new Promise((resolve) => {
    let d = "", aborted = false;
    req.on("data", (c) => { d += c; if (d.length > maxBytes) { aborted = true; req.destroy(); } });
    req.on("end", () => { if (aborted) return resolve(null); try { resolve(JSON.parse(d || "{}")); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}
function authUser(body) {   // returns the user for a request token, or null
  return body && body.token ? userFromToken(String(body.token)) : null;
}

/* ================= HTTP server ================= */
// Subdomains that should land on the staff portal instead of the public site.
// e.g. management.ramatlabamafm.co.za  ->  serves presenter.html at "/".
const PORTAL_HOSTS = (process.env.PORTAL_HOSTS || "management.")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
function isPortalHost(hostHeader) {
  const host = String(hostHeader || "").toLowerCase().split(":")[0];
  return PORTAL_HOSTS.some((h) =>
    h.endsWith(".") ? host.startsWith(h) : host === h
  );
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const p = url.pathname;

  // When reached via the management subdomain, the homepage IS the portal.
  // (API routes and static assets like CSS/JS still resolve normally below.)
  const portalHost = isPortalHost(req.headers.host);

  /* ---- public: live content for the listener site ---- */
  if (p === "/api/content" && req.method === "GET") {
    return sendJson(res, 200, {
      showsWeekday: content.showsWeekday || [],
      showsSaturday: content.showsSaturday || [],
      showsSunday: content.showsSunday || [],
      news: content.news || [],
    });
  }

  /* ---- public: ICE servers for call-in (STUN + optional TURN from env) ---- */
  if (p === "/api/ice" && req.method === "GET") {
    return sendJson(res, 200, { iceServers: ICE_SERVERS });
  }

  /* ---- public: list adverts for the listener site to rotate ---- */
  if (p === "/api/promos" && req.method === "GET") {
    return sendJson(res, 200, { adverts: adverts.items.map(advertView) });
  }

  /* ---- upload an advert image (manager only: god/elevated) ---- */
  if (p === "/api/promos" && req.method === "POST") {
    const body = await readBodyLarge(req, ADVERT_MAX_BYTES + 1024 * 1024);
    if (body === null) return sendJson(res, 400, { ok: false, error: "Upload too large or malformed." });
    const u = authUser(body);
    if (!u || !canManage(u.role)) return sendJson(res, 403, { ok: false, error: "Not authorized." });
    if (adverts.items.length >= ADVERT_MAX_COUNT) {
      return sendJson(res, 400, { ok: false, error: "Advert limit reached. Remove some first." });
    }
    // Expect a data URL: "data:image/png;base64,...."
    const dataUrl = String(body.image || "");
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return sendJson(res, 400, { ok: false, error: "Invalid image data." });
    const mime = m[1].toLowerCase();
    const ext = ADVERT_EXT[mime];
    if (!ext) return sendJson(res, 400, { ok: false, error: "Use PNG, JPG, WEBP or GIF." });
    let buf;
    try { buf = Buffer.from(m[2], "base64"); } catch { return sendJson(res, 400, { ok: false, error: "Bad image encoding." }); }
    if (buf.length > ADVERT_MAX_BYTES) return sendJson(res, 400, { ok: false, error: "Image over 3MB." });
    const id = "ad" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const file = id + ext;
    try { fs.writeFileSync(path.join(ADVERTS_DIR, file), buf); }
    catch { return sendJson(res, 500, { ok: false, error: "Could not save image." }); }
    const name = sanitize(body.name, 60).trim() || "Advert";
    const show = sanitize(body.show, 60).trim();   // "" = all shows
    adverts.items.push({ id, file, name, show, ts: Date.now() });
    saveAdverts();
    return sendJson(res, 200, { ok: true, adverts: adverts.items.map(advertView) });
  }

  /* ---- delete an advert (manager only) ---- */
  if (p === "/api/promos/delete" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u || !canManage(u.role)) return sendJson(res, 403, { ok: false, error: "Not authorized." });
    const adv = adverts.items.find((a) => a.id === String(body.id));
    if (adv) {
      try { fs.unlinkSync(path.join(ADVERTS_DIR, adv.file)); } catch (_) {}
      adverts.items = adverts.items.filter((a) => a.id !== adv.id);
      saveAdverts();
    }
    return sendJson(res, 200, { ok: true, adverts: adverts.items.map(advertView) });
  }

  /* ---- serve an uploaded advert image from the Disk ---- */
  if (p.startsWith("/promos/") && req.method === "GET") {
    const name = path.basename(decodeURIComponent(p.slice("/promos/".length)));
    const fp = path.join(ADVERTS_DIR, name);
    if (!fp.startsWith(ADVERTS_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
    return fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      const ext = path.extname(fp).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "public, max-age=3600" });
      res.end(data);
    });
  }

  /* ---- login ---- */
  if (p === "/api/login" && req.method === "POST") {
    const body = await readBody(req);
    const ident = body && String(body.identifier || "").trim();
    const pass = body && String(body.password || "");
    if (!ident || !pass) return sendJson(res, 400, { ok: false, error: "Enter your login and password." });
    const u = db.users.find((x) =>
      (x.login && x.login.toLowerCase() === ident.toLowerCase()) ||
      (x.email && x.email.toLowerCase() === ident.toLowerCase())
    );
    if (!u || u.password !== pass) return sendJson(res, 401, { ok: false, error: "Wrong login or password." });
    const token = newToken(u.id);
    return sendJson(res, 200, { ok: true, token, user: publicUser(u), access: accessLabel(u.role) });
  }

  /* ---- who am I (restore session) ---- */
  if (p === "/api/me" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u) return sendJson(res, 401, { ok: false });
    return sendJson(res, 200, { ok: true, user: publicUser(u), access: accessLabel(u.role) });
  }

  /* ---- save NEWS (everyone logged in can) ---- */
  if (p === "/api/news" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u) return sendJson(res, 401, { ok: false, error: "Not logged in." });
    content.news = cleanNews(body.news, content.news);
    saveJson(CONTENT_FILE, content);
    broadcast({ type: "content-updated" });
    return sendJson(res, 200, { ok: true, news: content.news });
  }

  /* ---- save SHOWS (manager only: god/elevated) ---- */
  if (p === "/api/shows" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u || !canManage(u.role)) return sendJson(res, 403, { ok: false, error: "Not authorized." });
    content.showsWeekday = cleanShows(body.showsWeekday, content.showsWeekday);
    content.showsSaturday = cleanShows(body.showsSaturday, content.showsSaturday);
    content.showsSunday = cleanShows(body.showsSunday, content.showsSunday);
    saveJson(CONTENT_FILE, content);
    broadcast({ type: "content-updated" });
    return sendJson(res, 200, {
      ok: true,
      showsWeekday: content.showsWeekday,
      showsSaturday: content.showsSaturday,
      showsSunday: content.showsSunday,
    });
  }

  /* ---- list members (ANY logged-in user; emails hidden) ---- */
  if (p === "/api/members" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u) return sendJson(res, 401, { ok: false, error: "Not logged in." });
    return sendJson(res, 200, { ok: true, members: db.users.map(memberView), meId: u.id, meRole: u.role, canManage: canManage(u.role) });
  }

  /* ---- enrol a new presenter email (manager only) ---- */
  if (p === "/api/members/enrol" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u || !canManage(u.role)) return sendJson(res, 403, { ok: false, error: "Not authorized." });
    const email = sanitize(body.email, 80).trim().toLowerCase();
    const name = sanitize(body.name, 40).trim() || email.split("@")[0];
    const title = sanitize(body.title, 40).trim() || "Presenter";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { ok: false, error: "Enter a valid email." });
    if (db.users.some((x) => x.email && x.email.toLowerCase() === email)) return sendJson(res, 409, { ok: false, error: "That email is already enrolled." });
    db.users.push({
      id: "u" + Date.now().toString(36), login: "", email, name, title,
      role: "presenter", password: PRESENTER_PASSWORD_DEFAULT,
    });
    saveJson(USERS_FILE, db);
    return sendJson(res, 200, { ok: true, members: db.users.map(memberView), meId: u.id, meRole: u.role, canManage: canManage(u.role) });
  }

  /* ---- "revoke" = demote to base-level presenter (NOT delete) ---- */
  if (p === "/api/members/revoke" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u || !canManage(u.role)) return sendJson(res, 403, { ok: false, error: "Not authorized." });
    const target = db.users.find((x) => x.id === String(body.id));
    if (!target) return sendJson(res, 404, { ok: false, error: "Not found." });
    if (!canActOn(u, target)) return sendJson(res, 403, { ok: false, error: "You can't manage this account." });
    target.role = "presenter";   // keep the account; drop to base presenter
    saveJson(USERS_FILE, db);
    return sendJson(res, 200, { ok: true, members: db.users.map(memberView), meId: u.id, meRole: u.role, canManage: canManage(u.role) });
  }

  /* ---- DELETE a member entirely ---- */
  if (p === "/api/members/delete" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u || !canManage(u.role)) return sendJson(res, 403, { ok: false, error: "Not authorized." });
    const target = db.users.find((x) => x.id === String(body.id));
    if (!target) return sendJson(res, 404, { ok: false, error: "Not found." });
    if (target.id === u.id) return sendJson(res, 403, { ok: false, error: "You can't delete your own account." });
    if (target.role === "god") return sendJson(res, 403, { ok: false, error: "The God Admin account can't be deleted." });
    if (!canActOn(u, target)) return sendJson(res, 403, { ok: false, error: "You can't manage this account." });
    db.users = db.users.filter((x) => x.id !== target.id);
    saveJson(USERS_FILE, db);
    return sendJson(res, 200, { ok: true, members: db.users.map(memberView), meId: u.id, meRole: u.role, canManage: canManage(u.role) });
  }

  /* ---- grant / remove elevated access (manager only) ---- */
  if (p === "/api/members/setrole" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u || !canManage(u.role)) return sendJson(res, 403, { ok: false, error: "Not authorized." });
    const target = db.users.find((x) => x.id === String(body.id));
    if (!target) return sendJson(res, 404, { ok: false, error: "Not found." });
    if (target.role === "god") return sendJson(res, 403, { ok: false, error: "The God Admin can't be changed." });
    if (!canActOn(u, target)) return sendJson(res, 403, { ok: false, error: "You can't manage this account." });
    const want = String(body.role);
    if (want !== "elevated" && want !== "presenter") return sendJson(res, 400, { ok: false, error: "Bad role." });
    target.role = want;
    saveJson(USERS_FILE, db);
    return sendJson(res, 200, { ok: true, members: db.users.map(memberView), meId: u.id, meRole: u.role, canManage: canManage(u.role) });
  }

  /* ---- edit a member's title (manager only) ---- */
  if (p === "/api/members/title" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u || !canManage(u.role)) return sendJson(res, 403, { ok: false, error: "Not authorized." });
    const target = db.users.find((x) => x.id === String(body.id));
    if (!target) return sendJson(res, 404, { ok: false, error: "Not found." });
    if (!canActOn(u, target)) return sendJson(res, 403, { ok: false, error: "You can't manage this account." });
    target.title = sanitize(body.title, 40).trim() || target.title;
    saveJson(USERS_FILE, db);
    return sendJson(res, 200, { ok: true, members: db.users.map(memberView), meId: u.id, meRole: u.role, canManage: canManage(u.role) });
  }

  /* ---- change my own name (not the two protected logins' identity rules) ---- */
  if (p === "/api/me/name" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u) return sendJson(res, 401, { ok: false });
    const name = sanitize(body.name, 40).trim();
    if (name) { u.name = name; saveJson(USERS_FILE, db); }
    return sendJson(res, 200, { ok: true, user: publicUser(u) });
  }

  /* ---- change my own password ---- */
  if (p === "/api/me/password" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u) return sendJson(res, 401, { ok: false });
    const cur = String(body.current || ""), next = String(body.next || "");
    if (u.password !== cur) return sendJson(res, 400, { ok: false, error: "Current password is wrong." });
    if (next.length < 4) return sendJson(res, 400, { ok: false, error: "New password too short." });
    u.password = next; saveJson(USERS_FILE, db);
    return sendJson(res, 200, { ok: true });
  }

  /* ---- friendly route: /portal -> the presenter/admin page ---- */
  let reqPath = p;
  if (reqPath === "/portal" || reqPath === "/portal/") reqPath = "/presenter.html";
  // On the management subdomain, the root path is the portal itself.
  if (portalHost && (reqPath === "/" || reqPath === "/index.html")) reqPath = "/presenter.html";

  /* ---- static files ---- */
  let filePath = path.normalize(path.join(SITE_DIR, decodeURIComponent(reqPath === "/" ? "/index.html" : reqPath)));
  if (!filePath.startsWith(SITE_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache", "Expires": "0",
    });
    res.end(data);
  });
});

/* ================= WebSocket chat ================= */
const wss = new WebSocketServer({ server: httpServer });
function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
}
/* ---------- Call-in (WebRTC signalling) ----------
   Audio itself flows peer-to-peer between the listener and the presenter's
   browser. The server only relays the small setup messages (offer/answer/ICE)
   and keeps the waiting queue. */
let nextWsId = 1;
function sendTo(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function pushCallQueue() {
  const queue = [];
  for (const c of wss.clients) {
    if (c.readyState === 1 && c.callState === "waiting") queue.push({ id: c.id, name: c.callName, since: c.callSince });
  }
  queue.sort((a, b) => a.since - b.since);
  for (const c of wss.clients) if (c.readyState === 1 && c.staff) sendTo(c, { type: "call-queue", queue });
}
function endCall(ws, notify) {
  const peer = ws.peer;
  ws.peer = null; ws.callState = null;
  if (peer) {
    peer.peer = null; peer.callState = null;
    if (notify) sendTo(peer, { type: "call-ended" });
  }
}

wss.on("connection", (ws) => {
  ws.id = String(nextWsId++);
  ws.staff = null; ws.peer = null; ws.callState = null;
  broadcast({ type: "presence", count: wss.clients.size });
  // Send the recent conversation so the newcomer sees what came before.
  pruneChat();
  ws.send(JSON.stringify({ type: "history", messages: chatLog.messages }));
  ws.send(JSON.stringify({ type: "system", text: "You joined the live chat." }));
  ws.on("message", (raw) => {
    let d; try { d = JSON.parse(raw.toString()); } catch { return; }

    // Presenter/manager action: clear the chat history for everyone.
    if (d.type === "clear") {
      const u = d.token ? userFromToken(String(d.token)) : null;
      if (!u) return;   // any logged-in staff member (presenters included) may clear
      chatLog.messages = [];
      saveJson(CHAT_FILE, chatLog);
      broadcast({ type: "cleared", by: sanitize(u.name, 40) });
      return;
    }

    /* ---- call-in signalling ---- */
    if (d.type === "staff-hello") {
      const u = d.token ? userFromToken(String(d.token)) : null;
      if (!u) return;
      ws.staff = { name: u.name, role: u.role };
      sendTo(ws, { type: "staff-ok" });
      pushCallQueue();
      return;
    }
    if (d.type === "call-request") {
      if (ws.staff || ws.callState) return;
      if (Date.now() - (ws.lastCallReq || 0) < 3000) return;   // tiny rate limit
      ws.lastCallReq = Date.now();
      ws.callState = "waiting";
      ws.callName = sanitize(d.name, 24) || "Caller";
      ws.callSince = Date.now();
      sendTo(ws, { type: "call-status", state: "waiting" });
      pushCallQueue();
      return;
    }
    if (d.type === "call-cancel") {
      if (ws.callState === "waiting") { ws.callState = null; sendTo(ws, { type: "call-status", state: "idle" }); pushCallQueue(); }
      return;
    }
    if (d.type === "call-accept") {
      if (!ws.staff || ws.peer) return;                       // staff only, one call at a time
      let target = null;
      for (const c of wss.clients) if (c.id === String(d.id) && c.callState === "waiting" && c.readyState === 1) target = c;
      if (!target) { sendTo(ws, { type: "call-gone" }); pushCallQueue(); return; }
      ws.peer = target; target.peer = ws;
      ws.callState = target.callState = "live";
      sendTo(target, { type: "call-accepted", host: ws.staff.name });
      sendTo(ws, { type: "call-live", id: target.id, name: target.callName });
      pushCallQueue();
      return;
    }
    if (d.type === "rtc") {
      if (!ws.peer) return;
      const data = d.data;
      if (!data || typeof data !== "object" || JSON.stringify(data).length > 20000) return;
      sendTo(ws.peer, { type: "rtc", data });
      return;
    }
    if (d.type === "call-end") {
      if (ws.callState === "live") endCall(ws, true);
      else if (ws.callState === "waiting") { ws.callState = null; pushCallQueue(); }
      sendTo(ws, { type: "call-ended" });
      return;
    }

    if (d.type !== "chat") return;
    if (ws.staff) return;   // presenter sockets are read-only: no typed replies
    const name = sanitize(d.name, 24) || "Guest";
    const text = sanitize(d.text, 500);
    if (!text) return;
    const msg = { type: "chat", name, text, ts: Date.now() };
    pushChat({ name, text, ts: msg.ts });   // persist (without the "type" field)
    broadcast(msg);
  });
  ws.on("close", () => {
    const wasWaiting = ws.callState === "waiting";
    if (ws.peer) endCall(ws, true);
    ws.callState = null;
    if (wasWaiting) pushCallQueue();
    broadcast({ type: "presence", count: wss.clients.size });
  });
});

// Every minute, drop expired messages and refresh everyone's chat view.
setInterval(() => {
  if (pruneChat()) {
    saveChatSoon();
    broadcast({ type: "history", messages: chatLog.messages });
  }
}, 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`\n  Ramatlabama FM server running: http://localhost:${PORT}`);
  console.log(`  God:  GOD_Admin / admin2026`);
  console.log(`  CEO:  CEO_Kutlwano_Nqaba / admin2026`);
  console.log(`  New presenters: <email> / ${PRESENTER_PASSWORD_DEFAULT}\n`);
});
