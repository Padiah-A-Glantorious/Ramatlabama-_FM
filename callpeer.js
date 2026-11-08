/* ============================================================
   Ramatlabama FM — one person's side of a studio call
   Used by listeners (call.js) and by presenters joining as co-host (studio.js).
   - Talks only to the HOST's portal tab, which mixes everyone.
   - No time limit: if the signalling socket drops (screen lock, network blip)
     it reconnects and resumes; the audio keeps flowing meanwhile.
   - If the audio path breaks (switching Wi-Fi <-> mobile data) it repairs it
     with an ICE restart instead of ending the call.
   - Echo: browser echo cancellation + noise suppression on the microphone, and
     the host sends this person a mix WITHOUT their own voice.
   ============================================================ */
(() => {
  "use strict";
  const wsUrl = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host;
  const FALLBACK_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
  async function getIce() {
    try {
      const j = await (await fetch("/api/ice", { cache: "no-store" })).json();
      if (j && Array.isArray(j.iceServers) && j.iceServers.length) return j.iceServers;
    } catch (_) {}
    return FALLBACK_ICE;
  }
  const MIC = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } };

  /* opts:
       request: object sent to start, e.g. { type: "call-request", name } or { type: "cohost-request", token }
       onStatus(state, info)  state: "connecting" | "waiting" | "live" | "reconnecting"
       onAudio(stream)        the host's mix for this person
       onEnded(reason)                                                        */
  function CallSession(opts) {
    let ws = null, pc = null, mic = null;
    let callId = null, key = null, state = "connecting", ended = false;
    let chain = Promise.resolve(), reconnectT = 0, backoff = 1000, repairT = 0, deadT = 0, wake = null;
    let ice = null, info = {};

    const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
    const status = (s, extra) => { state = s; Object.assign(info, extra || {}); opts.onStatus && opts.onStatus(s, info); };

    /* ---- keep the phone awake while on the line ---- */
    async function keepAwake() {
      try { if (navigator.wakeLock && !wake && document.visibilityState === "visible") { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => { wake = null; }); } } catch (_) {}
    }
    const onVis = () => { if (document.visibilityState === "visible") { if (state === "live") keepAwake(); if (!ws || ws.readyState > 1) connect(); } };
    document.addEventListener("visibilitychange", onVis);
    const onOnline = () => { if (!ws || ws.readyState > 1) connect(); if (pc && pc.connectionState !== "connected") repair(); };
    window.addEventListener("online", onOnline);
    const onLeave = () => { if (!ended) send({ type: "call-end" }); };
    window.addEventListener("pagehide", onLeave);

    /* ---- signalling socket (reconnects forever until the call ends) ---- */
    function connect() {
      if (ended) return;
      clearTimeout(reconnectT);
      try { if (ws) { ws.onclose = null; ws.close(); } } catch (_) {}
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        backoff = 1000;
        if (callId) send({ type: "call-resume", callId, key });
        else send(opts.request);
      };
      ws.onmessage = (ev) => {
        let d; try { d = JSON.parse(ev.data); } catch { return; }
        if (d.type === "call-session") { callId = d.callId; key = d.key; }
        else if (d.type === "call-status") {
          if (d.state === "waiting") status("waiting", { hostOnline: d.hostOnline, position: d.position, host: d.host });
          else if (d.state === "live") { if (!pc) startAudio(d.host); else status("live", { host: d.host || info.host }); }
        }
        else if (d.type === "call-accepted") startAudio(d.host);
        else if (d.type === "rtc") chain = chain.then(() => onRtc(d.data));
        else if (d.type === "call-ended") finish(d.reason || "");
      };
      ws.onclose = () => {
        if (ended) return;
        if (state === "live") status("live", { signal: false });   // audio continues; just reconnect quietly
        reconnectT = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15000);
      };
      ws.onerror = () => { try { ws.close(); } catch (_) {} };
    }

    /* ---- audio ---- */
    async function startAudio(host) {
      if (pc || ended) return;
      status("live", { host: host || info.host, connected: false, since: Date.now() });
      keepAwake();
      ice = ice || await getIce();
      pc = new RTCPeerConnection({ iceServers: ice });
      mic.getTracks().forEach((t) => {
        const s = pc.addTrack(t, mic);
        // Clear voice: give Opus room (64 kbps) instead of the low default.
        try { const p = s.getParameters(); p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}]; p.encodings[0].maxBitrate = 64000; s.setParameters(p).catch(() => {}); } catch (_) {}
      });
      pc.ontrack = (e) => opts.onAudio && opts.onAudio(e.streams[0]);
      pc.onicecandidate = (e) => { if (e.candidate) send({ type: "rtc", data: { candidate: e.candidate } }); };
      pc.onconnectionstatechange = () => {
        if (!pc) return;
        const cs = pc.connectionState;
        if (cs === "connected") { clearTimeout(repairT); clearTimeout(deadT); deadT = 0; status("live", { connected: true, signal: true }); }
        else if (cs === "disconnected") { clearTimeout(repairT); repairT = setTimeout(repair, 3000); status("reconnecting"); }
        else if (cs === "failed") repair();
      };
      await offer(false);
    }
    async function offer(restart) {
      if (!pc) return;
      try {
        const o = await pc.createOffer(restart ? { iceRestart: true } : undefined);
        await pc.setLocalDescription(o);
        send({ type: "rtc", data: { sdp: pc.localDescription } });
      } catch (_) {}
    }
    // The audio path broke (e.g. Wi-Fi -> mobile data): rebuild it, don't hang up.
    function repair() {
      if (!pc || ended) return;
      status("reconnecting");
      ice = null; getIce().then((s) => { ice = s; try { pc.setConfiguration({ iceServers: s }); } catch (_) {} offer(true); });
      if (!deadT) deadT = setTimeout(() => { if (pc && pc.connectionState !== "connected") finish("The line dropped. Please call again."); }, 90000);
    }
    async function onRtc(data) {
      if (!pc || !data) return;
      try {
        if (data.sdp) await pc.setRemoteDescription(data.sdp);
        else if (data.candidate) await pc.addIceCandidate(data.candidate);
      } catch (_) {}
    }

    function finish(reason) {
      if (ended) return;
      ended = true;
      clearTimeout(reconnectT); clearTimeout(repairT); clearTimeout(deadT);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", onLeave);
      try { if (wake) wake.release(); } catch (_) {}
      if (pc) { try { pc.close(); } catch (_) {} pc = null; }
      if (mic) { mic.getTracks().forEach((t) => t.stop()); mic = null; }
      if (ws) { ws.onclose = null; try { ws.close(); } catch (_) {} ws = null; }
      opts.onEnded && opts.onEnded(reason);
    }

    return {
      async start() {
        try { mic = await navigator.mediaDevices.getUserMedia(MIC); }
        catch (_) { ended = true; opts.onEnded && opts.onEnded("Microphone blocked. Allow it in your browser to call."); return; }
        status("connecting");
        connect();
      },
      hangUp() { send({ type: "call-end" }); setTimeout(() => finish(""), 150); },
      setMuted(on) { if (mic) mic.getAudioTracks().forEach((t) => { t.enabled = !on; }); },
      get state() { return state; },
      get active() { return !ended; },
    };
  }

  window.RFMCallSession = CallSession;
})();
