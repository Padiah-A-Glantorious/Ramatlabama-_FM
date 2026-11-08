/* ============================================================
   Ramatlabama FM — Portal "Render" tab
   Look up scripture (or type text / pick a picture), preview it, and click
   Render. Listeners' chat panel is replaced by it until you Stop.
   ============================================================ */
(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const wsUrl = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host;

  let ws = null, token = null;
  let passage = null;       // last scripture lookup { reference, translation, verses }
  let imageData = null;     // resized data URL of the chosen picture

  // Render / Stop go over plain HTTP: they work even if the live socket dropped,
  // and every failure (e.g. logged out after a restart) is shown on screen.
  async function apply(action, display, stateId) {
    const btns = document.querySelectorAll("#tab-render button");
    btns.forEach((b) => b.dataset.busy = "1");
    say(stateId, action === "clear" ? "Stopping…" : "Sending…");
    try {
      const r = await fetch("/api/display", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action, display }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { say(stateId, j.error || "Failed. Try again.", false); return false; }
      showStatus(j.display || null);
      say(stateId, action === "clear" ? "Stopped. Listeners see the chat again." : "Rendered.");
      return true;
    } catch (_) {
      say(stateId, "Can't reach the server. Check your connection and try again.", false);
      return false;
    } finally { btns.forEach((b) => delete b.dataset.busy); }
  }
  function say(id, text, ok) {
    const s = byId(id); if (!s) return;
    s.textContent = text || ""; s.style.color = ok === false ? "#ff6b5e" : "";
  }

  /* ---------- live status ---------- */
  function showStatus(d) {
    const stop = byId("renderStopBtn");
    if (!d) { say("renderStatus", "Showing the chat."); stop.disabled = true; return; }
    const what = d.kind === "scripture" ? "scripture: " + (d.reference || "")
      : d.kind === "image" ? "a picture" : d.kind === "video" ? "a YouTube video" : "text" + (d.title ? ": " + d.title : "");
    say("renderStatus", "Listeners are seeing " + what + (d.by ? " (rendered by " + d.by + ")" : "") + ". Chat is hidden.");
    stop.disabled = false;
  }

  /* ---------- scripture ---------- */
  function previewPassage(p) {
    const box = byId("biblePreview"); box.innerHTML = "";
    const h = document.createElement("div"); h.className = "pv-ref"; h.textContent = p.reference + " · " + p.translation;
    box.appendChild(h);
    p.verses.forEach((v) => {
      const row = document.createElement("p"); row.className = "pv-verse";
      const n = document.createElement("sup"); n.textContent = v.n || "";
      row.appendChild(n); row.appendChild(document.createTextNode(" " + v.text));
      box.appendChild(row);
    });
  }

  async function findPassage() {
    const ref = byId("bibleRef").value.trim();
    if (!ref) { say("bibleState", "Type a passage first.", false); return; }
    say("bibleState", "Looking up…");
    // Forget the previous passage so a failed lookup can never render the old one.
    passage = null;
    byId("bibleRenderBtn").disabled = true;
    byId("biblePreview").innerHTML = '<p class="edit-empty">Looking up…</p>';
    try {
      const r = await fetch("/api/bible", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ref, translation: byId("bibleTrans").value }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        byId("biblePreview").innerHTML = '<p class="edit-empty">Nothing to preview.</p>';
        say("bibleState", j.error || "Not found.", false);
        return;
      }
      passage = { reference: j.reference, translation: j.translation, verses: j.verses };
      previewPassage(passage);
      byId("bibleRenderBtn").disabled = false;
      say("bibleState", "");
    } catch (_) {
      byId("biblePreview").innerHTML = '<p class="edit-empty">Nothing to preview.</p>';
      say("bibleState", "Can't reach the server.", false);
    }
  }

  /* ---------- picture: shrink before sending ---------- */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 1280, s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
      img.src = url;
    });
  }

  /* ---------- YouTube: pull the video id (and start time) out of a pasted link ---------- */
  function parseYouTube(input) {
    const raw = String(input || "").trim();
    if (!raw) return null;
    let u;
    try { u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); } catch (_) { return null; }
    const host = u.hostname.replace(/^www\.|^m\./, "").toLowerCase();
    let id = null;
    if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
    else if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") id = u.searchParams.get("v");
      else {
        const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
        if (m) id = m[1];
      }
    }
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    // Start time: t=90, t=1m30s or start=90
    let start = 0;
    const t = u.searchParams.get("t") || u.searchParams.get("start");
    if (t) {
      const hms = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);
      if (hms) start = (+hms[1] || 0) * 3600 + (+hms[2] || 0) * 60 + (+hms[3] || 0);
    }
    return { videoId: id, start };
  }

  /* ---------- socket ---------- */
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.type === "display") showStatus(d.display || null);
      else if (d.type === "display-error") say("renderStatus", d.error || "That couldn't be displayed.", false);
    };
    ws.onclose = () => setTimeout(connect, 2500);
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  function wire() {
    byId("bibleFindBtn").onclick = findPassage;
    byId("bibleRef").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); findPassage(); } });

    byId("bibleRenderBtn").onclick = () => {
      if (!passage) return;
      apply("set", { kind: "scripture", ...passage }, "bibleState");
    };

    byId("textRenderBtn").onclick = () => {
      const body = byId("textBody").value;
      if (!body.trim()) { say("textState", "Type some text first.", false); return; }
      apply("set", { kind: "text", title: byId("textTitle").value.trim(), body }, "textState");
    };

    byId("imgFile").onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      imageData = null; byId("imgRenderBtn").disabled = true;
      if (!f) return;
      say("imgState", "Preparing…");
      try {
        imageData = await loadImage(f);
        const box = byId("imgPreview"); box.innerHTML = "";
        const im = document.createElement("img"); im.src = imageData; im.className = "pv-img"; box.appendChild(im);
        byId("imgRenderBtn").disabled = false; say("imgState", "");
      } catch (_) { say("imgState", "That file isn't a usable picture.", false); }
    };

    byId("imgRenderBtn").onclick = () => {
      if (!imageData) return;
      apply("set", { kind: "image", image: imageData, caption: byId("imgCaption").value.trim() }, "imgState");
    };

    // YouTube: validate as you type and show a preview.
    let yt = null;
    const ytUpdate = () => {
      const val = byId("ytUrl").value;
      yt = parseYouTube(val);
      const box = byId("ytPreview"); box.innerHTML = "";
      byId("ytRenderBtn").disabled = !yt;
      if (!val.trim()) { box.innerHTML = '<p class="edit-empty">Paste a link to preview it.</p>'; say("ytState", ""); return; }
      if (!yt) { box.innerHTML = '<p class="edit-empty">That doesn\'t look like a YouTube link.</p>'; say("ytState", "Check the link.", false); return; }
      say("ytState", "");
      const f = document.createElement("iframe");
      f.className = "pv-video";
      f.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(yt.videoId) + "?rel=0" + (yt.start ? "&start=" + yt.start : "");
      f.setAttribute("allow", "encrypted-media; picture-in-picture; fullscreen");
      f.setAttribute("allowfullscreen", "");
      f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      box.appendChild(f);
    };
    byId("ytUrl").addEventListener("input", ytUpdate);
    byId("ytRenderBtn").onclick = () => {
      if (!yt) return;
      apply("set", {
        kind: "video", videoId: yt.videoId, start: yt.start,
        muted: byId("ytMuted").checked, caption: byId("ytCaption").value.trim(),
      }, "ytState");
    };

    byId("renderStopBtn").onclick = () => { apply("clear", null, "renderStatus"); };
  }

  let wired = false;
  window.RFM_RENDER = {
    start(tk) {
      token = tk;
      if (!wired) { wire(); wired = true; }
      if (!ws) connect();
      // Show the real current state straight away (don't wait for the socket).
      fetch("/api/display", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j && j.ok) showStatus(j.display || null); }).catch(() => {});
    },
  };
})();
