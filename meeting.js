/* ============================================================
   Ramatlabama FM — Portal "Meeting Room" tab
   - The God Admin shows/hides the tab for all members and picks meeting leaders.
   - A leader starts the meeting: every member with the portal open gets a call.
     Anyone who said "Not now" or left can (re)join while the meeting is on.
   - Microphone only (no video). Each person in the room is a round name tile, like a
     WhatsApp group call: it glows green while they talk and gold when their hand is up.
   - The screen shows the agenda PDF, or text / a picture a leader put up.
   Audio goes directly between the browsers in the room (WebRTC); the server only
   relays the connection messages. Fine for a staff meeting (everyone in the portal).
   ============================================================ */
(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const MIC = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false };

  let token = null, me = null, ws = null, st = null;   // st = latest meeting view from the server
  let inCall = false, joining = false, mic = null, muted = false;
  let actx = null;
  const meters = new Map();   // userId -> { an, buf }
  const pcs = new Map();      // peer userId -> { pc, audio, queue }
  let iceCache = null;
  let screenKey = "";
  let ringTimer = 0, ringCtx = null;
  let build = null, lastTyping = 0, callWhoKey = "";

  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  function say(id, text, ok) {
    const s = byId(id); if (!s) return;
    s.textContent = text || ""; s.style.color = ok === false ? "#ff6b5e" : ok === true ? "#3ecf6b" : "";
  }
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  const initials = (n) => String(n || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase() || "?";
  const clock = (t) => { const s = Math.max(0, Math.floor((Date.now() - t) / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return (h ? h + ":" + String(m).padStart(2, "0") : String(m).padStart(2, "0")) + ":" + String(s % 60).padStart(2, "0"); };
  async function ice() {
    if (iceCache) return iceCache;
    try { const j = await (await fetch("/api/ice", { cache: "no-store" })).json(); if (j && j.iceServers && j.iceServers.length) iceCache = j.iceServers; } catch (_) {}
    return iceCache || [{ urls: "stun:stun.l.google.com:19302" }];
  }

  /* ================= socket ================= */
  function connect() {
    ws = new WebSocket((location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host);
    ws.onopen = () => {
      send({ type: "meeting-hello", token, quiet: inCall });
      if (inCall) send({ type: "meeting-join", muted });   // back after a connection blip
    };
    ws.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.type === "build") onBuild(d.v);
      else if (d.type === "meeting") { st = d; render(); }
      else if (d.type === "meeting-ring") { if (!inCall) ring(d.by, d.direct); }
      else if (d.type === "meeting-note") say("meetState", d.text, true);
      else if (d.type === "meeting-ring-stop") stopRing();
      else if (d.type === "meeting-joined") onJoined(d.peers || []);
      else if (d.type === "meeting-peer-left") closePeer(d.id);
      else if (d.type === "meeting-signal" && d.from) onSignal(d.from, d.data || {});
      else if (d.type === "meeting-ended") {
        stopRing();
        if (inCall) leaveLocal(d.reason || ("The meeting has ended" + (d.by ? " (ended by " + d.by + ")." : ".")));
      }
      else if (d.type === "meeting-mirror") applyMirror(d);
      else if (d.type === "meeting-error") say("meetState", d.error, false);
    };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  /* ================= new version deployed ================= */
  // The server sends a fingerprint of the website files. If it changes while this page is
  // open, new code was deployed: refresh by itself when that's safe (not in a call, not
  // hosting the studio, not typing), otherwise show a "Refresh now" banner.
  function busyNow() {
    return inCall || joining || Date.now() - lastTyping < 2 * 60 * 1000 ||
      !!(window.RFM_STUDIO && window.RFM_STUDIO.busy && window.RFM_STUDIO.busy());
  }
  function onBuild(v) {
    if (!v) return;
    if (!build) { build = v; return; }
    if (v === build) return;
    if (!busyNow()) { location.reload(); return; }
    byId("updateBanner").hidden = false;
    const retry = setInterval(() => { if (!busyNow()) { clearInterval(retry); location.reload(); } }, 30000);
  }

  /* ================= joining & leaving ================= */
  // This tab hosts the studio lines (and is shared into Miradio), or is on air as a co-host.
  function onAirTab() { return !!(window.RFM_STUDIO && window.RFM_STUDIO.busy && window.RFM_STUDIO.busy()); }
  async function join() {
    if (inCall || joining) return;
    stopRing();
    if (onAirTab() && !confirm("You're hosting the studio from this tab, so the meeting's voices would go ON AIR through Miradio.\n\nJoin from another device or browser instead, or close the lines first.\n\nJoin here anyway?")) return;
    if (!window.RTCPeerConnection || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      return say("meetState", "This browser can't join calls. Use Chrome, Edge or Safari.", false);
    joining = true; render();
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      await actx.resume();
      mic = await navigator.mediaDevices.getUserMedia(MIC);
    } catch (_) {
      joining = false; render();
      return say("meetState", "Your microphone is blocked. Allow the microphone for this site, then press Join again.", false);
    }
    mic.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    addMeter(me.id, mic);
    inCall = true; joining = false;
    say("meetState", "");
    send({ type: "meeting-join", muted });
    openTab();
    render();
  }
  function leave() {
    send({ type: "meeting-leave" });
    leaveLocal("You left the meeting. You can rejoin while it's on.");
  }
  function leaveLocal(msg) {
    inCall = false; joining = false;
    stopShare(true); stopMirror(true); closeView(); viewShareId = ""; showOverlay(false);
    [...pcs.keys()].forEach(closePeer);
    if (mic) { mic.getTracks().forEach((t) => t.stop()); mic = null; }
    meters.clear();
    say("meetState", msg || "");
    render();
  }
  function openTab() {
    const b = byId("meetTabBtn");
    if (b && !b.hidden && !b.classList.contains("active")) b.click();
  }

  /* ================= audio connections (one per other person) ================= */
  function onJoined(peers) {   // we just came in: call everyone already in the room
    [...pcs.keys()].forEach(closePeer);
    peers.forEach((id) => makePc(id, true));
  }
  function closePeer(id) {
    const e = pcs.get(id);
    if (!e) return;
    pcs.delete(id);
    try { if (e.pc) e.pc.close(); } catch (_) {}
    if (e.audio) { try { e.audio.srcObject = null; e.audio.remove(); } catch (_) {} }
    meters.delete(id);
  }
  async function makePc(id, offerer) {
    if (!mic) return null;
    closePeer(id);
    const entry = { pc: null, audio: null, queue: [] };
    pcs.set(id, entry);   // set now, so connection messages that arrive meanwhile are kept
    const pc = new RTCPeerConnection({ iceServers: await ice() });
    if (pcs.get(id) !== entry || !mic) { pc.close(); return null; }
    entry.pc = pc;
    mic.getAudioTracks().forEach((t) => pc.addTrack(t, mic));
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: "meeting-signal", to: id, data: { ice: e.candidate } }); };
    pc.ontrack = (e) => {
      const stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
      if (!entry.audio) {
        entry.audio = document.createElement("audio");
        entry.audio.autoplay = true; entry.audio.setAttribute("playsinline", "");
        byId("meetAudio").appendChild(entry.audio);
      }
      entry.audio.srcObject = stream;
      entry.audio.play().catch(() => {});
      addMeter(id, stream);
    };
    pc.onconnectionstatechange = () => {
      if (pcs.get(id) !== entry) return;
      // Lost the connection: the person who called first calls again.
      if (pc.connectionState === "failed" && offerer && inCall) setTimeout(() => { if (pcs.get(id) === entry && inMeeting(id)) makePc(id, true); }, 1500);
      renderTiles();
    };
    if (offerer) {
      try {
        await pc.setLocalDescription(await pc.createOffer());
        send({ type: "meeting-signal", to: id, data: { sdp: pc.localDescription } });
      } catch (_) {}
    }
    return entry;
  }
  function flush(entry) { entry.queue.splice(0).forEach((c) => entry.pc.addIceCandidate(c).catch(() => {})); }
  async function onSignal(from, data) {
    if (data.screen) return onScreenSignal(from, data);
    if (!inCall || !mic) return;
    try {
      if (data.sdp && data.sdp.type === "offer") {
        const entry = await makePc(from, false);
        if (!entry) return;
        await entry.pc.setRemoteDescription(data.sdp);
        await entry.pc.setLocalDescription(await entry.pc.createAnswer());
        send({ type: "meeting-signal", to: from, data: { sdp: entry.pc.localDescription } });
        flush(entry);
      } else if (data.sdp && data.sdp.type === "answer") {
        const entry = pcs.get(from);
        if (!entry || !entry.pc) return;
        await entry.pc.setRemoteDescription(data.sdp);
        flush(entry);
      } else if (data.ice) {
        const entry = pcs.get(from);
        if (!entry) return;
        if (entry.pc && entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.ice).catch(() => {});
        else entry.queue.push(data.ice);
      }
    } catch (_) {}
  }
  const inMeeting = (id) => !!(st && st.people && st.people.some((p) => p.id === id));

  /* ================= God Admin screen share =================
     The God Admin shares a screen/window/tab with getDisplayMedia. Each other person in
     the room gets it over its own video-only connection (separate from the audio ones).
     While someone is sharing, everyone else sees ONLY that screen, filling their whole
     display, with a small bar to mute, raise a hand, change fit/fill and leave. */
  const canCaptureScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) &&
    !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  let shareStream = null;          // sharer: the captured screen
  const sharePcs = new Map();      // sharer: viewerId -> connection
  let viewPc = null, viewQueue = [], viewStream = null, viewShareId = "";
  let overlay = null, fillMode = false;
  let sharePendingUntil = 0;     // waiting for the server to confirm we are the sharer
  async function startShare() {
    if (shareStream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia)
      return say("meetState", "This browser cannot share the whole screen. Use 📱 Share my portal screen instead.", false);
    // Pick the screen first, while the click still counts (browsers need it), then join.
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false }); }
    catch (_) { return say("meetState", "Screen sharing was cancelled.", false); }
    if (!inCall) {
      if (!st.live) send({ type: "meeting-start" });   // no meeting yet: start one and call everyone
      await join();
      if (!inCall) { stream.getTracks().forEach((t) => t.stop()); return; }
    }
    if (mirrorOn) stopMirror();                      // only one kind of share at a time
    shareStream = stream;
    const tr = shareStream.getVideoTracks()[0];
    if (tr) { try { tr.contentHint = "detail"; } catch (_) {} tr.onended = () => stopShare(); }
    sharePendingUntil = Date.now() + 8000;
    send({ type: "meeting-share", on: true });
    say("meetState", "🖥 You are sharing your screen. Everyone in the room sees only it.", true);
    render();
  }
  function stopShare(quiet) {
    const was = !!shareStream;
    if (shareStream) { shareStream.getTracks().forEach((t) => { t.onended = null; try { t.stop(); } catch (_) {} }); shareStream = null; }
    [...sharePcs.keys()].forEach((id) => { try { sharePcs.get(id).close(); } catch (_) {} sharePcs.delete(id); });
    if (was && !quiet) { send({ type: "meeting-share", on: false }); say("meetState", "Screen sharing stopped.", true); render(); }
  }
  async function makeSharePc(viewerId) {
    const old = sharePcs.get(viewerId); if (old) { try { old.close(); } catch (_) {} }
    const pc = new RTCPeerConnection({ iceServers: await ice() });
    if (!shareStream) { pc.close(); return; }
    sharePcs.set(viewerId, pc);
    shareStream.getVideoTracks().forEach((t) => pc.addTrack(t, shareStream));
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: "meeting-signal", to: viewerId, data: { screen: true, ice: e.candidate } }); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === "closed" || pc.connectionState === "failed") { if (sharePcs.get(viewerId) === pc) sharePcs.delete(viewerId); } };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      send({ type: "meeting-signal", to: viewerId, data: { screen: true, sdp: pc.localDescription } });
    } catch (_) {}
  }
  async function onScreenSignal(from, data) {
    if (!inCall) return;
    try {
      if (data.screen === "want") { if (shareStream) makeSharePc(from); return; }
      if (data.sdp && data.sdp.type === "offer") {             // viewer: the sharer is sending
        if (!viewShareId || viewShareId !== from + "|video") return;
        if (viewPc) { try { viewPc.close(); } catch (_) {} }
        const pc = viewPc = new RTCPeerConnection({ iceServers: await ice() });
        viewQueue = [];
        pc.onicecandidate = (e) => { if (e.candidate) send({ type: "meeting-signal", to: from, data: { screen: true, ice: e.candidate } }); };
        pc.ontrack = (e) => { viewStream = (e.streams && e.streams[0]) || new MediaStream([e.track]); attachView(); };
        await pc.setRemoteDescription(data.sdp);
        viewQueue.splice(0).forEach((c) => pc.addIceCandidate(c).catch(() => {}));
        await pc.setLocalDescription(await pc.createAnswer());
        send({ type: "meeting-signal", to: from, data: { screen: true, sdp: pc.localDescription } });
      } else if (data.sdp && data.sdp.type === "answer") {      // sharer: a viewer answered
        const pc = sharePcs.get(from);
        if (pc) await pc.setRemoteDescription(data.sdp);
      } else if (data.ice) {
        const pc = shareStream ? sharePcs.get(from) : viewPc;
        if (pc && pc.remoteDescription) await pc.addIceCandidate(data.ice).catch(() => {});
        else if (!shareStream) viewQueue.push(data.ice);
      }
    } catch (_) {}
  }
  function closeView() {
    if (viewPc) { try { viewPc.close(); } catch (_) {} viewPc = null; }
    viewStream = null; viewQueue = [];
    if (overlay) { const v = overlay.querySelector("video"); if (v) v.srcObject = null; overlay.classList.remove("has-video"); }
    if (mirror.frame) { try { mirror.frame.remove(); } catch (_) {} }
    Object.assign(mirror, { got: false, head: "", body: "", cls: "", hcls: "", w: 0, h: 0, scrolls: {}, applied: "", frame: null, ready: false, loading: false });
  }
  function buildOverlay() {
    if (overlay) return overlay;
    overlay = el("div", "meet-share-overlay"); overlay.id = "meetShareOverlay"; overlay.hidden = true;
    const v = el("video", "meet-share-video"); v.autoplay = true; v.muted = true; v.setAttribute("playsinline", "");
    const msg = el("div", "meet-share-msg", "Connecting to the shared screen…");
    const bar = el("div", "meet-share-bar");
    const label = el("span", "meet-share-label", "");
    const mk = (id, text, fn) => { const b = el("button", "m-btn", text); b.type = "button"; b.id = id; b.onclick = fn; return b; };
    bar.append(label,
      mk("shMute", "🔇 Mute", () => byId("meetMuteBtn").click()),
      mk("shHand", "✋ Raise hand", () => byId("meetHandBtn").click()),
      mk("shFit", "⤢ Fit", () => { fillMode = !fillMode; overlay.classList.toggle("fill", fillMode); byId("shFit").textContent = fillMode ? "⤡ Show all" : "⤢ Fill"; layoutMirror(); }),
      mk("shLeave", "Leave", () => leave()));
    overlay.append(v, msg, bar);
    document.body.appendChild(overlay);
    byId("shFit").textContent = "⤢ Fill";
    return overlay;
  }
  function attachView() {
    const o = buildOverlay(), v = o.querySelector("video");
    if (viewStream) { v.srcObject = viewStream; v.play().catch(() => {}); }
    o.classList.toggle("has-video", !!viewStream);
  }
  function showOverlay(on) {
    if (!overlay && !on) return;
    const o = buildOverlay();
    o.hidden = !on;
    document.body.classList.toggle("meet-sharing", !!on);
    if (on) { try { if (!document.fullscreenElement && o.requestFullscreen) o.requestFullscreen().catch(() => {}); } catch (_) {} }
    else if (document.fullscreenElement === o) { try { document.exitFullscreen(); } catch (_) {} }
  }
  // Called on every render: follow who is sharing (if anyone) and show / hide the full-screen view.
  function syncShare() {
    const s = st && st.sharing;
    if (s && s.id === me.id) sharePendingUntil = 0;
    const late = Date.now() > sharePendingUntil;
    // The server says we are no longer sharing (in this mode): stop.
    if (shareStream && !(s && s.id === me.id && s.mode !== "page") && late) stopShare(true);
    if (mirrorOn && !(s && s.id === me.id && s.mode === "page") && late) stopMirror(true);
    if (s && inCall && s.id !== me.id) {
      const key = s.id + "|" + (s.mode || "video");
      if (viewShareId !== key) {
        closeView(); viewShareId = key;
        if (s.mode === "page") send({ type: "meeting-mirror-want" });
        else send({ type: "meeting-signal", to: s.id, data: { screen: "want" } });
      }
      const o = buildOverlay();
      o.classList.toggle("page-mode", s.mode === "page");
      const label = o.querySelector(".meet-share-label");
      label.textContent = "🖥 " + String(s.name || "").split(" ")[0] + " is sharing";
      label.title = s.name + " is sharing their screen";
      byId("shMute").textContent = muted ? "🎤 Unmute" : "🔇 Mute";
      const mine = (st.people || []).find((p) => p.id === me.id);
      byId("shHand").textContent = mine && mine.hand ? "✋ Lower hand" : "✋ Raise hand";
      showOverlay(true);
    } else {
      if (viewShareId) { viewShareId = ""; closeView(); }
      showOverlay(false);
    }
  }
  // Ask again if the picture hasn't arrived (lost message, sharer reconnecting).
  setInterval(() => {
    if (!viewShareId || !inCall) return;
    const [id, mode] = viewShareId.split("|");
    if (mode === "page") { if (!mirror.got) send({ type: "meeting-mirror-want" }); }
    else if (!viewStream) send({ type: "meeting-signal", to: id, data: { screen: "want" } });
  }, 4000);

  /* ================= God Admin: share the PORTAL page (works on phones) =================
     Phone browsers can't capture the screen, so instead the God Admin's page sends a live
     copy of itself (what's on the page, typed values, scroll positions, window size) about
     once a second when something changes. Everyone else draws that copy at the God Admin's
     exact window size, scaled to fill their own screen. The copy can't run any code
     (sandboxed frame, no scripts) and can't be clicked. The God Admin's login token is
     taken out of it; each viewer's own token is put back so pictures still load. */
  let mirrorOn = false, mirrorObs = null, mirrorTimer = 0, mirrorQueued = 0, mirrorLastAt = 0, mirrorSeq = 0;
  let mirrorSent = { head: "", body: "", cls: "", hcls: "", w: 0, h: 0, sc: "" };
  const mirror = { got: false, head: "", body: "", cls: "", hcls: "", w: 0, h: 0, scrolls: {}, applied: "", frame: null, ready: false };
  const T_MARK = "__RFM_T__";
  async function startMirror() {
    if (mirrorOn || !st || !st.isGod) return;
    if (!inCall) {
      if (!st.live) send({ type: "meeting-start" });   // no meeting yet: start one and call everyone
      await join();
      if (!inCall) return;
    }
    if (shareStream) stopShare();                    // only one kind of share at a time
    mirrorOn = true;
    mirrorSent = { head: "", body: "", cls: "", hcls: "", w: 0, h: 0, sc: "" };
    sharePendingUntil = Date.now() + 8000;
    send({ type: "meeting-share", on: true, mode: "page" });
    mirrorObs = new MutationObserver(queueMirror);
    mirrorObs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    ["scroll", "input", "change", "resize"].forEach((ev) => window.addEventListener(ev, queueMirror, true));
    mirrorTimer = setInterval(queueMirror, 3000);
    queueMirror();
    say("meetState", "📱 Everyone in the room now sees your portal screen. Use the portal as normal; press Stop sharing when done.", true);
    render();
  }
  function stopMirror(quiet) {
    if (!mirrorOn) return;
    mirrorOn = false;
    if (mirrorObs) { mirrorObs.disconnect(); mirrorObs = null; }
    ["scroll", "input", "change", "resize"].forEach((ev) => window.removeEventListener(ev, queueMirror, true));
    clearInterval(mirrorTimer); clearTimeout(mirrorQueued); mirrorQueued = 0;
    if (!quiet) { send({ type: "meeting-share", on: false }); say("meetState", "Screen sharing stopped.", true); render(); }
  }
  function queueMirror() {
    if (!mirrorOn || mirrorQueued) return;
    mirrorQueued = setTimeout(() => { mirrorQueued = 0; sendMirror(); }, Math.max(250, 1000 - (Date.now() - mirrorLastAt)));
  }
  function snapshotBody() {
    const src = document.body, clone = src.cloneNode(true);
    const a = src.querySelectorAll("*"), b = clone.querySelectorAll("*");
    const scrolls = {};
    for (let i = 0; i < a.length && i < b.length; i++) {
      const o = a[i], c = b[i], tag = o.tagName;
      if (tag === "INPUT") {
        const ty = (o.type || "").toLowerCase();
        if (ty === "password") c.setAttribute("value", "");
        else if (ty === "checkbox" || ty === "radio") { if (o.checked) c.setAttribute("checked", ""); else c.removeAttribute("checked"); }
        else if (ty !== "file") c.setAttribute("value", o.value);
      } else if (tag === "TEXTAREA") c.textContent = o.value;
      else if (tag === "SELECT") [...c.options].forEach((op, j) => { if (j === o.selectedIndex) op.setAttribute("selected", ""); else op.removeAttribute("selected"); });
      else if (tag === "CANVAS") {
        try {
          const img = document.createElement("img");
          img.className = o.className; img.setAttribute("style", o.getAttribute("style") || "");
          img.src = o.toDataURL("image/jpeg", 0.6);
          c.replaceWith(img);
        } catch (_) {}
      }
      if (o.scrollTop || o.scrollLeft) { c.setAttribute("data-rfm-s", String(i)); scrolls[i] = [o.scrollTop, o.scrollLeft]; }
    }
    // Leave out things that can't or mustn't be copied.
    clone.querySelectorAll("script, noscript, audio, video, #meetShareOverlay, #meetAudio, #meetRing").forEach((n) => n.remove());
    clone.querySelectorAll("iframe").forEach((n) => { const d = document.createElement("div"); d.className = n.className; d.setAttribute("style", (n.getAttribute("style") || "") + ";background:#111"); n.replaceWith(d); });
    const se = document.scrollingElement || document.documentElement;
    scrolls.doc = [se.scrollTop, se.scrollLeft];
    scrolls.body = [src.scrollTop, src.scrollLeft];   // the portal page scrolls inside <body>, not the window
    let html = clone.innerHTML;
    // Never hand the God Admin's login token to anyone.
    if (token) html = html.split(encodeURIComponent(token)).join(T_MARK).split(token).join(T_MARK);
    return { html, scrolls };
  }
  function sendMirror() {
    if (!mirrorOn || !inCall) return;
    mirrorLastAt = Date.now();
    let snap;
    try { snap = snapshotBody(); } catch (_) { return; }
    const head = [...document.head.querySelectorAll('link[rel="stylesheet"], style')].map((n) => n.outerHTML).join("");
    const msg = { type: "meeting-mirror", seq: ++mirrorSeq, w: window.innerWidth, h: window.innerHeight, scrolls: snap.scrolls };
    const cls = document.body.className, hcls = document.documentElement.className, sc = JSON.stringify(snap.scrolls);
    let changed = msg.w !== mirrorSent.w || msg.h !== mirrorSent.h || sc !== mirrorSent.sc;
    if (head !== mirrorSent.head) { msg.head = head; changed = true; }
    if (snap.html !== mirrorSent.body || cls !== mirrorSent.cls || hcls !== mirrorSent.hcls) { msg.body = snap.html; msg.cls = cls; msg.hcls = hcls; changed = true; }
    if (!changed) return;
    if (msg.body && msg.body.length > 3500000) { say("meetState", "This page is too big to share. Close big pictures or the agenda first.", false); return; }
    mirrorSent = { head, body: snap.html, cls, hcls, w: msg.w, h: msg.h, sc };
    send(msg);
  }

  // Viewer: draw the God Admin's page copy, at their window size, scaled to our screen.
  function applyMirror(d) {
    const s = st && st.sharing;
    if (!s || s.mode !== "page" || s.id === me.id || !inCall) return;
    const o = buildOverlay();
    if (!mirror.frame) {
      const f = document.createElement("iframe");
      f.className = "meet-mirror-frame";
      f.setAttribute("sandbox", "allow-same-origin");   // no scripts can run inside
      f.setAttribute("tabindex", "-1"); f.setAttribute("aria-label", "Shared screen");
      o.insertBefore(f, o.firstChild);
      mirror.frame = f; mirror.ready = false;
    }
    let reload = !mirror.ready && !mirror.loading;
    if (typeof d.head === "string" && d.head !== mirror.head) { mirror.head = d.head; reload = true; }
    if (typeof d.body === "string") {
      mirror.body = d.body.split(T_MARK).join(encodeURIComponent(token || ""));
      mirror.cls = String(d.cls || ""); mirror.hcls = String(d.hcls || "");
    }
    if (d.w) mirror.w = d.w;
    if (d.h) mirror.h = d.h;
    if (d.scrolls && typeof d.scrolls === "object") mirror.scrolls = d.scrolls;
    if (!mirror.body) return;
    mirror.got = true;
    o.classList.add("has-video");
    if (mirror.loading && !reload) return;   // the frame is still loading: it draws the latest copy when ready
    if (reload) {
      mirror.ready = false; mirror.loading = true; mirror.applied = "";
      mirror.frame.onload = () => { mirror.loading = false; mirror.ready = true; fillMirror(); };
      mirror.frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><base href="' + location.origin + '/">' + mirror.head +
        // No clicks, and no animations: they would replay on every update and make the copy flicker.
        "<style>*,*::before,*::after{pointer-events:none!important;animation:none!important;transition:none!important;caret-color:transparent!important}" +
        "html,body,*{scrollbar-width:none!important}::-webkit-scrollbar{display:none!important}</style>" +
        "</head><body></body></html>";
    } else fillMirror();
  }
  function fillMirror() {
    const f = mirror.frame;
    const doc = f && f.contentDocument;
    if (!doc || !doc.body) return;
    if (mirror.applied !== mirror.body) {
      if (!mirror.applied) doc.body.innerHTML = mirror.body;       // first copy: draw it all
      else {                                                       // later: change only what changed
        const next = doc.createElement("body");
        next.innerHTML = mirror.body;
        morph(doc.body, next);
      }
      mirror.applied = mirror.body;
    }
    doc.body.className = mirror.cls; doc.documentElement.className = mirror.hcls;
    layoutMirror();
    for (const k of Object.keys(mirror.scrolls)) {
      const v = mirror.scrolls[k];
      if (!Array.isArray(v)) continue;
      const n = k === "doc" ? (doc.scrollingElement || doc.documentElement) : k === "body" ? doc.body : doc.querySelector('[data-rfm-s="' + k + '"]');
      if (n) { n.scrollTop = v[0] || 0; n.scrollLeft = v[1] || 0; }
    }
  }
  // Bring the drawn copy (`to`) in line with the new copy (`from`), touching only what
  // differs. Unchanged pictures, scroll positions and layout stay put, so nothing flashes.
  function morph(to, from) {
    if (to.nodeType === 1 && to !== to.ownerDocument.body) {
      for (const a of [...to.attributes]) if (!from.hasAttribute(a.name)) to.removeAttribute(a.name);
      for (const a of [...from.attributes]) if (to.getAttribute(a.name) !== a.value) to.setAttribute(a.name, a.value);
    }
    const want = [...from.childNodes];
    for (let i = 0; i < want.length; i++) {
      const f = want[i], t = to.childNodes[i];
      if (!t) { to.appendChild(f); continue; }
      if (t.nodeType !== f.nodeType || t.nodeName !== f.nodeName || (t.nodeType === 1 && t.id !== f.id)) { to.replaceChild(f, t); continue; }
      if (t.nodeType !== 1) { if (t.nodeValue !== f.nodeValue) t.nodeValue = f.nodeValue; continue; }
      morph(t, f);
    }
    while (to.childNodes.length > want.length) to.removeChild(to.lastChild);
  }
  // The frame is exactly the God Admin's window size (so the page lays out the same),
  // then scaled to fill this screen: "Show all" fits it inside, "Fill" covers edge to edge.
  function layoutMirror() {
    const f = mirror.frame;
    if (!f || !mirror.w || !mirror.h) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const s = fillMode ? Math.max(vw / mirror.w, vh / mirror.h) : Math.min(vw / mirror.w, vh / mirror.h);
    f.style.width = mirror.w + "px"; f.style.height = mirror.h + "px";
    f.style.transform = "translate(-50%, -50%) scale(" + s + ")";
  }
  window.addEventListener("resize", () => { if (mirror.frame) layoutMirror(); });
  // A new person joined while sharing: they ask for the picture themselves (see syncShare).
  /* ================= talking glow ================= */
  function addMeter(id, stream) {
    if (!actx) return;
    try {
      const an = actx.createAnalyser(); an.fftSize = 512;
      actx.createMediaStreamSource(stream).connect(an);   // analyser only: nothing goes to the speakers here
      meters.set(id, { an, buf: new Uint8Array(an.fftSize) });
    } catch (_) {}
  }
  function level(m) {
    m.an.getByteTimeDomainData(m.buf);
    let sum = 0;
    for (let i = 0; i < m.buf.length; i++) { const v = (m.buf[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / m.buf.length);
  }
  setInterval(() => {
    if (!inCall) return;
    document.querySelectorAll("#meetTiles .meet-tile").forEach((t) => {
      const id = t.dataset.id, m = meters.get(id);
      const p = st && st.people ? st.people.find((x) => x.id === id) : null;
      const talking = !!m && !(p && p.muted) && !(id === me.id && muted) && level(m) > 0.035;
      t.classList.toggle("speaking", talking);
    });
  }, 150);

  /* ================= ringing ================= */
  function ring(by, direct) {
    if (!st || !st.visible || inCall || joining) return;   // never ring someone who is already joining
    byId("meetRingTitle").textContent = direct
      ? "📞 " + (by || "A leader") + " is calling you"
      : "🤝 " + (by ? by + " is calling a meeting" : "Meeting call");
    byId("meetRing").hidden = false;
    try { if (navigator.vibrate) navigator.vibrate([400, 200, 400]); } catch (_) {}
    clearInterval(ringTimer);
    // Hosting the studio: this tab's sound goes ON AIR through Miradio's TAB share, so never beep.
    if (onAirTab()) { byId("meetRingTitle").textContent += " (silent: you're hosting the studio)"; return; }
    const beep = () => {
      try {
        ringCtx = ringCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (ringCtx.state === "suspended") ringCtx.resume().catch(() => {});
        [0, 0.35].forEach((at) => {
          const o = ringCtx.createOscillator(), g = ringCtx.createGain();
          o.frequency.value = 660; g.gain.value = 0.08;
          o.connect(g); g.connect(ringCtx.destination);
          o.start(ringCtx.currentTime + at); o.stop(ringCtx.currentTime + at + 0.25);
        });
      } catch (_) {}
    };
    beep();
    let n = 0;
    ringTimer = setInterval(() => { if (++n > 15) return stopRing(); beep(); }, 2500);   // rings about 40 s
  }
  function stopRing() {
    clearInterval(ringTimer); ringTimer = 0;
    const b = byId("meetRing"); if (b) b.hidden = true;
  }

  /* ================= render ================= */
  function render() {
    const tab = byId("meetTabBtn");
    if (!st || !st.visible) {
      tab.hidden = true;
      if (tab.classList.contains("active")) { const c = document.querySelector('.ptab[data-tab="chat"]'); if (c) c.click(); }
      if (inCall) leaveLocal("The Meeting Room was closed.");
      stopRing();
      return;
    }
    tab.hidden = false;
    const live = st.live;
    const people = st.people || [];
    byId("meetBadge").textContent = live ? String(people.length || "•") : "";
    if (!live) stopRing();

    // God Admin settings
    byId("meetAdmin").hidden = !st.isGod;
    if (st.isGod) renderAdmin();

    // Status + buttons
    byId("meetTitle").textContent = !live ? "Meeting Room" : live.open ? "🟢 Meeting in progress" : "🔒 Private call in progress";
    say("meetStatus", statusText());
    const show = (id, on) => { byId(id).hidden = !on; };
    // God Admin: one clear button to show/hide the Meeting Room for every member.
    show("meetVisBtn", !!st.isGod);
    byId("meetVisBtn").textContent = st.enabled ? "🙈 Hide from members" : "👁 Show to all members";
    byId("meetVisBtn").classList.toggle("on", !!st.enabled);
    show("meetStartBtn", st.canLead);
    byId("meetStartBtn").textContent = !live ? "📞 Start meeting & call everyone" : live.open ? "📞 Call everyone again" : "📞 Open to everyone & call all";
    show("meetCallOne", st.canLead);
    if (st.canLead) renderCallWho();
    show("meetJoinBtn", !!live && live.canJoin && !inCall);
    byId("meetJoinBtn").textContent = joining ? "Joining…" : "🎤 Join meeting";
    byId("meetJoinBtn").disabled = joining;
    show("meetMuteBtn", inCall);
    byId("meetMuteBtn").textContent = muted ? "🎤 Unmute" : "🔇 Mute";
    const mine = people.find((p) => p.id === me.id);
    show("meetHandBtn", inCall);
    byId("meetHandBtn").textContent = mine && mine.hand ? "✋ Lower hand" : "✋ Raise hand";
    byId("meetHandBtn").classList.toggle("on", !!(mine && mine.hand));
    show("meetLeaveBtn", inCall);
    show("meetEndBtn", st.canLead && !!live);
    byId("meetControls").hidden = !st.canPresent;   // only presenters can put things on the screen

    byId("meetCount").textContent = people.length ? "(" + people.length + ")" : "";
    renderTiles();
    renderScreen();
    const sb = byId("meetShareBtn");
    // God Admin: always there (they join the meeting for you). Whole-screen sharing only
    // works on computers; sharing the portal page works everywhere, phones included.
    sb.hidden = !st.isGod || !canCaptureScreen;
    sb.textContent = shareStream ? "⏹ Stop sharing screen" : "🖥 Share my whole screen";
    sb.classList.toggle("on", !!shareStream);
    const pb = byId("meetMirrorBtn");
    pb.hidden = !st.isGod;
    pb.textContent = mirrorOn ? "⏹ Stop sharing" : "📱 Share my portal screen";
    pb.classList.toggle("on", mirrorOn);
    syncShare();
  }

  function statusText() {
    const live = st && st.live;
    if (!live) return st && st.canLead
      ? "No meeting right now. Call everyone, or pick one member and press Call."
      : "No meeting right now. You'll get a call when one starts.";
    const n = (st.people || []).length;
    const base = (live.open ? "Started by " : "Private call by ") + live.by + " · " + clock(live.startedAt) + " · " + n + " in the room";
    return live.canJoin ? base : base + ". Only the people who were called can join.";
  }
  // Leaders: pick one member to call. ● = has the portal open now.
  function renderCallWho() {
    const sel = byId("meetCallWho");
    const inRoom = new Set((st.people || []).map((p) => p.id));
    const list = (st.members || []).filter((m) => m.id !== me.id && !inRoom.has(m.id))
      .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    const key = list.map((m) => m.id + (m.online ? "1" : "0")).join(",");
    if (key === callWhoKey) return;   // unchanged: don't close a dropdown that's open
    callWhoKey = key;
    const keep = sel.value;
    sel.innerHTML = "";
    const first = el("option", null, list.length ? "Call one person…" : "Everyone is in"); first.value = ""; sel.appendChild(first);
    list.forEach((m) => {
      // Short labels: a long option makes the list wider than a phone screen.
      const o = el("option", null, (m.online ? "● " : "○ ") + m.name);
      o.title = m.name + (m.title ? " · " + m.title : "") + (m.online ? " · portal open" : " · portal closed");
      o.value = m.id; sel.appendChild(o);
    });
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }

  function renderTiles() {
    const wrap = byId("meetTiles");
    if (!st) return;
    const people = [...(st.people || [])].sort((a, b) =>
      (b.hand - a.hand) || (a.hand && b.hand ? a.handAt - b.handAt : a.joinedAt - b.joinedAt));
    wrap.innerHTML = "";
    if (!people.length) { wrap.appendChild(el("p", "edit-empty", st.live ? "Nobody has joined yet." : "Nobody is in the meeting.")); return; }
    people.forEach((p) => {
      const t = el("div", "meet-tile" + (p.hand ? " hand" : "") + (p.muted ? " muted" : ""));
      t.dataset.id = p.id;
      const e = p.id !== me.id ? pcs.get(p.id) : null;
      if (inCall && e && e.pc && e.pc.connectionState && e.pc.connectionState !== "connected") t.classList.add("connecting");
      const av = el("div", "meet-avatar", initials(p.name));
      if (p.hand) av.appendChild(el("span", "meet-hand-badge", "✋"));
      if (p.muted) av.appendChild(el("span", "meet-mute-badge", "🔇"));
      t.appendChild(av);
      t.appendChild(el("div", "meet-name", p.id === me.id ? p.name + " (you)" : p.name));
      t.appendChild(el("div", "meet-sub", p.presenter ? "Presenter" : p.lead ? "Leader" : (p.title || "")));
      // God Admin: grant / remove presenting right here, during the meeting.
      if (st.isGod && p.id !== me.id) {
        const b = el("button", "m-btn meet-tile-btn" + (p.presenter ? " on" : ""), p.presenter ? "✖ Stop presenting" : "🖥 Let present");
        b.type = "button";
        b.onclick = (ev) => { ev.stopPropagation(); send({ type: "meeting-presenter", id: p.id, on: !p.presenter }); };
        t.appendChild(b);
      }
      // Leaders can lower someone else's hand once it has been answered.
      if (p.hand && st.canLead && p.id !== me.id && inCall) {
        t.title = "Lower " + p.name + "'s hand";
        t.classList.add("clickable");
        t.onclick = () => { if (confirm("Lower " + p.name + "'s hand?")) send({ type: "meeting-hand", id: p.id, up: false }); };
      }
      wrap.appendChild(t);
    });
  }

  /* ---- Agenda PDF: drawn with PDF.js (served from our own site) so every page is
     exactly as wide as the screen, on any phone. Browsers' own PDF viewers don't do that
     (iPhones show page 1 only, many Android phones won't show it inside a page at all). */
  const PDFJS = "assets/pdfjs-3.11.174/";
  let pdfLib = null, pdfDoc = null, pdfSrc = "", pdfJob = 0, pdfWidth = 0, pdfMode = "";
  function loadPdfLib() {
    if (pdfLib) return pdfLib;
    pdfLib = new Promise((resolve, reject) => {
      if (window.pdfjsLib) { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js"; return resolve(window.pdfjsLib); }
      const s = document.createElement("script");
      s.src = PDFJS + "pdf.min.js";
      s.onload = () => {
        if (!window.pdfjsLib) { pdfLib = null; return reject(new Error("PDF reader missing")); }
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js";
        resolve(window.pdfjsLib);
      };
      s.onerror = () => { pdfLib = null; reject(new Error("PDF reader didn't load")); };
      document.head.appendChild(s);
    });
    return pdfLib;
  }
  async function showPdf(box, src) {
    const job = ++pdfJob;
    const status = el("p", "edit-empty", "Loading the agenda…");
    const pages = el("div", "meet-pdf-pages"); pages.id = "meetPdfPages";
    box.append(status, pages);
    try {
      const lib = await loadPdfLib();
      if (pdfSrc !== src || !pdfDoc) {
        if (pdfDoc) { try { pdfDoc.destroy(); } catch (_) {} pdfDoc = null; }
        pdfDoc = await lib.getDocument({ url: src }).promise;
        pdfSrc = src;
      }
      if (job !== pdfJob) return;
      // Pull the words out of the PDF and show them like the On Air table, in the site font.
      let rows = [];
      try { rows = await extractRows(pdfDoc, job); } catch (_) { rows = []; }
      if (job !== pdfJob) return;
      status.remove();
      if (rows.length) { pdfMode = "text"; drawText(pages, rows); return; }
      pdfMode = "canvas";           // scanned / picture-only PDF: no words to extract, draw the pages
      await drawPages(pages, job);
    } catch (_) {
      if (job !== pdfJob) return;
      status.textContent = "The agenda couldn't be shown here. Press “↗ Open agenda” to read it.";
    }
  }
  /* ---- Words from the PDF, laid out like the On Air table ----
     Text items are grouped into lines by their height on the page. Words that sit far
     apart on a line become separate cells (time | show | host). Lines with one cell are
     headings (if the letters are bigger than usual) or paragraphs. */
  async function extractRows(doc, job) {
    const rows = [], sizes = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      if (job !== pdfJob) return [];
      const items = tc.items
        .filter((i) => typeof i.str === "string" && i.str.trim() !== "")
        .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0, h: Math.abs(i.height || i.transform[3]) || 10 }));
      items.sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x));
      const lines = [];
      for (const it of items) {
        const ln = lines.length ? lines[lines.length - 1] : null;
        if (ln && Math.abs(ln.y - it.y) <= Math.max(2, ln.h * 0.5)) { ln.items.push(it); ln.h = Math.max(ln.h, it.h); }
        else lines.push({ y: it.y, h: it.h, items: [it] });
      }
      for (const ln of lines) {
        ln.items.sort((a, b) => a.x - b.x);
        const cells = []; let prevEnd = null, cur = null;
        for (const it of ln.items) {
          const gap = prevEnd === null ? 0 : it.x - prevEnd;
          if (cur === null || gap > ln.h * 1.2) { cur = { t: it.s }; cells.push(cur); }
          else cur.t += (gap > ln.h * 0.15 && !/\s$/.test(cur.t) && !/^\s/.test(it.s) ? " " : "") + it.s;
          prevEnd = it.x + it.w;
        }
        const texts = cells.map((c) => c.t.replace(/\s+/g, " ").trim()).filter(Boolean);
        if (texts.length) { rows.push({ cells: texts, h: ln.h, page: n }); sizes.push(ln.h); }
      }
    }
    if (!rows.length) return rows;
    sizes.sort((a, b) => a - b);
    const body = sizes[Math.floor(sizes.length / 2)] || 10;
    rows.forEach((r) => { r.big = r.cells.length === 1 && r.h >= body * 1.25; });
    return rows;
  }
  function drawText(pages, rows) {
    pages.innerHTML = "";
    const doc = el("div", "meet-doc");
    let page = 0;
    for (const r of rows) {
      if (r.page !== page) { if (page) doc.appendChild(el("hr", "meet-doc-sep")); page = r.page; }
      if (r.cells.length === 1) { doc.appendChild(el(r.big ? "h3" : "p", r.big ? "meet-doc-h" : "meet-doc-p", r.cells[0])); continue; }
      const row = el("div", "sched-row meet-doc-row");
      const n = r.cells.length;
      row.style.gridTemplateColumns = n === 2 ? "auto 1fr" : "auto 1fr" + " auto".repeat(n - 2);
      r.cells.forEach((c, i) => row.appendChild(el("span", i === 0 ? "sched-time" : i === 1 ? "sched-show" : "sched-host", c)));
      doc.appendChild(row);
    }
    pages.appendChild(doc);
  }
  async function drawPages(pages, job) {
    const width = Math.max(200, Math.floor(pages.clientWidth || pages.parentNode.clientWidth || 600));
    pdfWidth = width;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);   // sharp on phones, without huge memory use
    pages.innerHTML = "";
    for (let n = 1; n <= pdfDoc.numPages; n++) {
      const page = await pdfDoc.getPage(n);
      if (job !== pdfJob) return;
      const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });   // fit the width
      const c = document.createElement("canvas");
      c.className = "meet-pdf-page";
      c.width = Math.floor(vp.width * ratio); c.height = Math.floor(vp.height * ratio);
      c.style.aspectRatio = vp.width + " / " + vp.height;
      c.setAttribute("role", "img");
      c.setAttribute("aria-label", "Agenda page " + n + " of " + pdfDoc.numPages);
      pages.appendChild(c);
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;
    }
  }
  // Rotated the phone / resized the window / went full screen: redraw to the new width.
  let resizeTimer = 0;
  function refit() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const pages = byId("meetPdfPages");
      if (!pages || !pdfDoc || pdfMode !== "canvas") return;
      const w = Math.floor(pages.clientWidth);
      if (w && Math.abs(w - pdfWidth) > 30) { const job = ++pdfJob; drawPages(pages, job).catch(() => {}); }
    }, 250);
  }
  window.addEventListener("resize", refit);
  window.addEventListener("orientationchange", refit);
  function setFull(on) {
    const card = byId("meetScreenCard");
    card.classList.toggle("full", on);
    document.body.classList.toggle("meet-full-open", on);
    byId("meetFullBtn").textContent = on ? "✖ Close" : "⛶ Full screen";
    byId("meetFullBtn").setAttribute("aria-pressed", on ? "true" : "false");
    refit();
  }

  function renderScreen() {
    const sc = st.screen || { kind: "agenda" };
    const key = sc.kind + "|" + sc.v + "|" + (st.agenda ? st.agenda.v : 0);
    if (key === screenKey) return;   // unchanged: don't reload the PDF
    screenKey = key;
    const box = byId("meetScreen"), open = byId("meetOpenPdf");
    pdfJob++;                        // stop drawing an older agenda
    box.innerHTML = "";
    open.hidden = true;
    byId("meetStopShow").disabled = sc.kind === "none";
    const by = sc.by ? " · shown by " + sc.by : "";
    if (sc.kind === "none") {
      byId("meetScreenTitle").textContent = "🖥 Screen";
      box.appendChild(el("p", "edit-empty", "Nothing is being shown right now."));
      byId("meetFullBtn").hidden = true;
      if (byId("meetScreenCard").classList.contains("full")) setFull(false);
      return;
    }
    byId("meetFullBtn").hidden = false;
    if (sc.kind === "text") {
      byId("meetScreenTitle").textContent = "🖥 Screen" + by;
      if (sc.title) box.appendChild(el("h3", "meet-text-title", sc.title));
      if (sc.body) box.appendChild(el("div", "meet-text-body", sc.body));
    } else if (sc.kind === "image") {
      byId("meetScreenTitle").textContent = "🖥 Screen" + by;
      const img = el("img", "meet-img"); img.alt = "Picture shown in the meeting";
      img.src = "/api/meeting/image?t=" + encodeURIComponent(token) + "&v=" + sc.v;
      box.appendChild(img);
    } else {
      byId("meetScreenTitle").textContent = "📄 Agenda" + (st.agenda ? " · " + st.agenda.name : "");
      if (!st.agenda) { box.appendChild(el("p", "edit-empty", "No agenda yet." + (st.canLead ? " Upload a PDF below." : ""))); return; }
      const src = "/api/meeting/agenda.pdf?t=" + encodeURIComponent(token) + "&v=" + st.agenda.v;
      showPdf(box, src);
      open.href = src; open.hidden = false;   // also open it in the phone's own PDF viewer (zoom, save)
    }
  }

  function renderAdmin() {
    byId("meetEnabled").checked = !!st.enabled;
    const wrap = byId("meetLeaders");
    if (wrap.dataset.dirty === "1") return;   // keep unsaved ticks
    wrap.innerHTML = "";
    // One row per member: Lead (call / start / end) and Present (agenda, text, pictures).
    (st.members || []).filter((m) => m.role !== "god").forEach((m) => {
      const row = el("div", "meet-perm-row");
      row.appendChild(el("span", "meet-perm-name", m.name));
      const box = (kind, checked, disabled, label) => {
        const lab = el("label", "meet-perm-check");
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.value = m.id; cb.dataset.kind = kind;
        cb.checked = checked; cb.disabled = disabled;
        cb.onchange = () => { wrap.dataset.dirty = "1"; };
        lab.append(cb, document.createTextNode(" " + label));
        return lab;
      };
      const elevated = m.role === "elevated";
      row.appendChild(box("lead", elevated || (st.leaders || []).includes(m.id), elevated, elevated ? "Lead (always)" : "Lead"));
      row.appendChild(box("present", (st.presenters || []).includes(m.id), false, "Present"));
      wrap.appendChild(row);
    });
  }

  /* ================= leader & admin actions ================= */
  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed.");
    return j;
  }
  async function upload(url, file, headers) {
    const r = await fetch(url, { method: "POST", headers: { "X-Token": token, "Content-Type": file.type || "application/octet-stream", ...headers }, body: file });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Upload failed.");
  }
  function wire() {
    byId("meetRingJoin").onclick = () => join();
    byId("meetRingLater").onclick = () => { stopRing(); send({ type: "meeting-decline" }); };
    byId("meetJoinBtn").onclick = () => join();
    byId("meetLeaveBtn").onclick = () => leave();
    byId("meetStartBtn").onclick = () => {
      if (!st.live && !confirm("Start the meeting and call every member who has the portal open?")) return;
      send({ type: "meeting-start" });
      say("meetState", st.live ? "Calling everyone who isn't in the room…" : "Meeting started. Calling everyone…", true);
      join();   // the leader goes straight in
    };
    byId("meetCallBtn").onclick = () => {
      const id = byId("meetCallWho").value;
      if (!id) return say("meetState", "Choose who to call first.", false);
      send({ type: "meeting-call", id });   // starts a private call if no meeting is on
      join();                               // and puts you in it
    };
    // Typing anywhere in the portal holds off an automatic refresh (so edits aren't lost).
    document.addEventListener("input", () => { lastTyping = Date.now(); }, true);
    byId("updateNowBtn").onclick = () => location.reload();
    byId("meetEndBtn").onclick = () => { if (confirm("End the meeting for everyone?")) send({ type: "meeting-end" }); };
    byId("meetShareBtn").onclick = () => { if (shareStream) stopShare(); else startShare(); };
    byId("meetMirrorBtn").onclick = () => { if (mirrorOn) stopMirror(); else startMirror(); };
    byId("meetMuteBtn").onclick = () => {
      muted = !muted;
      if (mic) mic.getAudioTracks().forEach((t) => { t.enabled = !muted; });
      send({ type: "meeting-mute", muted });
      render();
    };
    byId("meetHandBtn").onclick = () => {
      const mine = st && st.people ? st.people.find((p) => p.id === me.id) : null;
      send({ type: "meeting-hand", up: !(mine && mine.hand) });
    };

    byId("meetEnabled").onchange = async (e) => {
      try { await post("/api/meeting/settings", { enabled: e.target.checked }); say("meetAdminState", e.target.checked ? "✓ Members can now see the Meeting Room." : "✓ Meeting Room hidden from members.", true); }
      catch (err) { e.target.checked = !e.target.checked; say("meetAdminState", err.message, false); }
    };
    byId("meetVisBtn").onclick = async () => {
      const next = !st.enabled;
      if (!next && st.live && st.live.open && !confirm("Hide the Meeting Room from members? This also ends the meeting that's on now.")) return;
      try {
        await post("/api/meeting/settings", { enabled: next });
        say("meetState", next ? "✓ Every member can now see the Meeting Room." : "✓ Meeting Room hidden from members.", true);
      } catch (err) { say("meetState", err.message, false); }
    };
    byId("meetSaveLeaders").onclick = async () => {
      const wrap = byId("meetLeaders");
      const ticked = (kind) => [...wrap.querySelectorAll('input[data-kind="' + kind + '"]:checked:not(:disabled)')].map((c) => c.value);
      try { await post("/api/meeting/settings", { leaders: ticked("lead"), presenters: ticked("present") }); wrap.dataset.dirty = ""; say("meetAdminState", "✓ Saved", true); }
      catch (err) { say("meetAdminState", err.message, false); }
    };

    byId("meetPdfBtn").onclick = async () => {
      const f = byId("meetPdf").files[0];
      if (!f) return say("meetCtlState", "Choose the agenda PDF first.", false);
      if (f.size > 10 * 1024 * 1024) return say("meetCtlState", "The PDF is too big (max 10 MB).", false);
      say("meetCtlState", "Uploading…");
      try { await upload("/api/meeting/agenda", f, { "X-Name": encodeURIComponent(f.name) }); byId("meetPdf").value = ""; say("meetCtlState", "✓ Agenda is on the screen.", true); }
      catch (e) { say("meetCtlState", e.message, false); }
    };
    byId("meetStopShow").onclick = async () => {
      try { await post("/api/meeting/screen", { kind: "none" }); say("meetCtlState", "✓ Stopped. The screen is blank for everyone.", true); }
      catch (e) { say("meetCtlState", e.message, false); }
    };
    byId("meetFullBtn").onclick = () => setFull(!byId("meetScreenCard").classList.contains("full"));
    byId("meetTabBtn").addEventListener("click", () => setTimeout(refit, 50));   // pages drawn while hidden had no width
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && byId("meetScreenCard").classList.contains("full")) setFull(false); });
    byId("meetShowAgenda").onclick = async () => {
      try { await post("/api/meeting/screen", { kind: "agenda" }); say("meetCtlState", "✓ Showing the agenda.", true); }
      catch (e) { say("meetCtlState", e.message, false); }
    };
    byId("meetShowText").onclick = async () => {
      try { await post("/api/meeting/screen", { kind: "text", title: byId("meetTxtTitle").value, body: byId("meetTxtBody").value }); say("meetCtlState", "✓ Text is on the screen.", true); }
      catch (e) { say("meetCtlState", e.message, false); }
    };
    byId("meetShowImg").onclick = async () => {
      const f = byId("meetImg").files[0];
      if (!f) return say("meetCtlState", "Choose a picture first.", false);
      if (f.size > 4 * 1024 * 1024) return say("meetCtlState", "The picture is too big (max 4 MB).", false);
      say("meetCtlState", "Uploading…");
      try { await upload("/api/meeting/screen-image", f, {}); byId("meetImg").value = ""; say("meetCtlState", "✓ Picture is on the screen.", true); }
      catch (e) { say("meetCtlState", e.message, false); }
    };
    // Keep the meeting clock ticking.
    setInterval(() => { if (st && st.visible && st.live) say("meetStatus", statusText()); }, 1000);
    window.addEventListener("pagehide", () => { if (inCall) send({ type: "meeting-leave" }); });
  }

  let started = false;
  window.RFM_MEETING = {
    start(tk, user) {
      token = tk; me = user;
      if (started) return;
      started = true;
      wire();
      connect();
    },
  };
})();
