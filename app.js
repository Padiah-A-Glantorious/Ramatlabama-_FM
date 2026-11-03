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
  if (streamUrl) player.src = streamUrl; else setStatus("No stream URL set — add it in config.js");
  if (volume) {
    player.volume = parseFloat(volume.value);
    volume.addEventListener("input", () => { player.volume = parseFloat(volume.value); });
  }

  function togglePlay() {
    if (!streamUrl) { setStatus("⚠ Add the stream URL in config.js first."); return; }
    if (player.paused) {
      if (heroPlay) heroPlay.classList.add("loading");
      setStatus("Connecting…");
      if (player.src !== streamUrl) player.src = streamUrl;
      player.load();
      player.play().catch((err) => {
        setStatus("Couldn't play. Check the stream URL / CORS. (" + (err.name || "error") + ")");
      }).finally(() => { if (heroPlay) heroPlay.classList.remove("loading"); });
    } else {
      player.pause();
    }
  }
  if (heroPlay) heroPlay.addEventListener("click", togglePlay);

  /* ---- Autoplay (with first-interaction fallback) ---- */
  function startRadio() {
    if (!streamUrl) return Promise.reject();
    if (player.src !== streamUrl) player.src = streamUrl;
    return player.play();
  }
  function armFirstInteractionAutoplay() {
    setStatus("Tap anywhere to start listening 🔊");
    const kick = () => { startRadio().catch(() => {}); remove(); };
    const evs = ["pointerdown", "keydown", "touchstart", "scroll"];
    const remove = () => evs.forEach((e) => window.removeEventListener(e, kick));
    evs.forEach((e) => window.addEventListener(e, kick, { once: true, passive: true }));
  }
  function tryAutoplay() {
    if (!streamUrl) { setStatus("No stream URL set — add it in config.js"); return; }
    setStatus("Connecting…");
    startRadio().catch(() => armFirstInteractionAutoplay());
  }
  if (document.readyState !== "loading") tryAutoplay();
  else window.addEventListener("DOMContentLoaded", tryAutoplay);

  player.addEventListener("playing", () => {
    if (heroPlay) { heroPlay.textContent = "⏸ Playing Live"; heroPlay.classList.remove("loading"); }
    setStatus("● LIVE");
    setLive(true);
  });
  player.addEventListener("pause", () => {
    if (heroPlay) heroPlay.textContent = "▶ Listen Live";
    setStatus("Paused");
    setLive(false);
  });
  player.addEventListener("waiting", () => setStatus("Buffering…"));
  player.addEventListener("error", () => {
    setLive(false);
    if (heroPlay) heroPlay.textContent = "▶ Listen Live";
    setStatus("Stream error — verify the URL in config.js is a direct audio link.");
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
