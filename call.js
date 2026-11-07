/* ============================================================
   Ramatlabama FM — Listener "Call the studio" (WebRTC, in-browser)
   Flow: click Call -> allow mic -> wait in queue -> presenter accepts
         -> live audio over WebRTC -> either side hangs up.
   The presenter's browser (portal Studio tab) is the other end.
   ============================================================ */
(() => {
  "use strict";
  const btn = document.getElementById("callBtn");
  const statusEl = document.getElementById("callStatus");
  const audio = document.getElementById("callAudio");
  if (!btn || !statusEl || !audio) return;

  const cfg = window.RADIO_CONFIG || {};
  const supported = !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (!supported) { btn.hidden = true; return; }

  const wsUrl = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host;
  const iceServers = cfg.iceServers || [{ urls: "stun:stun.l.google.com:19302" }];

  let ws = null, pc = null, micStream = null;
  let state = "idle";   // idle | waiting | live

  function setUi(s, text) {
    state = s;
    btn.classList.toggle("calling", s !== "idle");
    btn.textContent = s === "idle" ? "📞 Call the studio" : s === "waiting" ? "✖ Cancel call" : "⏹ Hang up";
    statusEl.textContent = text || "";
    statusEl.hidden = !text;
  }

  function cleanup(text) {
    if (pc) { try { pc.close(); } catch (_) {} pc = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    audio.srcObject = null;
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    setUi("idle", text || "");
  }

  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  async function startCall() {
    let name = (localStorage.getItem("rfm_name") || "").trim();
    if (!name) {
      name = (prompt("Your name for the presenter:") || "").trim().slice(0, 24);
      if (!name) return;
      localStorage.setItem("rfm_name", name);
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (_) {
      setUi("idle", "Microphone blocked. Allow it in your browser to call.");
      return;
    }
    setUi("waiting", "Connecting…");
    ws = new WebSocket(wsUrl);
    ws.onopen = () => send({ type: "call-request", name });
    ws.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.type === "call-status" && d.state === "waiting") {
        setUi("waiting", "You're in the queue. A presenter will pick up shortly. Keep this page open.");
      } else if (d.type === "call-accepted") {
        onAccepted(d.host);
      } else if (d.type === "rtc") {
        onRtc(d.data);
      } else if (d.type === "call-ended") {
        cleanup("Call ended. Thanks for calling Ramatlabama FM!");
      }
    };
    ws.onclose = () => { if (state !== "idle") cleanup("Connection lost."); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  async function onAccepted(host) {
    // Pause the radio, or it would leak into the call and echo on air.
    const player = document.getElementById("player");
    if (player && !player.paused) player.pause();
    setUi("live", "You're live with " + (host || "the studio") + ". Use headphones and keep the radio off.");

    pc = new RTCPeerConnection({ iceServers });
    micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));
    pc.ontrack = (e) => { audio.srcObject = e.streams[0]; audio.play().catch(() => {}); };
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: "rtc", data: { candidate: e.candidate } }); };
    pc.onconnectionstatechange = () => {
      if (pc && (pc.connectionState === "failed")) {
        send({ type: "call-end" });
        cleanup("Couldn't connect the audio. Try again, or use the chat.");
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: "rtc", data: { sdp: pc.localDescription } });
  }

  async function onRtc(data) {
    if (!pc || !data) return;
    try {
      if (data.sdp) await pc.setRemoteDescription(data.sdp);
      else if (data.candidate) await pc.addIceCandidate(data.candidate);
    } catch (_) {}
  }

  btn.addEventListener("click", () => {
    if (state === "idle") startCall();
    else { send({ type: "call-end" }); cleanup(state === "waiting" ? "Call cancelled." : "Call ended."); }
  });
  setUi("idle", "");
})();
