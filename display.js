/* ============================================================
   Ramatlabama FM — Listener "live display"
   When a presenter clicks Render in the portal, the chat panel is replaced
   by scripture / text / a picture / a video. Clearing it brings the chat back.
   app.js forwards { type: "display" } socket messages to RFM_DISPLAY.show().
   ============================================================ */
(() => {
  "use strict";
  const wrap = document.querySelector(".chat-wrap");
  const view = document.getElementById("displayView");
  if (!wrap || !view) return;

  const YT_ORIGIN = "https://www.youtube-nocookie.com";
  let stopVideo = null;   // cleans up timers/listeners of the current video

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------- video: autoplay, no controls, can't be paused by viewers ---------- */
  function buildVideo(d, muted, inner) {
    const box = el("div", "display-video");
    const f = document.createElement("iframe");
    const q = new URLSearchParams({
      autoplay: "1", controls: "0", disablekb: "1", fs: "0", rel: "0", playsinline: "1",
      modestbranding: "1", iv_load_policy: "3", cc_load_policy: "0", enablejsapi: "1",
      origin: location.origin,
    });
    if (muted) q.set("mute", "1");
    if (d.start) q.set("start", String(d.start));
    f.src = YT_ORIGIN + "/embed/" + encodeURIComponent(d.videoId) + "?" + q.toString();
    f.title = d.caption || "Video from the station";
    f.tabIndex = -1;
    f.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
    f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    box.appendChild(f);

    // Transparent shield: viewers can't click, pause or open anything.
    const shield = el("div", "display-video-shield");
    box.appendChild(shield);

    // Shown when the video finishes, so no end-of-video suggestions appear.
    const ended = el("div", "display-video-ended", "Video finished");
    ended.hidden = true;
    box.appendChild(ended);

    const post = (obj) => { try { f.contentWindow.postMessage(JSON.stringify(obj), YT_ORIGIN); } catch (_) {} };

    let played = false, timer = 0, hs = [];
    const onMsg = (ev) => {
      if (ev.origin !== YT_ORIGIN || ev.source !== f.contentWindow) return;
      let data = ev.data;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch (_) { return; } }
      if (!data) return;
      let state = null;
      if (data.event === "onStateChange" && typeof data.info === "number") state = data.info;
      else if (data.event === "infoDelivery" && data.info && typeof data.info.playerState === "number") state = data.info.playerState;
      // A video with sound quiets the radio while it plays; the radio returns when it ends.
      if (data.event === "onReady" || data.event === "initialDelivery") armWatchdog(4500);   // player loaded: now give it time to start
      if (state === 1) { played = true; ended.hidden = true; if (!muted) radio(true); }
      if (state === 0) { ended.hidden = false; radio(false); }
    };
    window.addEventListener("message", onMsg);

    // Introduce ourselves to the player so it reports its state.
    const hello = () => post({ event: "listening", id: 1, channel: "widget" });
    f.addEventListener("load", () => { hello(); hs.push(setTimeout(hello, 600), setTimeout(hello, 1800)); });

    // Watchdog: if the browser blocked autoplay, retry muted; if still stuck, let the viewer tap play.
    // Counted from when YouTube's player has loaded (slow on first visit), with a 25 s cap overall.
    function armWatchdog(ms) { clearTimeout(timer); timer = setTimeout(onStuck, ms); }
    armWatchdog(25000);
    function onStuck() {
      if (played) return;
      if (!muted) {
        // Sound was blocked (visitor hasn't tapped the page yet): play it silently instead.
        radio(false);
        stopVideo && stopVideo();
        const nb = buildVideo(d, true, inner);
        box.replaceWith(nb.box);
        stopVideo = nb.stop;
        fitVideo();
      } else {
        shield.remove();   // last resort: expose the player so a tap can start it
        f.style.pointerEvents = "auto";
      }
    }

    return {
      box,
      stop() { clearTimeout(timer); hs.forEach(clearTimeout); window.removeEventListener("message", onMsg); },
    };
  }

  /* The video fills the render box edge to edge in its true 16:9 shape (YouTube's own
     shape), so nothing is cropped, zoomed or stretched. The box shrinks to fit it. */
  function fitVideo() {
    const box = view.querySelector(".display-video");
    if (!box) return;
    const cap = box.parentElement.querySelector(".display-trans");
    const reserve = cap ? cap.offsetHeight : 0;
    const w = view.clientWidth;
    if (w <= 0) return;
    let bw = w;
    // Desktop: never taller than the space the chat panel normally has.
    if (!window.matchMedia("(max-width: 860px)").matches) {
      const grid = wrap.parentElement;
      const maxH = (grid ? grid.clientHeight : window.innerHeight) - reserve;
      if (maxH > 0) bw = Math.min(w, Math.floor(maxH * 16 / 9));
    }
    box.style.width = bw + "px";
    box.style.height = Math.round(bw * 9 / 16) + "px";
  }
  const radio = (on) => { try { if (window.RFM_RADIO) window.RFM_RADIO.duck(on); } catch (_) {} };
  let fitObserver = null;
  function watchFit() {
    unwatchFit();
    fitVideo();
    if (window.ResizeObserver) { fitObserver = new ResizeObserver(fitVideo); fitObserver.observe(view); }
    else window.addEventListener("resize", fitVideo);
  }
  function unwatchFit() {
    if (fitObserver) { fitObserver.disconnect(); fitObserver = null; }
    window.removeEventListener("resize", fitVideo);
  }

  // Fully tear down whatever is showing (kills any playing video and its sound).
  function clearView() {
    if (stopVideo) { stopVideo(); stopVideo = null; }
    unwatchFit();
    radio(false);   // the radio comes back as soon as the video goes
    wrap.classList.remove("has-video");
    view.querySelectorAll("iframe").forEach((f) => { try { f.src = "about:blank"; } catch (_) {} f.remove(); });
    view.innerHTML = "";
    view.classList.remove("is-video");
  }

  function render(d) {
    clearView();
    view.classList.toggle("is-video", d.kind === "video");
    wrap.classList.toggle("has-video", d.kind === "video");
    const inner = el("div", "display-inner display-k-" + d.kind + (d.kind === "video" && d.caption ? " has-cap" : ""));

    if (d.kind === "scripture") {
      inner.appendChild(el("div", "display-ref", d.reference || ""));
      const body = el("div", "display-verses");
      d.verses.forEach((v) => {
        const p = el("p", "display-verse");
        if (v.n) p.appendChild(el("sup", "display-vnum", String(v.n)));
        p.appendChild(document.createTextNode(" " + v.text));
        body.appendChild(p);
      });
      inner.appendChild(body);
      if (d.translation) inner.appendChild(el("div", "display-trans", d.translation));
    } else if (d.kind === "text") {
      if (d.title) inner.appendChild(el("div", "display-ref", d.title));
      inner.appendChild(el("div", "display-body", d.body));
    } else if (d.kind === "video") {
      const v = buildVideo(d, !!d.muted, inner);
      stopVideo = v.stop;
      inner.appendChild(v.box);
      if (d.caption) inner.appendChild(el("div", "display-trans", d.caption));
    } else if (d.kind === "image") {
      const img = document.createElement("img");
      img.className = "display-img"; img.alt = d.caption || "Shown by the station";
      img.src = d.image;
      inner.appendChild(img);
      if (d.caption) inner.appendChild(el("div", "display-trans", d.caption));
    }
    view.appendChild(inner);
    view.scrollTop = 0;
    if (d.kind === "video") {
      // The panel is shown right after render(); size once it has a layout.
      requestAnimationFrame(() => { watchFit(); });
    }
  }

  // Re-check with the server: phones that slept (or whose socket died quietly) may
  // have missed a Render or Stop. Only redraw when something actually changed.
  let currentTs = null;
  function sync() {
    fetch("/api/display", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (!j || !j.ok) return;
      const ts = j.display ? j.display.ts : null;
      if (ts !== currentTs) window.RFM_DISPLAY.show(j.display || null);
    }).catch(() => {});
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
  window.addEventListener("pageshow", sync);
  window.addEventListener("online", sync);
  setInterval(() => { if (!document.hidden) sync(); }, 20000);

  window.RFM_DISPLAY = {
    show(d) {
      const ts = d ? (d.ts || 0) : null;
      if (d && ts && ts === currentTs) return;   // same render again (e.g. on reconnect): don't restart it
      currentTs = ts;
      // Page-level flag: on phones the On Air card hides so the render takes its place.
      document.body.classList.toggle("is-rendering", !!d);
      if (!d) {
        clearView();
        wrap.classList.remove("show-display");
        view.hidden = true;
        return;
      }
      render(d);
      view.hidden = false;
      wrap.classList.add("show-display");
    },
  };
})();
