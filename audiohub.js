/* ============================================================
   Ramatlabama FM — shared audio for the portal
   One AudioContext and one microphone for the whole page, shared by the
   On-Air studio (desk.js) and the call lines (studio.js). Sharing matters:
   phones (iPhones especially) mute the first microphone when a second one
   is opened, and sound from two AudioContexts can't be mixed together.

   The desk registers itself here (RFM_AUDIO.desk). The call lines then send
   callers into the desk's CALLS fader instead of straight to the speakers,
   and send the desk's music to the callers so they hear the show.
   ============================================================ */
(() => {
  "use strict";
  const MIC = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false };
  let ctx = null, mic = null, micPromise = null, micUsers = 0;
  const listeners = new Set();

  window.RFM_AUDIO = {
    ctx() {
      if (!ctx || ctx.state === "closed") ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
      return ctx;
    },
    async resume() { const c = this.ctx(); if (c.state !== "running") { try { await c.resume(); } catch (_) {} } return c; },
    // The one microphone. Each user calls releaseMic() when done; the last one stops it.
    async mic() {
      micUsers++;
      if (mic && mic.getAudioTracks().some((t) => t.readyState === "live")) return mic;
      if (!micPromise) {
        micPromise = navigator.mediaDevices.getUserMedia(MIC)
          .then((s) => { mic = s; micPromise = null; return s; })
          .catch((e) => { micPromise = null; micUsers = Math.max(0, micUsers - 1); throw e; });
      }
      return micPromise;
    },
    releaseMic() {
      micUsers = Math.max(0, micUsers - 1);
      if (!micUsers && mic) { mic.getTracks().forEach((t) => t.stop()); mic = null; }
    },
    desk: null,   // set by desk.js: { callsIn: AudioNode, musicOut: AudioNode }
    setDesk(d) { this.desk = d; listeners.forEach((f) => { try { f(d); } catch (_) {} }); },
    onDesk(f) { listeners.add(f); return () => listeners.delete(f); },
  };
})();
