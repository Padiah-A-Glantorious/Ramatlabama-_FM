/* ============================================================
   Ramatlabama FM — On Air studio: going live from the portal, and the cart wall
   ------------------------------------------------------------
   GOING LIVE
   The presenter's browser mixes everything (decks, mic, callers, carts) and records it
   (MediaRecorder, Opus/AAC). The chunks come here over the page's WebSocket as binary
   messages. ffmpeg turns them into MP3 at the chosen quality, and we send that to the
   Famcast (Icecast) server as a "source", exactly like Miradio does.
     - Famcast details come from environment variables (never from the code):
         FAMCAST_SOURCE_PASSWORD   the source password (required to really go live)
         FAMCAST_SOURCE_URL        default https://sv2.famcast.co.za:8845/stream
         FAMCAST_SOURCE_USER       default "source"
       Without a password the studio runs in PREVIEW: staff can listen on
       /api/broadcast/listen, nothing reaches Famcast. That is how it's tested locally.
     - One presenter is live at a time. Managers may take over.
     - If the presenter's connection blips, the page reconnects and carries on: each new
       recording gets a fresh ffmpeg, and the MP3 frames continue on the same Famcast link.
   CART WALL
   Short audio (jingles, SFX, clips, ads) stored on the Disk, fired live from the desk.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

module.exports = function setupBroadcast(h) {
  const { userFromToken, sanitize, sendTo, isOpen, allSockets, canManage, DATA_DIR, sniffAudio, readRaw, readBody, sendJson, rid, AUDIO_MIME } = h;

  /* ---------------- ffmpeg + Famcast settings ---------------- */
  let FFMPEG = process.env.FFMPEG_PATH || "";
  if (!FFMPEG) { try { FFMPEG = require("ffmpeg-static") || ""; } catch (_) {} }
  if (!FFMPEG) FFMPEG = "ffmpeg";
  const SRC_URL = (process.env.FAMCAST_SOURCE_URL || "https://sv2.famcast.co.za:8845/stream").trim();
  const SRC_USER = (process.env.FAMCAST_SOURCE_USER || "source").trim();
  const SRC_PASS = (process.env.FAMCAST_SOURCE_PASSWORD || "").trim();
  const QUALITIES = [64, 96, 128, 192];
  const GONE_GRACE = 45 * 1000;      // presenter's page lost its connection: keep the show this long
  const MAX_CHUNK = 2 * 1024 * 1024;
  const MAX_PREVIEWS = 20;

  let bc = null;   // the live show (one at a time)
  const previews = new Set();

  const famcastReady = () => !!SRC_PASS;
  function view() {
    return {
      type: "bc-state", famcastReady: famcastReady(),
      live: bc ? {
        by: bc.name, userId: bc.userId, since: bc.since, kbps: bc.kbps, target: bc.target,
        connected: isOpen(bc.ws), receiving: Date.now() - bc.lastData < 5000,
        famcast: bc.target === "famcast" ? bc.ice.state : "off", error: bc.ice.error || bc.ffError || "",
        bytesIn: bc.bytesIn, bytesOut: bc.bytesOut,
      } : null,
    };
  }
  function push() {
    const v = view();
    for (const w of allSockets()) if (isOpen(w) && w.bcViewer) sendTo(w, v);
  }
  let pushTimer = null;
  function pushSoon() { if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = null; push(); }, 400); }

  /* ---------------- encoder ---------------- */
  function stopFfmpeg() {
    if (!bc || !bc.ff) return;
    const ff = bc.ff; bc.ff = null;
    try { ff.stdin.end(); } catch (_) {}
    setTimeout(() => { try { ff.kill("SIGKILL"); } catch (_) {} }, 3000);
  }
  function startFfmpeg() {
    const args = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "2", "-ar", "44100",
      "-c:a", "libmp3lame", "-b:a", bc.kbps + "k", "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3", "pipe:1"];
    let ff;
    try { ff = spawn(FFMPEG, args, { stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { bc.ffError = "The audio encoder (ffmpeg) isn't available on the server."; pushSoon(); return null; }
    bc.ff = ff; bc.ffError = "";
    let err = "";
    ff.stdout.on("data", onMp3);
    ff.stderr.on("data", (c) => { err = (err + c.toString()).slice(-400); });
    ff.stdin.on("error", () => {});
    ff.on("error", () => { if (bc && bc.ff === ff) { bc.ff = null; bc.ffError = "The audio encoder (ffmpeg) isn't available on the server."; pushSoon(); } });
    ff.on("close", (code) => {
      if (bc && bc.ff === ff) { bc.ff = null; if (code) { bc.ffError = "The encoder stopped (" + (err.trim().split("\n").pop() || code) + ")."; pushSoon(); } }
    });
    return ff;
  }
  function onMp3(chunk) {
    if (!bc) return;
    bc.bytesOut += chunk.length;
    for (const res of previews) { try { res.write(chunk); } catch (_) {} }
    if (bc.target === "famcast") iceWrite(chunk);
  }

  /* ---------------- Famcast (Icecast source over HTTP PUT) ---------------- */
  function iceWrite(chunk) {
    const ice = bc.ice;
    if (ice.fatal) return;
    if (!ice.req) { if (Date.now() >= ice.retryAt) iceConnect(); else return; }
    if (ice.req && ice.state !== "error") { try { ice.req.write(chunk); } catch (_) {} }
  }
  function iceConnect() {
    const ice = bc.ice;
    let u;
    try { u = new URL(SRC_URL); } catch (_) { ice.state = "error"; ice.error = "FAMCAST_SOURCE_URL isn't a valid address."; ice.fatal = true; pushSoon(); return; }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method: "PUT",
      headers: {
        Authorization: "Basic " + Buffer.from(SRC_USER + ":" + SRC_PASS).toString("base64"),
        "Content-Type": "audio/mpeg", "User-Agent": "RamatlabamaFM-Studio/1.0",
        "Ice-Name": "Ramatlabama FM", "Ice-Description": "Live from the Ramatlabama FM studio",
        "Ice-Public": "0", "Ice-Audio-Info": "bitrate=" + bc.kbps,
      },
    });
    const show = bc;
    ice.req = req; ice.state = "connecting"; ice.error = "";
    const okTimer = setTimeout(() => { if (show === bc && ice.req === req && ice.state === "connecting") { ice.state = "on"; pushSoon(); } }, 6000);
    const drop = (msg, retryMs, fatal) => {
      clearTimeout(okTimer);
      if (show !== bc || ice.req !== req) return;
      ice.req = null; ice.state = "error"; ice.error = msg; ice.fatal = !!fatal;
      ice.retryAt = Date.now() + (retryMs || 5000);
      try { req.destroy(); } catch (_) {}
      pushSoon();
    };
    req.on("response", (r) => {
      if (r.statusCode >= 200 && r.statusCode < 300) {
        clearTimeout(okTimer);
        if (show === bc && ice.req === req) { ice.state = "on"; ice.error = ""; pushSoon(); }
        r.on("end", () => drop("Famcast closed the connection. Reconnecting…", 2000));
        r.resume();
        return;
      }
      let body = "";
      r.on("data", (c) => { body = (body + c.toString()).slice(0, 300); });
      r.on("end", () => {
        if (r.statusCode === 401) drop("Famcast refused the source password. Check FAMCAST_SOURCE_PASSWORD.", 0, true);
        else if (r.statusCode === 403 || /in use/i.test(body)) drop("Famcast is busy: another studio (for example Miradio) is live on this stream. Stop it there; we keep trying.", 8000);
        else drop("Famcast answered " + r.statusCode + ". Retrying…", 8000);
      });
    });
    req.on("error", (e) => drop("Can't reach Famcast (" + (e.code || e.message) + "). Retrying…", 5000));
    req.flushHeaders();
    pushSoon();
  }
  function iceClose() {
    if (!bc || !bc.ice.req) return;
    try { bc.ice.req.end(); } catch (_) {}
    try { bc.ice.req.destroy(); } catch (_) {}
    bc.ice.req = null;
  }

  /* ---------------- the show ---------------- */
  function stopShow(reason) {
    if (!bc) return;
    const show = bc;
    stopFfmpeg(); iceClose();
    for (const res of previews) { try { res.end(); } catch (_) {} }
    previews.clear();
    bc = null;
    if (show.ws) { sendTo(show.ws, { type: "bc-ended", reason: reason || "" }); show.ws.bcOwner = false; }
    push();
  }
  setInterval(() => {
    if (bc && !isOpen(bc.ws) && bc.goneAt && Date.now() - bc.goneAt > GONE_GRACE) stopShow("The studio lost its connection.");
    else if (bc) pushSoon();   // keeps the byte counters and "receiving" fresh on screen
  }, 3000);

  function onWs(ws, d) {
    if (d.type === "bc-hello") {
      const u = d.token ? userFromToken(String(d.token)) : null;
      if (!u) return sendTo(ws, { type: "bc-error", error: "Log in again." });
      ws.bcViewer = u.id;
      sendTo(ws, view());
      return;
    }
    if (d.type === "bc-start") {
      const u = d.token ? userFromToken(String(d.token)) : null;
      if (!u) return sendTo(ws, { type: "bc-error", error: "Log in again to go live." });
      ws.bcViewer = u.id;
      if (bc && bc.userId !== u.id && (isOpen(bc.ws) || Date.now() - bc.goneAt < GONE_GRACE)) {
        if (d.force && canManage(u.role)) stopShow("Taken over by " + sanitize(u.name, 40) + ".");
        else return sendTo(ws, { type: "bc-error", busy: true, error: bc.name + " is live right now." + (canManage(u.role) ? " You can take over." : "") });
      }
      if (bc && bc.userId !== u.id) stopShow("");
      if (bc && bc.userId === u.id) {          // same presenter: a new recording (reconnect or another tab)
        if (bc.ws && bc.ws !== ws) { sendTo(bc.ws, { type: "bc-ended", reason: "You went live from another window." }); bc.ws.bcOwner = false; }
        stopFfmpeg();
        bc.ws = ws; bc.goneAt = 0;
      } else {
        const kbps = QUALITIES.includes(Number(d.kbps)) ? Number(d.kbps) : 128;
        const target = famcastReady() && d.target !== "preview" ? "famcast" : "preview";
        bc = { userId: u.id, name: sanitize(u.name, 40), ws, since: Date.now(), kbps, target, ff: null, ffError: "",
          ice: { req: null, state: "off", error: "", retryAt: 0, fatal: false }, bytesIn: 0, bytesOut: 0, lastData: 0, goneAt: 0 };
      }
      ws.bcOwner = true;
      sendTo(ws, { type: "bc-ok", target: bc.target, kbps: bc.kbps, since: bc.since, famcastReady: famcastReady() });
      push();
      return;
    }
    if (d.type === "bc-stop") {
      const u = d.token ? userFromToken(String(d.token)) : null;
      if (!bc || !u) return;
      if (bc.ws === ws || bc.userId === u.id || canManage(u.role)) stopShow(bc.userId === u.id ? "" : "Stopped by " + sanitize(u.name, 40) + ".");
      return;
    }
  }
  function onBinary(ws, buf) {
    if (!bc || bc.ws !== ws || !buf || buf.length > MAX_CHUNK) return;
    if (!bc.ff && !startFfmpeg()) return;
    bc.bytesIn += buf.length; bc.lastData = Date.now();
    try { bc.ff.stdin.write(buf); } catch (_) {}
  }
  function onClose(ws) {
    if (bc && bc.ws === ws) { bc.ws = null; bc.goneAt = Date.now(); stopFfmpeg(); push(); }
  }

  /* ---------------- cart wall ---------------- */
  const CARTS_DIR = path.join(DATA_DIR, "carts");
  const CARTS_FILE = path.join(DATA_DIR, "carts.json");
  try { fs.mkdirSync(CARTS_DIR, { recursive: true }); } catch (_) {}
  const CART_CATS = ["jingles", "sfx", "clips", "ads"];
  const CART_MAX_BYTES = 8 * 1024 * 1024, CART_MAX_COUNT = 150, CART_MAX_TOTAL = 250 * 1024 * 1024;
  let carts = { items: [] };
  try { const j = JSON.parse(fs.readFileSync(CARTS_FILE, "utf8").replace(/^\uFEFF/, "")); if (j && Array.isArray(j.items)) carts = j; } catch (_) {}
  carts.items = carts.items.filter((c) => { try { return fs.existsSync(path.join(CARTS_DIR, c.file)); } catch (_) { return false; } });
  const saveCarts = () => { try { fs.writeFileSync(CARTS_FILE, JSON.stringify(carts, null, 2)); } catch (_) {} };
  const cartView = (c) => ({ id: c.id, title: c.title, cat: c.cat, size: c.size || 0, by: c.by || "", byName: c.byName || "", url: "/carts/" + encodeURIComponent(c.file) });
  const canRemoveCart = (u, c) => !!u && (canManage(u.role) || (!!c.by && c.by === u.id));
  const cartsReply = (u) => ({ ok: true, carts: carts.items.map(cartView), meId: u.id, canManage: canManage(u.role) });

  async function onHttp(req, res, url, p) {
    /* ---- staff: listen to the show as it leaves the studio (preview / checking) ---- */
    if (p === "/api/broadcast/listen" && req.method === "GET") {
      const u = userFromToken(String(url.searchParams.get("t") || ""));
      if (!u) { res.writeHead(403); res.end("Forbidden"); return true; }
      if (!bc) { res.writeHead(404); res.end("Nobody is live"); return true; }
      if (previews.size >= MAX_PREVIEWS) { res.writeHead(503); res.end("Too many listeners"); return true; }
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      previews.add(res);
      req.on("close", () => previews.delete(res));
      return true;
    }
    if (p === "/api/carts/list" && req.method === "POST") {
      const body = await readBody(req);
      const u = body && body.token ? userFromToken(String(body.token)) : null;
      if (!u) { sendJson(res, 401, { ok: false, error: "Log in again." }); return true; }
      sendJson(res, 200, cartsReply(u)); return true;
    }
    if (p === "/api/carts/upload" && req.method === "POST") {
      const u = userFromToken(String(req.headers["x-token"] || ""));
      if (!u) { req.resume(); sendJson(res, 403, { ok: false, error: "Log in to add carts." }); return true; }
      if (carts.items.length >= CART_MAX_COUNT) { req.resume(); sendJson(res, 400, { ok: false, error: "The cart wall is full. Delete some first." }); return true; }
      let title = "", cat = "";
      try { title = sanitize(decodeURIComponent(String(req.headers["x-title"] || "")), 60).trim(); } catch (_) {}
      try { cat = decodeURIComponent(String(req.headers["x-cat"] || "")).toLowerCase(); } catch (_) {}
      if (!CART_CATS.includes(cat)) { req.resume(); sendJson(res, 400, { ok: false, error: "Choose Jingles, SFX, Clips or Ads." }); return true; }
      const buf = await readRaw(req, CART_MAX_BYTES);
      if (!buf) { sendJson(res, 413, { ok: false, error: "That file is too big (max 8 MB)." }); return true; }
      const used = carts.items.reduce((n, c) => n + (c.size || 0), 0);
      if (used + buf.length > CART_MAX_TOTAL) { sendJson(res, 400, { ok: false, error: "Cart storage is full. Delete some first." }); return true; }
      const ext = sniffAudio(buf);
      if (!ext) { sendJson(res, 400, { ok: false, error: "Use MP3, M4A or OGG audio files." }); return true; }
      const id = "ct" + Date.now().toString(36) + rid(3);
      const file = id + ext;
      try { fs.writeFileSync(path.join(CARTS_DIR, file), buf); } catch (_) { sendJson(res, 500, { ok: false, error: "Could not save the file." }); return true; }
      carts.items.push({ id, file, title: title || "Untitled", cat, size: buf.length, ts: Date.now(), by: u.id, byName: sanitize(u.name, 40) });
      saveCarts();
      sendJson(res, 200, cartsReply(u)); return true;
    }
    if (p === "/api/carts/delete" && req.method === "POST") {
      const body = await readBody(req);
      const u = body && body.token ? userFromToken(String(body.token)) : null;
      if (!u) { sendJson(res, 401, { ok: false, error: "Log in again." }); return true; }
      const c = carts.items.find((x) => x.id === String(body.id));
      if (c && !canRemoveCart(u, c)) { sendJson(res, 403, { ok: false, error: "You can only delete carts you added." }); return true; }
      if (c) {
        try { fs.unlinkSync(path.join(CARTS_DIR, c.file)); } catch (_) {}
        carts.items = carts.items.filter((x) => x.id !== c.id);
        saveCarts();
      }
      sendJson(res, 200, cartsReply(u)); return true;
    }
    if (p.startsWith("/carts/") && (req.method === "GET" || req.method === "HEAD")) {
      let name = "";
      try { name = path.basename(decodeURIComponent(p.slice("/carts/".length))); } catch (_) {}
      const fp = path.join(CARTS_DIR, name);
      if (!name || !fp.startsWith(CARTS_DIR + path.sep)) { res.writeHead(403); res.end("Forbidden"); return true; }
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); return res.end("Not found"); }
        res.writeHead(200, { "Content-Type": AUDIO_MIME[path.extname(name).toLowerCase()] || "application/octet-stream", "Cache-Control": "public, max-age=86400", "Content-Length": data.length });
        res.end(req.method === "HEAD" ? undefined : data);
      });
      return true;
    }
    return false;
  }

  return { onWs, onBinary, onClose, onHttp, isLive: () => !!bc };
};
