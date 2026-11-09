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
// The genre that will actually play: the slot's genre, or, if it has no music yet,
// the day's default genre, or else any music. Never silent while music exists.
function playableGenre(c) {
  const has = (g) => music.tracks.some((t) => sameGenre(t.genre, g)) || music.links.some((l) => sameGenre(l.genre, g));
  const dayGenre = music.schedule[c.day] || "";
  for (const g of [c.genre, dayGenre, ""]) if (has(g)) return { genre: g, fallback: g !== c.genre };
  return { genre: c.genre, fallback: false };
}
function musicNow() {
  const c = currentGenre();
  const p = playableGenre(c);
  return {
    enabled: music.enabled, day: c.day, time: c.time, genre: p.genre || "All music",
    scheduled: c.genre || "All music", fallback: p.fallback,
    slot: c.day + "|" + (c.slot ? c.slot.start + "-" + c.slot.end : "day") + "|" + p.genre,
    tracks: music.enabled ? music.tracks.filter((t) => sameGenre(t.genre, p.genre)).map(trackView) : [],
    links: music.enabled ? music.links.filter((l) => sameGenre(l.genre, p.genre)).map(linkView) : [],
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
    today: c.day, time: c.time, genreNow: c.genre, playingNow: playableGenre(c).genre,
    genres: [...seen.values()],
    tracks: music.tracks.map((t) => ({ ...trackView(t), by: t.by || "", byName: t.byName || "" })),
    links: music.links.map((l) => ({ ...linkView(l), by: l.by || "", byName: l.byName || "" })),
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
/* ================= MEETING ROOM (staff audio meeting) =================
   God Admin switches the Meeting Room tab on for all members and picks extra leaders.
   Leaders (God Admin, Elevated users like managers/CEO, and anyone God picked) start the
   meeting, which rings every member who has the portal open, put an agenda PDF / text /
   picture on the shared screen, and end it. Members join with their MICROPHONE only.
   Audio goes browser-to-browser between everyone in the room; the server only passes the
   connection messages along and keeps the list of who's in, raised hands and mutes. */
const MEETING_FILE = path.join(DATA_DIR, "meeting.json");
const MEETING_DIR = path.join(DATA_DIR, "meeting");
try { fs.mkdirSync(MEETING_DIR, { recursive: true }); } catch (_) {}
const MEETING_PDF_MAX = 10 * 1024 * 1024;
const MEETING_IMG_MAX = 4 * 1024 * 1024;
const MEETING_MAX_PEOPLE = 16;
const MEETING_EMPTY_END = 30 * 60 * 1000;   // an empty meeting ends by itself after 30 minutes
let meeting = loadJson(MEETING_FILE, { enabled: false, leaders: [], agenda: null, screen: { kind: "agenda" } });
if (!Array.isArray(meeting.leaders)) meeting.leaders = [];
if (!Array.isArray(meeting.presenters)) meeting.presenters = [];   // may put things on the screen
if (!meeting.screen || typeof meeting.screen !== "object") meeting.screen = { kind: "agenda" };
if (meeting.agenda && !(meeting.agenda.file && fs.existsSync(path.join(MEETING_DIR, meeting.agenda.file)))) meeting.agenda = null;
if (meeting.screen.kind === "image" && !(meeting.screen.file && fs.existsSync(path.join(MEETING_DIR, meeting.screen.file)))) meeting.screen = { kind: "agenda" };
// Fingerprint of the website files. It only changes when new code is deployed, so open
// portals can tell they're out of date (a plain restart doesn't change it).
const SITE_BUILD = (() => {
  const h = crypto.createHash("sha256");
  try {
    fs.readdirSync(SITE_DIR).filter((f) => /\.(html|js|css)$/.test(f)).sort()
      .forEach((f) => { h.update(f); h.update(fs.readFileSync(path.join(SITE_DIR, f))); });
  } catch (_) {}
  return h.digest("hex").slice(0, 12);
})();
function saveMeeting() { try { saveJson(MEETING_FILE, meeting); } catch (_) {} }
let meetingLive = null;           // { startedAt, by, byId, declined:Set, emptySince } while a meeting is on
const meetPeople = new Map();     // userId -> { id, name, title, hand, handAt, muted, ws, joinedAt }
function canLead(u) { return !!u && (u.role === "god" || u.role === "elevated" || meeting.leaders.includes(u.id)); }
// Presenting (agenda PDF, text, pictures on the screen): God Admin, and only the people God grants it to.
function canPresent(u) { return !!u && (u.role === "god" || meeting.presenters.includes(u.id)); }
// Who sees the Meeting Room tab: the God Admin always; everyone once God switches it on;
// and, even while it's switched off, anyone a leader is calling (for that call only).
function canSeeMeeting(u) {
  if (!u) return false;
  if (u.role === "god" || meeting.enabled) return true;
  return !!meetingLive && (meetingLive.byId === u.id || meetingLive.invited.has(u.id) || meetPeople.has(u.id));
}
// "Call everyone" makes the meeting open to all members. Calling one person makes a
// private call: only the people a leader called (and leaders) can join it.
function canJoinMeeting(u) { return !!meetingLive && canSeeMeeting(u) && (meetingLive.open || canLead(u) || meetingLive.invited.has(u.id)); }
function newMeetingLive(u, open) {
  return { startedAt: Date.now(), by: sanitize(u.name, 40), byId: u.id, declined: new Set(), invited: new Set(), open, emptySince: Date.now() };
}
const portalOnline = () => new Set(meetSockets().map((w) => w.meetId));
function meetingView(u) {
  if (!canSeeMeeting(u)) return { type: "meeting", visible: false };
  const god = u.role === "god";
  const sc = meeting.screen || { kind: "agenda" };
  return {
    type: "meeting", visible: true, enabled: meeting.enabled, canLead: canLead(u), canPresent: canPresent(u), isGod: god, me: u.id,
    live: meetingLive ? { startedAt: meetingLive.startedAt, by: meetingLive.by, open: meetingLive.open, canJoin: canJoinMeeting(u) } : null,
    people: [...meetPeople.values()].map((p) => ({
      id: p.id, name: p.name, title: p.title, hand: p.hand, handAt: p.handAt, muted: p.muted, joinedAt: p.joinedAt,
      lead: canLead(db.users.find((x) => x.id === p.id)),
      presenter: canPresent(db.users.find((x) => x.id === p.id)),
    })),
    agenda: meeting.agenda ? { name: meeting.agenda.name, v: meeting.agenda.v } : null,
    screen: { kind: sc.kind, title: sc.title || "", body: sc.body || "", v: sc.v || 0, by: sc.by || "" },
    leaders: god ? meeting.leaders : undefined,
    presenters: god ? meeting.presenters : undefined,
    // Leaders get the member list so they can call one person (● = portal open now).
    members: god || canLead(u) ? (() => { const on = portalOnline(); return db.users.map((x) => ({ id: x.id, name: x.name, title: x.title || "", role: x.role, online: on.has(x.id) })); })() : undefined,
    max: MEETING_MAX_PEOPLE,
  };
}
function meetSockets() { return [...wss.clients].filter((w) => isOpen(w) && w.meetId); }
function pushMeeting() {
  for (const w of meetSockets()) {
    const u = db.users.find((x) => x.id === w.meetId);
    if (u) sendTo(w, meetingView(u));
  }
}
function ringMeeting() {   // every member with the portal open who isn't in the room (and didn't say "not now")
  if (!meetingLive) return;
  for (const w of meetSockets()) {
    const u = db.users.find((x) => x.id === w.meetId);
    if (!u || !canJoinMeeting(u) || meetPeople.has(u.id) || meetingLive.declined.has(u.id)) continue;
    sendTo(w, { type: "meeting-ring", by: meetingLive.by });
  }
}
function meetingLeave(userId, ws) {
  const p = meetPeople.get(userId);
  if (!p || (ws && p.ws !== ws)) return;
  meetPeople.delete(userId);
  if (p.ws) p.ws.inMeeting = false;
  for (const o of meetPeople.values()) sendTo(o.ws, { type: "meeting-peer-left", id: userId });
  if (meetingLive && !meetPeople.size) meetingLive.emptySince = Date.now();
  pushMeeting();
}
function meetingEnd(by) {
  for (const p of meetPeople.values()) { sendTo(p.ws, { type: "meeting-ended", by }); if (p.ws) p.ws.inMeeting = false; }
  meetPeople.clear();
  meetingLive = null;
  for (const w of meetSockets()) sendTo(w, { type: "meeting-ring-stop" });
  pushMeeting();
}
setInterval(() => {
  if (meetingLive && !meetPeople.size && meetingLive.emptySince && Date.now() - meetingLive.emptySince > MEETING_EMPTY_END) meetingEnd("");
}, 60 * 1000);
function handleMeeting(ws, u, d) {
  const err = (e) => sendTo(ws, { type: "meeting-error", error: e });
  if (d.type === "meeting-start") {          // start, or "call everyone again"
    if (!canLead(u)) return err("Only a meeting leader can start the meeting.");
    if (!meetingLive) meetingLive = newMeetingLive(u, true);
    else { meetingLive.open = true; meetingLive.declined.clear(); }
    ringMeeting(); pushMeeting();
    return;
  }
  if (d.type === "meeting-call") {           // ring ONE member (starts a private call if none is on)
    if (!canLead(u)) return err("Only a meeting leader can call members.");
    const t = db.users.find((x) => x.id === String(d.id || ""));
    if (!t || t.id === u.id) return err("Choose someone to call.");
    if (meetPeople.has(t.id)) return err(t.name + " is already in the meeting.");
    if (!meetingLive) meetingLive = newMeetingLive(u, false);
    meetingLive.invited.add(t.id);
    meetingLive.declined.delete(t.id);
    pushMeeting();   // first: the Meeting Room tab appears for them (needed before it can ring)
    const socks = meetSockets().filter((w) => w.meetId === t.id);
    socks.forEach((w) => sendTo(w, { type: "meeting-ring", by: sanitize(u.name, 40), direct: true }));
    sendTo(ws, { type: "meeting-note", text: socks.length
      ? "📞 Calling " + t.name + "…"
      : t.name + " doesn't have the portal open right now. They'll be able to join when they open it." });
    pushMeeting();
    return;
  }
  if (d.type === "meeting-end") {
    if (!canLead(u)) return err("Only a meeting leader can end the meeting.");
    if (meetingLive) meetingEnd(sanitize(u.name, 40));
    return;
  }
  if (d.type === "meeting-decline") { if (meetingLive) meetingLive.declined.add(u.id); return; }
  if (d.type === "meeting-join") {
    if (!meetingLive) return sendTo(ws, { type: "meeting-ended", by: "", reason: "There's no meeting right now." });
    if (!canJoinMeeting(u)) return err("This is a private call. A leader has to call you in.");
    const old = meetPeople.get(u.id);
    if (!old && meetPeople.size >= MEETING_MAX_PEOPLE) return err("The meeting is full (" + MEETING_MAX_PEOPLE + " people).");
    if (old && old.ws !== ws) {   // same person on another device / a reconnect: the newest one wins
      sendTo(old.ws, { type: "meeting-ended", by: "", reason: "You joined the meeting from another window." });
      if (old.ws) old.ws.inMeeting = false;
      meetPeople.delete(u.id);
      for (const o of meetPeople.values()) sendTo(o.ws, { type: "meeting-peer-left", id: u.id });
    }
    const peers = [...meetPeople.keys()];
    meetPeople.set(u.id, { id: u.id, name: sanitize(u.name, 40), title: sanitize(u.title, 60), hand: false, handAt: 0, muted: !!d.muted, ws, joinedAt: Date.now() });
    ws.inMeeting = true;
    meetingLive.declined.delete(u.id);
    meetingLive.emptySince = 0;
    sendTo(ws, { type: "meeting-joined", peers });   // the newcomer calls everyone already in
    pushMeeting();
    return;
  }
  if (d.type === "meeting-presenter") {     // God Admin grants/removes presenting (from a name tile; in the call or not)
    if (u.role !== "god") return err("Only the God Admin can make someone a presenter.");
    const t = db.users.find((x) => x.id === String(d.id || ""));
    if (!t || t.role === "god") return;
    meeting.presenters = meeting.presenters.filter((id) => id !== t.id);
    if (d.on) meeting.presenters.push(t.id);
    saveMeeting();
    return pushMeeting();
  }
  const p = meetPeople.get(u.id);
  if (!p || p.ws !== ws) return;               // the rest is for people in the room
  if (d.type === "meeting-leave") return meetingLeave(u.id, ws);
  if (d.type === "meeting-signal") {
    const t = meetPeople.get(String(d.to || ""));
    if (t && d.data && typeof d.data === "object") sendTo(t.ws, { type: "meeting-signal", from: u.id, data: d.data });
    return;
  }
  if (d.type === "meeting-hand") {
    const target = meetPeople.get(String(d.id || u.id));
    if (!target) return;
    if (target.id !== u.id && (d.up || !canLead(u))) return;   // leaders may only LOWER someone else's hand
    target.hand = !!d.up; target.handAt = Date.now();
    return pushMeeting();
  }
  if (d.type === "meeting-mute") { p.muted = !!d.muted; return pushMeeting(); }
}
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.slice(1, 4).toString("latin1") === "PNG") return ".png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return ".jpg";
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return ".webp";
  if (buf.slice(0, 3).toString("latin1") === "GIF") return ".gif";
  return null;
}
function removeMeetingFile(f) { if (f) { try { fs.unlinkSync(path.join(MEETING_DIR, path.basename(f))); } catch (_) {} } }
function sendMeetingFile(res, file, type, name) {
  const fp = path.join(MEETING_DIR, path.basename(file));
  fs.readFile(fp, (e, data) => {
    if (e) { res.writeHead(404); return res.end("Not found"); }
    const h = { "Content-Type": type, "Cache-Control": "private, no-store" };
    if (name) h["Content-Disposition"] = "inline; filename=\"" + String(name).replace(/[^\w .()-]/g, "_") + "\"";
    res.writeHead(200, h); res.end(data);
  });
}

