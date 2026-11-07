/* ============================================================
   Ramatlabama FM — Portal "Studio" tab: take listener calls in-browser.
   Listener (call.js) <-WebRTC-> this page. The caller's voice plays from
   #studioCallAudio; share this tab with sound via the Miradio "TAB"
   button to put the caller on air.
   ============================================================ */
(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const cfg = window.RADIO_CONFIG || {};
  let iceServers = cfg.iceServers || [{ urls: "stun:stun.l.google.com:19302" }];
  fetch("/api/ice", { cache: "no-store" }).then((r) => r.json())
    .then((j) => { if (j && Array.isArray(j.iceServers) && j.iceServers.length) iceServers = j.iceServers; })
    .catch(() => {});
  const wsUrl = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host;

  let ws = null, token = null;
  let pc = null, mic = null, pendingMic = null;
  let current = null;              // { id, name } of the live caller
  let chain = Promise.resolve();   // serialises signalling messages
  let audioCtx = null, rafId = 0, timerId = 0, startedAt = 0;

  const el = {
    queue: () => byId("callQueue"),
    live: () => byId("liveCall"),
    audio: () => byId("studioCallAudio"),
  };

  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function toast(t) { const s = byId("studioState"); if (s) { s.textContent = t || ""; } }

  /* ---------- queue ---------- */
  function renderQueue(queue) {
    const wrap = el.queue(); if (!wrap) return;
    wrap.innerHTML = "";
    byId("queueCount").textContent = queue.length ? String(queue.length) : "";
    if (!queue.length) {
      const p = document.createElement("p");
      p.className = "edit-empty"; p.textContent = "No callers waiting.";
      wrap.appendChild(p); return;
    }
    queue.forEach((c) => {
      const row = document.createElement("div"); row.className = "queue-row";
      const who = document.createElement("div"); who.className = "queue-who";
      const n = document.createElement("strong"); n.textContent = c.name;
      const w = document.createElement("small");
      const mins = Math.max(0, Math.round((Date.now() - c.since) / 60000));
      w.textContent = mins < 1 ? "just now" : mins + " min waiting";
      who.append(n, w);
      const b = document.createElement("button");
      b.className = "add-btn"; b.textContent = "📞 Take call";
      b.disabled = !!current;
      b.title = current ? "Finish the current call first" : "";
      b.onclick = () => accept(c.id);
      row.append(who, b); wrap.appendChild(row);
    });
  }
  let lastQueue = [];

  async function accept(id) {
    if (current || pendingMic) return;
    toast("Opening microphone…");
    try {
      // Presenter voice goes to the caller; echo cancellation guards against speaker bleed.
      pendingMic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (_) { toast("Microphone blocked. Allow it to take calls."); return; }
    send({ type: "call-accept", id });
  }

  /* ---------- live call ---------- */
  function beginCall(info) {
    current = info;
    mic = pendingMic; pendingMic = null;
    pc = new RTCPeerConnection({ iceServers });
    mic.getTracks().forEach((t) => pc.addTrack(t, mic));
    pc.ontrack = (e) => {
      const a = el.audio(); a.srcObject = e.streams[0];
      a.muted = false; a.volume = 1;
      const needBtn = (on) => { const b = byId("enableSoundBtn"); if (b) b.hidden = !on; };
      a.play().then(() => needBtn(false)).catch(() => needBtn(true));   // autoplay blocked -> show button
      startMeter(e.streams[0]);
    };
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: "rtc", data: { candidate: e.candidate } }); };
    pc.onconnectionstatechange = () => {
      if (pc && pc.connectionState === "connected") byId("liveStatus").textContent = "Connected";
      if (pc && pc.connectionState === "failed") { toast("Audio couldn't connect."); hangUp(); }
    };
    byId("liveName").textContent = info.name;
    byId("liveStatus").textContent = "Connecting…";
    byId("muteCallerBtn").textContent = "🔇 Mute caller";
    el.live().hidden = false;
    startedAt = Date.now();
    timerId = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      byId("liveTimer").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    }, 500);
    toast("");
    renderQueue(lastQueue);
  }

  async function handleRtc(data) {
    if (!pc || !data) return;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === "offer") {
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          send({ type: "rtc", data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        await pc.addIceCandidate(data.candidate);
      }
    } catch (_) {}
  }

  function endLocal(text) {
    if (pc) { try { pc.close(); } catch (_) {} pc = null; }
    if (mic) { mic.getTracks().forEach((t) => t.stop()); mic = null; }
    if (pendingMic) { pendingMic.getTracks().forEach((t) => t.stop()); pendingMic = null; }
    const a = el.audio(); if (a) a.srcObject = null;
    stopMeter();
    clearInterval(timerId); timerId = 0;
    current = null;
    if (el.live()) el.live().hidden = true;
    renderQueue(lastQueue);
    if (text) toast(text);
  }

  function hangUp() { send({ type: "call-end" }); endLocal("Call ended."); }

  /* ---------- level meter ---------- */
  function startMeter(stream) {
    stopMeter();
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(stream);
      const an = audioCtx.createAnalyser(); an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const bar = byId("meterBar");
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
        bar.style.width = Math.min(100, Math.round((peak / 128) * 140)) + "%";
        rafId = requestAnimationFrame(tick);
      };
      tick();
    } catch (_) {}
  }
  function stopMeter() {
    cancelAnimationFrame(rafId); rafId = 0;
    if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
    const bar = byId("meterBar"); if (bar) bar.style.width = "0%";
  }

  /* ---------- socket ---------- */
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => send({ type: "staff-hello", token });
    ws.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.type === "call-queue") { lastQueue = d.queue || []; renderQueue(lastQueue); }
      else if (d.type === "call-live") beginCall({ id: d.id, name: d.name });
      else if (d.type === "rtc") chain = chain.then(() => handleRtc(d.data));
      else if (d.type === "call-ended") endLocal("Caller hung up.");
      else if (d.type === "call-gone") { endLocal("That caller left the queue."); }
    };
    ws.onclose = () => {
      if (current) endLocal("Connection lost. Call ended.");
      setTimeout(connect, 2500);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  /* ---------- controls ---------- */
  document.addEventListener("click", (e) => {
    if (e.target && e.target.id === "hangupBtn") hangUp();
    if (e.target && e.target.id === "enableSoundBtn") {
      const a = el.audio(); a.muted = false;
      a.play().then(() => { e.target.hidden = true; }).catch(() => {});
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    }
    if (e.target && e.target.id === "muteCallerBtn") {
      const a = el.audio(); a.muted = !a.muted;
      e.target.textContent = a.muted ? "🔊 Unmute caller" : "🔇 Mute caller";
    }
    if (e.target && e.target.id === "openMiradioBtn") {
      window.open(cfg.studioUrl || "https://studio.miradio.co/v1/", "_blank", "noopener");
    }
  });

  window.RFM_STUDIO = {
    start(tk) {
      token = tk;
      if (!window.RTCPeerConnection || !navigator.mediaDevices) {
        toast("This browser can't take calls. Use Chrome or Edge over HTTPS.");
        return;
      }
      if (!ws) connect();
    },
  };
})();
