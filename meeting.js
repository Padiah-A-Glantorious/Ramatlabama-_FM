/* ============================================================
   Ramatlabama FM — Portal "Meeting Room" tab
   - The God Admin shows/hides the tab for all members and picks meeting leaders.
   - A leader starts the meeting: every member with the portal open gets a call.
     Anyone who said "Not now" or left can (re)join while the meeting is on.
   - Microphone only (no video). Each person in the room is a round name tile, like a
     WhatsApp group call: it glows green while they talk and gold when their hand is up.
   - The screen shows the agenda PDF, or text / a picture a leader put up.
   Audio goes directly between the browsers in the room (WebRTC); the server only
   relays the connection messages. Fine for a staff meeting (up to 16 people).
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
  async function join() {
    if (inCall || joining) return;
    stopRing();
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
    if (!st || !st.visible) return;
    byId("meetRingTitle").textContent = direct
      ? "📞 " + (by || "A leader") + " is calling you"
      : "🤝 " + (by ? by + " is calling a meeting" : "Meeting call");
    byId("meetRing").hidden = false;
    try { if (navigator.vibrate) navigator.vibrate([400, 200, 400]); } catch (_) {}
    clearInterval(ringTimer);
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
  let pdfLib = null, pdfDoc = null, pdfSrc = "", pdfJob = 0, pdfWidth = 0;
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
      status.remove();
      await drawPages(pages, job);
    } catch (_) {
      if (job !== pdfJob) return;
      status.textContent = "The agenda couldn't be shown here. Press “↗ Open agenda” to read it.";
    }
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
      if (!pages || !pdfDoc) return;
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
