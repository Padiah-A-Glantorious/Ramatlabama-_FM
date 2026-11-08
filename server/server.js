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

/* ================= LIVE DISPLAY (scripture / text / image) ================= */
// What presenters "render" over the listeners' chat panel. Held in memory only.
const BIBLE_TRANSLATIONS = {
  kjv: "King James Version", web: "World English Bible", webbe: "World English Bible (British)",
  bbe: "Bible in Basic English", "oeb-us": "Open English Bible (US)",
};
const MAX_DISPLAY_VERSES = 60;
const MAX_IMAGE_CHARS = 2.5 * 1024 * 1024;
let liveDisplay = null;
function cleanDisplay(d) {
  if (!d || typeof d !== "object") return null;
  if (d.kind === "scripture") {
    const verses = (Array.isArray(d.verses) ? d.verses : []).slice(0, MAX_DISPLAY_VERSES)
      .map((v) => ({ n: Number(v && v.n) || 0, text: sanitize(v && v.text, 1000) })).filter((v) => v.text);
    if (!verses.length) return null;
    return { kind: "scripture", reference: sanitize(d.reference, 100), translation: sanitize(d.translation, 60), verses };
  }
  if (d.kind === "text") {
    const body = String(d.body == null ? "" : d.body).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, 3000);
    if (!body.trim()) return null;
    return { kind: "text", title: sanitize(d.title, 100), body };
  }
  if (d.kind === "video") {
    const id = String(d.videoId || "");
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;          // a YouTube video id is exactly 11 chars
    const start = Math.max(0, Math.min(86400, parseInt(d.start, 10) || 0));
    return { kind: "video", videoId: id, start, muted: d.muted !== false, caption: sanitize(d.caption, 140) };
  }
  if (d.kind === "image") {
    const url = String(d.image || "");
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(url) || url.length > MAX_IMAGE_CHARS) return null;
    return { kind: "image", image: url, caption: sanitize(d.caption, 140) };
  }
  return null;
}

