/* ============================================================
   Ramatlabama FM — Station Portal
   Roles: god (Padiah), elevated (CEO + granted), presenter.
   Tabs: Chat, News (all), Shows + Members (manager only), Settings.
   ============================================================ */

(() => {
  "use strict";
  console.log("%cStation Portal v7 loaded", "color:#d4af37;font-weight:bold");
  const cfg = window.RADIO_CONFIG || {};
  const byId = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s);
  const escAttr = (s) => esc(s).replace(/"/g, "&quot;");
  const escHtml = (s) => esc(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

  let me = null;        // current user
  let token = localStorage.getItem("rfm_token") || null;
  let content = { showsWeekday: [], showsSaturday: [], showsSunday: [], news: [] };
  let members = [];
  let meId = null;
  let meRole = "presenter";
  let meCanManage = false;

  // Mirror of the server rule: who may actor act on target?
  function canActOn(actorRole, targetRole) {
    if (targetRole === "god") return actorRole === "god";
    return actorRole === "god" || actorRole === "elevated";
  }

  /* ============ LOGIN ============ */
  const loginEl = byId("presLogin");
  const portal  = byId("portal");
  const loginForm = byId("loginForm");
  const loginErr = byId("loginError");

  function showLoginErr(m) { loginErr.textContent = m; loginErr.hidden = false; }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const identifier = byId("loginId").value.trim();
    const password = byId("loginPw").value;
    if (!identifier || !password) { showLoginErr("Enter your login and password."); return; }
    try {
      const r = await fetch("/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });
      const res = await r.json();
      if (!r.ok || !res.ok) { showLoginErr(res.error || "Login failed."); return; }
      token = res.token; localStorage.setItem("rfm_token", token);
      me = res.user;
      enterPortal();
    } catch (_) { showLoginErr("Can't reach the server."); }
  });

  byId("logoutBtn").addEventListener("click", () => {
    localStorage.removeItem("rfm_token"); location.reload();
  });

  // Try to restore an existing session on load.
  async function restore() {
    if (!token) return;
    try {
      const r = await fetch("/api/me", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const res = await r.json();
      if (r.ok && res.ok) { me = res.user; enterPortal(); }
    } catch (_) {}
  }

  function isManager() { return me && (me.role === "god" || me.role === "elevated"); }
  function accessLabel() {
    return me.role === "god" ? "God Admin" : me.role === "elevated" ? "Elevated Access" : "Presenter";
  }

  async function enterPortal() {
    loginEl.hidden = true;
    portal.hidden = false;

    byId("welcomeName").textContent = "Welcome, " + me.name;
    byId("welcomeTitle").textContent = me.title || "";
    byId("accessBadge").textContent = accessLabel();

    // Manager-only tabs
    document.querySelectorAll(".manage-only").forEach((el) => { el.hidden = !isManager(); });
    // Render tab: God Admin always, others only when God grants it.
    document.querySelectorAll(".render-only").forEach((el) => { el.hidden = !me.canRender; });
    // Music tab: God Admin only.
    document.querySelectorAll(".god-only").forEach((el) => { el.hidden = me.role !== "god"; });

    // Prefill settings
    byId("setName").value = me.name || "";

    await loadContent();
    renderNews();
    renderShows();
    loadMembers();     // everyone can view the members list
    connectChat();
    if (window.RFM_STUDIO) window.RFM_STUDIO.start(token);
    if (window.RFM_RENDER && me.canRender) window.RFM_RENDER.start(token);
    if (window.RFM_MUSIC && me.role === "god") window.RFM_MUSIC.start(token);
    if (isManager()) loadAdverts();
  }

  /* ============ TABS ============ */
  document.querySelectorAll(".ptab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".ptab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll(".ptab-view").forEach((v) => v.classList.remove("active"));
      byId("tab-" + tab.dataset.tab).classList.add("active");
    });
  });

  /* ============ CONTENT LOAD ============ */
  async function loadContent() {
    try {
      const r = await fetch("/api/content", { cache: "no-store" });
      const c = await r.json();
      content.showsWeekday = Array.isArray(c.showsWeekday) ? c.showsWeekday : [];
      content.showsSaturday = Array.isArray(c.showsSaturday) ? c.showsSaturday : [];
      content.showsSunday = Array.isArray(c.showsSunday) ? c.showsSunday : [];
      content.news = Array.isArray(c.news) ? c.news : [];
    } catch (_) {}
  }

  /* ============ NEWS (everyone) ============ */
  function renderNews() {
    const wrap = byId("newsRows"); wrap.innerHTML = "";
    content.news.forEach((n, i) => {
      const row = document.createElement("div");
      row.className = "row news-row";
      row.innerHTML = `
        <input class="f-tag" placeholder="TAG" value="${escAttr(n.tag)}" />
        <input class="f-date" placeholder="Date" value="${escAttr(n.date)}" />
        <input class="f-title" placeholder="Headline" value="${escAttr(n.title)}" />
        <input class="f-body" placeholder="One-line detail" value="${escAttr(n.body)}" />
        <button class="row-del" title="Remove">✕</button>`;
      row.querySelector(".f-tag").oninput = (e) => content.news[i].tag = e.target.value;
      row.querySelector(".f-date").oninput = (e) => content.news[i].date = e.target.value;
      row.querySelector(".f-title").oninput = (e) => content.news[i].title = e.target.value;
      row.querySelector(".f-body").oninput = (e) => content.news[i].body = e.target.value;
      row.querySelector(".row-del").onclick = () => { content.news.splice(i, 1); renderNews(); };
      wrap.appendChild(row);
    });
    if (!content.news.length) wrap.innerHTML = '<p class="edit-empty">No stories yet.</p>';
  }
  byId("addNews").onclick = () => { content.news.push({ tag: "NEWS", title: "", body: "", date: "" }); renderNews(); };
  byId("saveNews").onclick = async () => {
    setState("newsState", "Saving…");
    try {
      const r = await fetch("/api/news", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, news: content.news }) });
      const res = await r.json();
      if (!r.ok || !res.ok) return setState("newsState", res.error || "Failed", false);
      content.news = res.news; renderNews();
      setState("newsState", "✓ Saved — live on site", true);
    } catch (_) { setState("newsState", "Can't reach server", false); }
  };

  /* ============ SHOWS (manager only) ============ */
  const DAYS = ["weekday", "saturday", "sunday"];
  document.querySelectorAll(".shows-day").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll(".shows-day").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      const day = b.dataset.day;
      byId("weekdayRows").hidden = day !== "weekday";
      byId("saturdayRows").hidden = day !== "saturday";
      byId("sundayRows").hidden = day !== "sunday";
      byId("addWeekday").hidden = day !== "weekday";
      byId("addSaturday").hidden = day !== "saturday";
      byId("addSunday").hidden = day !== "sunday";
    };
  });

  function renderShowList(arr, wrapId) {
    const wrap = byId(wrapId); wrap.innerHTML = "";
    arr.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "row show-row";
      row.innerHTML = `
        <input class="f-start" type="time" value="${escAttr(s.start)}" />
        <input class="f-end" type="time" value="${escAttr(s.end)}" />
        <input class="f-show" placeholder="Show name" value="${escAttr(s.show)}" />
        <input class="f-host" placeholder="Presenter" value="${escAttr(s.host)}" />
        <button class="row-del" title="Remove">✕</button>`;
      row.querySelector(".f-start").oninput = (e) => arr[i].start = e.target.value;
      row.querySelector(".f-end").oninput = (e) => arr[i].end = e.target.value;
      row.querySelector(".f-show").oninput = (e) => arr[i].show = e.target.value;
      row.querySelector(".f-host").oninput = (e) => arr[i].host = e.target.value;
      row.querySelector(".row-del").onclick = () => { arr.splice(i, 1); renderShows(); };
      wrap.appendChild(row);
    });
    if (!arr.length) wrap.innerHTML = '<p class="edit-empty">No shows yet.</p>';
  }
  function renderShows() {
    renderShowList(content.showsWeekday, "weekdayRows");
    renderShowList(content.showsSaturday, "saturdayRows");
    renderShowList(content.showsSunday, "sundayRows");
  }
  byId("addWeekday").onclick  = () => { content.showsWeekday.push({ start: "00:00", end: "00:00", show: "", host: "" }); renderShows(); };
  byId("addSaturday").onclick = () => { content.showsSaturday.push({ start: "00:00", end: "00:00", show: "", host: "" }); renderShows(); };
  byId("addSunday").onclick   = () => { content.showsSunday.push({ start: "00:00", end: "00:00", show: "", host: "" }); renderShows(); };
  byId("saveShows").onclick = async () => {
    setState("showsState", "Saving…");
    try {
      const r = await fetch("/api/shows", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, showsWeekday: content.showsWeekday, showsSaturday: content.showsSaturday, showsSunday: content.showsSunday }) });
      const res = await r.json();
      if (!r.ok || !res.ok) return setState("showsState", res.error || "Failed", false);
      content.showsWeekday = res.showsWeekday; content.showsSaturday = res.showsSaturday; content.showsSunday = res.showsSunday; renderShows();
      setState("showsState", "✓ Saved — live on site", true);
    } catch (_) { setState("showsState", "Can't reach server", false); }
  };

  /* ============ MEMBERS (manager only) ============ */
  async function loadMembers() {
    try {
      const r = await fetch("/api/members", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }) });
      const res = await r.json();
      if (r.ok && res.ok) {
        members = res.members; meId = res.meId; meRole = res.meRole || "presenter"; meCanManage = !!res.canManage;
        byId("enrolForm").style.display = meCanManage ? "flex" : "none";
        renderMembers();
      }
    } catch (_) {}
  }
  function roleTag(role) {
    const label = role === "god" ? "God Admin" : role === "elevated" ? "Elevated Access" : "Presenter";
    return `<span class="role-tag ${role}">${label}</span>`;
  }
  function renderMembers() {
    const wrap = byId("membersList"); wrap.innerHTML = "";
    members.forEach((m) => {
      const row = document.createElement("div");
      row.className = "member-row";
      // Can the logged-in user act on this member?
      const editable = meCanManage && canActOn(meRole, m.role);
      const isSelf = m.id === meId;

      // Title: inline text box for rows you can edit, plain text otherwise.
      const titleHtml = editable
        ? `<input class="m-title-input" data-id="${m.id}" value="${escAttr(m.title || "")}" placeholder="Title" />`
        : `<span class="member-sub">${escHtml(m.title || "")}</span>`;

      let actions = "";
      if (editable) {
        if (m.role === "presenter")
          actions += `<button class="m-btn elevate" data-id="${m.id}">↑ Elevate</button>`;
        else if (m.role === "elevated")
          actions += `<button class="m-btn revoke" data-id="${m.id}">↓ Revoke to presenter</button>`;
        // God Admin: put someone's password back to the default (never shown on screen).
        if (meRole === "god" && !isSelf)
          actions += `<button class="m-btn reset-pw" data-id="${m.id}" data-name="${escAttr(m.name)}">🔑 Reset password</button>`;
        // Only the God Admin decides who may render scripture/text/pictures.
        if (meRole === "god" && m.role !== "god")
          actions += m.canRender
            ? `<button class="m-btn revoke-render" data-id="${m.id}">📖 Revoke Render</button>`
            : `<button class="m-btn grant-render" data-id="${m.id}">📖 Allow Render</button>`;
        // Delete: any non-god account, but never your own.
        if (m.role !== "god" && !isSelf)
          actions += `<button class="m-btn delete" data-id="${m.id}" data-name="${escAttr(m.name)}">🗑 Delete</button>`;
      }
      row.innerHTML = `
        <div class="member-info">
          <div class="member-name">${escHtml(m.name)} ${roleTag(m.role)}${m.canRender && m.role !== "god" ? ' <span class="role-tag render-tag">📖 Render</span>' : ""}</div>
          ${m.email || m.login ? `<div class="member-email">✉ ${escHtml(m.email || "")}${m.login ? (m.email ? " · " : "") + "login: " + escHtml(m.login) : ""}</div>` : ""}
          ${titleHtml}
        </div>
        <div class="member-actions">${actions}</div>`;
      wrap.appendChild(row);
    });
  }
  byId("membersList").addEventListener("click", async (e) => {
    const btn = e.target.closest(".m-btn"); if (!btn) return;
    const id = btn.dataset.id;
    if (btn.classList.contains("revoke")) {
      if (!confirm("Revoke elevated access? They drop to base-level presenter (account kept).")) return;
      await memberAction("/api/members/revoke", { id });
    } else if (btn.classList.contains("reset-pw")) {
      if (!confirm("Reset " + (btn.dataset.name || "this member") + "'s password to the default?\n\nThey'll be logged out and must log in again with the default password.")) return;
      await memberAction("/api/members/reset-password", { id });
    } else if (btn.classList.contains("grant-render")) {
      await memberAction("/api/members/render", { id, allow: true });
    } else if (btn.classList.contains("revoke-render")) {
      await memberAction("/api/members/render", { id, allow: false });
    } else if (btn.classList.contains("elevate")) {
      await memberAction("/api/members/setrole", { id, role: "elevated" });
    } else if (btn.classList.contains("delete")) {
      if (!confirm("Permanently delete " + (btn.dataset.name || "this member") + "? This removes the account entirely.")) return;
      await memberAction("/api/members/delete", { id });
    }
  });
  // Save a title when the inline box loses focus or Enter is pressed.
  byId("membersList").addEventListener("blur", (e) => {
    const inp = e.target.closest(".m-title-input"); if (inp) saveTitle(inp);
  }, true);
  byId("membersList").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const inp = e.target.closest(".m-title-input"); if (inp) { e.preventDefault(); inp.blur(); } }
  });
  let titleSaving = false;
  async function saveTitle(inp) {
    if (titleSaving) return;
    const id = inp.dataset.id;
    const member = members.find((x) => x.id === id);
    if (!member || inp.value.trim() === (member.title || "")) return;  // no change
    titleSaving = true;
    await memberAction("/api/members/title", { id, title: inp.value.trim() });
    titleSaving = false;
  }
  async function memberAction(url, extra) {
    setState("membersState", "Working…");
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...extra }) });
      const res = await r.json();
      if (!r.ok || !res.ok) return setState("membersState", res.error || "Failed", false);
      members = res.members; meId = res.meId; meRole = res.meRole || meRole; meCanManage = !!res.canManage; renderMembers();
      setState("membersState", res.note ? "✓ " + res.note : "✓ Done", true);
    } catch (_) { setState("membersState", "Can't reach server", false); }
  }
  byId("enrolForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = byId("enrolEmail").value.trim();
    const name = byId("enrolName").value.trim();
    const title = byId("enrolTitle").value.trim();
    setState("membersState", "Enrolling…");
    try {
      const r = await fetch("/api/members/enrol", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, email, name, title }) });
      const res = await r.json();
      if (!r.ok || !res.ok) return setState("membersState", res.error || "Failed", false);
      members = res.members; meId = res.meId; meRole = res.meRole || meRole; meCanManage = !!res.canManage; renderMembers();
      byId("enrolEmail").value = byId("enrolName").value = byId("enrolTitle").value = "";
      setState("membersState", "✓ Enrolled (password: presenter2026)", true);
    } catch (_) { setState("membersState", "Can't reach server", false); }
  });

  /* ============ SETTINGS ============ */
  byId("saveName").onclick = async () => {
    const name = byId("setName").value.trim();
    if (!name) return setState("settingsState", "Name can't be empty", false);
    try {
      const r = await fetch("/api/me/name", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name }) });
      const res = await r.json();
      if (r.ok && res.ok) {
        me = res.user; byId("welcomeName").textContent = "Welcome, " + me.name;
        setState("settingsState", "✓ Name updated", true);
      }
    } catch (_) { setState("settingsState", "Can't reach server", false); }
  };
  byId("savePw").onclick = async () => {
    const current = byId("curPw").value, next = byId("newPw").value;
    try {
      const r = await fetch("/api/me/password", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, current, next }) });
      const res = await r.json();
      if (!r.ok || !res.ok) return setState("settingsState", res.error || "Failed", false);
      byId("curPw").value = byId("newPw").value = "";
      setState("settingsState", "✓ Password changed", true);
    } catch (_) { setState("settingsState", "Can't reach server", false); }
  };

  /* ============ CHAT FEED (read-only) ============ */
  function connectChat() {
    const feed = byId("chatFeed");
    // Derive the chat server URL from the current page so it works on the live
    // site (wss:// under HTTPS) without any config edit. Falls back to the
    // configured URL only when opened as a local file.
    function resolveChatUrl() {
      const configured = (cfg.chatServerUrl || "").trim();
      if (location.protocol === "file:") return configured;
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      return `${scheme}//${location.host}`;
    }
    if (cfg.chatMode !== "server") return;
    const chatUrl = resolveChatUrl();
    if (!chatUrl) return;
    let ws;
    // Time the listener SENT it (server timestamp), not when it was drawn here.
    function when(ts) {
      const d = ts ? new Date(ts) : new Date();
      const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return d.toDateString() === new Date().toDateString() ? hm : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + hm;
    }
    function add(name, text, system, ts) {
      const d = document.createElement("div");
      if (system) { d.className = "pres-msg system"; d.textContent = text; }
      else {
        d.className = "pres-msg";
        d.innerHTML = `<div class="pres-msg-name">${escHtml(name)} <span class="pres-msg-time">${escHtml(when(ts))}</span></div><div>${escHtml(text)}</div>`;
      }
      feed.appendChild(d); feed.scrollTop = feed.scrollHeight;
    }
    function connect() {
      ws = new WebSocket(chatUrl);
      // Mark this socket as staff so the server treats the portal chat as read-only.
      ws.onopen = () => ws.send(JSON.stringify({ type: "staff-hello", token }));
      ws.onmessage = (ev) => {
        let d; try { d = JSON.parse(ev.data); } catch { return; }
        if (d.type === "history") {
          feed.innerHTML = "";
          (d.messages || []).forEach((m) => add(m.name, m.text, false, m.ts));
          if (!(d.messages || []).length) add(null, "Listener requests appear here.", true);
        } else if (d.type === "chat") {
          add(d.name, d.text, false, d.ts);
        } else if (d.type === "cleared") {
          feed.innerHTML = "";
          add(null, "Chat cleared" + (d.by ? " by " + d.by : "") + ".", true);
        }
        // presence (online count) is intentionally ignored — not shown.
      };
      ws.onclose = () => { setTimeout(connect, 2500); };
      ws.onerror = () => ws.close();
    }
    connect();

    // "Clear chat" button (available to every presenter).
    const clearBtn = byId("clearChatBtn");
    if (clearBtn) {
      clearBtn.onclick = function () {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!confirm("Clear the live chat for everyone? This cannot be undone.")) return;
        ws.send(JSON.stringify({ type: "clear", token }));
      };
    }
  }

  /* ============ ADVERTS (manager only) ============ */
  let advertList = [];

  async function loadAdverts() {
    try {
      const r = await fetch("/api/promos", { cache: "no-store" });
      if (!r.ok) return;
      const data = await r.json();
      advertList = Array.isArray(data.adverts) ? data.adverts : [];
      populateShowDropdown();
      renderAdverts();
    } catch (_) { /* ignore */ }
  }

  // Build the show dropdown from unique show names across all schedules.
  function populateShowDropdown() {
    const sel = byId("advertShow");
    if (!sel) return;
    const names = [];
    const seen = new Set();
    [].concat(content.showsWeekday || [], content.showsSaturday || [], content.showsSunday || [])
      .forEach((s) => {
        const n = (s.show || "").trim();
        if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); names.push(n); }
      });
    names.sort((a, b) => a.localeCompare(b));
    const current = sel.value;
    sel.innerHTML = '<option value="">All shows</option>' +
      names.map((n) => `<option value="${escAttr(n)}">${escHtml(n)}</option>`).join("");
    if (current) sel.value = current;   // keep selection if still valid
  }

  function renderAdverts() {
    const grid = byId("advertGrid");
    if (!grid) return;
    if (!advertList.length) {
      grid.innerHTML = '<p class="edit-hint">No adverts uploaded yet.</p>';
      return;
    }
    grid.innerHTML = advertList.map((a) => `
      <div class="advert-item">
        <img src="${a.url}" alt="${escHtml(a.name || "Advert")}" />
        <div class="advert-item-foot">
          <span class="advert-item-name">${escHtml(a.name || "Advert")}</span>
          <button class="btn-ghost advert-del" data-id="${escHtml(a.id)}">Remove</button>
        </div>
        <div class="advert-item-show">🎯 ${escHtml(a.show ? a.show : "All shows")}</div>
      </div>`).join("");
    grid.querySelectorAll(".advert-del").forEach((b) => {
      b.onclick = () => deleteAdvert(b.dataset.id);
    });
  }

  async function deleteAdvert(id) {
    if (!confirm("Remove this advert?")) return;
    try {
      const r = await fetch("/api/promos/delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, id }),
      });
      const res = await r.json();
      if (r.ok && res.ok) { advertList = res.adverts || []; renderAdverts(); }
      else setState("advertState", res.error || "Failed to remove", false);
    } catch (_) { setState("advertState", "Can't reach server", false); }
  }

  const advertForm = byId("advertForm");
  if (advertForm) {
    advertForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const fileInput = byId("advertFile");
      const file = fileInput.files && fileInput.files[0];
      if (!file) return setState("advertState", "Choose an image first.", false);
      if (file.size > 3 * 1024 * 1024) return setState("advertState", "Image over 3MB.", false);
      const name = byId("advertName").value.trim();
      const show = byId("advertShow") ? byId("advertShow").value : "";
      setState("advertState", "Uploading…");
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const r = await fetch("/api/promos", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, name, show, image: reader.result }),
          });
          const res = await r.json();
          if (r.ok && res.ok) {
            advertList = res.adverts || [];
            renderAdverts();
            setState("advertState", "✓ Uploaded", true);
            advertForm.reset();
          } else {
            setState("advertState", res.error || "Upload failed", false);
          }
        } catch (_) { setState("advertState", "Can't reach server", false); }
      };
      reader.onerror = () => setState("advertState", "Could not read the file.", false);
      reader.readAsDataURL(file);
    });
  }

  /* ============ util ============ */
  function setState(id, text, ok) {
    const el = byId(id); if (!el) return;
    el.textContent = text;
    el.style.color = ok === false ? "#ff6b5e" : ok ? "#7fe0a2" : "var(--muted)";
    if (ok) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 3000);
  }

  restore();
})();
