/* ============================================================
   Ramatlabama FM — Live Radio + Community Hub front-end
   - Persistent radio bar (audio never stops on tab/section change)
   - Autoplay with first-interaction fallback
   - Landing page: hero (current show), news ticker, On Air list
   - Public chat; a chosen name locks for the session
   ============================================================ */

(() => {
  "use strict";
  console.log("%cRamatlabama FM app build v9 loaded", "color:#ff5a36;font-weight:bold");
  const cfg = window.RADIO_CONFIG || {};

  /* ===================================================================
     Small helpers
     =================================================================== */
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  // When the message was SENT (server timestamp), in the reader's local time.
  // Older than today: prefix "Yesterday" or the date.
  function msgTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((today - day) / 86400000);
    if (diff <= 0) return hm;
    if (diff === 1) return "Yesterday " + hm;
    return d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + hm;
  }
  function byId(id) { return document.getElementById(id); }

  /* ===================================================================
     RADIO PLAYER
     =================================================================== */
  const player    = byId("player");
  const heroPlay  = byId("heroPlay");
  const statusEl  = byId("radioStatus");
  const livePill  = byId("livePill");
  const liveLabel = livePill ? livePill.querySelector(".live-label") : null;
  const volume    = byId("volume");

  function setStatus(text) { if (statusEl) statusEl.textContent = text; }
  function setLive(on) {
    if (livePill)  livePill.classList.toggle("on", on);
    if (liveLabel) liveLabel.textContent = on ? "LIVE" : "OFFLINE";
  }

  const streamUrl = (cfg.streamUrl || "").trim();
  if (!streamUrl) setStatus("No stream URL set — add it in config.js");
  if (volume) {
    player.volume = parseFloat(volume.value);
    volume.addEventListener("input", () => {
      player.volume = parseFloat(volume.value);
      if (yt && yt.setVolume) { try { yt.setVolume(Math.round(player.volume * 100)); } catch (_) {} }
    });
  }

  /* ---- Live show vs fill-in music ----
     The server tells us whether a presenter is on air (it watches Famcast).
     Off air: play the God Admin's fill-in music for the current time slot,
     mixing uploaded songs (the <audio> element) and YouTube links (a visible
     YouTube player). On air: switch to the live stream straight away. */
  let intent = false;       // has the listener asked to listen?
  let mode = null;          // "live" | "music" (uploaded song) | "yt" (YouTube) | null
  let onAir = null;         // null until the server tells us
  let switching = false;    // true while we change the <audio> source ourselves
  let musicCache = { tracks: [], links: [], genre: "", slot: "" };
  let recent = [];          // recently played ids (own-pick fallback only)
  let nowTitle = "";
  let musicErrors = 0;
  let retryTimer = 0;

  /* ---- Station clock ----
     The server says what the station is playing and how far into the song it is.
     Every listener plays that same song from that same second, so opening the site,
     logging in or pressing Play joins the song in progress instead of starting over.
     Only if this device can't play it (e.g. YouTube blocked) does it pick its own. */
  let station = null;       // { seq, id, type, kind, ytId, url, title, idx, dur, offset, at }
  let stationSend = null;   // set by the chat socket
  let following = false;    // playing the station's song (not our own pick)
  let curKey = "";          // which item is loaded now
  let endTimer = 0;
  const keyOf = (it) => it.id + ":" + (it.idx || 0);
  function setStation(st) { station = st ? { ...st, at: Date.now() } : null; }
  function stationOffset() { return station ? station.offset + (Date.now() - station.at) / 1000 : 0; }
  function report(extra) {
    if (station && stationSend) stationSend({ type: "station-report", seq: station.seq, ...extra });
  }
  function canFollow(st) { return !!st && (st.type === "file" || (!ytBlocked && Date.now() >= ytDownUntil)); }

  /* ---- YouTube fill-in music: audio only (the player is kept off-screen) ----
     One player is kept for the whole visit and new songs are loaded into it. On iPhones
     that matters: once you've tapped to start sound, later songs play without another tap. */
  let ytApi = null, yt = null, ytReady = false, ytItem = null, ytTimer = 0;
  let ytBlocked = false;    // this browser won't play hidden YouTube audio: use uploaded songs instead
  let ytDownUntil = 0;      // YouTube couldn't load: skip YouTube links until this time
  let ytNeedSync = false;   // jump to the station's position on the next PLAYING
  let ytReported = false;   // song length already sent for this song
  let curId = null;         // id of the uploaded song now playing

  /* ---- Radio goes quiet while a rendered video plays its sound (display.js calls this) ---- */
  // Fill-in music pauses (then rejoins the station); a live show is only muted,
  // so the stream connection isn't dropped.
  let ducked = false;
  function applyDuck() {
    if (ducked) {
      if (mode === "music" && !player.paused) { try { player.pause(); } catch (_) {} }
      if (mode === "yt" && yt) { try { yt.pauseVideo(); } catch (_) {} }
      player.muted = mode === "live";
      setStatus(duckers.has("call") ? "⏸ Paused while you're on the line" : "⏸ Paused for the video");
    } else {
      player.muted = false;
      if (yt) { try { yt.unMute(); } catch (_) {} }
      if (intent && onAir !== true && (mode === "music" || mode === "yt")) {
        if (following) { if (!nextFill()) offAirIdle(); }   // rejoin the station where it is now
        else if (mode === "music" && player.paused && player.getAttribute("src") && !player.ended) player.play().catch(onPlayReject);
        else if (mode === "yt" && yt) { try { yt.playVideo(); } catch (_) {} }
        else if (mode === "music" && player.ended) { if (!nextFill()) offAirIdle(); }
      }
      if (mode === "live") setStatus("● LIVE");
      else if (nowTitle) setStatus("♪ " + nowTitle);
    }
    setButton(); setPill();
  }
  // Several things can hold the radio quiet at once (a rendered video, the listener's own call).
  const duckers = new Set();
  window.RFM_RADIO = {
    duck(on, who) {
      who = who || "video";
      if (on) duckers.add(who); else duckers.delete(who);
      const next = duckers.size > 0;
      if (ducked === next) return;
      ducked = next; applyDuck();
    },
  };

  function loadYtApi() {
    if (ytApi) return ytApi;
    ytApi = new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) return resolve();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { try { if (prev) prev(); } catch (_) {} resolve(); };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api"; s.async = true;
      s.onerror = () => { ytApi = null; reject(new Error("YouTube unreachable")); };
      document.head.appendChild(s);
      setTimeout(() => { if (!(window.YT && window.YT.Player)) { ytApi = null; reject(new Error("YouTube timeout")); } }, 30000);   // slow mobile data
    });
    return ytApi;
  }
  // Playing or buffering (3) both count as "music is on", so the button never flips back mid-song.
  function ytPlaying() { try { const s = yt && yt.getPlayerState ? yt.getPlayerState() : -1; return s === 1 || s === 3; } catch (_) { return false; } }
  function parkYt() {      // stop YouTube but keep the player for the next song
    clearTimeout(ytTimer);
    ytItem = null;
    if (yt && ytReady) { try { yt.pauseVideo(); } catch (_) {} }
  }
  function destroyYt() {
    clearTimeout(ytTimer);
    if (yt) { try { yt.destroy(); } catch (_) {} }
    yt = null; ytReady = false;
    const box = byId("ytMusicBox"); if (box) box.innerHTML = '<div id="ytMusicPlayer"></div>';
  }
  function showYtTitle(t) {
    nowTitle = t;
    setStatus("♪ " + t);
  }
  // Where to start this item: the station's live position, or the top for our own picks.
  function startAt(item) {
    return following && station && keyOf(station) === keyOf(item) ? stationOffset() : 0;
  }
  function ytLoad(item) {  // load a song into the existing player
    const s = Math.floor(startAt(item));
    if (item.kind === "playlist") yt.loadPlaylist({ list: item.ytId, listType: "playlist", index: item.idx || 0, startSeconds: s });
    else yt.loadVideoById({ videoId: item.ytId, startSeconds: s });
  }
  function playYt(item) {
    clearTimeout(retryTimer);
    mode = "yt";                                     // set first: the <audio> pause below is then ignored
    try { player.pause(); } catch (_) {}
    if (player.getAttribute("src")) { player.removeAttribute("src"); try { player.load(); } catch (_) {} }
    ytItem = item; ytNeedSync = true; ytReported = false;
    showYtTitle(item.title);
    setButton(); setPill();
    loadYtApi().then(() => {
      if (mode !== "yt" || ytItem !== item) return;   // something else took over meanwhile
      if (yt && ytReady) {
        try { ytLoad(item); armIfSilent(item); return; } catch (_) { destroyYt(); }
      }
      if (yt) return;   // still being created: onReady loads the current item
      createYt(item);
    }).catch(() => {
      if (mode !== "yt" || ytItem !== item) return;
      // YouTube unreachable for now: play uploaded songs meanwhile, and try YouTube again soon.
      ytDownUntil = Date.now() + 20000;
      if (!nextFill()) { setStatus("Loading music…"); clearTimeout(retryTimer); retryTimer = setTimeout(() => { if (intent && onAir !== true) go(); }, 5000); }
    });
  }
  // Phones may refuse to start without a tap: say so instead of sitting silent.
  function armIfSilent(item) {
    clearTimeout(ytTimer);
    ytTimer = setTimeout(() => { if (mode === "yt" && ytItem === item && !ytPlaying()) armFirstInteractionAutoplay(); }, 5000);
  }
  function createYt(item) {
    const s = Math.floor(startAt(item));
    const vars = { autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3 };
    const opts = {
      width: "100%", height: "100%", host: "https://www.youtube-nocookie.com", playerVars: vars,
      events: {
        onReady: (e) => {
          ytReady = true;
          try { e.target.setVolume(Math.round(player.volume * 100)); } catch (_) {}
          if (mode !== "yt" || !ytItem) { try { e.target.pauseVideo(); } catch (_) {} return; }
          if (ytItem !== item) { try { ytLoad(ytItem); } catch (_) {} }   // the song changed while loading
          if (ducked) return;   // a video is playing with sound: wait (applyDuck starts it after)
          try { e.target.playVideo(); } catch (_) {}
          armIfSilent(ytItem);
        },
        onStateChange: onYtState,
        onError: () => {
          if (mode !== "yt" || !ytItem) return;
          if (following) { report({ error: true }); waitForNext(6000); return; }
          if (++musicErrors > 3) { musicErrors = 0; if (!nextFill()) offAirIdle(); return; }
          if (!nextFill()) offAirIdle();
        },
      },
    };
    if (item.kind === "playlist") { vars.listType = "playlist"; vars.list = item.ytId; vars.index = item.idx || 0; }
    else opts.videoId = item.ytId;
    if (s > 0) vars.start = s;
    yt = new window.YT.Player("ytMusicPlayer", opts);
  }
  function onYtState(e) {
    if (mode !== "yt" || !ytItem) return;
    const S = window.YT.PlayerState;
    if (e.data === S.PLAYING) {
      if (ducked) { try { e.target.pauseVideo(); } catch (_) {} return; }   // video has the floor
      musicErrors = 0; intent = true; clearTimeout(endTimer);
      syncYt();
      reportYt();
      const d = e.target.getVideoData ? e.target.getVideoData() : null;
      showYtTitle((d && d.title) || ytItem.title);
      setButton(); setPill();
    } else if (e.data === S.BUFFERING) {
      setButton(); setPill();
    } else if (e.data === S.PAUSED) {
      // Listeners can't pause the fill-in music: carry on playing (unless a video has the floor).
      if (intent && !ducked) { try { e.target.playVideo(); } catch (_) {} }
    } else if (e.data === S.ENDED) {
      onItemEnded();
    }
  }
  function syncYt() {      // once per song (and after a tap): line up with the station's second
    if (!ytNeedSync || !following || !station || station.id !== ytItem.id) return;
    ytNeedSync = false;
    try {
      if (ytItem.kind === "playlist" && yt.getPlaylistIndex() !== station.idx) return;
      const target = stationOffset(), now = yt.getCurrentTime() || 0, dur = yt.getDuration() || 0;
      if (Math.abs(now - target) > 5 && (!dur || target < dur - 3)) yt.seekTo(target, true);
    } catch (_) {}
  }
  function reportYt() {    // tell the station this song's length (and the playlist size)
    if (ytReported || !following || !station || keyOf(station) !== curKey) return;
    try {
      const dur = yt.getDuration() || 0;
      if (!dur) return;
      ytReported = true;
      report({ dur, plLen: ytItem.kind === "playlist" ? (yt.getPlaylist() || []).length : 0 });
    } catch (_) {}
  }
  // A song finished. Station songs: tell the server and wait for the next one
  // (with a fallback in case the message is lost). Own picks: just play another.
  function onItemEnded() {
    if (!intent) return;
    if (onAir === true) { playStream(); return; }
    if (!following) { if (!nextFill()) offAirIdle(); return; }
    report({ ended: true });
    waitForNext(4000);
  }
  function waitForNext(ms) {
    const key = curKey;
    clearTimeout(endTimer);
    endTimer = setTimeout(() => {
      refreshMusic().then(() => {
        if (!intent || onAir === true || curKey !== key) return;   // already moved on
        if (!nextFill()) offAirIdle();
      });
    }, ms);
  }

  function isPlaying() { return mode === "yt" ? ytPlaying() : !player.paused; }
  function setPill() {
    if (!livePill || !liveLabel) return;
    const music = intent && (mode === "music" || mode === "yt") && isPlaying();
    livePill.classList.toggle("on", onAir === true || music);
    liveLabel.textContent = onAir === true ? "LIVE" : music ? "MUSIC" : "OFFLINE";
  }
  function setButton() {
    if (!heroPlay) return;
    heroPlay.classList.remove("loading");
    const playing = intent && isPlaying();
    const music = mode === "music" || mode === "yt";
    // While fill-in music plays the button is only a label: listeners can't pause it.
    heroPlay.classList.toggle("is-locked", playing && music);
    heroPlay.setAttribute("aria-disabled", playing && music ? "true" : "false");
    heroPlay.textContent = playing ? (music ? "♪ Music playing" : "⏸ Playing Live") : "▶ Listen Live";
    if (ducked && (intent || duckers.has("call"))) {   // paused for a video / the call: just a label
      heroPlay.classList.add("is-locked"); heroPlay.setAttribute("aria-disabled", "true");
      heroPlay.textContent = duckers.has("call") ? "📞 On the line" : "▶ Video playing";
    }
  }
  function refreshMusic() {
    return fetch("/api/music/now", { cache: "no-store" })
      .then((r) => r.json())
      .then((m) => {
        if (!m || !m.ok) return null;
        musicCache = {
          tracks: Array.isArray(m.tracks) ? m.tracks : [],
          links: Array.isArray(m.links) ? m.links : [],
          genre: m.genre || "", slot: m.slot || "",
        };
        if ("station" in m) setStation(m.station);
        if (m.known) setOnAir(!!m.live);
        followStation();
        return m;
      })
      .catch(() => null);
  }
  // The station moved on (new song, new time slot, music added/removed): follow it.
  function followStation() {
    if (!intent || onAir !== false || ducked || !station || !canFollow(station)) return;
    const k = keyOf(station);
    if (k === curKey && (mode === "music" || mode === "yt")) return;   // already on it
    // YouTube already moved to this playlist song by itself: just carry on.
    if (mode === "yt" && ytItem && yt && ytReady && station.type === "yt" && station.kind === "playlist" && ytItem.ytId === station.ytId) {
      let i = -1; try { i = yt.getPlaylistIndex(); } catch (_) {}
      if (i === station.idx) {
        ytItem = { ...station, type: "yt" }; curKey = k; following = true;
        ytReported = false; ytNeedSync = true; clearTimeout(endTimer);
        syncYt(); reportYt();
        return;
      }
    }
    nextFill();
  }
  function pickItem() {     // own pick (only when this device can't play the station's song)
    const list = [
      ...musicCache.tracks.map((t) => ({ ...t, type: "file" })),
      ...(ytBlocked || Date.now() < ytDownUntil ? [] : musicCache.links).map((l) => ({ ...l, type: "yt" })),
    ];
    if (!list.length) return null;
    let pool = list.filter((t) => !recent.includes(t.id));
    if (!pool.length) { recent = []; pool = list; }
    const t = pool[Math.floor(Math.random() * pool.length)];
    recent.push(t.id);
    while (recent.length > Math.max(1, Math.floor(list.length * 0.6))) recent.shift();
    return t;
  }
  function onPlayReject(err) {
    switching = false;
    if (err && err.name === "NotAllowedError") armFirstInteractionAutoplay();
    // Other failures surface through the "error" event below.
  }
  function playStream() {
    clearTimeout(retryTimer); clearTimeout(endTimer);
    if (mode === "yt") parkYt();
    following = false; curKey = "";
    if (!streamUrl) { setStatus("No stream URL set — add it in config.js"); return; }
    mode = "live"; switching = true;
    setStatus("Connecting…");
    player.src = streamUrl + (streamUrl.includes("?") ? "&" : "?") + "t=" + Date.now();   // fresh connection
    player.play().catch(onPlayReject);
  }
  function nextFill() {      // play the station's song (or our own pick); false when there's nothing
    clearTimeout(retryTimer); clearTimeout(endTimer);
    let it;
    if (canFollow(station)) { it = { ...station }; following = true; curKey = keyOf(station); }
    else {
      it = pickItem();
      if (!it) { if (mode === "yt") parkYt(); following = false; curKey = ""; return false; }
      following = false; curKey = "own:" + it.id;
    }
    if (it.type === "yt") { curId = null; playYt(it); return true; }
    if (mode === "yt") parkYt();
    mode = "music"; switching = true; nowTitle = it.title; curId = it.id;
    const at = startAt(it);
    player.src = it.url;
    player.addEventListener("loadedmetadata", () => {
      if (curId !== it.id) return;
      const dur = player.duration;
      if (following && isFinite(dur) && !(station && station.dur)) report({ dur });
      if (at > 1 && isFinite(dur)) {
        if (at < dur - 2) { try { player.currentTime = at; } catch (_) {} }
        else onItemEnded();   // the station is already past the end of this song
      }
    }, { once: true });
    player.play().catch(onPlayReject);
    return true;
  }
  function offAirIdle() {    // nobody live and no music: wait and try again
    if (mode === "yt") parkYt();
    mode = "live"; following = false; curKey = "";
    setStatus("We're off air right now. Back soon.");
    setButton(); setPill();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (intent) go(); }, 30000);
  }
  function go() {            // start whatever should be playing right now
    if (onAir === false) { if (!nextFill()) playStream(); }
    else playStream();
  }
  function setOnAir(live) {
    const was = onAir;
    onAir = live;
    setPill();
    if (!intent || was === live || was === null) return;   // first answer only informs go()
    if (live && mode !== "live") { setStatus("We're live! Switching…"); playStream(); }
    else if (!live && mode === "live") { if (!nextFill()) offAirIdle(); }
  }
  // Every minute while music plays, re-check (time slots, and in case a station message was missed).
  setInterval(() => { if (intent && onAir === false && (mode === "music" || mode === "yt")) refreshMusic(); }, 60000);

  /* ---- Unlock the live player while YouTube music plays ----
     YouTube songs play in YouTube's own player, so the site's <audio> player (the live
     show) has never been started by a tap. Phones then refuse to start it when a presenter
     goes live, and listeners are left in silence. On the listener's first tap anywhere we
     play a split second of silence through it, so it's allowed to play the live show later. */
  let audioUnlocked = false, silentUrl = "", unlocking = false;
  // True while the silent clip (or the moment just after it) is in the player: the player's
  // own events then mean nothing and must not change the radio's state.
  function unlockNoise() {
    const src = player.getAttribute("src");
    return unlocking && (!src || src === silentUrl);
  }
  function silentClip() {
    if (silentUrl) return silentUrl;
    const n = 800, b = new Uint8Array(44 + n), v = new DataView(b.buffer);   // 0.1 s of silence, 8 kHz WAV
    const s = (o, t) => { for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); };
    s(0, "RIFF"); v.setUint32(4, 36 + n, true); s(8, "WAVE"); s(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    s(36, "data"); v.setUint32(40, n, true); b.fill(128, 44);
    silentUrl = URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
    return silentUrl;
  }
  function unlockAudio() {
    // Only needed while the <audio> player is idle (YouTube music, or nothing yet).
    if (audioUnlocked || player.getAttribute("src")) return;
    audioUnlocked = true; unlocking = true;
    const clip = silentClip();
    const tidy = () => {   // leave the player empty again, unless the live show took it meanwhile
      if (player.getAttribute("src") !== clip) { unlocking = false; return; }
      try { player.pause(); } catch (_) {}
      player.removeAttribute("src"); try { player.load(); } catch (_) {}
      setTimeout(() => { unlocking = false; }, 800);   // let the pause/emptied events pass
    };
    try {
      player.src = clip;
      const p = player.play();
      if (p && p.then) p.then(tidy, () => { audioUnlocked = false; tidy(); }); else tidy();
    } catch (_) { audioUnlocked = false; tidy(); }
  }
  ["pointerdown", "touchend", "keydown"].forEach((ev) =>
    window.addEventListener(ev, () => { if (mode !== "live" && mode !== "music") unlockAudio(); }, { passive: true, capture: true }));

  function togglePlay() {
    if (ducked) return;   // a rendered video or the listener's own call has the sound right now
    if (intent && isPlaying()) {
      if (mode === "music" || mode === "yt") return;   // fill-in music can't be paused
      intent = false; clearTimeout(retryTimer);
      player.pause();
      setStatus("Paused"); setButton(); setPill();
      return;
    }
    intent = true;
    if (heroPlay) heroPlay.classList.add("loading");
    // Music already loaded (e.g. the phone blocked autoplay): start it, lined up with the station.
    if (mode === "yt" && yt && ytReady && ytItem && onAir !== true) { ytNeedSync = true; try { yt.playVideo(); return; } catch (_) {} }
    if (mode === "music" && onAir !== true && following && player.getAttribute("src") && !player.ended) {
      const t = stationOffset();
      try { if (isFinite(player.duration) && t < player.duration - 2 && Math.abs(player.currentTime - t) > 3) player.currentTime = t; } catch (_) {}
      player.play().catch(onPlayReject);
      return;
    }
    go();
  }
  if (heroPlay) heroPlay.addEventListener("click", togglePlay);

  /* ---- Autoplay (with first-interaction fallback) ----
     iPhones (and most browsers) won't play sound until you've touched the page.
     So the first tap ANYWHERE starts the music, already at the station's position. */
  let armed = false;
  function armFirstInteractionAutoplay() {
    if (armed) return;
    armed = true;
    setStatus(onAir === true ? "🔴 We're LIVE now. Tap anywhere to listen 🔊" : "Tap anywhere to start listening 🔊");
    setButton();
    const evs = ["pointerdown", "keydown", "touchend"];
    const kick = (e) => {
      remove(); armed = false;
      if (heroPlay && e && e.target && heroPlay.contains(e.target)) return;   // the button handles itself
      if (!intent) return;
      if (mode === "yt" && yt && ytReady) {
        ytNeedSync = true;
        try { yt.playVideo(); } catch (_) {}
        // A few phones never play hidden YouTube audio, even after a tap.
        // Then use uploaded songs for this visit, if there are any.
        const item = ytItem;
        setTimeout(() => {
          if (mode !== "yt" || ytItem !== item || ytPlaying()) return;
          ytBlocked = true;
          if (musicCache.tracks.length || (station && station.type === "file")) nextFill();
          else setStatus("Music can't play on this device right now. We'll be live soon.");
        }, 4000);
        return;
      }
      if (mode === "music" && player.getAttribute("src") && !player.ended) {
        const t = following ? stationOffset() : 0;
        try { if (t > 1 && isFinite(player.duration) && t < player.duration - 2) player.currentTime = t; } catch (_) {}
        player.play().catch(onPlayReject);
        return;
      }
      go();
    };
    const remove = () => evs.forEach((ev) => window.removeEventListener(ev, kick));
    evs.forEach((ev) => window.addEventListener(ev, kick, { passive: true }));
  }
  function tryAutoplay() {
    if (!streamUrl) return;
    intent = true;
    setStatus("Connecting…");
    // Learn whether we're live (and what the station is playing) first.
    Promise.race([refreshMusic(), new Promise((r) => setTimeout(r, 2500))]).then(() => {
      if (mode === null) go();   // refreshMusic may already have started the station's song
    });
  }
  if (document.readyState !== "loading") tryAutoplay();
  else window.addEventListener("DOMContentLoaded", tryAutoplay);

  player.addEventListener("playing", () => {
    if (unlockNoise()) return;   // the silent unlock clip, not real audio
    switching = false;
    if (mode === "yt") return;
    // A new song started while a video has the floor (e.g. presenter went off air): hold it.
    if (ducked && mode === "music") { try { player.pause(); } catch (_) {} return; }
    if (ducked) { player.muted = true; setButton(); setPill(); return; }
    if (mode === "music") { musicErrors = 0; clearTimeout(endTimer); setStatus("♪ " + nowTitle); }
    else setStatus("● LIVE");
    setButton(); setPill();
  });
  player.addEventListener("pause", () => {
    if (unlockNoise()) return;
    // Ignore pauses we cause by changing songs, handing over to YouTube, or for a video.
    if (switching || player.ended || mode === "yt" || ducked) return;
    // Fill-in music can't be paused (e.g. by headphone/keyboard media keys): resume it.
    if (mode === "music" && intent) { setTimeout(() => { if (mode === "music" && player.paused && !player.ended) player.play().catch(onPlayReject); }, 0); return; }
    intent = false; clearTimeout(retryTimer);
    setStatus("Paused"); setButton(); setPill();
  });
  player.addEventListener("ended", () => {
    if (unlockNoise() || !intent || mode === "yt") return;
    if (mode === "music") onItemEnded();
    else if (onAir === true) { retryTimer = setTimeout(playStream, 3000); }   // brief drop: reconnect
    else if (!nextFill()) offAirIdle();
  });
  player.addEventListener("waiting", () => { if (!unlockNoise() && intent && mode !== "yt") setStatus("Buffering…"); });
  player.addEventListener("error", () => {
    if (unlockNoise()) return;
    switching = false;
    if (mode === "yt" || !player.getAttribute("src")) return;   // we emptied it on purpose
    if (!intent) { setButton(); setPill(); return; }
    if (mode === "music") {
      if (following) { report({ error: true }); waitForNext(6000); return; }
      // A bad file: skip it; after a few failures in a row, give up for now.
      if (++musicErrors <= 3) { setTimeout(() => { if (intent && !nextFill()) offAirIdle(); }, 1000); }
      else { musicErrors = 0; offAirIdle(); }
      return;
    }
    // Live stream failed: presenter live -> reconnect; nobody live -> fill-in music.
    if (onAir === true) { setStatus("Reconnecting…"); retryTimer = setTimeout(playStream, 4000); }
    else if (!nextFill()) offAirIdle();
  });

  /* ===================================================================
     LANDING PAGE CONTENT  (live from the server, admin-editable)
     Starts from config defaults, then is replaced by /api/content and
     refreshed whenever the console saves (via a WebSocket ping).
     =================================================================== */
  const live = {
    showsWeekday: cfg.schedule || [],
    showsSaturday: cfg.schedule || [],
    showsSunday: cfg.schedule || [],
    news: cfg.news || [],
  };

  // Pick today's schedule: Sun → Sunday, Sat → Saturday, else weekday.
  function todayShows() {
    const dow = new Date().getDay();   // 0 = Sun, 6 = Sat
    if (dow === 0) return live.showsSunday || [];
    if (dow === 6) return live.showsSaturday || [];
    return live.showsWeekday || [];
  }

  async function loadLiveContent() {
    try {
      const r = await fetch("/api/content", { cache: "no-store" });
      if (!r.ok) return;
      const c = await r.json();
      if (Array.isArray(c.showsWeekday))  live.showsWeekday  = c.showsWeekday;
      if (Array.isArray(c.showsSaturday)) live.showsSaturday = c.showsSaturday;
      if (Array.isArray(c.showsSunday))   live.showsSunday   = c.showsSunday;
      if (Array.isArray(c.news)) live.news = c.news;
      renderHome();
    } catch (_) { /* server not running: keep config defaults */ }
  }

  // Minutes since midnight for "HH:MM".
  function toMins(t) { const [h, m] = String(t || "0:0").split(":").map(Number); return h * 60 + (m || 0); }

  // Which scheduled show is on air right now? Handles overnight wrap
  // (e.g. 23:00 -> 06:00). Returns the index, or -1 if none.
  function currentShowIndex() {
    const sched = todayShows();
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    for (let i = 0; i < sched.length; i++) {
      const s = toMins(sched[i].start), e = toMins(sched[i].end);
      const onAir = s <= e ? (mins >= s && mins < e)       // same-day slot
                           : (mins >= s || mins < e);       // wraps past midnight
      if (onAir) return i;
    }
    return -1;
  }

  function renderHome() {
    // Hero "Now Broadcasting" reflects the show currently on air.
    updateNowBroadcasting();

    // Today's label
    const todayLabel = byId("todayLabel");
    if (todayLabel) {
      todayLabel.textContent = new Date().toLocaleDateString([], {
        weekday: "long", day: "numeric", month: "short",
      });
    }

    // News ticker: scrolling marquee of headlines.
    const track = byId("tickerTrack");
    if (track) {
      const items = (live.news || []).map((n) =>
        `<span class="ticker-item"><span class="ticker-tag">${escapeHtml(n.tag || "NEWS")}</span>${escapeHtml(n.title || "")}${n.body ? " — " + escapeHtml(n.body) : ""}</span>`
      );
      if (items.length) {
        // Duplicate the sequence so the loop scrolls seamlessly.
        const seq = items.join('<span class="ticker-dot">◆</span>');
        track.innerHTML = seq + '<span class="ticker-dot">◆</span>' + seq + '<span class="ticker-dot">◆</span>';
      } else {
        track.innerHTML = '<span class="ticker-item">Ramatlabama FM — live now.</span>';
      }
    }

    // On Air show list (admin-editable via config.schedule)
    const sched = byId("scheduleList");
    if (sched) {
      sched.innerHTML = (todayShows()).map((s) => `
        <div class="sched-row">
          <span class="sched-time">${escapeHtml(s.start || "")}</span>
          <span class="sched-show">${escapeHtml(s.show || "")}</span>
          <span class="sched-host">${escapeHtml(s.host || "")}</span>
        </div>`).join("") || `<p class="empty">Schedule coming soon.</p>`;
      highlightCurrentShow();
    }
  }

  // Set the hero "Now Broadcasting" to the show that is live right now.
  function updateNowBroadcasting() {
    const sched = todayShows();
    const i = currentShowIndex();
    const nowShow = byId("nowShow");
    const nowDesc = byId("nowDesc");
    const heroMeta = byId("heroMeta");
    if (i >= 0) {
      const s = sched[i];
      if (nowShow) nowShow.textContent = s.show;
      if (nowDesc) nowDesc.textContent = "with " + (s.host || "the team") + " · " + s.start + "–" + s.end;
    } else {
      // Nothing scheduled right now — fall back to station default.
      const np = cfg.nowPlaying || {};
      if (nowShow) nowShow.textContent = np.show || "Ramatlabama FM Live";
      if (nowDesc) nowDesc.textContent = np.desc || "Live from the North West border.";
    }
    if (heroMeta && cfg.nowPlaying && cfg.nowPlaying.meta) heroMeta.textContent = cfg.nowPlaying.meta;
  }

  // Highlight the on-air row in the On Air list.
  function highlightCurrentShow() {
    const rows = Array.from(document.querySelectorAll(".sched-row"));
    if (!rows.length) return;
    const current = currentShowIndex();
    rows.forEach((r, i) => r.classList.toggle("now", i === current));
  }

  renderHome();
  loadLiveContent();   // pull the live, admin-edited content from the server
  // Refresh "now broadcasting" + the highlight every minute as time passes.
  setInterval(() => { updateNowBroadcasting(); highlightCurrentShow(); }, 60000);

  /* ===================================================================
     ADVERT TAKEOVER
     Every ON_AIR_MS the On Air card hides and an advert image animates
     in (random effect each time), holds for ADVERT_MS, then On Air
     returns. Rotates through all uploaded adverts. Does nothing when no
     adverts are uploaded.
     =================================================================== */
  const ON_AIR_MS  = 3 * 60 * 1000;   // On Air visible for 3 minutes
  const ADVERT_MS  = 60 * 1000;       // advert visible for 60 seconds
  const AD_EFFECTS = ["fx-fade", "fx-zoom", "fx-slideUp", "fx-slideL", "fx-flip", "fx-blur", "fx-rotate"];

  const onairView  = byId("onairView");
  const advertView = byId("advertView");
  const advertImg  = byId("advertImg");
  const advertBg   = byId("advertBg");

  let adList = [];      // [{ id, name, url, ts }]
  let adIndex = 0;      // which advert to show next (rotation)
  let adFirstTimer = null;
  let adCycleTimer = null;
  let adHoldTimer = null;
  let lastEffect = "";

  function adSignature(list) { return list.map((a) => a.id).join("|"); }

  async function loadAdverts() {
    let next = [];
    try {
      const r = await fetch("/api/promos", { cache: "no-store" });
      if (!r.ok) return;
      const data = await r.json();
      next = Array.isArray(data.adverts) ? data.adverts : [];
    } catch (_) { next = []; }
    // Only restart the cycle if the set of adverts actually changed, so the
    // periodic refresh doesn't keep resetting the 3-minute timer.
    if (adSignature(next) !== adSignature(adList)) {
      adList = next;
      adIndex = 0;
      restartAdCycle();
    }
  }

  function randomEffect() {
    // Pick an effect different from the previous one for variety.
    let fx = AD_EFFECTS[Math.floor(Math.random() * AD_EFFECTS.length)];
    if (fx === lastEffect && AD_EFFECTS.length > 1) {
      fx = AD_EFFECTS[(AD_EFFECTS.indexOf(fx) + 1) % AD_EFFECTS.length];
    }
    lastEffect = fx;
    return fx;
  }

  // Name of the show currently on air, or "" if nothing is scheduled now.
  function currentShowName() {
    const sched = todayShows();
    const i = currentShowIndex();
    return (i >= 0 && sched[i]) ? (sched[i].show || "") : "";
  }

  // Adverts eligible to air right now: "All shows" ones, plus any targeting
  // the show currently on air (matched by name, case-insensitive).
  function eligibleAdverts() {
    const now = currentShowName().trim().toLowerCase();
    return adList.filter((a) => {
      const target = (a.show || "").trim().toLowerCase();
      if (!target) return true;            // "All shows"
      return now && target === now;        // specific show must be on air now
    });
  }

  function showAdvert() {
    if (!advertView) return;
    const eligible = eligibleAdverts();
    if (!eligible.length) return;          // nothing targeted at the current show → skip this break
    const ad = eligible[adIndex % eligible.length];
    adIndex = (adIndex + 1) % eligible.length;

    // Preload the image so the animation starts with it ready.
    const pre = new Image();
    pre.onload = () => {
      advertImg.src = ad.url;
      advertImg.alt = ad.name || "Advertisement";
      if (advertBg) advertBg.src = ad.url;   // blurred backdrop fills the box
      advertView.hidden = false;
      advertView.classList.remove("fx-out");
      const fx = randomEffect();
      AD_EFFECTS.forEach((c) => advertView.classList.remove(c));
      // reflow to restart the animation, then apply the chosen effect
      void advertView.offsetWidth;
      advertView.classList.add(fx);

      adHoldTimer = setTimeout(hideAdvert, ADVERT_MS);
    };
    pre.onerror = () => { /* skip a broken image; try again next cycle */ };
    pre.src = ad.url;
  }

  function hideAdvert() {
    if (!advertView) return;
    advertView.classList.add("fx-out");
    setTimeout(() => {
      advertView.hidden = true;
      AD_EFFECTS.forEach((c) => advertView.classList.remove(c));
      advertView.classList.remove("fx-out");
    }, 550);
  }

  function restartAdCycle() {
    if (adFirstTimer) { clearTimeout(adFirstTimer); adFirstTimer = null; }
    if (adCycleTimer) { clearInterval(adCycleTimer); adCycleTimer = null; }
    if (adHoldTimer)  { clearTimeout(adHoldTimer);  adHoldTimer = null; }
    if (advertView) { advertView.hidden = true; AD_EFFECTS.forEach((c) => advertView.classList.remove(c)); }
    if (!adList.length) return;   
   
    adFirstTimer = setTimeout(() => {
      showAdvert();
      adCycleTimer = setInterval(showAdvert, ON_AIR_MS + ADVERT_MS);
    }, ON_AIR_MS);
  }

  loadAdverts();
  // Re-check for advert changes periodically (managers may upload/remove).
  setInterval(loadAdverts, 2 * 60 * 1000);

  /* ===================================================================
     CHAT  (public, name locks once set)
     Presenters respond verbally on air — no in-chat replies/badges.
     =================================================================== */
  const messagesEl = byId("messages");
  const composer   = byId("composer");
  const nameInput  = byId("nameInput");
  const msgInput   = byId("msgInput");

  // The name box is always editable. The last name is remembered only to pre-fill it, so
  // a listener can change it any time (a change also updates their earlier messages).
  let currentName = (localStorage.getItem("rfm_name") || "").trim().slice(0, 24);
  // Private random id for this browser. The server uses it to find this listener's older
  // messages when the name changes; other people only ever see a hash of it.
  let cid = localStorage.getItem("rfm_cid") || "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(cid)) {
    cid = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12)).replace(/[^A-Za-z0-9_-]/g, "");
    try { localStorage.setItem("rfm_cid", cid); } catch (_) {}
  }
  nameInput.value = currentName;
  nameInput.readOnly = false;
  nameInput.title = "Your name. You can change it any time.";
  nameInput.addEventListener("change", () => {
    const entered = nameInput.value.trim().slice(0, 24);
    if (!entered || entered === currentName) return;
    currentName = entered;
    try { localStorage.setItem("rfm_name", currentName); } catch (_) {}
    if (backend.rename) backend.rename(currentName);
  });

  // Render one message. `msg` = { name, text, mine, system }
  function addMessage(msg) {
    const div = document.createElement("div");
    if (msg.system) {
      div.className = "msg system";
      div.textContent = msg.text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }
    div.className = "msg " + (msg.mine ? "me" : "other");
    div.innerHTML =
      `<div class="meta">${escapeHtml(msg.name)} · ${msgTime(msg.ts)}</div>` +
      `<div class="body">${escapeHtml(msg.text)}</div>`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  addMessage({ system: true, text: "Send your requests, shout-outs and dedications — presenters read them out live on air. 🎙" });

  /* ---- Backend adapter ---- */
  // Work out the chat server URL. When the page is served by our own Node
  // server (localhost, onrender.com, or ramatlabamafm.co.za) the chat lives on
  // the SAME host/port, so derive it from the current page. This makes the
  // deployed site "just work" over HTTPS (wss://) with no config edits.
  function resolveChatUrl() {
    const configured = (cfg.chatServerUrl || "").trim();
    // If opened as a plain file (file://) with no server, honour the config.
    if (location.protocol === "file:") return configured;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${location.host}`;
  }
  const backend = (cfg.chatMode === "server")
    ? createServerBackend(resolveChatUrl())
    : createLocalBackend();

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = msgInput.value.trim();
    if (!text) return;

    // Use whatever is in the name box right now.
    const entered = nameInput.value.trim().slice(0, 24);
    if (!entered) { nameInput.focus(); nameInput.placeholder = "Enter your name first"; return; }
    currentName = entered;
    try { localStorage.setItem("rfm_name", currentName); } catch (_) {}

    backend.send({ name: currentName, text });
    msgInput.value = "";
    msgInput.focus();
  });

  /* LOCAL BACKEND: this browser + cross-tab mirror via storage event. */
  function createLocalBackend() {
    const CHANNEL = "rfm_local_chat";
    window.addEventListener("storage", (e) => {
      if (e.key === CHANNEL && e.newValue) {
        const m = JSON.parse(e.newValue);
        addMessage({ name: m.name, text: m.text, ts: m.t, mine: false });
      }
    });
    return {
      send({ name, text }) {
        addMessage({ name, text, mine: true });
        localStorage.setItem(CHANNEL, JSON.stringify({ name, text, t: Date.now() }));
      },
    };
  }

  /* SERVER BACKEND: real-time shared chat seen by everyone. */
  function createServerBackend(url) {
    let ws, myName = null, myWho = "", lastHistory = null;

    function isMine(m) { return myWho ? m.who === myWho : (!m.who && m.name === myName); }
    function renderHistory() {
      messagesEl.innerHTML = "";
      (lastHistory || []).forEach((m) => addMessage({ name: m.name, text: m.text, ts: m.ts, mine: isMine(m) }));
    }

    function connect() {
      // Know our own name up front so replayed history aligns our messages right.
      if (!myName && currentName) myName = currentName;
      ws = new WebSocket(url);
      ws.addEventListener("open", () => {
        try { ws.send(JSON.stringify({ type: "hello", cid })); } catch (_) {}
        stationSend = (o) => { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); } catch (_) {} };
      });
      ws.addEventListener("message", (ev) => {
        let d; try { d = JSON.parse(ev.data); } catch { return; }
        if (d.type === "history") {
          lastHistory = d.messages || [];
          renderHistory();
        } else if (d.type === "you") {
          myWho = d.who || "";
          if (lastHistory) renderHistory();   // now we know which messages are ours
        } else if (d.type === "chat") {
          addMessage({ name: d.name, text: d.text, ts: d.ts, mine: isMine(d) });
        } else if (d.type === "cleared") {
          messagesEl.innerHTML = "";
          addMessage({ system: true, text: "Chat was cleared by the station." });
        } else if (d.type === "system") {
          addMessage({ system: true, text: d.text });
        } else if (d.type === "onair") {
          setOnAir(!!d.live);   // presenter went live / off air -> switch live <-> music
        } else if (d.type === "station") {
          setStation(d.station || null);   // the station moved on to another song
          followStation();
        } else if (d.type === "music-changed") {
          refreshMusic();       // God Admin changed songs, links or time slots
        } else if (d.type === "display") {
          if (window.RFM_DISPLAY) window.RFM_DISPLAY.show(d.display || null);   // presenter rendered / cleared
        } else if (d.type === "content-updated") {
          loadLiveContent();   // admin changed shows/news — refresh
        }
        // presence (online count) intentionally ignored — not shown.
      });
      ws.addEventListener("close", () => { setTimeout(connect, 2500); });
      ws.addEventListener("error", () => ws.close());
    }
    connect();

    return {
      rename(name) {
        myName = name;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "rename", name }));
      },
      send({ name, text }) {
        myName = name;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "chat", name, text, cid }));
        else addMessage({ system: true, text: "Not connected — message not sent." });
      },
    };
  }
})();

/* Phones: when the keyboard closes, snap the page back into place so the
   user never has to pinch/scroll to re-fit the screen. */
(() => {
  "use strict";
  const isTouch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  if (!isTouch) return;
  document.addEventListener("focusout", (e) => {
    if (!e.target || !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    setTimeout(() => {
      const active = document.activeElement;
      if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return;   // moved to another box
      window.scrollTo(0, 0);
      const vv = window.visualViewport;
      if (vv && vv.scale > 1) {
        // Re-fit if the browser left the page zoomed in.
        const m = document.querySelector('meta[name="viewport"]');
        if (m) {
          const orig = m.getAttribute("content");
          m.setAttribute("content", "width=device-width, initial-scale=1.0, maximum-scale=1.0");
          setTimeout(() => m.setAttribute("content", orig), 300);
        }
      }
    }, 150);
  });
})();
