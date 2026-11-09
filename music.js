/* ============================================================
   Ramatlabama FM — Portal "Music" tab (everyone adds music; God Admin sets the schedule)
   Fill-in music for the website while nobody is live: uploaded songs and
   YouTube links, tagged by genre, played by time slot for each weekday.
   ============================================================ */
(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const DAYS = [
    ["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"],
    ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"],
  ];
  const dayName = (k) => (DAYS.find((d) => d[0] === k) || [, k])[1];
  let token = null;
  let me = null;      // the logged-in presenter
  const canRemove = (t) => !!me && (me.role === "god" || me.role === "elevated" || (!!t.by && t.by === me.id));
  let state = null;   // last server view
  let draft = null;   // unsaved edits to { schedule, slots }

  function say(id, text, ok) {
    const s = byId(id); if (!s) return;
    s.textContent = text || ""; s.style.color = ok === false ? "#ff6b5e" : ok === true ? "#3ecf6b" : "";
  }
  function mb(n) { return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB"; }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const same = (a, g) => !g || String(a).toLowerCase() === String(g).toLowerCase();
  function countFor(genre) {
    if (!state) return 0;
    return state.tracks.filter((t) => same(t.genre, genre)).length + state.links.filter((l) => same(l.genre, genre)).length;
  }
  function freshDraft() {
    return { schedule: { ...state.schedule }, slots: JSON.parse(JSON.stringify(state.slots || {})) };
  }

  async function api(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed.");
    return j;
  }

  function genreSelect(value, withAll) {
    const sel = document.createElement("select");
    if (withAll) { const o = document.createElement("option"); o.value = ""; o.textContent = "All music"; sel.appendChild(o); }
    state.genres.forEach((g) => { const o = document.createElement("option"); o.value = g; o.textContent = g + " (" + countFor(g) + ")"; sel.appendChild(o); });
    sel.value = value || "";
    if (sel.value !== (value || "") && value) {   // a genre no longer in the list: keep it selectable
      const o = document.createElement("option"); o.value = value; o.textContent = value + " (0)"; sel.appendChild(o); sel.value = value;
    }
    return sel;
  }

  function statusLine() {
    const live = state.onAirKnown ? (state.onAir ? "A presenter is LIVE now, so listeners hear the show." : "Nobody is live now.") : "Checking if anyone is live…";
    if (!state.enabled) return say("musicStatus", "Off. Listeners hear silence while nobody is live. " + live);
    const g = state.genreNow || "", p = state.playingNow != null ? state.playingNow : g;
    const when = " Now (" + dayName(state.today) + " " + state.time + "): ";
    if (!countFor(p)) return say("musicStatus", live + when + (g || "all music") + ". ⚠ No music uploaded yet, so listeners hear nothing.", false);
    if (p !== g) return say("musicStatus", live + when + "scheduled " + (g || "all music") + ", but there's no " + (g || "") + " music yet, so " + (p || "any music") + " plays instead (" + countFor(p) + " songs/links).");
    say("musicStatus", live + when + (g || "all music") + " · " + countFor(g) + " songs/links.");
  }

  /* ---------- render ---------- */
  function renderAll() {
    if (!state) return;
    if (!draft) draft = freshDraft();
    byId("musicEnabled").checked = !!state.enabled;

    statusLine();

    const dl = byId("musicGenreList"); dl.innerHTML = "";
    state.genres.forEach((x) => { const o = document.createElement("option"); o.value = x; dl.appendChild(o); });

    renderDays();
    byId("musicStorage").textContent = "Storage: " + mb(state.usedBytes) + " of " + mb(state.maxBytes) + " used · " + state.tracks.length + " uploaded songs.";

    const filter = byId("musicFilter"), keep = filter.value;
    filter.innerHTML = '<option value="">All genres</option>';
    [...new Set([...state.tracks.map((t) => t.genre), ...state.links.map((l) => l.genre)])].sort().forEach((x) => {
      const o = document.createElement("option"); o.value = x; o.textContent = x + " (" + countFor(x) + ")"; filter.appendChild(o);
    });
    filter.value = [...filter.options].some((o) => o.value === keep) ? keep : "";
    renderList();
  }

  function renderDays() {
    const wrap = byId("musicDays"); wrap.innerHTML = "";
    DAYS.forEach(([key, name]) => {
      const box = el("div", "music-day-box" + (key === state.today ? " today" : ""));
      const head = el("div", "music-day");
      head.appendChild(el("span", "music-day-name", name + (key === state.today ? " · today" : "")));
      const def = el("label", "music-def");
      def.appendChild(el("small", null, "Default"));
      const ds = genreSelect(draft.schedule[key] || "", true);
      ds.onchange = () => { if (ds.value) draft.schedule[key] = ds.value; else delete draft.schedule[key]; renderWarn(); };
      def.appendChild(ds);
      head.appendChild(def);
      box.appendChild(head);

      (draft.slots[key] || []).forEach((s, i) => {
        const row = el("div", "music-slot");
        const a = document.createElement("input"); a.type = "time"; a.value = s.start; a.required = true;
        const b = document.createElement("input"); b.type = "time"; b.value = s.end; b.required = true;
        a.onchange = () => { s.start = a.value; renderWarn(); };
        b.onchange = () => { s.end = b.value; renderWarn(); };
        const gs = genreSelect(s.genre, false);
        gs.onchange = () => { s.genre = gs.value; renderWarn(); };
        const rm = el("button", "m-btn delete", "✕"); rm.type = "button"; rm.title = "Remove slot";
        rm.onclick = () => { draft.slots[key].splice(i, 1); if (!draft.slots[key].length) delete draft.slots[key]; renderDays(); };
        row.append(a, el("span", "music-dash", "–"), b, gs, rm);
        box.appendChild(row);
      });
      const add = el("button", "m-btn", "+ Time slot"); add.type = "button";
      add.onclick = () => {
        const list = draft.slots[key] || (draft.slots[key] = []);
        const last = list[list.length - 1];
        list.push({ start: last ? last.end : "06:00", end: "12:00", genre: state.genres[0] || "Gospel" });
        renderDays();
      };
      box.appendChild(add);
      wrap.appendChild(box);
    });
    renderWarn();
  }

  function renderWarn() {
    const warn = [];
    DAYS.forEach(([key, name]) => {
      const dg = draft.schedule[key];
      if (dg && countFor(dg) === 0) warn.push("⚠ " + name + " default is " + dg + " but there's no " + dg + " music yet.");
      (draft.slots[key] || []).forEach((s) => {
        if (!s.start || !s.end || s.start === s.end) warn.push("⚠ " + name + ": a slot needs different start and end times.");
        else if (countFor(s.genre) === 0) warn.push("⚠ " + name + " " + s.start + "–" + s.end + " is " + s.genre + " but there's no " + s.genre + " music yet. It will be silent.");
      });
    });
    if (!state.tracks.length && !state.links.length) warn.unshift("⚠ No music yet. Upload songs or add YouTube links.");
    byId("musicWarn").textContent = warn.join("\n");
  }

  function renderList() {
    const list = byId("musicList"); list.innerHTML = "";
    const g = byId("musicFilter").value;
    const items = [
      ...state.links.filter((l) => same(l.genre, g)).map((l) => ({ ...l, type: "yt" })),
      ...state.tracks.filter((t) => same(t.genre, g)).map((t) => ({ ...t, type: "file" })),
    ];
    if (!items.length) { list.appendChild(el("p", "edit-empty", "No music yet.")); return; }
    items.forEach((t) => {
      const row = el("div", "music-row");
      const info = el("div", "music-info");
      info.appendChild(el("strong", null, t.title));
      const meta = el("small");
      meta.appendChild(el("span", "role-tag elevated", t.genre));
      meta.appendChild(document.createTextNode("  " + (t.type === "yt" ? (t.kind === "playlist" ? "▶ YouTube playlist" : "▶ YouTube video") : "⬆ Upload · " + mb(t.size))));
      info.appendChild(meta);
      const actions = el("div", "member-actions");

      if (t.type === "yt") {
        const open = el("a", "m-btn", "↗ Open");
        open.href = t.kind === "playlist" ? "https://www.youtube.com/playlist?list=" + encodeURIComponent(t.ytId) : "https://www.youtube.com/watch?v=" + encodeURIComponent(t.ytId);
        open.target = "_blank"; open.rel = "noopener";
        actions.appendChild(open);
      } else {
        const play = el("button", "m-btn", "▶ Listen"); play.type = "button";
        play.onclick = () => {
          const a = byId("musicPreview");
          if (a.dataset.id === t.id && !a.paused) { a.pause(); play.textContent = "▶ Listen"; play.classList.remove("playing"); return; }
          list.querySelectorAll(".m-btn.playing").forEach((x) => { x.classList.remove("playing"); x.textContent = "▶ Listen"; });
          a.src = t.url; a.dataset.id = t.id; a.hidden = false; a.play().catch(() => {});
          play.classList.add("playing"); play.textContent = "⏸ Stop";
        };
        actions.appendChild(play);
      }
      if (t.byName) meta.appendChild(document.createTextNode("  · added by " + t.byName));
      const del = el("button", "m-btn delete", "🗑 Delete"); del.type = "button";
      del.onclick = async () => {
        if (!confirm("Delete \"" + t.title + "\"?")) return;
        try {
          state = await api(t.type === "yt" ? "/api/music/link/delete" : "/api/music/delete", { id: t.id });
          renderAll(); say("musicUploadState", "Deleted.", true);
        } catch (e) { say("musicUploadState", e.message, false); }
      };
      if (canRemove(t)) actions.appendChild(del);
      row.append(info, actions);
      list.appendChild(row);
    });
  }

  /* ---------- actions ---------- */
  async function load() {
    try { state = await api("/api/music/admin", {}); renderAll(); }
    catch (e) { say("musicStatus", e.message, false); }
  }

  async function saveDays() {
    const bad = Object.values(draft.slots).flat().some((s) => !s.start || !s.end || s.start === s.end || !s.genre);
    if (bad) return say("musicDaysState", "Fix the slots marked ⚠ first.", false);
    say("musicDaysState", "Saving…");
    try {
      state = await api("/api/music/settings", { schedule: draft.schedule, slots: draft.slots });
      draft = freshDraft();
      renderAll(); say("musicDaysState", "✓ Saved", true);
    } catch (e) { say("musicDaysState", e.message, false); }
  }

  async function toggleEnabled(e) {
    try { state = await api("/api/music/settings", { enabled: e.target.checked }); renderAll(); }
    catch (err) { e.target.checked = !e.target.checked; say("musicStatus", err.message, false); }
  }

  async function addLink() {
    const url = byId("musicYtUrl").value.trim();
    const genre = byId("musicYtGenre").value.trim();
    if (!url) return say("musicYtState", "Paste a YouTube link first.", false);
    if (!genre) return say("musicYtState", "Type or pick a genre first.", false);
    const btn = byId("musicYtAddBtn"); btn.disabled = true;
    say("musicYtState", "Checking with YouTube…");
    try {
      state = await api("/api/music/link", { url, genre, title: byId("musicYtTitle").value.trim() });
      byId("musicYtUrl").value = ""; byId("musicYtTitle").value = "";
      renderAll();
      if (state.note) say("musicYtState", "✓ Added to " + genre + ". " + state.note);
      else say("musicYtState", "✓ Added to " + genre + ".", true);
    } catch (e) { say("musicYtState", e.message, false); }
    btn.disabled = false;
  }

  async function upload() {
    const files = [...(byId("musicFiles").files || [])];
    const genre = byId("musicGenre").value.trim();
    if (!files.length) return say("musicUploadState", "Choose one or more songs first.", false);
    if (!genre) return say("musicUploadState", "Type or pick a genre first.", false);
    const btn = byId("musicUploadBtn"); btn.disabled = true;
    let done = 0; const failed = [];
    for (const f of files) {
      say("musicUploadState", "Uploading " + (done + failed.length + 1) + " of " + files.length + ": " + f.name + "…");
      if (f.size > 15 * 1024 * 1024) { failed.push(f.name + " (over 15 MB)"); continue; }
      const title = f.name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
      try {
        const r = await fetch("/api/music/upload", {
          method: "POST",
          headers: { "X-Token": token, "X-Genre": encodeURIComponent(genre), "X-Title": encodeURIComponent(title), "Content-Type": f.type || "application/octet-stream" },
          body: f,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) { failed.push(f.name + " (" + (j.error || "failed") + ")"); continue; }
        state = j; done++;
      } catch (_) { failed.push(f.name + " (connection lost)"); }
    }
    btn.disabled = false;
    byId("musicFiles").value = "";
    renderAll();
    if (failed.length) say("musicUploadState", "Added " + done + ". Failed: " + failed.join(", "), false);
    else say("musicUploadState", "✓ Added " + done + " song" + (done === 1 ? "" : "s") + " to " + genre + ".", true);
  }

  let wired = false;
  window.RFM_MUSIC = {
    start(tk, user) {
      token = tk; me = user || me;
      if (!wired) {
        wired = true;
        byId("musicSaveDays").onclick = saveDays;
        byId("musicEnabled").onchange = toggleEnabled;
        byId("musicUploadBtn").onclick = upload;
        byId("musicYtAddBtn").onclick = addLink;
        byId("musicYtUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } });
        byId("musicFilter").onchange = renderList;
        byId("musicPreview").addEventListener("ended", () => {
          byId("musicList").querySelectorAll(".m-btn.playing").forEach((b) => { b.classList.remove("playing"); b.textContent = "▶ Listen"; });
        });
        // Refresh the status line every 20s (keeps unsaved slot edits: they live in `draft`).
        setInterval(() => {
          if (document.hidden || !state) return;
          api("/api/music/admin", {}).then((s) => {
            state = s;
            statusLine();
          }).catch(() => {});
        }, 20000);
      }
      load();
    },
  };
})();
