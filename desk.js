/* ============================================================
   Ramatlabama FM — 🔴 On Air studio (portal tab)
   A full radio desk in the browser, on a computer or a phone:
     - Deck A and Deck B: waveform, time played / left, CUE, PLAY, stop, load, eject
     - Mixer: CH A, CH B, MIC and CALLS faders with level meters, crossfader
     - TALK (mic on air) with TALK-OVER (music dips while you talk)
     - Playlist: the station's uploaded music + your own files, search, LOAD A / LOAD B
     - Cart wall: jingles, SFX, clips and ads, fired live with one tap
     - GO LIVE: everything on air is recorded in this page and sent to our server,
       which turns it into MP3 and feeds Famcast (see server/broadcast.js).
   What goes on air:  decks + carts + MIC (when TALK is on) + CALLS
   What you hear:     decks + carts + CALLS (never your own mic: no delay in your ears)
   What callers hear: you + the other callers (studio.js) + the music
   ============================================================ */
(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const wsUrl = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host;
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };
  const faderGain = (v) => Math.pow(v / 100, 2) * 1.5625;   // 80% = unity, 100% = +4 dB
  const CART_CATS = [["all", "All"], ["jingles", "Jingles"], ["sfx", "SFX"], ["clips", "Clips"], ["ads", "Ads"]];

  let token = null, me = null, ws = null, started = false;
  let N = null;                 // audio engine nodes
  const decks = {};
  let tracks = [], hidden = new Set(), localN = 0;
  let carts = [], cartFilter = "all", canManageCarts = false;
  const cartCache = new Map();  // id -> AudioBuffer
  const cartPlaying = new Map(); // id -> { src, start, dur }
  let micOn = false, micHeld = false, micSrc = null;
  let state = null;             // bc-state from the server
  let wantLive = false, rec = null, recMime = "", sendChain = Promise.resolve(), wakeLock = null, liveSince = 0;
  let listenAudio = null, wasHiddenLive = false;
  let recs = [], recSeqSeen = 0, recCanManage = false, recPlayer = null, shows = null;

  /* ================= markup ================= */
  function deckHtml(D) {
    return `
    <section class="dk-card dk-deck" data-deck="${D}" id="dkDeck${D}">
      <div class="dk-deckhead">
        <div class="dk-deckinfo">
          <div class="dk-decktag">DECK ${D}</div>
          <div class="dk-title" id="dkTitle${D}">Drop a playlist track or audio file</div>
          <div class="dk-sub" id="dkSub${D}">EMPTY</div>
        </div>
        <span class="dk-chip" id="dkState${D}">STANDBY</span>
      </div>
      <div class="dk-wave" id="dkWaveBox${D}"><canvas id="dkWave${D}"></canvas><span class="dk-wavehint" id="dkHint${D}">WAVEFORM READY</span></div>
      <div class="dk-times">
        <span class="dk-time" id="dkTime${D}">0:00</span>
        <span class="dk-remain"><b id="dkRem${D}">-0:00</b><small id="dkTot${D}">0:00 TOTAL</small></span>
      </div>
      <div class="dk-controls">
        <div class="dk-platter" id="dkPlat${D}"><i></i><span>${D}</span></div>
        <button type="button" class="dk-btn dk-cue" id="dkCue${D}">↺ CUE</button>
        <button type="button" class="dk-btn dk-play" id="dkPlay${D}">▷ PLAY</button>
      </div>
      <div class="dk-deckfoot">
        <button type="button" class="dk-icon" id="dkHalt${D}" title="Stop">■</button>
        <label class="dk-icon" title="Load an audio file">📂<input type="file" accept="audio/*" hidden id="dkFile${D}" /></label>
        <button type="button" class="dk-icon" id="dkEject${D}" title="Eject">⏏</button>
      </div>
    </section>`;
  }
  function faderHtml(ch, name) {
    return `
      <div class="dk-fader dk-ch-${ch}" id="dkFader_${ch}">
        <div class="dk-chname">${name}</div>
        <div class="dk-fbody"><canvas class="dk-meter" id="dkMeter_${ch}" width="16" height="150"></canvas>
          <input type="range" class="dk-vslider" id="dkFad_${ch}" min="0" max="100" value="80" aria-label="${name} level" /></div>
        <div class="dk-pct" id="dkPct_${ch}">80%</div>
      </div>`;
  }
  function build(root) {
    root.innerHTML = `
    <div class="dk" id="dk">
      <div class="dk-main">
        <!-- One bar: going live, recording, the show's status, the lines, TALK and settings -->
        <header class="dk-card dk-top">
          <div class="dk-transport">
            <span class="dk-livedot" id="dkLiveDot" aria-hidden="true"></span>
            <button type="button" class="dk-btn dk-go" id="dkGo">GO LIVE</button>
            <button type="button" class="dk-btn" id="dkStop">STOP</button>
            <button type="button" class="dk-btn dk-rec" id="dkRec" title="Go live first to record">● REC</button>
          </div>
          <div class="dk-status" id="dkStatus">Off air</div>
          <div class="dk-topbtns">
            <button type="button" class="dk-pill dk-linespill" id="dkCalls" title="Calls: open the lines, see who's waiting">📞 <span>LINES</span> <b id="dkCallsN"></b></button>
            <span class="dk-micgroup">
              <button type="button" class="dk-mic" id="dkTalk" aria-pressed="false" aria-label="Microphone" title="Microphone off. Tap to talk on air.">
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 14.5a3.5 3.5 0 0 0 3.5-3.5V5.5a3.5 3.5 0 0 0-7 0V11a3.5 3.5 0 0 0 3.5 3.5zm6-3.5a6 6 0 0 1-12 0H4.2a7.8 7.8 0 0 0 6.9 7.75V22h1.8v-3.25A7.8 7.8 0 0 0 19.8 11H18z"/></svg>
              </button>
              <button type="button" class="dk-micpick" id="dkMicPick" title="Choose which microphone to use" aria-label="Choose microphone">▾</button>
            </span>
            <button type="button" class="dk-pill dk-gear" id="dkGear" title="Studio settings" aria-expanded="false">⚙</button>
            <span class="dk-wifi" id="dkWifi" title="Connection">●</span>
          </div>
        </header>
        <!-- Settings you rarely change: hidden until ⚙ is pressed -->
        <div class="dk-card dk-settings" id="dkSettings" hidden>
          <label class="dk-micsel">Microphone
            <span class="dk-microw"><select id="dkMicSel" aria-label="Microphone"><option value="">Default microphone</option></select>
              <button type="button" class="dk-icon" id="dkMicRefresh" title="Plugged something in? Refresh the list">↻</button></span>
            <small id="dkMicNote"></small></label>
          <label>Decks<select id="dkDecks"><option value="2">2 decks</option><option value="1">1 deck</option></select></label>
          <label>Quality<select id="dkQuality">
            <option value="64">Low (64 kbps)</option><option value="96">Medium (96 kbps)</option>
            <option value="128" selected>High (128 kbps)</option><option value="192">Very high (192 kbps)</option>
          </select></label>
          <label>Headphones<input type="range" id="dkMonitor" min="0" max="100" value="80" aria-label="Headphone level" /></label>
          <label class="dk-check"><input type="checkbox" id="dkTalkover" checked /> Music dips while I talk</label>
          <div class="dk-setbtns">
            <button type="button" class="dk-btn dk-smb" id="dkListen" title="Hear what leaves the studio (a few seconds late)">🎧 Listen</button>
            <button type="button" class="dk-btn dk-smb" id="dkUsage">📊 Usage</button>
            <button type="button" class="dk-btn dk-smb" id="dkReload">⟳ Reload</button>
          </div>
        </div>

        <div class="dk-decks" id="dkDecksRow">
          ${deckHtml("A")}
          <section class="dk-card dk-mixer">
            <div class="dk-mixhead"><span class="dk-label">MIXER</span><span class="dk-onair"><small>ON AIR</small><canvas id="dkMaster" width="160" height="8"></canvas></span></div>
            <div class="dk-faders">
              ${faderHtml("A", "CH A")}${faderHtml("B", "CH B")}${faderHtml("mic", "MIC")}${faderHtml("calls", "CALLS")}
            </div>
            <div class="dk-xf" id="dkXfBox">
              <div class="dk-xflab"><span class="dk-a">A</span><small>CROSSFADE</small><span class="dk-b">B</span></div>
              <input type="range" id="dkXfade" min="0" max="100" value="50" aria-label="Crossfade" />
            </div>
          </section>
          ${deckHtml("B")}
        </div>

        <div class="dk-bottom">
          <!-- The call lines (studio.js fills these in: same ids as the old Studio tab) -->
          <section class="dk-card dk-lines" id="dkLines">
            <div class="dk-cartbar">
              <div><strong>📞 Lines</strong><small id="hostStatus">Loading…</small></div>
              <button type="button" class="btn-primary" id="hostToggleBtn">📞 Open the lines</button>
            </div>
            <div class="invite-row" id="inviteRow" hidden>
              <select id="inviteSelect" aria-label="Choose a co-host"></select>
              <button type="button" class="dk-btn dk-smb" id="inviteBtn">➕ Invite co-host</button>
            </div>
            <div id="inviteList"></div>
            <div class="save-state" id="studioState"></div>
            <div class="dk-cohost" id="cohostCard" hidden>
              <div class="dk-cohostrow">
                <div><strong>🎧 Co-host</strong><div class="save-state" id="cohostStatus"></div></div>
                <div class="live-actions">
                  <button type="button" class="dk-btn dk-smb" id="cohostMuteBtn">🔇 Mute my mic</button>
                  <button type="button" class="btn-danger" id="cohostLeaveBtn">⏹ Leave</button>
                </div>
              </div>
              <div class="meter" id="cohostMeterWrap"><div class="meter-bar" id="cohostMeter"></div></div>
              <audio id="cohostAudio" autoplay></audio>
            </div>
            <div class="dk-label dk-linelab">WAITING</div>
            <div class="call-queue" id="callQueue"><p class="dk-empty">No callers waiting.</p></div>
            <div class="dk-label dk-linelab">ON THE LINE <span id="lineCount"></span></div>
            <div id="lineList"><p class="dk-empty">Nobody on the line.</p></div>
            <p class="dk-hint">🎧 Wear headphones. Callers you put through go on air on the CALLS fader. They hear you, the music and each other.</p>
          </section>
          <section class="dk-card dk-list">
            <div class="dk-listbar">
              <input type="search" id="dkSearch" placeholder="Search tracks…" />
              <span class="dk-count" id="dkCount">0 / 0 tracks</span>
              <label class="dk-btn dk-smb dk-auto" title="When a song ends, the next one starts on the other deck"><input type="checkbox" id="dkAuto" /> ⏭ Auto next</label>
              <button type="button" class="dk-btn dk-smb" id="dkClear">🗑 Clear</button>
              <label class="dk-btn dk-smb">⬆ Load Files<input type="file" id="dkFiles" accept="audio/*" multiple hidden /></label>
            </div>
            <div class="dk-tracks" id="dkTracks"></div>
          </section>
          <section class="dk-card dk-carts">
            <div class="dk-cartbar">
              <div><strong>Cart wall</strong><small>Tap a cart to fire it live</small></div>
              <input type="search" id="dkCartSearch" placeholder="Search carts" />
            </div>
            <div class="dk-chips" id="dkChips"></div>
            <div class="dk-cartgrid" id="dkCartGrid"></div>
            <div class="dk-cartadd">
              <select id="dkCartCat" aria-label="Cart type"><option value="jingles">Jingle</option><option value="sfx">SFX</option><option value="clips">Clip</option><option value="ads">Ad</option></select>
              <label class="dk-btn dk-smb">＋ Add cart<input type="file" id="dkCartFile" accept="audio/*" hidden /></label>
            </div>
          </section>
          <section class="dk-card dk-recs">
            <div class="dk-cartbar">
              <div><strong>Recordings</strong><small>While live, press ● REC to record. Saved as MP3 when you stop recording or go off air. Downloading removes it from the server.</small></div>
              <span class="dk-count" id="dkRecUsed"></span>
            </div>
            <div class="dk-reclist" id="dkRecList"><p class="dk-empty">No recordings yet.</p></div>
          </section>
        </div>
        <div class="dk-msg" id="dkMsg" role="status"></div>
      </div>
    </div>`;
    if (window.RFM_STUDIO && window.RFM_STUDIO.render) window.RFM_STUDIO.render();   // fill in the lines
  }

  function say(text, bad) {
    const m = byId("dkMsg"); if (!m) return;
    m.textContent = text || ""; m.classList.toggle("bad", !!bad); m.classList.toggle("show", !!text);
    clearTimeout(say.t); if (text && !bad) say.t = setTimeout(() => m.classList.remove("show"), 6000);
  }

  /* ================= audio engine ================= */
  function engine() {
    if (N) return N;
    const ctx = window.RFM_AUDIO.ctx();
    N = { ctx };
    N.program = ctx.createGain();                         // everything that goes on air
    N.musicBus = ctx.createGain();                        // decks + carts
    N.duck = ctx.createGain();                            // talk-over
    N.monitor = ctx.createGain(); N.monitor.gain.value = faderGain(80); N.monitor.connect(ctx.destination);
    N.callsIn = ctx.createGain();                         // callers arrive here (studio.js)
    N.calls = ctx.createGain(); N.calls.gain.value = faderGain(80);
    N.mic = ctx.createGain(); N.mic.gain.value = faderGain(80);
    N.carts = ctx.createGain();
    N.out = ctx.createMediaStreamDestination();
    N.duck.connect(N.musicBus); N.carts.connect(N.musicBus);
    N.musicBus.connect(N.program); N.musicBus.connect(N.monitor);
    N.callsIn.connect(N.calls); N.calls.connect(N.program); N.calls.connect(N.monitor);
    N.mic.connect(N.program);                             // mic: on air only (not in your ears)
    N.program.connect(N.out);
    const an = () => { const a = ctx.createAnalyser(); a.fftSize = 1024; a.smoothingTimeConstant = 0.3; return a; };
    N.anMaster = an(); N.program.connect(N.anMaster);
    N.anCalls = an(); N.calls.connect(N.anCalls);
    N.anMic = an(); N.mic.connect(N.anMic);
    ["A", "B"].forEach((D) => {
      const d = decks[D];
      d.src = ctx.createMediaElementSource(d.audio);
      d.fader = ctx.createGain(); d.fader.gain.value = faderGain(80);
      d.xf = ctx.createGain();
      d.an = an();
      d.src.connect(d.fader); d.fader.connect(d.xf); d.xf.connect(N.duck); d.fader.connect(d.an);
    });
    applyXfade(); applyDuck();
    window.RFM_AUDIO.setDesk({ callsIn: N.callsIn, musicOut: N.musicBus });   // callers now come through CALLS
    requestAnimationFrame(frame);
    return N;
  }
  async function wake() { engine(); await window.RFM_AUDIO.resume(); }

  function applyXfade() {
    if (!N) return;
    const one = byId("dkDecks").value === "1";
    const x = Number(byId("dkXfade").value) / 100;
    const t = N.ctx.currentTime;
    decks.A.xf.gain.setTargetAtTime(one ? 1 : Math.cos(x * Math.PI / 2), t, 0.02);
    decks.B.xf.gain.setTargetAtTime(one ? 0 : Math.sin(x * Math.PI / 2), t, 0.02);
  }
  function applyDuck() {
    if (!N) return;
    const down = micOn && byId("dkTalkover").checked;
    N.duck.gain.setTargetAtTime(down ? 0.25 : 1, N.ctx.currentTime, down ? 0.05 : 0.35);
  }

  /* ================= microphone (TALK) ================= */
  async function setTalk(on) {
    await wake();
    if (on && !micOn) {
      try { const s = await window.RFM_AUDIO.mic(); micHeld = true; micSrc = N.ctx.createMediaStreamSource(s); micSrc.connect(N.mic); }
      catch (_) { return say("Your microphone is blocked. Allow the microphone for this site.", true); }
      micOn = true;
    } else if (!on && micOn) {
      try { micSrc.disconnect(); } catch (_) {}
      micSrc = null; micOn = false;
      if (micHeld) { window.RFM_AUDIO.releaseMic(); micHeld = false; }
    }
    const b = byId("dkTalk");
    b.classList.toggle("on", micOn);
    b.setAttribute("aria-pressed", String(micOn));
    b.title = micOn ? "Microphone ON (on air). Tap to switch it off." : "Microphone off. Tap to talk on air.";
    applyDuck();
    if (micOn) fillMics();   // names of the mics show once the site may use one
  }
  // Another microphone was chosen while it's open: the MIC fader gets the new one.
  window.RFM_AUDIO.onMicChange((stream) => {
    if (!micOn || !N) return;
    const old = micSrc;
    micSrc = N.ctx.createMediaStreamSource(stream); micSrc.connect(N.mic);
    try { old.disconnect(); } catch (_) {}
  });

  /* ================= choosing the microphone ================= */
  // Browsers only list (and name) the microphones once the site may use one, so when
  // the list is still anonymous we ask for the mic for a moment, then list them all.
  let micAsked = false;
  async function fillMics(ask) {
    const sel = byId("dkMicSel"); if (!sel) return;
    let list = await window.RFM_AUDIO.devices();
    if (ask && !list.some((d) => d.label) && !micAsked && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      micAsked = true;
      try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); }
      catch (_) { byId("dkMicNote").textContent = "Allow the microphone for this site to choose one."; }
      list = await window.RFM_AUDIO.devices();
    }
    const cur = window.RFM_AUDIO.deviceId();
    const named = list.some((d) => d.label);
    const clean = (l) => String(l || "").replace(/^(Default|Communications)\s*-\s*/i, "");
    const defEntry = list.find((d) => d.deviceId === "default");
    const real = list.filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
    sel.innerHTML = "";
    const def = el("option", null, defEntry && defEntry.label ? "Default (" + clean(defEntry.label) + ")" : "Default microphone"); def.value = ""; sel.appendChild(def);
    real.forEach((d, i) => { const o = el("option", null, d.label || "Microphone " + (i + 1)); o.value = d.deviceId; sel.appendChild(o); });
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "";
    const phone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    byId("dkMicNote").textContent = !named ? "Allow the microphone for this site to see the names."
      : real.length <= 1 ? (phone
        ? "Phones switch to a plugged-in headset mic by themselves: keep Default. Headphones without a mic use the phone's mic."
        : "Only one microphone found. Check your headphones have a mic, plug them in fully, then press ↻.")
      : "";
  }
  async function chooseMic(id) {
    try {
      await window.RFM_AUDIO.setDevice(id);
      const label = window.RFM_AUDIO.currentLabel() || byId("dkMicSel").selectedOptions[0].textContent;
      say("🎙 Using " + label + (window.RFM_AUDIO.isMicOpen() ? "." : " next time the mic opens."));
    } catch (_) { say("That microphone couldn't be opened. Check it's plugged in.", true); fillMics(); }
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", () => fillMics());

  /* ================= decks ================= */
  function makeDeck(D) {
    const audio = new Audio(); audio.preload = "auto"; audio.setAttribute("playsinline", "");
    const d = { D, audio, track: null, url: "", peaks: null, cue: 0, loading: 0 };
    audio.addEventListener("ended", () => { deckState(d); if (byId("dkAuto").checked) autoNext(D); });
    ["play", "pause", "loadedmetadata", "seeked"].forEach((ev) => audio.addEventListener(ev, () => deckState(d)));
    audio.addEventListener("error", () => { if (d.track) { say("Deck " + D + " can't play “" + d.track.title + "”.", true); deckState(d); } });
    decks[D] = d;
  }
  function deckState(d) {
    const D = d.D, a = d.audio;
    const chip = byId("dkState" + D);
    const playing = !!d.track && !a.paused && !a.ended;
    const label = d.loading ? "LOADING" : !d.track ? "STANDBY" : playing ? "ON AIR" : a.ended ? "ENDED" : a.currentTime > 0.05 ? "PAUSED" : "CUED";
    chip.textContent = label;
    chip.className = "dk-chip" + (playing ? " live" : d.track ? " ready" : "");
    byId("dkPlay" + D).textContent = playing ? "❚❚ PAUSE" : "▷ PLAY";
    byId("dkPlay" + D).classList.toggle("on", playing);
    byId("dkPlat" + D).classList.toggle("spin", playing);
    byId("dkDeck" + D).classList.toggle("playing", playing);
    renderTracks();
  }
  async function blobOf(t) {
    if (t.blob) return t.blob;
    const r = await fetch(t.url, { cache: "force-cache" });
    if (!r.ok) throw new Error("download failed");
    return await r.blob();
  }
  async function loadDeck(D, t, autoplay) {
    if (D === "B" && byId("dkDecks").value === "1") D = "A";
    const d = decks[D];
    await wake();
    if (!d.audio.paused && d.track && !confirm("Deck " + D + " is playing “" + d.track.title + "”. Replace it?")) return;
    const job = ++d.loading;
    d.audio.pause();
    d.track = t; d.peaks = null; d.cue = 0;
    byId("dkTitle" + D).textContent = t.title;
    byId("dkSub" + D).textContent = t.sub || "";
    byId("dkHint" + D).textContent = "LOADING…"; byId("dkHint" + D).hidden = false;
    deckState(d); drawWave(D);
    if (t.source === "rec") {   // a recorded show: stream it from the server (too long to load whole or draw)
      if (d.url) { URL.revokeObjectURL(d.url); d.url = ""; }
      d.audio.src = t.url; d.loading = 0;
      byId("dkHint" + D).textContent = "RECORDED SHOW";
      deckState(d);
      if (autoplay) { try { await d.audio.play(); } catch (_) {} }
      return;
    }
    let blob;
    try { blob = await blobOf(t); } catch (_) { if (job === d.loading) { d.loading = 0; d.track = null; byId("dkTitle" + D).textContent = "Couldn't load that track"; byId("dkSub" + D).textContent = "EMPTY"; deckState(d); } return; }
    if (job !== d.loading) return;
    if (d.url) URL.revokeObjectURL(d.url);
    d.url = URL.createObjectURL(blob);
    d.audio.src = d.url;
    d.loading = 0;
    deckState(d);
    if (autoplay) { try { await d.audio.play(); } catch (_) {} }
    // Waveform: decode once, keep only the peaks. Very long files are skipped (phones run out of memory).
    if (blob.size > 25 * 1024 * 1024) { byId("dkHint" + D).textContent = "LONG TRACK"; return; }
    try {
      const buf = await N.ctx.decodeAudioData(await blob.arrayBuffer());
      if (d.track !== t) return;
      d.peaks = peaksOf(buf, 600);
      byId("dkHint" + D).hidden = true;
    } catch (_) { byId("dkHint" + D).textContent = "NO WAVEFORM"; }
    drawWave(D);
  }
  function peaksOf(buf, n) {
    const ch = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) ch.push(buf.getChannelData(c));
    const len = ch[0].length, step = Math.max(1, Math.floor(len / n)), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0; const s = i * step, e = Math.min(len, s + step);
      for (const data of ch) for (let j = s; j < e; j += 16) { const v = Math.abs(data[j]); if (v > m) m = v; }
      out[i] = m;
    }
    let max = 0; for (const v of out) if (v > max) max = v;
    if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
    return out;
  }
  function eject(D) {
    const d = decks[D];
    if (!d.audio.paused && !confirm("Eject Deck " + D + " while it's playing?")) return;
    d.loading++; d.audio.pause(); d.audio.removeAttribute("src"); try { d.audio.load(); } catch (_) {}
    if (d.url) URL.revokeObjectURL(d.url);
    d.url = ""; d.track = null; d.peaks = null;
    byId("dkTitle" + D).textContent = "Drop a playlist track or audio file";
    byId("dkSub" + D).textContent = "EMPTY";
    byId("dkHint" + D).textContent = "WAVEFORM READY"; byId("dkHint" + D).hidden = false;
    deckState(d); drawWave(D);
  }
  async function togglePlay(D) {
    const d = decks[D];
    if (!d.track) return say("Load a track into Deck " + D + " first.", true);
    await wake();
    if (d.audio.paused) { try { await d.audio.play(); } catch (_) { say("Tap PLAY again to start the sound.", true); } }
    else d.audio.pause();
  }
  function cue(D) {          // back to the cue point, ready to go
    const d = decks[D];
    if (!d.track) return;
    d.audio.pause();
    try { d.audio.currentTime = d.cue || 0; } catch (_) {}
  }
  function halt(D) { const d = decks[D]; d.audio.pause(); try { d.audio.currentTime = 0; } catch (_) {} }
  function autoNext(D) {
    const list = visibleTracks();
    if (!list.length) return;
    const cur = decks[D].track;
    const i = cur ? list.findIndex((t) => t.key === cur.key) : -1;
    const next = list[(i + 1) % list.length];
    const one = byId("dkDecks").value === "1";
    const O = one ? D : D === "A" ? "B" : "A";
    const other = decks[O];
    const go = () => {
      if (!one) {      // swing the crossfader over to the new deck
        const x = byId("dkXfade"), from = Number(x.value), to = O === "B" ? 100 : 0, t0 = performance.now();
        const step = (t) => { const k = Math.min(1, (t - t0) / 1500); x.value = String(Math.round(from + (to - from) * k)); applyXfade(); if (k < 1) requestAnimationFrame(step); };
        requestAnimationFrame(step);
      }
    };
    if (!one && other.track && other.audio.paused && other.audio.currentTime < 0.1 && (!cur || other.track.key !== cur.key)) { other.audio.play().catch(() => {}); go(); return; }
    loadDeck(O, next, true).then(go);
  }

  /* ================= drawing: waveforms, meters, times ================= */
  function sizeCanvas(c) {
    const r = c.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return { w, h, dpr };
  }
  function drawWave(D) {
    const c = byId("dkWave" + D); if (!c) return;
    const d = decks[D], { w, h } = sizeCanvas(c), g = c.getContext("2d");
    g.clearRect(0, 0, w, h);
    if (!d.peaks) return;
    const dur = d.audio.duration || 0, pos = dur ? d.audio.currentTime / dur : 0;
    const n = d.peaks.length, bw = w / n, mid = h / 2;
    const col = getComputedStyle(byId("dkDeck" + D)).getPropertyValue("--deck").trim() || "#e0b64b";
    for (let i = 0; i < n; i++) {
      const v = Math.max(0.02, d.peaks[i]) * (h * 0.46);
      g.fillStyle = i / n <= pos ? col : "rgba(255,255,255,0.22)";
      g.fillRect(i * bw, mid - v, Math.max(1, bw - 0.6), v * 2);
    }
    g.fillStyle = "#fff"; g.fillRect(Math.round(pos * w), 0, 2, h);
  }
  function level(an) {
    if (!an) return 0;
    const b = an._b || (an._b = new Float32Array(an.fftSize));
    an.getFloatTimeDomainData(b);
    let s = 0; for (let i = 0; i < b.length; i++) s += b[i] * b[i];
    const db = 20 * Math.log10(Math.sqrt(s / b.length) + 1e-9);
    return Math.max(0, Math.min(1, (db + 54) / 54));   // -54 dB .. 0 dB
  }
  function drawMeter(id, v) {
    const c = byId(id); if (!c) return;
    const { w, h } = sizeCanvas(c), g = c.getContext("2d");
    const segs = 18, gap = Math.max(1, h * 0.012), sh = (h - gap * (segs - 1)) / segs, lit = Math.round(v * segs);
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < segs; i++) {
      const on = i < lit;
      g.fillStyle = !on ? "rgba(255,255,255,0.08)" : i >= segs - 2 ? "#ff5a4f" : i >= segs - 5 ? "#f1cf72" : "#d4af37";
      g.fillRect(0, h - (i + 1) * sh - i * gap, w, sh);
    }
  }
  function drawBar(id, v) {
    const c = byId(id); if (!c) return;
    const { w, h } = sizeCanvas(c), g = c.getContext("2d");
    g.clearRect(0, 0, w, h);
    g.fillStyle = "rgba(255,255,255,0.1)"; g.fillRect(0, 0, w, h);
    const grd = g.createLinearGradient(0, 0, w, 0); grd.addColorStop(0, "#d4af37"); grd.addColorStop(0.8, "#f1cf72"); grd.addColorStop(1, "#ff5a4f");
    g.fillStyle = grd; g.fillRect(0, 0, w * v, h);
  }
  let lastWave = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (document.hidden || !byId("tab-desk") || !byId("tab-desk").classList.contains("active")) return;
    ["A", "B"].forEach((D) => {
      const d = decks[D], a = d.audio, dur = isFinite(a.duration) ? a.duration : 0;
      byId("dkTime" + D).textContent = fmt(a.currentTime);
      byId("dkRem" + D).textContent = "-" + fmt(dur - a.currentTime);
      byId("dkTot" + D).textContent = fmt(dur) + " TOTAL";
      byId("dkDeck" + D).classList.toggle("ending", !a.paused && dur > 0 && dur - a.currentTime < 15);
      drawMeter("dkMeter_" + D, N ? level(d.an) : 0);
    });
    if (t - lastWave > 120) { lastWave = t; drawWave("A"); drawWave("B"); }
    drawMeter("dkMeter_mic", N && micOn ? level(N.anMic) : 0);
    drawMeter("dkMeter_calls", N ? level(N.anCalls) : 0);
    drawBar("dkMaster", N ? level(N.anMaster) : 0);
    // cart progress
    cartPlaying.forEach((p, id) => {
      const tile = document.querySelector('.dk-cart[data-id="' + id + '"] .dk-cartprog');
      if (tile) tile.style.width = Math.min(100, ((N.ctx.currentTime - p.start) / p.dur) * 100) + "%";
    });
  }

  /* ================= playlist ================= */
  async function loadStationTracks() {
    try {
      const r = await fetch("/api/music/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const j = await r.json();
      if (!j || !j.ok) return;
      const station = (j.tracks || []).map((t) => ({ key: "s:" + t.id, title: t.title || "Untitled", sub: (t.genre ? t.genre + " · " : "") + "station music", url: t.url, source: "station" }));
      tracks = [...station, ...tracks.filter((t) => t.source === "local")];
      renderTracks();
    } catch (_) {}
  }
  function addLocalFiles(files) {
    const list = [...files].filter((f) => /^audio\//.test(f.type) || /\.(mp3|m4a|aac|ogg|oga|wav|flac|opus|webm)$/i.test(f.name));
    if (!list.length) return say("Choose audio files (MP3, M4A, WAV, OGG).", true);
    list.forEach((f) => tracks.push({ key: "l:" + (++localN), title: f.name.replace(/\.[^.]+$/, ""), sub: f.name, blob: f, source: "local" }));
    renderTracks();
    say("Added " + list.length + " file" + (list.length > 1 ? "s" : "") + " to the playlist. They stay on this device only.");
    return list.length;
  }
  function visibleTracks() {
    const q = byId("dkSearch").value.trim().toLowerCase();
    return tracks.filter((t) => !hidden.has(t.key) &&
      (!q || t.title.toLowerCase().includes(q) || (t.sub || "").toLowerCase().includes(q)));
  }
  function freeDeck() {
    if (byId("dkDecks").value === "1") return "A";
    const a = decks.A, b = decks.B;
    if (!a.track) return "A";
    if (!b.track) return "B";
    if (a.audio.paused) return "A";
    if (b.audio.paused) return "B";
    return Number(byId("dkXfade").value) >= 50 ? "A" : "B";   // the one you can't hear
  }
  let tracksKey = "";
  function renderTracks() {
    const box = byId("dkTracks"); if (!box) return;
    const list = visibleTracks(), all = tracks.filter((t) => !hidden.has(t.key)).length;
    byId("dkCount").textContent = list.length + " / " + all + " tracks";
    const onA = decks.A && decks.A.track ? decks.A.track.key : "", onB = decks.B && decks.B.track ? decks.B.track.key : "";
    const key = list.map((t) => t.key).join(",") + "|" + onA + "|" + onB + "|" + byId("dkDecks").value;
    if (key === tracksKey) return;
    tracksKey = key;
    box.innerHTML = "";
    if (!list.length) {
      box.appendChild(el("p", "dk-empty", tracks.length ? "No tracks match." : "No tracks yet. Upload songs in 🎵 Music, or press ⬆ Load Files."));
      return;
    }
    const one = byId("dkDecks").value === "1";
    list.forEach((t, i) => {
      const row = el("div", "dk-track" + (t.key === onA ? " on-a" : "") + (t.key === onB ? " on-b" : ""));
      row.draggable = true;
      row.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/rfm-track", t.key); e.dataTransfer.effectAllowed = "copy"; });
      row.appendChild(el("span", "dk-idx", String(i + 1).padStart(2, "0")));
      const info = el("div", "dk-tinfo");
      info.append(el("div", "dk-ttitle", t.title), el("div", "dk-tsub", t.sub || ""));
      row.appendChild(info);
      const acts = el("div", "dk-tacts");
      const b = (txt, cls, fn, title) => { const x = el("button", "dk-btn dk-tbtn " + (cls || ""), txt); x.type = "button"; if (title) x.title = title; x.onclick = fn; acts.appendChild(x); };
      b("▷", "dk-round", () => loadDeck(freeDeck(), t, true), "Play now on the free deck");
      b("LOAD A", "dk-la", () => loadDeck("A", t, false));
      if (!one) b("LOAD B", "dk-lb", () => loadDeck("B", t, false));
      b("🗑", "dk-round", () => { hidden.add(t.key); if (t.source === "local") tracks = tracks.filter((x) => x !== t); renderTracks(); }, "Remove from the playlist");
      row.appendChild(acts);
      box.appendChild(row);
    });
  }

  /* ================= cart wall ================= */
  async function loadCarts() {
    try {
      const r = await fetch("/api/carts/list", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const j = await r.json();
      if (j && j.ok) { carts = j.carts || []; canManageCarts = !!j.canManage; renderCarts(); }
    } catch (_) {}
  }
  function renderChips() {
    const box = byId("dkChips"); box.innerHTML = "";
    CART_CATS.forEach(([k, name]) => {
      const c = el("button", "dk-chipbtn dk-cat-" + k + (cartFilter === k ? " on" : ""), name); c.type = "button";
      c.onclick = () => { cartFilter = k; renderChips(); renderCarts(); };
      box.appendChild(c);
    });
  }
  function renderCarts() {
    const grid = byId("dkCartGrid"); if (!grid) return;
    const q = byId("dkCartSearch").value.trim().toLowerCase();
    const list = carts.filter((c) => (cartFilter === "all" || c.cat === cartFilter) && (!q || c.title.toLowerCase().includes(q)));
    grid.innerHTML = "";
    if (!list.length) { grid.appendChild(el("p", "dk-empty", carts.length ? "No carts here." : "No carts yet. Pick a type below and press ＋ Add cart.")); return; }
    list.forEach((c) => {
      const t = el("button", "dk-cart dk-cat-" + c.cat + (cartPlaying.has(c.id) ? " firing" : ""));
      t.type = "button"; t.dataset.id = c.id;
      t.append(el("span", "dk-carttitle", c.title), el("span", "dk-cartcat", c.cat.toUpperCase()), el("span", "dk-cartprog"));
      t.onclick = () => fireCart(c);
      if (canManageCarts || c.by === me.id) {
        const x = el("span", "dk-cartdel", "✕"); x.title = "Delete this cart";
        x.onclick = (e) => { e.stopPropagation(); deleteCart(c); };
        t.appendChild(x);
      }
      grid.appendChild(t);
    });
  }
  async function fireCart(c) {
    await wake();
    const p = cartPlaying.get(c.id);
    if (p) { try { p.src.stop(); } catch (_) {} return; }   // tap again = stop
    let buf = cartCache.get(c.id);
    if (!buf) {
      try { buf = await N.ctx.decodeAudioData(await (await fetch(c.url)).arrayBuffer()); cartCache.set(c.id, buf); }
      catch (_) { return say("That cart couldn't be played.", true); }
    }
    const src = N.ctx.createBufferSource(); src.buffer = buf; src.connect(N.carts);
    const entry = { src, start: N.ctx.currentTime, dur: buf.duration };
    cartPlaying.set(c.id, entry);
    src.onended = () => { if (cartPlaying.get(c.id) === entry) cartPlaying.delete(c.id); renderCarts(); };
    src.start();
    renderCarts();
  }
  async function addCart(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return say("That file is too big for a cart (max 8 MB).", true);
    const title = (prompt("Name this cart:", file.name.replace(/\.[^.]+$/, "")) || "").trim();
    if (!title) return;
    say("Uploading…");
    try {
      const r = await fetch("/api/carts/upload", { method: "POST", headers: { "X-Token": token, "X-Title": encodeURIComponent(title), "X-Cat": byId("dkCartCat").value, "Content-Type": file.type || "application/octet-stream" }, body: file });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Upload failed.");
      carts = j.carts || []; canManageCarts = !!j.canManage; renderCarts(); say("✓ Cart added.");
    } catch (e) { say(e.message, true); }
  }
  async function deleteCart(c) {
    if (!confirm("Delete the cart “" + c.title + "”?")) return;
    try {
      const r = await fetch("/api/carts/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, id: c.id }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Couldn't delete.");
      carts = j.carts || []; renderCarts();
    } catch (e) { say(e.message, true); }
  }

  /* ================= recording the show ================= */
  // The server records the exact MP3 that goes on air, and saves it when you go off air
  // (or switch REC off). Before going live, REC is "armed": recording starts with the show.
  const isMineLive = () => !!(state && state.live && me && state.live.userId === me.id && wantLive);
  const fmtMB = (b) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + " MB";
  async function loadShows() {
    try { shows = await (await fetch("/api/content", { cache: "no-store" })).json(); } catch (_) { shows = null; }
  }
  function showNow() {   // the scheduled show on air now (South African time)
    if (!shows) return "";
    let day = 0, mins = 0;
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Johannesburg", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date()).map((x) => [x.type, x.value]));
      day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday); mins = Number(p.hour) * 60 + Number(p.minute);
    } catch (_) { const d = new Date(); day = d.getDay(); mins = d.getHours() * 60 + d.getMinutes(); }
    const list = (day === 0 ? shows.showsSunday : day === 6 ? shows.showsSaturday : shows.showsWeekday) || [];
    const m = (t) => { const [h, x] = String(t || "0:0").split(":").map(Number); return h * 60 + (x || 0); };
    const s = list.find((x) => { const a = m(x.start), b = m(x.end); return a <= b ? mins >= a && mins < b : mins >= a || mins < b; });
    return s ? s.show : "";
  }
  function recTitle() {
    let stamp = "";
    try { stamp = new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()); } catch (_) { stamp = new Date().toLocaleString(); }
    const show = showNow();
    return (show ? show + " · " : "") + (me && me.name ? me.name + " · " : "") + stamp;
  }
  // Recording only ever starts when you press ● REC. Never by itself.
  //  - Live: the server records the exact MP3 going on air (saved when you stop REC or go off air).
  //  - Not live: the mixer is recorded on its own connection (nothing goes to listeners).
  //    Going live meanwhile doesn't interrupt it.
  let solo = null;   // { ws, rec, since, stopping, chain }
  async function toggleRec() {
    if (solo) {
      if (!confirm("Stop recording? What's recorded so far is saved as an MP3.")) return;
      return stopSolo();
    }
    if (!shows) await loadShows();
    const s = state && state.live;
    if (isMineLive()) {
      const on = !(s && s.rec);
      if (!on && !confirm("Stop recording? What's recorded so far is saved as an MP3.")) return;
      send({ type: "bc-record", token, on, title: recTitle() });
      if (on) say("● Recording the show. It's saved as an MP3 when you press REC again or go off air.");
      return;
    }
    startSolo();
  }
  async function startSolo() {
    await wake();
    const mime = pickMime();
    if (!mime) return say("This browser can't record. Use Chrome, Edge or Safari.", true);
    const sws = new WebSocket(wsUrl);
    sws.binaryType = "arraybuffer";
    const me0 = solo = { ws: sws, rec: null, since: 0, stopping: false, chain: Promise.resolve() };
    sws.onopen = () => sws.send(JSON.stringify({ type: "rec-solo-start", token, title: recTitle(), kbps: Number(byId("dkQuality").value) }));
    sws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.type === "rec-solo-ok" && solo === me0 && !me0.rec) {
        let r;
        try { r = new MediaRecorder(N.out.stream, { mimeType: mime, audioBitsPerSecond: Math.max(96, Number(byId("dkQuality").value)) * 1000 }); }
        catch (_) { try { r = new MediaRecorder(N.out.stream); } catch (e) { say("This browser can't record the mix.", true); sws.close(); return; } }
        me0.rec = r; me0.since = Date.now();
        r.ondataavailable = (e) => {
          if (!e.data || !e.data.size) return;
          me0.chain = me0.chain.then(() => e.data.arrayBuffer()).then((b) => { if (sws.readyState === 1) sws.send(b); }).catch(() => {});
        };
        r.onstop = () => { me0.chain.then(() => { if (sws.readyState === 1) sws.send(JSON.stringify({ type: "rec-solo-stop", token })); }); };
        r.start(250);
        keepAwake(true);
        say("● Recording (not live). Nothing goes to listeners. Press ● REC again to stop and save.");
        renderRec();
      } else if (d.type === "bc-recorded") {
        say("✓ Recording saved: " + d.rec.title + " (" + fmt(d.rec.secs) + ", " + fmtMB(d.rec.size) + "). Download it under Recordings.");
        loadRecs();
        try { sws.close(); } catch (_) {}
      } else if (d.type === "bc-note") { say(d.text, !!d.bad); if (d.bad && !me0.rec) { try { sws.close(); } catch (_) {} } }
      else if (d.type === "bc-error") { say(d.error, true); try { sws.close(); } catch (_) {} }
    };
    sws.onclose = () => {
      if (me0.rec && me0.rec.state !== "inactive") { try { me0.rec.stop(); } catch (_) {} }
      if (solo === me0) {
        solo = null;
        if (!me0.stopping && me0.rec) say("The recording connection dropped. What was recorded up to now is saved.", true);
        if (!wantLive) keepAwake(false);
        renderRec();
      }
    };
    sws.onerror = () => { try { sws.close(); } catch (_) {} };
    renderRec();
  }
  function stopSolo() {
    const s = solo; if (!s) return;
    s.stopping = true;
    if (s.rec && s.rec.state !== "inactive") { try { s.rec.stop(); } catch (_) { s.ws.close(); } }   // onstop sends the last audio, then "stop"
    else { try { s.ws.close(); } catch (_) {} }
    setTimeout(() => { try { s.ws.close(); } catch (_) {} }, 20000);   // the server answers long before this
    solo = null;
    if (!wantLive) keepAwake(false);
    say("Saving the recording…");
    renderRec();
  }
  function renderRec() {
    const b = byId("dkRec"); if (!b) return;
    const s = state && state.live;
    const liveRec = isMineLive() && s && s.rec;
    const since = solo && solo.since ? solo.since : liveRec ? s.rec.since : 0;
    const rec = !!since || !!(solo && !solo.since);
    b.classList.toggle("on", rec);
    b.disabled = false;
    b.textContent = since ? "● REC " + fmt((Date.now() - since) / 1000) : rec ? "● REC…" : "● REC";
    b.title = rec ? "Recording" + (liveRec ? ": " + fmtMB(s.rec.bytes) + " so far" : solo ? " (not live)" : "") + ". Tap to stop and save it."
      : isMineLive() ? "Record the show as an MP3" : "Record the mixer as an MP3 (nothing goes to listeners)";
  }
  async function loadRecs() {
    try {
      const r = await fetch("/api/recordings/list", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const j = await r.json();
      if (j && j.ok) { recs = j.recordings || []; recCanManage = !!j.canManage; byId("dkRecUsed").textContent = fmtMB(j.used) + " of " + fmtMB(j.max); renderRecs(); }
    } catch (_) {}
  }
  const recUrl = (r, dl) => "/api/recordings/file/" + encodeURIComponent(r.id) + "?t=" + encodeURIComponent(token) + (dl ? "&dl=1" : "");
  function renderRecs() {
    const box = byId("dkRecList"); if (!box) return;
    box.innerHTML = "";
    if (!recs.length) { box.appendChild(el("p", "dk-empty", "No recordings waiting. GO LIVE, then press ● REC to record.")); return; }
    recs.forEach((r) => {
      const row = el("div", "dk-track dk-recrow");
      row.appendChild(el("span", "dk-idx", "🎙"));
      const info = el("div", "dk-tinfo");
      let when = ""; try { when = new Date(r.start).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (_) {}
      info.append(el("div", "dk-ttitle", r.title), el("div", "dk-tsub", [when, fmt(r.secs), fmtMB(r.size), r.byName].filter(Boolean).join(" · ")));
      row.appendChild(info);
      const acts = el("div", "dk-tacts");
      const playing = recPlayer && recPlayer.dataset.id === r.id && !recPlayer.paused;
      const b = (txt, cls, fn, title) => { const x = el("button", "dk-btn dk-tbtn " + (cls || ""), txt); x.type = "button"; if (title) x.title = title; x.onclick = fn; acts.appendChild(x); return x; };
      b(playing ? "❚❚" : "▷", "dk-round", () => previewRec(r), "Listen here (not on air)");
      const dl = el("a", "dk-btn dk-tbtn", "⬇ MP3"); dl.href = recUrl(r, true); dl.setAttribute("download", "");
      dl.title = "Download the MP3. Once it has downloaded it is removed from the server.";
      dl.onclick = (e) => {
        if (!confirm("Download “" + r.title + "”?\n\nWhen the download finishes, the recording is removed from the server to free up space. Keep the MP3 safe on your device.")) { e.preventDefault(); return; }
        if (recPlayer && recPlayer.dataset.id === r.id) { recPlayer.pause(); recPlayer = null; }
        say("Downloading… The recording leaves this list when the download has finished.");
      };
      acts.appendChild(dl);
      b("LOAD A", "dk-la", () => loadDeck("A", { key: "r:" + r.id, title: r.title, sub: "recorded show", url: recUrl(r), source: "rec" }, false), "Put this show on Deck A to replay it on air");
      if (recCanManage || (me && r.by === me.id)) b("🗑", "dk-round", () => deleteRec(r), "Delete this recording");
      row.appendChild(acts);
      box.appendChild(row);
    });
  }
  function previewRec(r) {
    if (recPlayer && recPlayer.dataset.id === r.id) { if (recPlayer.paused) recPlayer.play().catch(() => {}); else recPlayer.pause(); renderRecs(); return; }
    if (recPlayer) recPlayer.pause();
    recPlayer = new Audio(recUrl(r)); recPlayer.dataset.id = r.id;
    recPlayer.onpause = recPlayer.onplay = recPlayer.onended = () => renderRecs();
    recPlayer.play().catch(() => say("Tap ▷ again to listen.", true));
    if (isMineLive()) say("Playing in your headphones only. It is not going on air.");
  }
  async function deleteRec(r) {
    if (!confirm("Delete the recording “" + r.title + "”? This can't be undone.")) return;
    try {
      const res = await fetch("/api/recordings/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, id: r.id }) });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "Couldn't delete.");
      recs = j.recordings || []; byId("dkRecUsed").textContent = fmtMB(j.used) + " of " + fmtMB(j.max); renderRecs();
    } catch (e) { say(e.message, true); }
  }

  /* ================= going live ================= */
  function pickMime() {
    if (!window.MediaRecorder) return "";
    return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"]
      .find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch (_) { return false; } }) || "";
  }
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  async function goLive(force) {
    await wake();
    recMime = pickMime();
    if (!recMime) return say("This browser can't broadcast. Use Chrome, Edge or Safari (iPhone: iOS 14.5 or newer).", true);
    if (!force && !wantLive && !confirm("Go live now? Everything on the mixer (decks, carts, TALK and CALLS) goes on air.")) return;
    wantLive = true;
    send({ type: "bc-start", token, kbps: Number(byId("dkQuality").value), target: "famcast", force: !!force });   // the server falls back to a preview if Famcast isn't set up
    renderLive();
  }
  function startRecorder() {
    stopRecorder();
    const kbps = Number(byId("dkQuality").value);
    try { rec = new MediaRecorder(N.out.stream, { mimeType: recMime, audioBitsPerSecond: Math.max(96, kbps) * 1000 }); }
    catch (_) { try { rec = new MediaRecorder(N.out.stream); } catch (e) { wantLive = false; send({ type: "bc-stop", token }); return say("This browser can't record the mix for broadcasting.", true); } }
    const mine = rec;
    sendChain = Promise.resolve();
    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size || rec !== mine) return;
      sendChain = sendChain.then(() => e.data.arrayBuffer()).then((b) => {
        if (rec !== mine || !ws || ws.readyState !== 1) return;
        if (ws.bufferedAmount > 3 * 1024 * 1024) { say("Your internet is too slow for this quality. Choose a lower QUALITY.", true); return; }
        ws.send(b);
      }).catch(() => {});
    };
    rec.onerror = () => say("Recording stopped unexpectedly. Press GO LIVE again.", true);
    rec.start(250);
    keepAwake(true);
  }
  function stopRecorder() {
    if (rec) { const r = rec; rec = null; try { if (r.state !== "inactive") r.stop(); } catch (_) {} }
  }
  function stopLive() {
    if (!wantLive && !(state && state.live && me && state.live.userId === me.id)) return;
    const recording = !!(state && state.live && state.live.rec);
    if (!confirm("Stop the broadcast? Listeners go back to the fill-in music." + (recording ? "\n\nThe recording is saved as an MP3." : ""))) return;
    wantLive = false;
    send({ type: "bc-stop", token });
    stopRecorder(); if (!solo) keepAwake(false); renderLive();   // an off-air recording keeps going
  }
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); }
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (_) {}
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && wantLive) wasHiddenLive = true;
    if (!document.hidden) {
      if (wantLive) keepAwake(true);
      if (wasHiddenLive && wantLive) { wasHiddenLive = false; say("Keep this screen open while you're live. Phones may pause the broadcast in the background.", true); }
    }
  });
  window.addEventListener("beforeunload", (e) => { if (wantLive || solo) { e.preventDefault(); e.returnValue = ""; } });

  function renderLive() {
    const s = state && state.live;
    const mine = !!(s && me && s.userId === me.id);
    const go = byId("dkGo"), st = byId("dkStatus"), top = document.querySelector(".dk-top");
    if (!go) return;
    const onAir = mine && wantLive;
    go.classList.toggle("on", onAir);
    go.textContent = onAir ? "LIVE" : "GO LIVE";
    byId("dkLiveDot").classList.toggle("on", onAir);
    byId("dkStop").disabled = !onAir && !(mine && s);
    top.classList.toggle("live", onAir);
    top.classList.toggle("busy", !!s && !mine);
    byId("dkQuality").disabled = onAir;
    let text = "Off air";
    if (s && !mine) text = "🔴 " + s.by + " is live right now.";
    else if (s && mine) {
      const since = fmt((Date.now() - s.since) / 1000);
      const where = s.target === "famcast"
        ? (s.famcast === "on" ? "Famcast connected" : s.famcast === "connecting" ? "connecting to Famcast…" : s.famcast === "error" ? "Famcast problem" : "starting…")
        : "preview only (not on Famcast)";
      text = "LIVE " + since + " · " + where + (s.receiving ? "" : " · waiting for audio…") + (s.error ? " · " + s.error : "");
    } else if (wantLive) text = "Starting…";
    else if (state && !state.famcastReady) text = "Off air · Famcast isn't set up here, so GO LIVE runs a preview";
    st.textContent = text;
    st.title = text;
    st.classList.toggle("bad", !!(s && mine && s.error));
    st.classList.toggle("live", onAir && !(s && s.error));
    renderRec();
  }
  setInterval(renderLive, 1000);

  /* ================= socket ================= */
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      byId("dkWifi").classList.add("ok"); byId("dkWifi").title = "Connected";
      send({ type: "bc-hello", token });
      if (wantLive) send({ type: "bc-start", token, kbps: Number(byId("dkQuality").value), target: "famcast" });   // carry on after a blip
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.type === "bc-state") { state = d; if (d.recSeq && d.recSeq !== recSeqSeen) { recSeqSeen = d.recSeq; loadRecs(); } renderLive(); }
      else if (d.type === "bc-note") say(d.text, !!d.bad);
      else if (d.type === "bc-recorded") {
        const r = d.rec;
        say("✓ Recording saved: " + r.title + " (" + fmt(r.secs) + ", " + fmtMB(r.size) + "). Download it under Recordings.");
        loadRecs();
      }
      else if (d.type === "bc-ok") { liveSince = d.since; if (wantLive) startRecorder(); if (d.target === "preview") say(d.famcastReady ? "Live in PREVIEW: nothing goes to Famcast." : "Live in PREVIEW: Famcast isn't set up on this server yet. Press LISTEN to hear it."); else say("✓ You're live on Famcast."); renderLive(); }
      else if (d.type === "bc-error") {
        if (d.busy && wantLive && canTakeOver() && confirm(d.error + "\n\nTake over the broadcast?")) { goLive(true); return; }
        wantLive = false; stopRecorder(); say(d.error, true); renderLive();
      }
      else if (d.type === "bc-ended") { if (wantLive || rec) { wantLive = false; stopRecorder(); keepAwake(false); if (d.reason) say(d.reason, true); } renderLive(); }
    };
    ws.onclose = () => {
      byId("dkWifi").classList.remove("ok"); byId("dkWifi").title = "Reconnecting…";
      stopRecorder();             // a new recording starts when we're back
      if (wantLive) say("Connection lost. Reconnecting… (listeners hear a short gap)", true);
      setTimeout(connect, 1500);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  const canTakeOver = () => me && (me.role === "god" || me.role === "elevated");

  /* ================= wiring ================= */
  function wire() {
    ["A", "B"].forEach((D) => {
      byId("dkPlay" + D).onclick = () => togglePlay(D);
      byId("dkCue" + D).onclick = () => cue(D);
      byId("dkHalt" + D).onclick = () => halt(D);
      byId("dkEject" + D).onclick = () => eject(D);
      byId("dkFile" + D).onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; const before = tracks.length; if (addLocalFiles([f])) loadDeck(D, tracks[before], false); };
      const box = byId("dkWaveBox" + D);
      box.onclick = (e) => {
        const d = decks[D], dur = d.audio.duration;
        if (!d.track || !isFinite(dur)) return;
        const r = box.getBoundingClientRect();
        try { d.audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur; } catch (_) {}
      };
      const deckEl = byId("dkDeck" + D);
      deckEl.addEventListener("dragover", (e) => { e.preventDefault(); deckEl.classList.add("drop"); });
      deckEl.addEventListener("dragleave", () => deckEl.classList.remove("drop"));
      deckEl.addEventListener("drop", (e) => {
        e.preventDefault(); deckEl.classList.remove("drop");
        const key = e.dataTransfer.getData("text/rfm-track");
        if (key) { const t = tracks.find((x) => x.key === key); if (t) loadDeck(D, t, false); return; }
        const files = e.dataTransfer.files;
        if (files && files.length) { const before = tracks.length; if (addLocalFiles(files)) loadDeck(D, tracks[before], false); }
      });
    });
    const fader = (ch, node) => {
      const s = byId("dkFad_" + ch);
      s.oninput = () => { byId("dkPct_" + ch).textContent = s.value + "%"; engine(); const n = node(); if (n) n.gain.setTargetAtTime(faderGain(Number(s.value)), N.ctx.currentTime, 0.02); };
    };
    fader("A", () => decks.A.fader); fader("B", () => decks.B.fader); fader("mic", () => N.mic); fader("calls", () => N.calls);
    byId("dkXfade").oninput = () => { engine(); applyXfade(); };
    byId("dkMonitor").oninput = (e) => { engine(); N.monitor.gain.setTargetAtTime(faderGain(Number(e.target.value)), N.ctx.currentTime, 0.02); };
    byId("dkTalkover").onchange = applyDuck;
    byId("dkTalk").onclick = () => setTalk(!micOn);
    byId("dkDecks").onchange = () => {
      const one = byId("dkDecks").value === "1";
      byId("dk").classList.toggle("one-deck", one);
      if (one && !decks.B.audio.paused) decks.B.audio.pause();
      applyXfade(); tracksKey = ""; renderTracks();
    };
    byId("dkGo").onclick = () => { if (!wantLive) goLive(false); };
    byId("dkStop").onclick = stopLive;
    byId("dkRec").onclick = toggleRec;
    byId("dkReload").onclick = () => { loadStationTracks(); loadCarts(); say("Playlist and carts reloaded."); };
    const setSettings = (open) => {
      byId("dkSettings").hidden = !open; byId("dkGear").classList.toggle("open", open); byId("dkGear").setAttribute("aria-expanded", String(open));
      if (open) fillMics(true);
    };
    byId("dkMicRefresh").onclick = (e) => { e.preventDefault(); micAsked = false; fillMics(true); say("Microphone list refreshed."); };
    byId("dkGear").onclick = () => setSettings(byId("dkSettings").hidden);
    byId("dkMicPick").onclick = () => { setSettings(true); byId("dkMicSel").focus(); };
    byId("dkMicSel").onchange = (e) => chooseMic(e.target.value);
    byId("dkSearch").oninput = renderTracks;
    byId("dkClear").onclick = () => {
      const n = tracks.filter((t) => t.source === "local").length;
      if (!n && !hidden.size) return;
      if (!confirm("Clear the playlist? Your own files are removed and hidden station songs come back.")) return;
      tracks = tracks.filter((t) => t.source !== "local"); hidden.clear(); tracksKey = ""; renderTracks();
    };
    byId("dkFiles").onchange = (e) => { addLocalFiles(e.target.files); e.target.value = ""; };
    byId("dkCartSearch").oninput = renderCarts;
    byId("dkCartFile").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; addCart(f); };
    byId("dkCalls").onclick = () => {   // jump to the Lines panel (on phones it's further down)
      const l = byId("dkLines"); l.scrollIntoView({ behavior: "smooth", block: "start" });
      l.classList.remove("flash"); void l.offsetWidth; l.classList.add("flash");
    };
    byId("dkUsage").onclick = () => {
      const s = state && state.live;
      if (!s || s.userId !== me.id) return say("Not live. Usage shows here while you broadcast.");
      say("Live for " + fmt((Date.now() - s.since) / 1000) + " · sent " + (s.bytesIn / 1048576).toFixed(1) + " MB from this device · " + s.kbps + " kbps to listeners.");
    };
    byId("dkListen").onclick = () => {
      if (listenAudio) { listenAudio.pause(); listenAudio.src = ""; listenAudio = null; byId("dkListen").classList.remove("on"); return; }
      if (!(state && state.live)) return say("Nobody is live, so there's nothing to listen to yet.", true);
      say("Playing what leaves the studio (a few seconds late). Use headphones, or it echoes into your mic.");
      listenAudio = new Audio("/api/broadcast/listen?t=" + encodeURIComponent(token) + "&n=" + Date.now());
      listenAudio.play().catch(() => say("Tap LISTEN again to start.", true));
      byId("dkListen").classList.add("on");
    };
    // Any first tap in the studio starts the audio engine (phones need a tap for sound).
    byId("dk").addEventListener("pointerdown", () => { wake(); }, { once: true });
    // The studio needs the whole width of the screen.
    document.querySelectorAll(".ptab").forEach((t) => t.addEventListener("click", () => {
      document.body.classList.toggle("desk-open", t.dataset.tab === "desk");
      if (t.dataset.tab === "desk") { tracksKey = ""; renderTracks(); setTimeout(() => { drawWave("A"); drawWave("B"); }, 50); }
    }));
    // Callers waiting (studio.js keeps the count on the On Air tab's badge).
    setInterval(() => {
      const q = byId("queueCount"), n = q ? q.textContent : "";
      byId("dkCallsN").textContent = n;
      byId("dkCalls").classList.toggle("ringing", !!n);
    }, 1000);
    renderChips();
  }

  window.RFM_DESK = {
    start(tk, user) {
      token = tk; me = user;
      if (started) return;
      const root = byId("deskRoot");
      if (!root) return;
      started = true;
      makeDeck("A"); makeDeck("B");
      build(root); wire();
      renderTracks(); renderCarts();
      loadStationTracks(); loadCarts(); loadRecs(); loadShows();
      connect();
    },
    busy() { return wantLive || !!solo; },
    wake,   // studio.js: start the audio engine before opening the lines, so callers reach the CALLS fader
  };
})();
