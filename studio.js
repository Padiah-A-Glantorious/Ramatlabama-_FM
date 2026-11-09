/* ============================================================
   Ramatlabama FM — Portal Studio (multi-caller, co-hosts, no time limit)

   HOST ("Open the lines"): this tab becomes the mixing desk.
     - Every caller and co-host connects to this tab (star layout).
     - What this tab plays = everyone on the line. Share it into Miradio with
       TAB, so they go on air. Your own voice goes on air through Miradio's MIC
       (it is NOT played here, so it's never doubled).
     - Each person receives their own mix: you + everyone else, minus
       themselves (mix-minus), so nobody hears an echo of their own voice.
   CO-HOST (Studio tab, "Call the host"): you join the host's show from anywhere;
     once on air you see the same Waiting / On the line lists and can put
     waiting callers through too.
   ============================================================ */
(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const wsUrl = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host;
  const MIC = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } };

  let ws = null, token = null, me = null, snap = null;
  let hosting = false;                 // this tab is the mixing desk
  let ctx = null, hostMic = null, micSrc = null, master = null;
  const peers = new Map();             // id -> person on the line (host side)
  const earlyRtc = new Map();          // rtc that arrived before the peer did
  let co = null, coInfo = {}, coSince = 0, coMuted = false, coCtx = null, coAn = null;
  let rafId = 0;

  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  function toast(t, bad) {
    const s = byId("studioState"); if (!s) return;
    s.textContent = t || ""; s.style.color = bad ? "#ff6b5e" : "";
  }
  async function getIce() {
    try { const j = await (await fetch("/api/ice", { cache: "no-store" })).json(); if (j && j.iceServers && j.iceServers.length) return j.iceServers; } catch (_) {}
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  const clock = (t) => { const s = Math.max(0, Math.floor((Date.now() - t) / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return (h ? h + ":" + String(m).padStart(2, "0") : String(m).padStart(2, "0")) + ":" + String(s % 60).padStart(2, "0"); };
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m + " min waiting"; };
  function bitrate(sender) {
    try { const p = sender.getParameters(); p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}]; p.encodings[0].maxBitrate = 64000; sender.setParameters(p).catch(() => {}); } catch (_) {}
  }

  /* ================= socket ================= */
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      send({ type: "staff-hello", token });
      if (hosting) send({ type: "host-start", token, peers: [...peers.keys()] });   // reattach after a blip
    };
    ws.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.type === "staff-ok") { me = d.me; render(); }
      else if (d.type === "studio") { snap = d; syncPeers(); render(); }
      else if (d.type === "host-ok") { toast(""); render(); }
      else if (d.type === "host-error") { stopHub(); toast(d.error, true); render(); }
      else if (d.type === "studio-error") toast(d.error, true);
      else if (d.type === "studio-note") toast(d.text);
      else if (d.type === "peer-join") { if (hosting) addPeer(d); }
      else if (d.type === "peer-left") removePeer(d.id);
      else if (d.type === "rtc" && d.from) onPeerRtc(d.from, d.data);
    };
    // Never end calls because this socket dropped: the audio is browser-to-browser.
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  /* ================= hosting: the mixing desk ================= */
  async function startHosting() {
    if (co) return toast("Leave your co-host call first.", true);
    if (!confirm("Open the lines and host?\n\nWear HEADPHONES. Speakers would feed callers back into your microphone and onto the air (echo).\n\nThen share this tab into Miradio with TAB (tick 'Also share tab audio').")) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
      await ctx.resume();
      hostMic = await navigator.mediaDevices.getUserMedia(MIC);
    } catch (_) { stopHub(); return toast("Microphone blocked. Allow it to host calls.", true); }
    micSrc = ctx.createMediaStreamSource(hostMic);   // goes to the people on the line only
    master = ctx.createGain(); master.connect(ctx.destination);   // everyone on the line -> this tab -> TAB -> air
    hosting = true;
    send({ type: "host-start", token, peers: [] });
    loop(); render();
  }
  function stopHosting() {
    if (peers.size && !confirm("Close the lines? Everyone on the line will be hung up.")) return;
    send({ type: "host-stop" });
    stopHub(); render();
  }
  function stopHub() {
    hosting = false;
    [...peers.keys()].forEach((id) => removePeer(id));
    if (hostMic) { hostMic.getTracks().forEach((t) => t.stop()); hostMic = null; }
    if (ctx) { try { ctx.close(); } catch (_) {} ctx = null; }
    micSrc = master = null;
  }
  window.addEventListener("beforeunload", (e) => { if (hosting && peers.size) { e.preventDefault(); e.returnValue = ""; } });

  function addPeer(info) {
    if (peers.has(info.id) || !ctx) return;
    const p = { id: info.id, kind: info.kind, name: info.name, since: Date.now(), muted: false, connected: false, chain: Promise.resolve() };
    // This person's mix: host mic + everyone already on the line (never themselves).
    p.dest = ctx.createMediaStreamDestination();
    micSrc.connect(p.dest);
    peers.forEach((q) => { if (q.gain) q.gain.connect(p.dest); });
    peers.set(p.id, p);
    p.ready = (async () => {
      p.pc = new RTCPeerConnection({ iceServers: await getIce() });
      bitrate(p.pc.addTrack(p.dest.stream.getAudioTracks()[0], p.dest.stream));
      p.pc.ontrack = (e) => attachVoice(p, e.streams[0] || new MediaStream([e.track]));
      p.pc.onicecandidate = (e) => { if (e.candidate) send({ type: "rtc", to: p.id, data: { candidate: e.candidate } }); };
      p.pc.onconnectionstatechange = () => { p.connected = p.pc && p.pc.connectionState === "connected"; renderLine(); };
    })();
    (earlyRtc.get(p.id) || []).forEach((data) => onPeerRtc(p.id, data));
    earlyRtc.delete(p.id);
    renderLine(); render();
  }
  // Their voice: into the on-air mix, and into everyone else's mix.
  function attachVoice(p, stream) {
    if (p.src || !ctx) return;
    p.keep = new Audio(); p.keep.muted = true; p.keep.srcObject = stream; p.keep.play().catch(() => {});   // Chrome needs this to feed WebAudio
    p.src = ctx.createMediaStreamSource(stream);
    p.gain = ctx.createGain(); p.gain.gain.value = p.muted ? 0 : 1;
    p.src.connect(p.gain);
    p.gain.connect(master);
    peers.forEach((q) => { if (q !== p && q.dest) p.gain.connect(q.dest); });
    p.an = ctx.createAnalyser(); p.an.fftSize = 512; p.src.connect(p.an);
    p.buf = new Uint8Array(p.an.fftSize);
  }
  function onPeerRtc(id, data) {
    const p = peers.get(id);
    if (!p) { const l = earlyRtc.get(id) || []; l.push(data); earlyRtc.set(id, l); return; }
    p.chain = p.chain.then(() => p.ready).then(async () => {
      try {
        if (data.sdp) {
          await p.pc.setRemoteDescription(data.sdp);
          if (data.sdp.type === "offer") {   // first offer, or an ICE-restart repair
            const a = await p.pc.createAnswer(); await p.pc.setLocalDescription(a);
            send({ type: "rtc", to: id, data: { sdp: p.pc.localDescription } });
          }
        } else if (data.candidate) await p.pc.addIceCandidate(data.candidate);
      } catch (_) {}
    });
  }
  function removePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    try { if (p.pc) p.pc.close(); } catch (_) {}
    try { if (p.gain) p.gain.disconnect(); } catch (_) {}
    try { if (p.src) p.src.disconnect(); } catch (_) {}
    try { if (micSrc && p.dest) micSrc.disconnect(p.dest); } catch (_) {}
    peers.forEach((q) => { try { if (q.gain && p.dest) q.gain.disconnect(p.dest); } catch (_) {} });
    if (p.keep) p.keep.srcObject = null;
    renderLine(); render();
  }
  // Server is the source of truth for who's on the line.
  function syncPeers() {
    if (!hosting || !snap) return;
    const live = new Set(snap.live.map((c) => c.id));
    [...peers.keys()].forEach((id) => { if (!live.has(id)) removePeer(id); });
    snap.live.forEach((c) => { if (!peers.has(c.id)) addPeer(c); });
  }
  function toggleMute(id) {
    const p = peers.get(id); if (!p) return;
    p.muted = !p.muted;
    if (p.gain) p.gain.gain.value = p.muted ? 0 : 1;
    renderLine();
  }

  /* ================= co-host: the host invites, you answer ================= */
  let members = [], membersAt = 0, ringingFor = null, ringT = 0, ringCtx = null, titleT = 0;
  const baseTitle = document.title;
  async function loadMembers(force) {
    if (!force && Date.now() - membersAt < 60000) return;
    try {
      const j = await (await fetch("/api/members", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })).json();
      if (j && j.ok) { members = j.members || []; membersAt = Date.now(); renderInvite(); }
    } catch (_) {}
  }
  function invite() {
    const id = byId("inviteSelect").value;
    if (!id) return toast("Choose who to invite.", true);
    send({ type: "cohost-invite", userId: id });
  }
  const myInvite = () => (snap && me && !co && !hosting ? (snap.invites || []).find((v) => v.userId === me.id) : null);

  // The phone-style ring for the invited member: banner on every tab + tone + tab title.
  function ring(v) {
    if (ringingFor === (v && v.id)) return;
    ringingFor = v ? v.id : null;
    clearInterval(ringT); clearInterval(titleT); document.title = baseTitle;
    const banner = byId("ringBanner"); if (!banner) return;
    banner.hidden = !v;
    if (!v) { if (ringCtx) { try { ringCtx.close(); } catch (_) {} ringCtx = null; } return; }
    byId("ringTitle").textContent = "📞 " + ((snap.host && snap.host.name) || "The host") + " is inviting you to co-host the show";
    const beep = () => {
      try {
        ringCtx = ringCtx || new (window.AudioContext || window.webkitAudioContext)();
        ringCtx.resume().catch(() => {});
        [0, 0.35].forEach((t) => {
          const o = ringCtx.createOscillator(), g = ringCtx.createGain();
          o.frequency.value = 880; g.gain.value = 0.08;
          o.connect(g); g.connect(ringCtx.destination);
          o.start(ringCtx.currentTime + t); o.stop(ringCtx.currentTime + t + 0.22);
        });
      } catch (_) {}
    };
    beep(); ringT = setInterval(beep, 2500);
    let flip = false; titleT = setInterval(() => { flip = !flip; document.title = flip ? "📞 Co-host call…" : baseTitle; }, 1000);
  }
  function answer() {
    const v = myInvite(); if (!v) return;
    ring(null);
    startCohost(v.id);
  }
  function decline() {
    const v = myInvite(); if (!v) return;
    send({ type: "cohost-decline", inviteId: v.id });
    ring(null);
  }

  function startCohost(inviteId) {
    if (hosting || co) return;
    coMuted = false; coInfo = {}; coSince = 0;
    co = window.RFMCallSession({
      request: { type: "cohost-answer", token, inviteId },
      onStatus(state, info) { coInfo = info; if (state === "live" && !coSince) coSince = Date.now(); renderCohost(); },
      onAudio(stream) {
        const a = byId("cohostAudio"); a.srcObject = stream; a.play().catch(() => {});
        try {
          coCtx = coCtx || new (window.AudioContext || window.webkitAudioContext)();
          const s = coCtx.createMediaStreamSource(stream); coAn = coCtx.createAnalyser(); coAn.fftSize = 512; s.connect(coAn); loop();
        } catch (_) {}
      },
      onEnded(reason) {
        co = null; coSince = 0; coAn = null;
        const a = byId("cohostAudio"); if (a) a.srcObject = null;
        if (coCtx) { try { coCtx.close(); } catch (_) {} coCtx = null; }
        coInfo = { ended: reason || "You left the show." };
        renderCohost(); render();
      },
    });
    co.start();
    renderCohost();
  }
  const coLive = () => !!(co && (co.state === "live" || co.state === "reconnecting"));

  /* ================= level meters ================= */
  function level(an, buf) { an.getByteTimeDomainData(buf); let pk = 0; for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i] - 128)); return Math.min(100, Math.round((pk / 128) * 140)); }
  function loop() {
    if (rafId) return;
    const tick = () => {
      peers.forEach((p) => { const b = byId("lvl-" + p.id); if (b && p.an) b.style.width = level(p.an, p.buf) + "%"; });
      if (coAn) { const b = byId("cohostMeter"); if (b) { coAn.buf = coAn.buf || new Uint8Array(coAn.fftSize); b.style.width = level(coAn, coAn.buf) + "%"; } }
      document.querySelectorAll("[data-since]").forEach((n) => { n.textContent = clock(+n.dataset.since); });
      if (hosting || co) rafId = requestAnimationFrame(tick); else rafId = 0;
    };
    rafId = requestAnimationFrame(tick);
  }

  /* ================= rendering ================= */
  function render() { renderHost(); renderInvite(); renderQueue(); renderLine(); renderCohost(); ring(myInvite()); }

  // Host: pick a member to ring; see who's ringing.
  function renderInvite() {
    const row = byId("inviteRow"), sel = byId("inviteSelect"), list = byId("inviteList"); if (!row || !sel || !list) return;
    row.hidden = !hosting; list.innerHTML = "";
    if (!hosting) return;
    loadMembers();
    const online = new Set((snap && snap.online) || []);
    const busy = new Set([...((snap && snap.invites) || []).map((v) => v.userId), ...((snap && snap.live) || []).filter((c) => c.kind === "cohost").map((c) => c.userId)]);
    const keep = sel.value;
    sel.innerHTML = "";
    const first = el("option", null, "Choose a member…"); first.value = ""; sel.appendChild(first);
    members.filter((m) => !me || m.id !== me.id).sort((a, b) => (online.has(b.id) - online.has(a.id)) || a.name.localeCompare(b.name)).forEach((m) => {
      const o = el("option", null, (online.has(m.id) ? "● " : "○ ") + m.name + (m.title ? " · " + m.title : "") + (busy.has(m.id) ? " (in the show)" : online.has(m.id) ? "" : " (portal closed)"));
      o.value = m.id; o.disabled = busy.has(m.id); sel.appendChild(o);
    });
    if ([...sel.options].some((o) => o.value === keep && !o.disabled)) sel.value = keep;
    ((snap && snap.invites) || []).forEach((v) => {
      const r = el("div", "queue-row");
      const who = el("div", "queue-who");
      who.append(el("strong", null, "📞 Ringing " + v.name + "…"), el("small", null, "Waiting for them to answer"));
      const act = el("div", "member-actions");
      act.appendChild(button("✖ Cancel", "m-btn delete", () => send({ type: "cohost-cancel", inviteId: v.id })));
      r.append(who, act); list.appendChild(r);
    });
  }

  function renderHost() {
    const st = byId("hostStatus"), btn = byId("hostToggleBtn"); if (!st || !btn) return;
    const h = snap && snap.host;
    btn.hidden = false; btn.disabled = false;
    if (hosting) {
      st.textContent = "You're hosting from this tab. Share it into Miradio with TAB so callers go on air." + (h && !h.connected ? " (Reconnecting…)" : "");
      btn.textContent = "⏹ Close the lines"; btn.className = "btn-danger";
    } else if (h && me && h.userId === me.id) {
      st.textContent = "You're hosting from another tab or device.";
      btn.textContent = "🎙 Host from this tab instead"; btn.className = "btn-primary";
    } else if (h) {
      st.textContent = h.name + " is hosting." + (h.connected ? "" : " (Their studio tab is reconnecting.)") + (coLive() ? "" : " They can invite you to co-host.");
      btn.hidden = true;
    } else {
      st.textContent = "The lines are closed. Open them to take calls and co-hosts.";
      btn.textContent = "🎙 Open the lines (I'm hosting)"; btn.className = "btn-primary";
      btn.disabled = !!co;
    }
  }

  function personRow(c, actions) {
    const row = el("div", "queue-row");
    const who = el("div", "queue-who");
    const n = el("strong", null, c.name);
    if (c.kind === "cohost") n.appendChild(el("span", "role-tag elevated", "Co-host"));
    who.append(n, el("small", null, ago(c.since)));
    const act = el("div", "member-actions"); actions.forEach((a) => act.appendChild(a));
    row.append(who, act); return row;
  }
  function button(label, cls, onClick, disabled, title) { const b = el("button", cls, label); b.type = "button"; b.onclick = onClick; b.disabled = !!disabled; if (title) b.title = title; return b; }

  function renderQueue() {
    const wrap = byId("callQueue"); if (!wrap) return;
    const callers = (snap && snap.callers) || [];
    const canPut = hosting || coLive();
    const full = snap && snap.live.length >= snap.max;
    wrap.innerHTML = "";
    if (!callers.length) wrap.appendChild(el("p", "edit-empty", "No callers waiting."));
    callers.forEach((c) => wrap.appendChild(personRow(c, canPut ? [
      button("📞 Put through", "add-btn", () => send({ type: "call-accept", id: c.id }), full, full ? "The line is full" : ""),
      button("✖", "m-btn delete", () => { if (confirm("Decline " + c.name + "'s call?")) send({ type: "call-end", id: c.id }); }, false, "Decline"),
    ] : [])));
    if (!canPut && callers.length) wrap.appendChild(el("p", "edit-hint", snap && snap.host ? "Only the host or a co-host on air can put callers through." : "Open the lines to take these calls."));
    const n = callers.length + (myInvite() ? 1 : 0);   // badge also lights up when you're being invited
    const badge = byId("queueCount"); if (badge) badge.textContent = n ? String(n) : "";
  }

  function renderLine() {
    const list = byId("lineList"), count = byId("lineCount"); if (!list) return;
    const live = (snap && snap.live) || [];
    if (count) count.textContent = live.length ? live.length + " of " + ((snap && snap.max) || 8) : "";
    list.innerHTML = "";
    if (!live.length) { list.appendChild(el("p", "edit-empty", "Nobody on the line.")); return; }
    live.forEach((c) => {
      const p = peers.get(c.id);
      const box = el("div", "live-call");
      const top = el("div", "live-top");
      const left = el("div");
      const n = el("strong", null, c.name);
      n.appendChild(el("span", "role-tag " + (c.kind === "cohost" ? "elevated" : "presenter"), c.kind === "cohost" ? "Co-host" : "Caller"));
      const stt = !c.connected ? "Signal lost, reconnecting…" : p ? (p.connected ? (p.muted ? "Muted (off air)" : "On air") : "Connecting audio…") : "On the line";
      left.append(n, el("small", null, stt));
      const t = el("span", "live-timer"); t.dataset.since = c.liveSince || Date.now(); t.textContent = clock(c.liveSince || Date.now());
      top.append(left, t); box.appendChild(top);
      if (hosting) {
        const m = el("div", "meter"); const bar = el("div", "meter-bar"); bar.id = "lvl-" + c.id; m.appendChild(bar); box.appendChild(m);
        const act = el("div", "live-actions");
        act.append(
          button(p && p.muted ? "🔊 Unmute" : "🔇 Mute", "add-btn", () => toggleMute(c.id)),
          button("⏹ Hang up", "btn-danger", () => { if (confirm("Hang up on " + c.name + "?")) { send({ type: "call-end", id: c.id }); removePeer(c.id); } }),
        );
        box.appendChild(act);
      }
      list.appendChild(box);
    });
  }

  function renderCohost() {
    const card = byId("cohostCard"); if (!card) return;
    const st = byId("cohostStatus"), mute = byId("cohostMuteBtn");
    const h = snap && snap.host;
    const hostName = (coInfo && coInfo.host) || (h && h.name) || "the host";
    // Only shown while you're joining or on air as co-host.
    card.hidden = !co || hosting;
    if (co) {
      st.innerHTML = "";
      if (co.state === "live" || co.state === "reconnecting") {
        const since = coSince || Date.now();
        st.append(co.state === "reconnecting" ? "Reconnecting the line… " : "🔴 On air with " + hostName + " · ");
        const t = el("span"); t.dataset.since = since; t.textContent = clock(since); st.appendChild(t);
        if (coMuted) st.append(" · your mic is muted");
        st.append(". Put callers through from the Waiting list below.");
      } else st.textContent = "Joining " + hostName + "'s show…";
      mute.textContent = coMuted ? "🎙 Unmute my mic" : "🔇 Mute my mic";
    } else if (coInfo && coInfo.ended) {
      toast(coInfo.ended); coInfo = {};
    }
    // On air, the co-host works the Waiting / On the line lists below (re-render them).
    renderQueue(); renderLine();
  }

  /* ================= controls ================= */
  document.addEventListener("click", (e) => {
    const id = e.target && e.target.id;
    if (id === "hostToggleBtn") {
      if (hosting) stopHosting();
      else if (snap && snap.host && me && snap.host.userId === me.id) { if (confirm("Host from this tab? Calls held by your other tab will end.")) startHosting(); }
      else startHosting();
    }
    if (id === "inviteBtn") invite();
    if (id === "ringAnswerBtn") answer();
    if (id === "ringDeclineBtn") decline();
    if (id === "cohostLeaveBtn") { if (co && confirm("Leave the show?")) co.hangUp(); }
    if (id === "cohostMuteBtn" && co) { coMuted = !coMuted; co.setMuted(coMuted); renderCohost(); }
  });
  setInterval(() => { if (snap && snap.callers.length) renderQueue(); }, 30000);   // refresh "x min waiting"

  window.RFM_STUDIO = {
    start(tk) {
      token = tk;
      if (!window.RTCPeerConnection || !navigator.mediaDevices) {
        toast("This browser can't take calls. Use Chrome or Edge.", true);
        return;
      }
      if (!ws) connect();
    },
    // True while this tab hosts the lines or is on air as a co-host (never auto-refresh then).
    busy() { return !!hosting || !!co; },
  };
})();