/* ================= FILL-IN MUSIC (plays on the site while nobody is live) ================= */
// The God Admin uploads songs tagged with a genre and picks a genre per weekday
// (Sunday defaults to Gospel). Listeners' players play these while the Famcast
// stream is off air, and switch to the live show as soon as a presenter goes live.
const MUSIC_FILE = path.join(DATA_DIR, "music.json");
const MUSIC_DIR = path.join(DATA_DIR, "music");
try { fs.mkdirSync(MUSIC_DIR, { recursive: true }); } catch (_) {}
const MUSIC_MAX_BYTES = 15 * 1024 * 1024;                                   // per song
const MUSIC_MAX_TOTAL = (parseInt(process.env.MUSIC_MAX_MB, 10) || 700) * 1024 * 1024;   // whole library
const MUSIC_MAX_TRACKS = 400;
const WEEK_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DEFAULT_GENRES = ["Gospel", "Afro-pop", "Amapiano", "House", "Jazz", "R&B", "Traditional", "Kwaito", "Hip-hop", "Reggae"];
const AUDIO_MIME = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg" };
// Default time slots: Sunday morning Gospel, Jazz in the day, Gospel in the evening
// up to the Spiritual Awakening show. Outside a slot the day's default genre applies.
const DEFAULT_SLOTS = {
  sun: [
    { start: "05:00", end: "12:00", genre: "Gospel" },
    { start: "12:00", end: "18:00", genre: "Jazz" },
    { start: "18:00", end: "22:00", genre: "Gospel" },
  ],
};
let music = loadJson(MUSIC_FILE, { enabled: true, tracks: [], links: [], schedule: { sun: "Gospel" }, slots: DEFAULT_SLOTS });
if (!Array.isArray(music.tracks)) music.tracks = [];
if (!Array.isArray(music.links)) music.links = [];
if (!music.schedule || typeof music.schedule !== "object") music.schedule = { sun: "Gospel" };
if (!music.slots || typeof music.slots !== "object") music.slots = JSON.parse(JSON.stringify(DEFAULT_SLOTS));
if (typeof music.enabled !== "boolean") music.enabled = true;
const MUSIC_MAX_LINKS = 200;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Self-heal: drop records whose audio file is missing.
music.tracks = music.tracks.filter((t) => { try { return fs.existsSync(path.join(MUSIC_DIR, t.file)); } catch (_) { return false; } });
function saveMusic() { try { saveJson(MUSIC_FILE, music); } catch (_) {} }
function cleanGenre(g) { return sanitize(g, 30).trim(); }
function stationDay() {   // weekday in South Africa, whatever timezone the server runs in
  try {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Johannesburg", weekday: "short" })
      .format(new Date()).toLowerCase().slice(0, 3);
    if (WEEK_DAYS.includes(wd)) return wd;
  } catch (_) {}
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date().getDay()];
}
function stationTime() {   // "HH:MM" in South Africa
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Johannesburg", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    const h = (parts.find((p) => p.type === "hour") || {}).value, m = (parts.find((p) => p.type === "minute") || {}).value;
    if (h && m) return h.padStart(2, "0") + ":" + m.padStart(2, "0");
  } catch (_) {}
  const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function inSlot(t, s) {   // end <= start means the slot runs past midnight (00:00 = until midnight)
  return s.start < s.end ? t >= s.start && t < s.end : t >= s.start || t < s.end;
}
function currentGenre() {
  const day = stationDay(), time = stationTime();
  const slot = (music.slots[day] || []).find((s) => inSlot(time, s));
  const genre = slot ? slot.genre : (music.schedule[day] || "");     // "" = any genre
  return { day, time, genre, slot: slot || null };
}
function trackView(t) { return { id: t.id, title: t.title, genre: t.genre, size: t.size || 0, url: "/music/" + encodeURIComponent(t.file) }; }
function linkView(l) { return { id: l.id, kind: l.kind, ytId: l.ytId, title: l.title, genre: l.genre }; }
const sameGenre = (a, g) => !g || String(a).toLowerCase() === String(g).toLowerCase();
function musicNow() {
  const c = currentGenre();
  return {
    enabled: music.enabled, day: c.day, time: c.time, genre: c.genre || "All music",
    slot: c.day + "|" + (c.slot ? c.slot.start + "-" + c.slot.end : "day") + "|" + c.genre,
    tracks: music.enabled ? music.tracks.filter((t) => sameGenre(t.genre, c.genre)).map(trackView) : [],
    links: music.enabled ? music.links.filter((l) => sameGenre(l.genre, c.genre)).map(linkView) : [],
  };
}
function musicAdminView() {
  const seen = new Map();
  const slotGenres = Object.values(music.slots).flat().map((s) => s && s.genre);
  [...DEFAULT_GENRES, ...music.tracks.map((t) => t.genre), ...music.links.map((l) => l.genre), ...Object.values(music.schedule), ...slotGenres]
    .filter(Boolean).forEach((g) => { if (!seen.has(g.toLowerCase())) seen.set(g.toLowerCase(), g); });
  const c = currentGenre();
  return {
    ok: true, enabled: music.enabled, schedule: music.schedule, slots: music.slots,
    today: c.day, time: c.time, genreNow: c.genre,
    genres: [...seen.values()], tracks: music.tracks.map(trackView), links: music.links.map(linkView),
    usedBytes: music.tracks.reduce((n, t) => n + (t.size || 0), 0), maxBytes: MUSIC_MAX_TOTAL,
    onAir, onAirKnown,
  };
}
// Accept youtube.com/watch, youtu.be, shorts, live, embed and playlist links.
// A link that carries list= is treated as the whole playlist.
function parseYouTubeLink(raw) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); } catch (_) { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, "");
  if (!["youtube.com", "youtu.be", "youtube-nocookie.com"].includes(host)) return null;
  let id = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (u.pathname === "/watch") id = u.searchParams.get("v");
  else { const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/); if (m) id = m[1]; }
  const video = id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  const list = u.searchParams.get("list");
  // YouTube Mixes (RD…) are made per viewer and can't be played as a playlist;
  // WL / LL / LM are someone's private Watch later / Liked lists.
  const special = list && (/^RD/.test(list) || /^(WL|LL|LM)$/.test(list));
  if (list && !special && /^[A-Za-z0-9_-]{10,80}$/.test(list)) return { kind: "playlist", ytId: list, videoId: video };
  if (video) return { kind: "video", ytId: video, fromMix: !!special };
  if (special) return { kind: "mix" };
  return null;
}
async function youTubeInfo(link) {   // title, and an early warning if it can't be played
  const page = link.kind === "playlist" ? "https://www.youtube.com/playlist?list=" + link.ytId : "https://www.youtube.com/watch?v=" + link.ytId;
  try {
    const r = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(page), { signal: AbortSignal.timeout(8000) });
    if (r.status === 401 || r.status === 403) return { error: "The owner doesn't allow this to be played on other websites." };
    if (r.status === 400 || r.status === 404) return { error: "YouTube can't find that. It may be private or deleted." };
    if (!r.ok) return {};
    const j = await r.json();
    return { title: sanitize(j.title, 100) };
  } catch (_) { return {}; }   // YouTube unreachable: accept it anyway
}
function cleanSlots(input) {
  const out = {};
  WEEK_DAYS.forEach((d) => {
    const arr = Array.isArray(input && input[d]) ? input[d] : [];
    const clean = arr.slice(0, 12).map((s) => ({
      start: String(s && s.start || ""), end: String(s && s.end || ""), genre: cleanGenre(s && s.genre),
    })).filter((s) => TIME_RE.test(s.start) && TIME_RE.test(s.end) && s.start !== s.end && s.genre);
    if (clean.length) out[d] = clean.sort((a, b) => (a.start < b.start ? -1 : 1));
  });
  return out;
}
function sniffAudio(buf) {   // trust the bytes, not the file name
  if (buf.length < 12) return null;
  if (buf.slice(0, 3).toString("latin1") === "ID3") return ".mp3";
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return ".mp3";
  if (buf.slice(4, 8).toString("latin1") === "ftyp") return ".m4a";
  if (buf.slice(0, 4).toString("latin1") === "OggS") return ".ogg";
  return null;
}
function readRaw(req, max) {   // raw request body as a Buffer, or null if too big
  return new Promise((resolve) => {
    const chunks = []; let n = 0, tooBig = false;
    req.on("data", (c) => { n += c.length; if (n > max) tooBig = true; else chunks.push(c); });
    req.on("end", () => resolve(tooBig ? null : Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

/* ---- Is a presenter live? Ask the Famcast (Icecast) server every 10 seconds ---- */
const STREAM_STATUS_URL = process.env.STREAM_STATUS_URL || "https://sv2.famcast.co.za:8845/status-json.xsl";
const STREAM_MOUNT = process.env.STREAM_MOUNT || "/stream";
let onAir = false, onAirKnown = false;
async function pollOnAir() {
  try {
    const r = await fetch(STREAM_STATUS_URL, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "RamatlabamaFM-site" } });
    const j = await r.json();
    const src = j && j.icestats && j.icestats.source;
    const list = Array.isArray(src) ? src : src ? [src] : [];
    const live = list.some((s) => !s || !s.listenurl || String(s.listenurl).endsWith(STREAM_MOUNT));
    if (live !== onAir || !onAirKnown) {
      onAir = live; onAirKnown = true;
      broadcast({ type: "onair", live: onAir });
    }
  } catch (_) { /* network hiccup: keep the last known state */ }
}

// Render / Stop, shared by the WebSocket and the HTTP API. Returns { ok, error }.
function applyDisplay(u, action, display) {
  if (!u) return { ok: false, error: "Not logged in. Log in again." };
  if (!canRender(u)) return { ok: false, error: "You don't have permission to render. Ask the God Admin." };
  if (action === "clear") liveDisplay = null;
  else {
    const clean = cleanDisplay(display);
    if (!clean) return { ok: false, error: "That couldn't be displayed." };
    liveDisplay = { ...clean, ts: Date.now(), by: sanitize(u.name, 40) };
  }
  broadcast({ type: "display", display: liveDisplay });
  return { ok: true };
}

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

// Session tokens -> { id, ts }. Saved to the data disk so a deploy/restart doesn't
// silently log out presenters mid-show. Tokens expire after 30 days.
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const sessions = new Map();
(() => {
  const saved = loadJson(SESSIONS_FILE, { tokens: {} });
  const now = Date.now();
  Object.entries((saved && saved.tokens) || {}).forEach(([t, s]) => {
    if (s && s.id && now - (s.ts || 0) < SESSION_TTL_MS) sessions.set(t, { id: s.id, ts: s.ts });
  });
})();
let sessionsSaveTimer = null;
function saveSessionsSoon() {
  if (sessionsSaveTimer) return;
  sessionsSaveTimer = setTimeout(() => {
    sessionsSaveTimer = null;
    try { saveJson(SESSIONS_FILE, { tokens: Object.fromEntries(sessions) }); } catch (_) {}
  }, 1000);
}
function newToken(userId) {
  const t = crypto.randomBytes(24).toString("hex");
  sessions.set(t, { id: userId, ts: Date.now() });
  saveSessionsSoon();
  return t;
}
function userFromToken(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.ts > SESSION_TTL_MS) { sessions.delete(token); saveSessionsSoon(); return null; }
  return db.users.find((u) => u.id === s.id) || null;
}
function publicUser(u) {   // for the logged-in user's own identity
  return { id: u.id, login: u.login, email: u.email, name: u.name, title: u.title, role: u.role, canRender: canRender(u) };
}
function memberView(u) {   // for the Members list — NO email shown
  return { id: u.id, name: u.name, title: u.title, role: u.role, canRender: canRender(u) };
}
function accessLabel(role) {
  return role === "god" ? "God Admin" : role === "elevated" ? "Elevated Access" : "Presenter";
}
function canManage(role) { return role === "god" || role === "elevated"; }
// Rendering scripture/text/pictures to listeners: God Admin always, others only if God grants it.
function canRender(u) { return !!u && (u.role === "god" || u.canRender === true); }

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

  /* ---- public: what is rendered right now (listeners re-check this when they wake) ---- */
  if (p === "/api/display" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, display: liveDisplay });
  }
  /* ---- staff: Render / Stop over plain HTTP (works even if the live socket dropped) ---- */
  if (p === "/api/display" && req.method === "POST") {
    const body = await readBodyLarge(req, 4 * 1024 * 1024);
    if (body === null) return sendJson(res, 400, { ok: false, error: "Too large." });
    const r = applyDisplay(authUser(body), body.action === "clear" ? "clear" : "set", body.display);
    return sendJson(res, r.ok ? 200 : 403, { ...r, display: liveDisplay });
  }

  /* ---- public: ICE servers for call-in (STUN + optional TURN from env) ---- */
  if (p === "/api/ice" && req.method === "GET") {
    return sendJson(res, 200, { iceServers: ICE_SERVERS });
  }

  /* ---- staff: look up a Bible passage (proxied to bible-api.com) ---- */
  if (p === "/api/bible" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u) return sendJson(res, 401, { ok: false, error: "Not logged in." });
    if (!canRender(u)) return sendJson(res, 403, { ok: false, error: "You don't have permission to render. Ask the God Admin." });
    const ref = sanitize(body.ref, 80).trim();
    const tr = BIBLE_TRANSLATIONS[String(body.translation)] ? String(body.translation) : "kjv";
    if (!ref) return sendJson(res, 400, { ok: false, error: "Type a passage, e.g. John 3:16-17." });
    try {
      const r = await fetch("https://bible-api.com/" + encodeURIComponent(ref) + "?translation=" + tr, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) {
        // Some translations (e.g. Open English) are unfinished. If KJV has it, say so.
        if (tr !== "kjv") {
          try {
            const k = await fetch("https://bible-api.com/" + encodeURIComponent(ref) + "?translation=kjv", { signal: AbortSignal.timeout(8000) });
            if (k.ok) return sendJson(res, 404, { ok: false, error: BIBLE_TRANSLATIONS[tr] + " doesn't include " + ref + ". Choose KJV or WEB instead." });
          } catch (_) {}
        }
        return sendJson(res, 404, { ok: false, error: "Passage not found. Check the spelling, e.g. Psalm 23 or John 3:16-17." });
      }
      const j = await r.json();
      const verses = (Array.isArray(j.verses) ? j.verses : []).slice(0, MAX_DISPLAY_VERSES).map((v) => ({
        n: Number(v.verse) || 0, text: sanitize(String(v.text || "").replace(/\s+/g, " ").trim(), 1000),
      }));
      if (!verses.length) return sendJson(res, 404, { ok: false, error: "Passage not found." });
      return sendJson(res, 200, { ok: true, reference: sanitize(j.reference, 100), translation: BIBLE_TRANSLATIONS[tr], verses });
    } catch (_) {
      return sendJson(res, 502, { ok: false, error: "Couldn't reach the Bible service. Try again, or use Custom text." });
    }
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

  /* ---- public: is anyone live, and what fill-in music is playing today ---- */
  if (p === "/api/music/now" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, live: onAir, known: onAirKnown, ...musicNow() });
  }

  /* ---- God Admin: fill-in music library, schedule and settings ---- */
  if (p === "/api/music/admin" && req.method === "POST") {
    const u = authUser(await readBody(req));
    if (!u || u.role !== "god") return sendJson(res, 403, { ok: false, error: "Only the God Admin can manage music." });
    return sendJson(res, 200, musicAdminView());
  }
  if (p === "/api/music/settings" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u || u.role !== "god") return sendJson(res, 403, { ok: false, error: "Only the God Admin can manage music." });
    if (typeof body.enabled === "boolean") music.enabled = body.enabled;
    if (body.schedule && typeof body.schedule === "object") {
      const next = {};
      WEEK_DAYS.forEach((d) => { const g = cleanGenre(body.schedule[d]); if (g) next[d] = g; });
      music.schedule = next;
    }
    if (body.slots && typeof body.slots === "object") music.slots = cleanSlots(body.slots);
    saveMusic();
    broadcast({ type: "music-changed" });   // listeners re-check what should play
    return sendJson(res, 200, musicAdminView());
  }
  if (p === "/api/music/link" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u || u.role !== "god") return sendJson(res, 403, { ok: false, error: "Only the God Admin can manage music." });
    if (music.links.length >= MUSIC_MAX_LINKS) return sendJson(res, 400, { ok: false, error: "Link limit reached. Delete some first." });
    let link = parseYouTubeLink(sanitize(body.url, 400).trim());
    if (!link) return sendJson(res, 400, { ok: false, error: "That isn't a YouTube video or playlist link." });
    if (link.kind === "mix") return sendJson(res, 400, { ok: false, error: "That's a YouTube Mix or a private list (Liked / Watch later), which can't be shared. Open a normal playlist and copy its link, or save the songs into your own public playlist." });
    const genre = cleanGenre(body.genre);
    if (!genre) return sendJson(res, 400, { ok: false, error: "Choose a genre for the link." });
    let info = await youTubeInfo(link);
    let note = link.fromMix ? "That was a YouTube Mix, so only the song in the link was added. For many songs, use a normal playlist." : "";
    // A private/unlisted playlist link that also names a song: fall back to that song.
    if (info.error && link.kind === "playlist" && link.videoId) {
      const asVideo = { kind: "video", ytId: link.videoId };
      const vInfo = await youTubeInfo(asVideo);
      if (!vInfo.error) { link = asVideo; info = vInfo; note = "That playlist is private, so only the song in the link was added. Make the playlist Public (or Unlisted) to add all of it."; }
    }
    if (info.error) {
      const why = link.kind === "playlist"
        ? "YouTube can't open that playlist. Make sure it's set to Public or Unlisted (not Private), then copy the link again."
        : info.error;
      return sendJson(res, 400, { ok: false, error: why });
    }
    if (music.links.some((l) => l.ytId === link.ytId && sameGenre(l.genre, genre)))
      return sendJson(res, 400, { ok: false, error: "That link is already in " + genre + "." });
    const title = sanitize(body.title, 100).trim() || info.title || (link.kind === "playlist" ? "YouTube playlist" : "YouTube video");
    music.links.push({ id: "yt" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind: link.kind, ytId: link.ytId, title, genre, ts: Date.now() });
    saveMusic();
    broadcast({ type: "music-changed" });
    return sendJson(res, 200, { ...musicAdminView(), note });
  }
  if (p === "/api/music/link/delete" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u || u.role !== "god") return sendJson(res, 403, { ok: false, error: "Only the God Admin can manage music." });
    music.links = music.links.filter((l) => l.id !== String(body.id));
    saveMusic();
    return sendJson(res, 200, musicAdminView());
  }
  if (p === "/api/music/upload" && req.method === "POST") {
    // Raw file body; token/genre/title travel in headers so nothing is read before auth.
    const u = userFromToken(String(req.headers["x-token"] || ""));
    if (!u || u.role !== "god") { req.resume(); return sendJson(res, 403, { ok: false, error: "Only the God Admin can upload music." }); }
    if (music.tracks.length >= MUSIC_MAX_TRACKS) { req.resume(); return sendJson(res, 400, { ok: false, error: "Song limit reached. Delete some first." }); }
    let genre = "", title = "";
    try { genre = cleanGenre(decodeURIComponent(String(req.headers["x-genre"] || ""))); } catch (_) {}
    try { title = sanitize(decodeURIComponent(String(req.headers["x-title"] || "")), 80).trim(); } catch (_) {}
    if (!genre) { req.resume(); return sendJson(res, 400, { ok: false, error: "Choose a genre for the song." }); }
    const buf = await readRaw(req, MUSIC_MAX_BYTES);
    if (!buf) return sendJson(res, 413, { ok: false, error: "Song is too big (max 15 MB)." });
    const used = music.tracks.reduce((n, t) => n + (t.size || 0), 0);
    if (used + buf.length > MUSIC_MAX_TOTAL) return sendJson(res, 400, { ok: false, error: "Music storage is full. Delete some songs first." });
    const ext = sniffAudio(buf);
    if (!ext) return sendJson(res, 400, { ok: false, error: "Use MP3, M4A or OGG audio files." });
    const id = "mu" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const file = id + ext;
    try { fs.writeFileSync(path.join(MUSIC_DIR, file), buf); }
    catch (_) { return sendJson(res, 500, { ok: false, error: "Could not save the song." }); }
    music.tracks.push({ id, file, title: title || "Untitled", genre, size: buf.length, ts: Date.now() });
    saveMusic();
    return sendJson(res, 200, musicAdminView());
  }
  if (p === "/api/music/delete" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u || u.role !== "god") return sendJson(res, 403, { ok: false, error: "Only the God Admin can manage music." });
    const t = music.tracks.find((x) => x.id === String(body.id));
    if (t) {
      try { fs.unlinkSync(path.join(MUSIC_DIR, t.file)); } catch (_) {}
      music.tracks = music.tracks.filter((x) => x.id !== t.id);
      saveMusic();
    }
    return sendJson(res, 200, musicAdminView());
  }

  /* ---- serve a song (with Range support: phones need it to play and seek audio) ---- */
  if (p.startsWith("/music/") && (req.method === "GET" || req.method === "HEAD")) {
    let name = "";
    try { name = path.basename(decodeURIComponent(p.slice("/music/".length))); } catch (_) {}
    const fp = path.join(MUSIC_DIR, name);
    if (!name || !fp.startsWith(MUSIC_DIR + path.sep)) { res.writeHead(403); return res.end("Forbidden"); }
    return fs.stat(fp, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end("Not found"); }
      const headers = {
        "Content-Type": AUDIO_MIME[path.extname(name).toLowerCase()] || "application/octet-stream",
        "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400",
      };
      const range = req.headers.range;
      let start = 0, end = st.size - 1, code = 200;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (!m || (m[1] === "" && m[2] === "")) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); return res.end(); }
        if (m[1] === "") { start = Math.max(0, st.size - parseInt(m[2], 10)); }
        else { start = parseInt(m[1], 10); if (m[2] !== "") end = Math.min(parseInt(m[2], 10), st.size - 1); }
        if (start > end || start >= st.size) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); return res.end(); }
        code = 206; headers["Content-Range"] = "bytes " + start + "-" + end + "/" + st.size;
      }
      headers["Content-Length"] = end - start + 1;
      res.writeHead(code, headers);
      if (req.method === "HEAD") return res.end();
      const rs = fs.createReadStream(fp, { start, end });
      rs.on("error", () => res.destroy());
      rs.pipe(res);
    });
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

  /* ---- grant / revoke a member's permission to render (God Admin only) ---- */
  if (p === "/api/members/render" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u || u.role !== "god") return sendJson(res, 403, { ok: false, error: "Only the God Admin can do this." });
    const target = db.users.find((x) => x.id === String(body.id));
    if (!target) return sendJson(res, 404, { ok: false, error: "Not found." });
    if (target.role === "god") return sendJson(res, 400, { ok: false, error: "The God Admin can always render." });
    target.canRender = body.allow === true;
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
// Ping every 30s; a socket that didn't answer the last ping is dead -> close it.
setInterval(() => {
  for (const c of wss.clients) {
    if (c.isAlive === false) { try { c.terminate(); } catch (_) {} continue; }
    c.isAlive = false;
    try { c.ping(); } catch (_) {}
  }
}, 30000);
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
  // Tell the newcomer whether a presenter is live (drives the fill-in music).
  sendTo(ws, { type: "onair", live: onAir });
  // Always tell a (re)connecting page what to show, including "nothing": a phone that
  // slept through Stop must bring the chat back when it reconnects.
  sendTo(ws, { type: "display", display: liveDisplay });
  // Heartbeat: Render/Cloudflare drop idle sockets silently; pings keep them alive
  // and let us close dead ones so the page reconnects.
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
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

    /* ---- live display: render scripture/text/image over the listeners' chat ---- */
    if (d.type === "display-set" || d.type === "display-clear") {
      const u = d.token ? userFromToken(String(d.token)) : null;
      const r = applyDisplay(u, d.type === "display-clear" ? "clear" : "set", d.display);
      if (!r.ok && u) sendTo(ws, { type: "display-error", error: r.error });
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

// Watch the Famcast stream so listeners switch between live and fill-in music.
setTimeout(pollOnAir, 1000);
setInterval(pollOnAir, 10 * 1000);

httpServer.listen(PORT, () => {
  console.log(`\n  Ramatlabama FM server running: http://localhost:${PORT}`);
  console.log(`  God:  GOD_Admin / admin2026`);
  console.log(`  CEO:  CEO_Kutlwano_Nqaba / admin2026`);
  console.log(`  New presenters: <email> / ${PRESENTER_PASSWORD_DEFAULT}\n`);
});
