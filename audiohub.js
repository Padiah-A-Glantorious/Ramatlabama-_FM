/* ============================================================
   Ramatlabama FM — shared audio for the portal
   One AudioContext and one microphone for the whole page, shared by the
   On-Air studio (desk.js) and the call lines (studio.js). Sharing matters:
   phones (iPhones especially) mute the first microphone when a second one
   is opened, and sound from two AudioContexts can't be mixed together.

   The presenter can choose which microphone to use (a headset, the built-in
   mic, a USB mic). The choice is remembered on this device. Switching while
   the mic is open swaps it everywhere at once (studio + callers).

   The desk registers itself here (RFM_AUDIO.desk). The call lines then send
   callers into the desk's CALLS fader instead of straight to the speakers,
   and send the desk's music to the callers so they hear the show.
   ============================================================ */
(() => {
  "use strict";
  const BASE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  const KEY = "rfm_mic";
  let ctx = null, mic = null, micPromise = null, micUsers = 0;
  let deviceId = "";
  try { deviceId = localStorage.getItem(KEY) || ""; } catch (_) {}
  const deskListeners = new Set(), micListeners = new Set();

  const constraints = (id) => ({ audio: id ? { ...BASE, deviceId: { exact: id } } : { ...BASE }, video: false });
  async function open() {
    try { return await navigator.mediaDevices.getUserMedia(constraints(deviceId)); }
    catch (e) {
      // The chosen mic was unplugged (or isn't allowed): fall back to the default one.
      if (deviceId && (e.name === "OverconstrainedError" || e.name === "NotFoundError" || e.name === "NotReadableError")) {
        deviceId = "";
        return await navigator.mediaDevices.getUserMedia(constraints(""));
      }
      throw e;
    }
  }
  const live = (s) => !!s && s.getAudioTracks().some((t) => t.readyState === "live");

  window.RFM_AUDIO = {
    ctx() {
      // "balanced": a slightly bigger buffer than "interactive", so busy moments (loading a
      // song, drawing waveforms) don't make the music stutter. Calls stay fine.
      if (!ctx || ctx.state === "closed") ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "balanced" });
      return ctx;
    },
    async resume() { const c = this.ctx(); if (c.state !== "running") { try { await c.resume(); } catch (_) {} } return c; },
    // The one microphone. Each user calls releaseMic() when done; the last one stops it.
    async mic() {
      micUsers++;
      if (live(mic)) return mic;
      if (!micPromise) {
        micPromise = open()
          .then((s) => { mic = s; micPromise = null; return s; })
          .catch((e) => { micPromise = null; micUsers = Math.max(0, micUsers - 1); throw e; });
      }
      return micPromise;
    },
    releaseMic() {
      micUsers = Math.max(0, micUsers - 1);
      if (!micUsers && mic) { mic.getTracks().forEach((t) => t.stop()); mic = null; }
    },
    isMicOpen() { return live(mic); },
    // Microphones on this device. Names only show once the site may use the mic.
    async devices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
      try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"); } catch (_) { return []; }
    },
    deviceId() { return deviceId; },
    currentLabel() { const t = mic && mic.getAudioTracks()[0]; return t ? t.label : ""; },
    // Use another microphone. If the mic is open now, swap it for everyone using it.
    async setDevice(id) {
      deviceId = id || "";
      try { if (deviceId) localStorage.setItem(KEY, deviceId); else localStorage.removeItem(KEY); } catch (_) {}
      if (!live(mic) || !micUsers) return null;
      const old = mic;
      const next = await open();
      mic = next;
      micListeners.forEach((f) => { try { f(next); } catch (_) {} });
      old.getTracks().forEach((t) => t.stop());
      return next;
    },
    onMicChange(f) { micListeners.add(f); return () => micListeners.delete(f); },
    // A question in the page (Yes / No) instead of the browser's confirm() box. confirm()
    // freezes the page on phones: while it's open no audio is sent, so the live stream
    // runs dry. This never blocks anything. Resolves true (yes) or false (no).
    ask(message, yes, no) {
      return new Promise((resolve) => {
        let box = document.getElementById("rfmAsk");
        if (box && box._done) box._done(false);   // a newer question replaces an open one
        if (!box) {
          box = document.createElement("div");
          box.id = "rfmAsk"; box.className = "rfm-ask"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "false");
          box.innerHTML = '<div class="rfm-ask-card"><p class="rfm-ask-text"></p><div class="rfm-ask-btns"><button type="button" class="rfm-ask-no"></button><button type="button" class="rfm-ask-yes"></button></div></div>';
          document.body.appendChild(box);
        }
        box.querySelector(".rfm-ask-text").textContent = message;
        box.querySelector(".rfm-ask-yes").textContent = yes || "Yes";
        box.querySelector(".rfm-ask-no").textContent = no || "Cancel";
        const done = (v) => { box._done = null; box.classList.remove("show"); document.removeEventListener("keydown", key, true); resolve(v); };
        const key = (e) => { if (e.key === "Escape") done(false); if (e.key === "Enter") done(true); };
        box._done = done;
        box.querySelector(".rfm-ask-yes").onclick = () => done(true);
        box.querySelector(".rfm-ask-no").onclick = () => done(false);
        document.addEventListener("keydown", key, true);
        box.classList.add("show");
        setTimeout(() => { try { box.querySelector(".rfm-ask-yes").focus({ preventScroll: true }); } catch (_) {} }, 30);
      });
    },
    desk: null,   // set by desk.js: { callsIn: AudioNode, musicOut: AudioNode }
    setDesk(d) { this.desk = d; deskListeners.forEach((f) => { try { f(d); } catch (_) {} }); },
    onDesk(f) { deskListeners.add(f); return () => deskListeners.delete(f); },
  };
})();
