/* ============================================================
   Ramatlabama FM — Live Radio + Community Hub front-end
   - Persistent radio bar (audio never stops on tab/section change)
   - Autoplay with first-interaction fallback
   - Landing page: hero (current show), news ticker, On Air list
   - Public chat; a chosen name locks for the session
   ============================================================ */

(() => {
  "use strict";
  console.log("%cRamatlabama FM app build v7 loaded", "color:#ff5a36;font-weight:bold");
  const cfg = window.RADIO_CONFIG || {};

  /* ===================================================================
     Small helpers
     =================================================================== */
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function timeNow() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
  let recent = [];          // recently played ids (avoid repeats)
  let nowTitle = "";
  let musicErrors = 0;
  let retryTimer = 0;

  /* ---- YouTube fill-in music: audio only (the player is kept off-screen) ---- */
  let ytApi = null, yt = null, ytItem = null, ytTimer = 0, ytShuffled = false;
  let ytBlocked = false;    // this browser won't play hidden YouTube audio: use uploaded songs instead
  let ytDownUntil = 0;      // YouTube couldn't load: skip YouTube links until this time
  let ytVid = null, ytSongs = 0;   // songs played in the current playlist turn
  const SONGS_PER_TURN = 3;        // then rotate to another playlist / song in the same genre
  let curId = null;                // id of the uploaded song now playing

  /* ---- Radio goes quiet while a rendered video plays its sound (display.js calls this) ---- */
  let ducked = false;
  function applyDuck() {
    player.muted = ducked;
    if (yt) { try { if (ducked) yt.mute(); else yt.unMute(); } catch (_) {} }
  }
  window.RFM_RADIO = { duck(on) { if (ducked === !!on) return; ducked = !!on; applyDuck(); } };

  /* ---- Refresh carries on the same song where it was (saved every 3 s for this tab) ---- */
  const RESUME_KEY = "rfm_resume";
  let resumeTried = false;
  function saveResume() {
    try {
      if (!intent || onAir === true) { sessionStorage.removeItem(RESUME_KEY); return; }
      let s = null;
      if (mode === "music" && curId && player.currentTime > 0) s = { kind: "file", id: curId, t: player.currentTime };
      else if (mode === "yt" && ytItem && yt && yt.getCurrentTime) {
        s = { kind: "yt", id: ytItem.id, idx: ytItem.kind === "playlist" ? (yt.getPlaylistIndex() || 0) : 0, t: yt.getCurrentTime() || 0 };
      }
      if (s) { s.at = Date.now(); sessionStorage.setItem(RESUME_KEY, JSON.stringify(s)); }
    } catch (_) {}
  }
  setInterval(saveResume, 3000);
  window.addEventListener("pagehide", saveResume);
  function takeResume() {      // the song this tab was playing before the refresh, if still valid
    if (resumeTried || (!musicCache.tracks.length && !musicCache.links.length)) return null;
    resumeTried = true;
    try {
      const s = JSON.parse(sessionStorage.getItem(RESUME_KEY) || "null");
      if (!s || Date.now() - s.at > 15 * 60000) return null;
      const list = s.kind === "file" ? musicCache.tracks : (ytBlocked ? [] : musicCache.links);
      const item = list.find((x) => x.id === s.id);   // gone, or not in this time slot any more
      if (!item) return null;
      return { item: { ...item, type: s.kind }, t: s.t + (Date.now() - s.at) / 1000, idx: s.idx || 0 };
    } catch (_) { return null; }
  }
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
  function stopYt() {
    clearTimeout(ytTimer);
    if (yt) { try { yt.destroy(); } catch (_) {} yt = null; }
    ytItem = null;
    const box = byId("ytMusicBox"); if (box) box.innerHTML = '<div id="ytMusicPlayer"></div>';
  }
  function showYtTitle(t) {
    nowTitle = t;
    setStatus("♪ " + t);
  }
  function playYt(item, resume) {
    clearTimeout(retryTimer);
    mode = "yt";                                     // set first: the <audio> pause below is then ignored
    try { player.pause(); } catch (_) {}
    if (player.getAttribute("src")) { player.removeAttribute("src"); try { player.load(); } catch (_) {} }
    stopYt();
    mode = "yt"; ytItem = item; ytShuffled = !!resume; ytVid = null; ytSongs = 0;   // resuming: no random jump
    let seekTo = resume && resume.t > 1 ? resume.t : 0;
    showYtTitle(item.title);
    setButton(); setPill();
    loadYtApi().then(() => {
      if (mode !== "yt" || ytItem !== item) return;   // something else took over meanwhile
      const vars = { autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3 };
      const opts = {
        width: "100%", height: "100%", host: "https://www.youtube-nocookie.com", playerVars: vars,
        events: {
          onReady: (e) => {
            try { e.target.setVolume(Math.round(player.volume * 100)); } catch (_) {}
            if (ducked) { try { e.target.mute(); } catch (_) {} }
            try { e.target.playVideo(); } catch (_) {}
            // Phones may refuse to start without a tap: say so instead of sitting silent.
            ytTimer = setTimeout(() => { if (mode === "yt" && ytItem === item && !ytPlaying()) armFirstInteractionAutoplay(); }, 5000);
          },
          onStateChange: (e) => {
            if (mode !== "yt" || ytItem !== item) return;
            const S = window.YT.PlayerState;
            if (e.data === S.PLAYING) {
              musicErrors = 0; intent = true;
              if (seekTo) {   // after a refresh: jump back to where the song was
                const at = seekTo; seekTo = 0;
                try { if (Math.abs((e.target.getCurrentTime() || 0) - at) > 4) e.target.seekTo(at, true); } catch (_) {}
              }
              if (item.kind === "playlist" && !ytShuffled) {      // start the playlist at a random song
                ytShuffled = true;
                try {
                  const pl = e.target.getPlaylist() || [];
                  e.target.setShuffle(true);
                  if (pl.length > 1) { ytVid = null; ytSongs = 0; e.target.playVideoAt(Math.floor(Math.random() * pl.length)); return; }
                } catch (_) {}
              }
              const d = e.target.getVideoData ? e.target.getVideoData() : null;
              // Rotate: after a few songs from one playlist, move on to another playlist/song.
              const vid = d && d.video_id;
              if (vid && vid !== ytVid) {
                ytVid = vid; ytSongs++;
                if (item.kind === "playlist" && ytSongs > SONGS_PER_TURN && fillPoolSize() > 1) { if (!nextFill()) offAirIdle(); return; }
              }
              showYtTitle((d && d.title) || item.title);
              setButton(); setPill();
            } else if (e.data === S.BUFFERING) {
              setButton(); setPill();
            } else if (e.data === S.PAUSED) {
              // Listeners can't pause the fill-in music: carry on playing.
              if (intent) { try { e.target.playVideo(); } catch (_) {} }
            } else if (e.data === S.ENDED) {
              if (item.kind === "playlist") {
                try { const pl = e.target.getPlaylist() || []; if (pl.length && e.target.getPlaylistIndex() < pl.length - 1) return; } catch (_) {}
              }
              if (intent) { if (!nextFill()) offAirIdle(); }
            }
          },
          onError: (e) => {
            if (mode !== "yt" || ytItem !== item) return;
            if (++musicErrors > 3) { musicErrors = 0; if (!nextFill()) offAirIdle(); return; }
            if (item.kind === "playlist") { try { e.target.nextVideo(); return; } catch (_) {} }   // skip a blocked song
            if (!nextFill()) offAirIdle();
          },
        },
      };
      if (item.kind === "playlist") { vars.listType = "playlist"; vars.list = item.ytId; if (resume) vars.index = resume.idx; }
      else opts.videoId = item.ytId;
      if (seekTo) vars.start = Math.floor(seekTo);
      yt = new window.YT.Player("ytMusicPlayer", opts);
    }).catch(() => {
      if (mode !== "yt" || ytItem !== item) return;
      // YouTube unreachable for now: play uploaded songs meanwhile, and try YouTube again soon.
      ytDownUntil = Date.now() + 20000;
      if (!nextFill()) { setStatus("Loading music…"); clearTimeout(retryTimer); retryTimer = setTimeout(() => { if (intent && onAir !== true) go(); }, 5000); }
    });
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
  }
  function fillPoolSize() {   // how many songs/links can play right now
    return musicCache.tracks.length + (ytBlocked || Date.now() < ytDownUntil ? 0 : musicCache.links.length);
  }
  function refreshMusic() {
    return fetch("/api/music/now", { cache: "no-store" })
      .then((r) => r.json())
      .then((m) => {
        if (!m || !m.ok) return null;
        const slotChanged = musicCache.slot && m.slot !== musicCache.slot;
        musicCache = {
          tracks: Array.isArray(m.tracks) ? m.tracks : [],
          links: Array.isArray(m.links) ? m.links : [],
          genre: m.genre || "", slot: m.slot || "",
        };
        if (m.known) setOnAir(!!m.live);
        // New time slot (e.g. Gospel -> Jazz) while a long YouTube playlist plays: move on now.
        if (slotChanged && intent && mode === "yt" && onAir !== true) {
          const still = ytItem && musicCache.links.some((l) => l.id === ytItem.id);
          if (!still && !nextFill()) offAirIdle();
        }
        return m;
      })
      .catch(() => null);
  }
  function pickItem() {
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
    clearTimeout(retryTimer);
    if (mode === "yt") stopYt();
    if (!streamUrl) { setStatus("No stream URL set — add it in config.js"); return; }
    mode = "live"; switching = true;
    setStatus("Connecting…");
    player.src = streamUrl + (streamUrl.includes("?") ? "&" : "?") + "t=" + Date.now();   // fresh connection
    player.play().catch(onPlayReject);
  }
  function nextFill() {      // play the next fill-in item; false when there's nothing to play
    clearTimeout(retryTimer);
    const r = onAir === false ? takeResume() : null;   // first song after a refresh: carry on
    const it = r ? r.item : pickItem();
    refreshMusic();          // keep the list fresh (new slot, new uploads/links)
    if (!it) { if (mode === "yt") stopYt(); return false; }
    if (r) recent.push(it.id);
    if (it.type === "yt") { curId = null; playYt(it, r); return true; }
    if (mode === "yt") stopYt();
    mode = "music"; switching = true; nowTitle = it.title; curId = it.id;
    player.src = it.url;
    if (r && r.t > 1) {
      const at = r.t;
      player.addEventListener("loadedmetadata", () => {
        if (!isFinite(player.duration)) return;
        if (at < player.duration - 2) { try { player.currentTime = at; } catch (_) {} }
        else setTimeout(() => { if (intent && mode === "music" && !nextFill()) offAirIdle(); }, 0);   // that song had finished
      }, { once: true });
    }
    player.play().catch(onPlayReject);
    return true;
  }
  function offAirIdle() {    // nobody live and no music: wait and try again
    if (mode === "yt") stopYt();
    mode = "live";
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
  // Every minute while music plays, check for a new time slot (Gospel -> Jazz etc.).
  setInterval(() => { if (intent && onAir === false && (mode === "music" || mode === "yt")) refreshMusic(); }, 60000);

  function togglePlay() {
    if (intent && isPlaying()) {
      if (mode === "music" || mode === "yt") return;   // fill-in music can't be paused
      intent = false; clearTimeout(retryTimer);
      if (mode === "yt") { try { yt.pauseVideo(); } catch (_) {} } else player.pause();
      setStatus("Paused"); setButton(); setPill();
      return;
    }
    intent = true;
    if (heroPlay) heroPlay.classList.add("loading");
    if (mode === "yt" && yt && onAir !== true) { try { yt.playVideo(); return; } catch (_) {} }
    // Resume a paused song where it stopped; otherwise start fresh.
    if (mode === "music" && onAir !== true && player.src && !player.ended && player.currentTime > 0) {
      player.play().catch(onPlayReject);
    } else go();
  }
  if (heroPlay) heroPlay.addEventListener("click", togglePlay);

  /* ---- Autoplay (with first-interaction fallback) ---- */
  let armed = false;
  function armFirstInteractionAutoplay() {
    if (armed) return;
    armed = true;
    setStatus("Tap anywhere to start listening 🔊");
    setButton();
    const evs = ["pointerdown", "keydown", "touchstart"];
    const kick = (e) => {
      remove(); armed = false;
      if (heroPlay && e && e.target && heroPlay.contains(e.target)) return;   // the button handles itself
      if (!intent) return;
      if (mode === "yt" && yt) {
        try { yt.playVideo(); } catch (_) {}
        // Some phones (mostly iPhones) never play hidden YouTube audio, even after a tap.
        // Then use uploaded songs for this visit, if there are any.
        const item = ytItem;
        setTimeout(() => {
          if (mode !== "yt" || ytItem !== item || ytPlaying()) return;
          ytBlocked = true;
          if (musicCache.tracks.length) nextFill();
          else setStatus("Music can't play on this device right now. We'll be live soon.");
        }, 4000);
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
    // Learn whether we're live first, so off-air visitors go straight to music.
    Promise.race([refreshMusic(), new Promise((r) => setTimeout(r, 2500))]).then(go);
  }
  if (document.readyState !== "loading") tryAutoplay();
  else window.addEventListener("DOMContentLoaded", tryAutoplay);

  player.addEventListener("playing", () => {
    switching = false;
    if (mode === "yt") return;
    if (mode === "music") { musicErrors = 0; setStatus("♪ " + nowTitle); }
    else setStatus("● LIVE");
    setButton(); setPill();
  });
  player.addEventListener("pause", () => {
    // Ignore pauses we cause by changing songs or handing over to YouTube.
    if (switching || player.ended || mode === "yt") return;
    // Fill-in music can't be paused (e.g. by headphone/keyboard media keys): resume it.
    if (mode === "music" && intent) { setTimeout(() => { if (mode === "music" && player.paused && !player.ended) player.play().catch(onPlayReject); }, 0); return; }
    intent = false; clearTimeout(retryTimer);
    setStatus("Paused"); setButton(); setPill();
  });
  player.addEventListener("ended", () => {
    if (!intent || mode === "yt") return;
    if (mode === "music") { if (onAir === true) playStream(); else if (!nextFill()) offAirIdle(); }
    else if (onAir === true) { retryTimer = setTimeout(playStream, 3000); }   // brief drop: reconnect
    else if (!nextFill()) offAirIdle();
  });
  player.addEventListener("waiting", () => { if (intent && mode !== "yt") setStatus("Buffering…"); });
  player.addEventListener("error", () => {
    switching = false;
    if (mode === "yt" || !player.getAttribute("src")) return;   // we emptied it on purpose
    if (!intent) { setButton(); setPill(); return; }
    if (mode === "music") {
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

  // Name is locked for the whole browser session once chosen.
  let lockedName = localStorage.getItem("rfm_name") || null;

  function applyNameLock() {
    if (lockedName) {
      nameInput.value = lockedName;
      nameInput.readOnly = true;
      nameInput.classList.add("locked");
      nameInput.title = "Your name is locked for this session";
      msgInput.focus();
    } else {
      nameInput.readOnly = false;
      nameInput.classList.remove("locked");
      nameInput.title = "";
    }
  }
  applyNameLock();

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
      `<div class="meta">${escapeHtml(msg.name)} · ${timeNow()}</div>` +
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

    // First message: capture and LOCK the name for the session.
    if (!lockedName) {
      const entered = nameInput.value.trim().slice(0, 24);
      if (!entered) { nameInput.focus(); nameInput.placeholder = "Enter your name first"; return; }
      lockedName = entered;
      localStorage.setItem("rfm_name", lockedName);
      applyNameLock();
    }

    backend.send({ name: lockedName, text });
    msgInput.value = "";
    msgInput.focus();
  });

  /* LOCAL BACKEND: this browser + cross-tab mirror via storage event. */
  function createLocalBackend() {
    const CHANNEL = "rfm_local_chat";
    window.addEventListener("storage", (e) => {
      if (e.key === CHANNEL && e.newValue) {
        const m = JSON.parse(e.newValue);
        addMessage({ name: m.name, text: m.text, mine: false });
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
    let ws, myName = null;

    function connect() {
      // Know our own name up front so replayed history aligns our messages right.
      if (!myName && lockedName) myName = lockedName;
      ws = new WebSocket(url);
      ws.addEventListener("message", (ev) => {
        let d; try { d = JSON.parse(ev.data); } catch { return; }
        if (d.type === "history") {
          // Replay the recent conversation on (re)connect.
          messagesEl.innerHTML = "";
          (d.messages || []).forEach((m) =>
            addMessage({ name: m.name, text: m.text, mine: m.name === myName })
          );
        } else if (d.type === "chat") {
          addMessage({ name: d.name, text: d.text, mine: d.name === myName });
        } else if (d.type === "cleared") {
          messagesEl.innerHTML = "";
          addMessage({ system: true, text: "Chat was cleared by the station." });
        } else if (d.type === "system") {
          addMessage({ system: true, text: d.text });
        } else if (d.type === "onair") {
          setOnAir(!!d.live);   // presenter went live / off air -> switch live <-> music
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
      send({ name, text }) {
        myName = name;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "chat", name, text }));
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
