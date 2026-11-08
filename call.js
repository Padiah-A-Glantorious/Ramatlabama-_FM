/* ============================================================
   Ramatlabama FM — Listener "Call the studio"
   Click Call -> allow mic -> wait in the queue -> the host or a co-host puts
   you through -> you're on air for as long as you like -> hang up.
   The call itself lives in callpeer.js (reconnects, repairs, no time limit).
   ============================================================ */
(() => {
  "use strict";
  const btn = document.getElementById("callBtn");
  const statusEl = document.getElementById("callStatus");
  const audio = document.getElementById("callAudio");
  if (!btn || !statusEl || !audio) return;
  const supported = !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RFMCallSession);
  if (!supported) { btn.hidden = true; return; }

  let session = null, ui = "idle", timer = 0, since = 0;
  // The radio stops while you're on the line: hearing the delayed stream would echo on air.
  const radio = (on) => { try { if (window.RFM_RADIO) window.RFM_RADIO.duck(on, "call"); } catch (_) {} };

  function setUi(s, text) {
    ui = s;
    btn.classList.toggle("calling", s !== "idle");
    btn.textContent = s === "idle" ? "📞 Call the studio" : s === "waiting" ? "✖ Cancel call" : "⏹ Hang up";
    statusEl.textContent = text || "";
    statusEl.hidden = !text;
  }
  const clock = () => {
    const s = Math.floor((Date.now() - since) / 1000);
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  };
  function liveText(info) {
    const who = info.host || "the studio";
    if (info.connected === false) return "Connecting you to " + who + "…";
    return "🔴 On air with " + who + " · " + clock();
  }

  function start() {
    let name = (localStorage.getItem("rfm_name") || "").trim();
    if (!name) {
      name = (prompt("Your name for the presenter:") || "").trim().slice(0, 24);
      if (!name) return;
      localStorage.setItem("rfm_name", name);
    }
    setUi("waiting", "Connecting…");
    session = window.RFMCallSession({
      request: { type: "call-request", name },
      onStatus(state, info) {
        if (state === "waiting") {
          setUi("waiting", info.hostOnline
            ? "You're in the queue" + (info.position ? " (number " + info.position + ")" : "") + ". A presenter will put you through. Keep this page open."
            : "You're in the queue. The studio will pick up when the lines open. Keep this page open.");
        } else if (state === "live") {
          if (ui !== "live") { since = info.since || Date.now(); radio(true); clearInterval(timer); timer = setInterval(() => { if (ui === "live") statusEl.textContent = liveText(info); }, 1000); }
          setUi("live", liveText(info));
        } else if (state === "reconnecting") {
          setUi("live", "Reconnecting the line… stay on the call.");
        }
      },
      onAudio(stream) {
        audio.srcObject = stream; audio.muted = false; audio.volume = 1;
        audio.play().catch(() => {
          // Sound blocked until a tap: the next tap anywhere starts it.
          const go = () => { audio.play().catch(() => {}); window.removeEventListener("pointerdown", go); };
          window.addEventListener("pointerdown", go);
        });
      },
      onEnded(reason) {
        clearInterval(timer); timer = 0;
        audio.srcObject = null;
        radio(false);
        session = null;
        setUi("idle", reason || "Call ended. Thanks for calling Ramatlabama FM!");
        // Short goodbye, then it's gone. A real problem (e.g. mic blocked) stays a bit longer.
        const msg = statusEl.textContent, ms = /blocked|busy|dropped/i.test(msg) ? 6000 : 2500;
        setTimeout(() => { if (ui === "idle" && statusEl.textContent === msg) setUi("idle", ""); }, ms);
      },
    });
    session.start();
  }

  btn.addEventListener("click", () => {
    if (!session) start();
    else session.hangUp();
  });
  setUi("idle", "");
})();