/* ---- Station clock: ONE shared "now playing" for the fill-in music ----
   The server decides which song plays and when it started, so every listener hears
   the same song at the same second (like real radio) and joins mid-song. The audio
   itself still comes from YouTube's official player in each browser (or from the
   uploaded file). Songs play in the order they were added and loop forever. A
   playlist plays STATION_TURN songs, then the next link gets a turn; it carries on
   where it left off next time. Browsers tell us each song's length the first time
   they play it, which is how the server knows when to move on. */
const STATION_TURN = 3;
if (!music.durs || typeof music.durs !== "object") music.durs = {};      // song key -> seconds
if (!music.plLens || typeof music.plLens !== "object") music.plLens = {}; // playlist id -> song count
const station = { seq: 0, item: null, startedAt: 0, turn: 0, cursors: {} };
let musicSaveTimer = null;
function saveMusicSoon() {
  if (musicSaveTimer) return;
  musicSaveTimer = setTimeout(() => { musicSaveTimer = null; saveMusic(); }, 5000);
}
function durKey(it) {
  if (it.type === "file") return "f:" + it.id;
  return it.kind === "playlist" ? "p:" + it.ytId + ":" + (it.idx || 0) : "v:" + it.ytId;
}
function stationPool() {   // what may play right now, in the order it was added
  if (!music.enabled) return [];
  const g = playableGenre(currentGenre()).genre;
  return [
    ...music.tracks.filter((t) => sameGenre(t.genre, g)).map((t) => ({ type: "file", ...trackView(t), ts: t.ts || 0 })),
    ...music.links.filter((l) => sameGenre(l.genre, g)).map((l) => ({ type: "yt", ...linkView(l), ts: l.ts || 0 })),
  ].sort((a, b) => a.ts - b.ts);
}
function stationStart(item, idx, at, turn) {
  station.item = { ...item, idx: idx || 0 };
  station.startedAt = at; station.turn = turn; station.seq++;
}
function stationAdvance(pool, at) {   // move on to the next song
  const cur = station.item;
  if (!pool.length) { if (cur) { station.item = null; station.seq++; } return; }
  if (cur && cur.type === "yt" && cur.kind === "playlist") {
    const n = music.plLens[cur.ytId] || 0;
    const next = n ? (cur.idx + 1) % n : cur.idx + 1;
    const stillHere = pool.some((x) => x.id === cur.id);
    if (stillHere && (pool.length === 1 || station.turn < STATION_TURN)) return stationStart(cur, next, at, station.turn + 1);
    station.cursors[cur.id] = next;   // next turn of this playlist carries on from here
  }
  const pos = cur ? pool.findIndex((x) => x.id === cur.id) : -1;
  const item = pos >= 0 ? pool[(pos + 1) % pool.length] : pool[Math.floor(Math.random() * pool.length)];
  let idx = 0;
  if (item.type === "yt" && item.kind === "playlist") {
    const n = music.plLens[item.ytId] || 0;
    idx = station.cursors[item.id] || 0;
    if (n) idx %= n;
  }
  stationStart(item, idx, at, 1);
}
function stationTick() {   // keep the clock right; returns true if the song changed
  const before = station.seq, now = Date.now();
  const pool = stationPool();
  const cur = station.item;
  if (!cur || !pool.some((x) => x.id === cur.id)) {   // nothing yet, removed, or a new time slot/genre
    station.item = null;
    stationAdvance(pool, now);
    return station.seq !== before;
  }
  const dur = music.durs[durKey(cur)] || 0;
  const elapsed = (now - station.startedAt) / 1000;
  if (dur && elapsed >= dur + 1) {
    // Seamless when someone is listening; after a long quiet gap, start the next song fresh.
    stationAdvance(pool, elapsed > dur + 60 ? now : station.startedAt + dur * 1000);
  } else if (!dur && elapsed > 600) {
    station.startedAt = now;   // length still unknown (nobody played it yet): don't send people past the end
  }
  return station.seq !== before;
}
function stationView() {
  stationTick();
  const s = station.item;
  if (!s) return null;
  return {
    seq: station.seq, id: s.id, type: s.type, kind: s.kind || "", ytId: s.ytId || "", url: s.url || "",
    title: s.title, idx: s.idx || 0, dur: music.durs[durKey(s)] || 0,
    offset: Math.max(0, (Date.now() - station.startedAt) / 1000),
  };
}
// A listener's player reports the song's length / playlist size, or that the song ended or failed.
function stationReport(d) {
  const s = station.item;
  if (!s || Number(d.seq) !== station.seq) return;   // stale report (the song already changed)
  const key = durKey(s);
  const dur = Number(d.dur);
  if (!music.durs[key] && isFinite(dur) && dur >= 5 && dur <= 6 * 3600) {
    music.durs[key] = Math.round(dur);
    const keys = Object.keys(music.durs);
    if (keys.length > 5000) keys.slice(0, keys.length - 5000).forEach((k) => delete music.durs[k]);
    saveMusicSoon();
  }
  const n = parseInt(d.plLen, 10);
  if (s.kind === "playlist" && n >= 1 && n <= 5000 && music.plLens[s.ytId] !== n) { music.plLens[s.ytId] = n; saveMusicSoon(); }
  const elapsed = (Date.now() - station.startedAt) / 1000;
  const known = music.durs[key] || 0;
  // Only believe "ended" near the real end, and "failed" after a few seconds (stops skip-spamming).
  const ok = (d.ended && elapsed >= (known ? known - 15 : 20)) || (d.error && elapsed >= 3);
  if (ok) {
    stationAdvance(stationPool(), Date.now());
    broadcast({ type: "station", station: stationView() });
  }
}
setInterval(() => { if (stationTick()) broadcast({ type: "station", station: stationView() }); }, 2000);

// Any logged-in presenter may add music. Removing is limited to the person who added it,
// the God Admin and Elevated users (older items with no owner: managers only).
function canRemoveMusic(u, item) {
  return !!u && (u.role === "god" || u.role === "elevated" || (!!item.by && item.by === u.id));
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

// Cloudflare TURN: set CF_TURN_KEY_ID and CF_TURN_API_TOKEN on Render. The key stays on
// the server; browsers only get short-lived credentials (6 h), refreshed every hour.
const CF_TURN_KEY_ID = (process.env.CF_TURN_KEY_ID || "").trim();
const CF_TURN_API_TOKEN = (process.env.CF_TURN_API_TOKEN || "").trim();
let cfIce = null, cfIceAt = 0, cfIceFail = 0;
async function getIceServers() {
  if (!CF_TURN_KEY_ID || !CF_TURN_API_TOKEN) return ICE_SERVERS;
  if (cfIce && Date.now() - cfIceAt < 60 * 60 * 1000) return cfIce;
  if (Date.now() - cfIceFail < 60 * 1000) return cfIce || ICE_SERVERS;   // don't hammer after an error
  try {
    const r = await fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" + encodeURIComponent(CF_TURN_KEY_ID) + "/credentials/generate-ice-servers", {
      method: "POST",
      headers: { Authorization: "Bearer " + CF_TURN_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 6 * 60 * 60 }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(j.iceServers) || !j.iceServers.length) throw new Error("Cloudflare TURN " + r.status);
    cfIce = j.iceServers; cfIceAt = Date.now();
    return cfIce;
  } catch (e) {
    cfIceFail = Date.now();
    console.warn("Cloudflare TURN credentials failed:", e.message);
    return cfIce || ICE_SERVERS;
  }
}

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
// Listeners have no accounts. Each browser makes a private random id (cid); messages keep it so a
// later name change can update that person's older messages. Browsers only ever see a hash of it.
function cleanCid(c) { c = String(c == null ? "" : c); return /^[A-Za-z0-9_-]{8,64}$/.test(c) ? c : ""; }
function whoOf(cid) { return crypto.createHash("sha256").update("rfm-who:" + cid).digest("hex").slice(0, 12); }
function renameChat(cid, name) {   // returns true if any older message had a different name
  let changed = false;
  chatLog.messages.forEach((m) => { if (m && m.cid === cid && m.name !== name) { m.name = name; changed = true; } });
  if (changed) saveChatSoon();
  return changed;
}
function historyPayload() {
  return {
    type: "history",
    messages: chatLog.messages.map((m) => ({ name: m.name, text: m.text, ts: m.ts, who: m.cid ? whoOf(m.cid) : "" })),
  };
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
// The Members list as the viewer may see it: the God Admin also sees emails/logins.
// Passwords are never sent to any browser.
function membersFor(viewer) {
  const god = viewer && viewer.role === "god";
  return db.users.map((x) => (god ? { ...memberView(x), email: x.email || "", login: x.login || "" } : memberView(x)));
}
// What a reset sets an account back to: the protected logins have their own defaults.
function defaultPasswordFor(u) {
  if (u.login === "GOD_Admin") return GOD_PASSWORD_DEFAULT;
  if (u.login === "CEO_Kutlwano_Nqaba") return CEO_PASSWORD_DEFAULT;
  return PRESENTER_PASSWORD_DEFAULT;
}
function endSessionsOf(userId) {   // log the person out everywhere (e.g. after a reset)
  for (const [t, s] of sessions) if (s.id === userId) sessions.delete(t);
  saveSessionsSoon();
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
    return sendJson(res, 200, { iceServers: await getIceServers() });
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
    return sendJson(res, 200, { ok: true, live: onAir, known: onAirKnown, ...musicNow(), station: stationView() });
  }

  /* ---- God Admin: fill-in music library, schedule and settings ---- */
  if (p === "/api/music/admin" && req.method === "POST") {
    const u = authUser(await readBody(req));
    if (!u) return sendJson(res, 403, { ok: false, error: "Log in to manage music." });
    return sendJson(res, 200, musicAdminView());
  }
  if (p === "/api/music/settings" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    // Any presenter may set what plays when; switching fill-in music off is God Admin only.
    if (!u) return sendJson(res, 403, { ok: false, error: "Log in to manage music." });
    if (typeof body.enabled === "boolean") {
      if (u.role !== "god") return sendJson(res, 403, { ok: false, error: "Only the God Admin can switch music on or off." });
      music.enabled = body.enabled;
    }
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
    if (!u) return sendJson(res, 403, { ok: false, error: "Log in to add music." });
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
    music.links.push({ id: "yt" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind: link.kind, ytId: link.ytId, title, genre, ts: Date.now(), by: u.id, byName: sanitize(u.name, 40) });
    saveMusic();
    broadcast({ type: "music-changed" });
    return sendJson(res, 200, { ...musicAdminView(), note });
  }
  if (p === "/api/music/link/delete" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u) return sendJson(res, 403, { ok: false, error: "Log in to manage music." });
    const target = music.links.find((l) => l.id === String(body.id));
    if (target && !canRemoveMusic(u, target)) return sendJson(res, 403, { ok: false, error: "You can only remove music you added." });
    music.links = music.links.filter((l) => l.id !== String(body.id));
    saveMusic();
    broadcast({ type: "music-changed" });
    return sendJson(res, 200, musicAdminView());
  }
  if (p === "/api/music/upload" && req.method === "POST") {
    // Raw file body; token/genre/title travel in headers so nothing is read before auth.
    const u = userFromToken(String(req.headers["x-token"] || ""));
    if (!u) { req.resume(); return sendJson(res, 403, { ok: false, error: "Log in to upload music." }); }
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
    music.tracks.push({ id, file, title: title || "Untitled", genre, size: buf.length, ts: Date.now(), by: u.id, byName: sanitize(u.name, 40) });
    saveMusic();
    broadcast({ type: "music-changed" });
    return sendJson(res, 200, musicAdminView());
  }
  if (p === "/api/music/delete" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u) return sendJson(res, 403, { ok: false, error: "Log in to manage music." });
    const t = music.tracks.find((x) => x.id === String(body.id));
    if (t && !canRemoveMusic(u, t)) return sendJson(res, 403, { ok: false, error: "You can only remove music you added." });
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

  /* ---- Meeting Room ---- */
  if (p === "/api/meeting/settings" && req.method === "POST") {   // God Admin: show the tab, pick leaders
    const body = await readBody(req);
    const u = authUser(body);
    if (!u || u.role !== "god") return sendJson(res, 403, { ok: false, error: "Only the God Admin can change the Meeting Room." });
    if (typeof body.enabled === "boolean") {
      meeting.enabled = body.enabled;
      if (!meeting.enabled && meetingLive) meetingEnd(sanitize(u.name, 40));
    }
    if (Array.isArray(body.leaders)) meeting.leaders = [...new Set(body.leaders.map(String))].filter((id) => db.users.some((x) => x.id === id));
    if (Array.isArray(body.presenters)) meeting.presenters = [...new Set(body.presenters.map(String))].filter((id) => db.users.some((x) => x.id === id));
    saveMeeting(); pushMeeting();
    return sendJson(res, 200, { ok: true, view: meetingView(u) });
  }
  if (p === "/api/meeting/agenda" && req.method === "POST") {     // leader uploads the agenda PDF (raw body)
    const u = userFromToken(String(req.headers["x-token"] || ""));
    if (!canSeeMeeting(u) || !canPresent(u)) { req.resume(); return sendJson(res, 403, { ok: false, error: "Only a meeting presenter can upload the agenda. Ask the God Admin." }); }
    const buf = await readRaw(req, MEETING_PDF_MAX);
    if (!buf) return sendJson(res, 413, { ok: false, error: "The PDF is too big (max 10 MB)." });
    if (buf.slice(0, 5).toString("latin1") !== "%PDF-") return sendJson(res, 400, { ok: false, error: "That isn't a PDF file." });
    let name = "Agenda.pdf";
    try { name = sanitize(decodeURIComponent(String(req.headers["x-name"] || "")), 80).trim() || name; } catch (_) {}
    const file = "agenda-" + rid(6) + ".pdf";
    try { fs.writeFileSync(path.join(MEETING_DIR, file), buf); } catch (_) { return sendJson(res, 500, { ok: false, error: "Could not save the PDF." }); }
    if (meeting.agenda) removeMeetingFile(meeting.agenda.file);
    meeting.agenda = { file, name, v: Date.now(), by: sanitize(u.name, 40) };
    if (meeting.screen.kind === "image") removeMeetingFile(meeting.screen.file);
    meeting.screen = { kind: "agenda", v: Date.now(), by: sanitize(u.name, 40) };
    saveMeeting(); pushMeeting();
    return sendJson(res, 200, { ok: true });
  }
  if (p === "/api/meeting/screen" && req.method === "POST") {     // leader: show the agenda, or some text
    const body = await readBody(req);
    const u = authUser(body);
    if (!canSeeMeeting(u) || !canPresent(u)) return sendJson(res, 403, { ok: false, error: "Only a meeting presenter can change the screen. Ask the God Admin." });
    // "none" = stop showing anything (the screen goes blank for everyone).
    const kind = body.kind === "text" ? "text" : body.kind === "none" ? "none" : "agenda";
    const next = { kind, v: Date.now(), by: sanitize(u.name, 40) };
    if (kind === "text") {
      next.title = sanitize(body.title, 120).trim();
      next.body = String(body.body == null ? "" : body.body).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").slice(0, 4000);
      if (!next.title && !next.body.trim()) return sendJson(res, 400, { ok: false, error: "Type something to show first." });
    }
    if (meeting.screen.kind === "image") removeMeetingFile(meeting.screen.file);
    meeting.screen = next;
    saveMeeting(); pushMeeting();
    return sendJson(res, 200, { ok: true });
  }
  if (p === "/api/meeting/screen-image" && req.method === "POST") {   // leader shows a picture (raw body)
    const u = userFromToken(String(req.headers["x-token"] || ""));
    if (!canSeeMeeting(u) || !canPresent(u)) { req.resume(); return sendJson(res, 403, { ok: false, error: "Only a meeting presenter can change the screen. Ask the God Admin." }); }
    const buf = await readRaw(req, MEETING_IMG_MAX);
    if (!buf) return sendJson(res, 413, { ok: false, error: "The picture is too big (max 4 MB)." });
    const ext = sniffImage(buf);
    if (!ext) return sendJson(res, 400, { ok: false, error: "Use a JPG, PNG, WEBP or GIF picture." });
    const file = "screen-" + rid(6) + ext;
    try { fs.writeFileSync(path.join(MEETING_DIR, file), buf); } catch (_) { return sendJson(res, 500, { ok: false, error: "Could not save the picture." }); }
    if (meeting.screen.kind === "image") removeMeetingFile(meeting.screen.file);
    meeting.screen = { kind: "image", file, v: Date.now(), by: sanitize(u.name, 40) };
    saveMeeting(); pushMeeting();
    return sendJson(res, 200, { ok: true });
  }
  if ((p === "/api/meeting/agenda.pdf" || p === "/api/meeting/image") && req.method === "GET") {   // members only
    const u = userFromToken(String(url.searchParams.get("t") || ""));
    if (!canSeeMeeting(u)) { res.writeHead(403); return res.end("Forbidden"); }
    if (p === "/api/meeting/agenda.pdf") {
      if (!meeting.agenda) { res.writeHead(404); return res.end("No agenda"); }
      return sendMeetingFile(res, meeting.agenda.file, "application/pdf", meeting.agenda.name);
    }
    if (meeting.screen.kind !== "image") { res.writeHead(404); return res.end("No picture"); }
    const ext = path.extname(meeting.screen.file).toLowerCase();
    return sendMeetingFile(res, meeting.screen.file, MIME[ext] || "image/" + ext.slice(1), "");
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
    return sendJson(res, 200, { ok: true, members: membersFor(u), meId: u.id, meRole: u.role, canManage: canManage(u.role) });
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
    return sendJson(res, 200, { ok: true, members: membersFor(u), meId: u.id, meRole: u.role, canManage: canManage(u.role) });
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
    return sendJson(res, 200, { ok: true, members: membersFor(u), meId: u.id, meRole: u.role, canManage: canManage(u.role) });
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
    return sendJson(res, 200, { ok: true, members: membersFor(u), meId: u.id, meRole: u.role, canManage: canManage(u.role) });
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
    return sendJson(res, 200, { ok: true, members: membersFor(u), meId: u.id, meRole: u.role, canManage: canManage(u.role) });
  }

  /* ---- reset a member's password to the default (God Admin only) ---- */
  if (p === "/api/members/reset-password" && req.method === "POST") {
    const body = await readBody(req);
    const u = authUser(body);
    if (!u || u.role !== "god") return sendJson(res, 403, { ok: false, error: "Only the God Admin can reset passwords." });
    const target = db.users.find((x) => x.id === String(body.id));
    if (!target) return sendJson(res, 404, { ok: false, error: "Not found." });
    if (target.id === u.id) return sendJson(res, 400, { ok: false, error: "Change your own password in Settings." });
    target.password = defaultPasswordFor(target);
    saveJson(USERS_FILE, db);
    endSessionsOf(target.id);   // they log in again with the default password
    return sendJson(res, 200, { ok: true, members: membersFor(u), meId: u.id, meRole: u.role, canManage: canManage(u.role),
      note: target.name + "'s password is reset to the default. They've been logged out and can log in with " + (target.login || target.email) + " and the default password." });
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
    return sendJson(res, 200, { ok: true, members: membersFor(u), meId: u.id, meRole: u.role, canManage: canManage(u.role) });
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
    return sendJson(res, 200, { ok: true, members: membersFor(u), meId: u.id, meRole: u.role, canManage: canManage(u.role) });
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
    // Libraries in a versioned folder (e.g. assets/pdfjs-3.11.174) never change: let phones keep them.
    const fixed = /^\/assets\/[a-z0-9-]+-\d+\.\d+\.\d+\//i.test(reqPath);
    res.writeHead(200, fixed ? {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    } : {
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
/* ---------- Studio calls (WebRTC signalling) ----------
   Star layout: every caller and co-host connects to the HOST's portal tab. That
   tab mixes everyone (each person hears all the others but never themselves) and
   its sound goes to Miradio through TAB. Audio flows browser-to-browser; the server
   only relays setup messages and keeps the queue.
   A call never ends just because a socket drops (phones sleep, networks blip):
   the person reconnects with their call id + key and the audio carries on.
   Calls end only when someone hangs up, or after a long absence. */
let nextWsId = 1;
function sendTo(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
const calls = new Map();   // id -> { id, key, kind: "caller"|"cohost", name, userId, state: "waiting"|"live", ws, since, liveSince, goneAt }
let studio = null;         // the host: { userId, name, ws, since, goneAt }
const invites = new Map(); // co-host invitations ringing: id -> { id, userId, name, since }
const INVITE_RING_MS = 60 * 1000;
const MAX_ON_LINE = 8;            // people on the line with the host at once
const MAX_WAITING = 40;
const WAIT_GRACE = 2 * 60 * 1000; // a waiting caller who vanished is dropped after this
const LIVE_GRACE = 10 * 60 * 1000;// someone on air whose socket died (audio may still flow)
const HOST_GRACE = 5 * 60 * 1000; // host's page lost its connection
const rid = (n) => crypto.randomBytes(n).toString("hex");
const isOpen = (w) => !!(w && w.readyState === 1);
function callView(c) {
  return { id: c.id, kind: c.kind, name: c.name, userId: c.kind === "cohost" ? c.userId : undefined,
    since: c.since, liveSince: c.liveSince || 0, connected: isOpen(c.ws) };
}
function studioPayload() {
  const all = [...calls.values()].sort((a, b) => a.since - b.since);
  return {
    type: "studio",
    host: studio ? { userId: studio.userId, name: studio.name, since: studio.since, connected: isOpen(studio.ws) } : null,
    callers: all.filter((c) => c.kind === "caller" && c.state === "waiting").map(callView),
    cohosts: all.filter((c) => c.kind === "cohost" && c.state === "waiting").map(callView),
    live: all.filter((c) => c.state === "live").map(callView),
    invites: [...invites.values()].map((v) => ({ id: v.id, userId: v.userId, name: v.name, since: v.since })),
    online: [...new Set([...wss.clients].filter((w) => isOpen(w) && w.staffId).map((w) => w.staffId))],
    max: MAX_ON_LINE,
  };
}
function endInvite(id, reason) {
  const v = invites.get(id);
  if (!v) return;
  invites.delete(id);
  if (reason && studio) sendTo(studio.ws, { type: "studio-note", text: v.name + " " + reason });
  pushStudio();
}
function pushStudio() {
  const p = studioPayload();
  for (const w of wss.clients) if (isOpen(w) && w.staff) sendTo(w, p);
  // Waiting callers learn whether the studio is open, and their place in the queue.
  p.callers.forEach((c, i) => {
    const call = calls.get(c.id);
    if (call) sendTo(call.ws, { type: "call-status", state: "waiting", hostOnline: !!studio, position: i + 1 });
  });
}
function endCallById(id, reason, tellHost = true) {
  const c = calls.get(id);
  if (!c) return;
  calls.delete(id);
  if (c.ws && c.ws.callId === id) c.ws.callId = null;
  sendTo(c.ws, { type: "call-ended", reason: reason || "" });
  if (c.state === "live" && tellHost && studio) sendTo(studio.ws, { type: "peer-left", id });
  pushStudio();
}
function closeStudio(reason) {
  for (const c of [...calls.values()]) if (c.state === "live") endCallById(c.id, reason, false);
  if (studio && studio.ws) studio.ws.isHost = false;
  studio = null;
  invites.clear();   // nobody to co-host with any more
  pushStudio();
}
function isHostWs(ws) { return !!(studio && ws.staffId && studio.userId === ws.staffId); }
// The host, or a co-host who is on air with the host, may put callers through.
function canPutThrough(ws) {
  if (!ws.staffId) return false;
  if (isHostWs(ws)) return true;
  for (const c of calls.values()) if (c.kind === "cohost" && c.state === "live" && c.userId === ws.staffId) return true;
  return false;
}
function putOnLine(c) {
  if (!studio || !isOpen(studio.ws)) return "The host isn't connected right now.";
  if ([...calls.values()].filter((x) => x.state === "live").length >= MAX_ON_LINE) return "The line is full (" + MAX_ON_LINE + " people). End a call first.";
  c.state = "live"; c.liveSince = Date.now();
  sendTo(c.ws, { type: "call-accepted", host: studio.name });
  sendTo(studio.ws, { type: "peer-join", id: c.id, kind: c.kind, name: c.name });
  pushStudio();
  return null;
}
// Sweep: drop people who have been gone too long.
setInterval(() => {
  const now = Date.now();
  for (const c of [...calls.values()]) {
    if (!c.goneAt) continue;
    if (c.state === "waiting" && now - c.goneAt > WAIT_GRACE) endCallById(c.id, "");
    else if (c.state === "live" && now - c.goneAt > LIVE_GRACE) endCallById(c.id, "The line dropped.");
  }
  if (studio && studio.goneAt && now - studio.goneAt > HOST_GRACE) closeStudio("The studio went offline. Please call again later.");
  for (const v of [...invites.values()]) if (now - v.since > INVITE_RING_MS) endInvite(v.id, "didn't answer.");
}, 5000);

wss.on("connection", (ws) => {
  ws.id = String(nextWsId++);
  ws.staff = null; ws.staffId = null; ws.callId = null; ws.isHost = false;
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
  ws.send(JSON.stringify(historyPayload()));
  ws.send(JSON.stringify({ type: "station", station: stationView() }));
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

    /* ---- studio calls ---- */
    if (d.type === "staff-hello") {
      const u = d.token ? userFromToken(String(d.token)) : null;
      if (!u) return;
      const wasOnline = [...wss.clients].some((w) => w !== ws && isOpen(w) && w.staffId === u.id);
      ws.staff = { name: u.name, role: u.role }; ws.staffId = u.id;
      sendTo(ws, { type: "staff-ok", me: { id: u.id, name: u.name } });
      if (wasOnline) sendTo(ws, studioPayload()); else pushStudio();   // others see you come online
      return;
    }
    // Host invites a member to co-host: their portal rings.
    if (d.type === "cohost-invite") {
      if (!isHostWs(ws)) return sendTo(ws, { type: "studio-error", error: "Only the host can invite a co-host." });
      const target = db.users.find((x) => x.id === String(d.userId || ""));
      if (!target || target.id === studio.userId) return sendTo(ws, { type: "studio-error", error: "Choose someone else to invite." });
      if ([...calls.values()].some((c) => c.kind === "cohost" && c.userId === target.id && c.state === "live"))
        return sendTo(ws, { type: "studio-error", error: target.name + " is already on air." });
      if ([...invites.values()].some((v) => v.userId === target.id)) return;   // already ringing
      if ([...calls.values()].filter((x) => x.state === "live").length >= MAX_ON_LINE)
        return sendTo(ws, { type: "studio-error", error: "The line is full (" + MAX_ON_LINE + " people). End a call first." });
      const v = { id: rid(6), userId: target.id, name: sanitize(target.name, 40) || "Co-host", since: Date.now() };
      invites.set(v.id, v);
      pushStudio();
      if (![...wss.clients].some((w) => isOpen(w) && w.staffId === target.id))
        sendTo(ws, { type: "studio-note", text: v.name + " doesn't have the portal open right now. It will ring for 60 seconds if they open it." });
      return;
    }
    if (d.type === "cohost-cancel") {   // host stops ringing
      if (isHostWs(ws)) endInvite(String(d.inviteId || ""), "");
      return;
    }
    if (d.type === "cohost-decline") {   // the invited member says no
      const v = invites.get(String(d.inviteId || ""));
      if (v && v.userId === ws.staffId) endInvite(v.id, "declined the invitation.");
      return;
    }
    // Host opens the studio (or their page reconnects). `peers` = calls the page still holds.
    if (d.type === "host-start") {
      const u = d.token ? userFromToken(String(d.token)) : null;
      if (!u) return sendTo(ws, { type: "host-error", error: "Log in again to host." });
      if (studio && studio.userId !== u.id && isOpen(studio.ws))
        return sendTo(ws, { type: "host-error", error: studio.name + " is hosting right now." });
      if (studio && studio.userId !== u.id) closeStudio("The studio changed hands. Please call again.");
      // Hosting replaces any co-host call of your own.
      for (const c of [...calls.values()]) if (c.kind === "cohost" && c.userId === u.id) endCallById(c.id, "");
      if (!studio) studio = { userId: u.id, name: u.name, since: Date.now() };
      if (studio.ws && studio.ws !== ws) studio.ws.isHost = false;
      studio.ws = ws; studio.goneAt = 0; ws.isHost = true;
      ws.staff = ws.staff || { name: u.name, role: u.role }; ws.staffId = u.id;
      const keep = new Set((Array.isArray(d.peers) ? d.peers : []).map(String));
      for (const c of [...calls.values()]) if (c.state === "live" && !keep.has(c.id)) endCallById(c.id, "The studio reconnected. Please call again.", false);
      sendTo(ws, { type: "host-ok" });
      pushStudio();
      return;
    }
    if (d.type === "host-stop") {
      if (isHostWs(ws)) closeStudio("The presenter has closed the lines. Thanks for calling!");
      return;
    }
    // A listener calls in, or an invited member answers the host's co-host call.
    if (d.type === "call-request" || d.type === "cohost-answer") {
      if (ws.callId && calls.has(ws.callId)) return;
      if (Date.now() - (ws.lastCallReq || 0) < 3000) return;   // tiny rate limit
      ws.lastCallReq = Date.now();
      let c;
      if (d.type === "cohost-answer") {
        const u = d.token ? userFromToken(String(d.token)) : null;
        const v = invites.get(String(d.inviteId || ""));
        if (!u) return sendTo(ws, { type: "call-ended", reason: "Log in again to co-host." });
        if (!v || v.userId !== u.id) return sendTo(ws, { type: "call-ended", reason: "That invitation has ended." });
        if (!studio || !isOpen(studio.ws)) { endInvite(v.id, ""); return sendTo(ws, { type: "call-ended", reason: "The host isn't connected right now." }); }
        invites.delete(v.id);
        for (const x of [...calls.values()]) if (x.kind === "cohost" && x.userId === u.id) endCallById(x.id, "");
        c = { kind: "cohost", name: sanitize(u.name, 40) || "Co-host", userId: u.id };
        Object.assign(c, { id: rid(6), key: rid(12), state: "waiting", ws, since: Date.now(), goneAt: 0 });
        calls.set(c.id, c); ws.callId = c.id;
        ws.staff = ws.staff || { name: u.name, role: u.role }; ws.staffId = u.id;
        sendTo(ws, { type: "call-session", callId: c.id, key: c.key });
        const err = putOnLine(c);   // answering puts them straight on air
        if (err) endCallById(c.id, err);
        return;
      } else {
        if ([...calls.values()].filter((x) => x.state === "waiting").length >= MAX_WAITING)
          return sendTo(ws, { type: "call-ended", reason: "The lines are busy. Please try again in a few minutes." });
        c = { kind: "caller", name: sanitize(d.name, 24) || "Caller" };
      }
      Object.assign(c, { id: rid(6), key: rid(12), state: "waiting", ws, since: Date.now(), goneAt: 0 });
      calls.set(c.id, c); ws.callId = c.id;
      sendTo(ws, { type: "call-session", callId: c.id, key: c.key });
      pushStudio();
      return;
    }
    // Reconnect to a call in progress (the audio kept flowing meanwhile).
    if (d.type === "call-resume") {
      const c = calls.get(String(d.callId || ""));
      if (!c || c.key !== String(d.key || "")) return sendTo(ws, { type: "call-ended", reason: "That call has ended." });
      if (c.ws && c.ws !== ws && c.ws.callId === c.id) c.ws.callId = null;
      c.ws = ws; c.goneAt = 0; ws.callId = c.id;
      sendTo(ws, { type: "call-status", state: c.state, hostOnline: !!studio, host: studio && studio.name });
      pushStudio();
      return;
    }
    if (d.type === "call-accept") {
      const c = calls.get(String(d.id || ""));
      if (!canPutThrough(ws)) return sendTo(ws, { type: "studio-error", error: "Only the host or a co-host on air can put callers through." });
      if (!c || c.state !== "waiting" || c.kind !== "caller")
        return sendTo(ws, { type: "studio-error", error: "That person isn't waiting any more." });
      const err = putOnLine(c);
      if (err) sendTo(ws, { type: "studio-error", error: err });
      return;
    }
    if (d.type === "rtc") {
      const data = d.data;
      if (!data || typeof data !== "object" || JSON.stringify(data).length > 20000) return;
      if (ws.isHost && isHostWs(ws) && d.to) {                // host -> a person on the line
        const c = calls.get(String(d.to));
        if (c && c.state === "live") sendTo(c.ws, { type: "rtc", data });
      } else if (ws.callId) {                                  // person on the line -> host
        const c = calls.get(ws.callId);
        if (c && c.state === "live" && studio) sendTo(studio.ws, { type: "rtc", from: c.id, data });
      }
      return;
    }
    if (d.type === "call-end" || d.type === "call-cancel") {
      if (d.id) {   // staff ending/declining someone else's call
        const c = calls.get(String(d.id));
        if (c && (isHostWs(ws) || (c.state === "waiting" && canPutThrough(ws))))
          endCallById(c.id, c.state === "live" ? "The presenter ended the call. Thanks for calling!" : "Sorry, the studio couldn't take your call this time.");
      } else if (ws.callId) {
        endCallById(ws.callId, "");   // hanging up yourself
      }
      return;
    }

    if (d.type === "station-report") { stationReport(d); return; }

    /* ---- Meeting Room (its own portal socket, separate from the studio) ---- */
    if (d.type === "meeting-hello") {
      const u = d.token ? userFromToken(String(d.token)) : null;
      if (!u) return sendTo(ws, { type: "meeting", visible: false, auth: false });
      const firstWindow = !meetSockets().some((w) => w !== ws && w.meetId === u.id);
      ws.meetId = u.id;
      sendTo(ws, { type: "build", v: SITE_BUILD });   // the page refreshes itself after a deploy
      sendTo(ws, meetingView(u));
      if (meetingLive && canJoinMeeting(u) && (meetingLive.open || meetingLive.invited.has(u.id)) &&
          !meetPeople.has(u.id) && !meetingLive.declined.has(u.id) && !d.quiet)
        sendTo(ws, { type: "meeting-ring", by: meetingLive.by, direct: !meetingLive.open });
      if (firstWindow) pushMeeting();   // leaders' member lists show this person as online
      return;
    }
    if (typeof d.type === "string" && d.type.startsWith("meeting-")) {
      const u = ws.meetId ? db.users.find((x) => x.id === ws.meetId) : null;
      if (u && canSeeMeeting(u)) handleMeeting(ws, u, d);
      return;
    }

    // A listener's browser introduces itself with a private random id. We reply with a public
    // "who" hash so the page can tell which messages are its own, even after a rename.
    if (d.type === "hello") {
      const cid = cleanCid(d.cid);
      if (cid) { ws.cid = cid; sendTo(ws, { type: "you", who: whoOf(cid) }); }
      return;
    }
    // The listener changed their name: every earlier message of theirs shows the new name.
    if (d.type === "rename") {
      if (ws.staff || !ws.cid) return;
      const name = sanitize(d.name, 24).trim();
      if (name && renameChat(ws.cid, name)) broadcast(historyPayload());
      return;
    }

    if (d.type !== "chat") return;
    if (ws.staff) return;   // presenter sockets are read-only: no typed replies
    const name = sanitize(d.name, 24).trim() || "Guest";
    const text = sanitize(d.text, 500);
    if (!text) return;
    const cid = ws.cid || cleanCid(d.cid);
    if (cid && !ws.cid) ws.cid = cid;
    const renamed = cid ? renameChat(cid, name) : false;   // keep older messages in step with the current name
    const ts = Date.now();
    pushChat({ name, text, ts, cid });   // persist (without the "type" field)
    // If older messages changed name, resend the whole log (it already includes this message).
    if (renamed) broadcast(historyPayload());
    else broadcast({ type: "chat", name, text, ts, who: cid ? whoOf(cid) : "" });
  });
  ws.on("close", () => {
    if (ws.inMeeting && ws.meetId) meetingLeave(ws.meetId, ws);   // the page rejoins by itself if it reconnects
    else if (ws.meetId && !meetSockets().some((w) => w !== ws && w.meetId === ws.meetId)) pushMeeting();   // went offline
    // Don't end calls here: the page reconnects and resumes (see call-resume / host-start).
    if (ws.callId) {
      const c = calls.get(ws.callId);
      if (c && c.ws === ws) { c.ws = null; c.goneAt = Date.now(); pushStudio(); }
    }
    if (studio && studio.ws === ws) { studio.ws = null; studio.goneAt = Date.now(); pushStudio(); }
    else if (ws.staffId && ![...wss.clients].some((w) => w !== ws && isOpen(w) && w.staffId === ws.staffId)) pushStudio();   // went offline
    broadcast({ type: "presence", count: wss.clients.size });
  });
});

// Every minute, drop expired messages and refresh everyone's chat view.
setInterval(() => {
  if (pruneChat()) {
    saveChatSoon();
    broadcast(historyPayload());
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
