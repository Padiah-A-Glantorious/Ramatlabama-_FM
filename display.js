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
      if (state === 1) { played = true; ended.hidden = true; }
      if (state === 0) { ended.hidden = false; }
    };
    window.addEventListener("message", onMsg);

    // Introduce ourselves to the player so it reports its state.
    const hello = () => post({ event: "listening", id: 1, channel: "widget" });
    f.addEventListener("load", () => { hello(); hs.push(setTimeout(hello, 600), setTimeout(hello, 1800)); });

    // Watchdog: if the browser blocked autoplay, retry muted; if still stuck, let the viewer tap play.
    timer = setTimeout(() => {
      if (played) return;
      if (!muted) {
        stopVideo && stopVideo();
        const nb = buildVideo(d, true, inner);
        box.replaceWith(nb.box);
        stopVideo = nb.stop;
        fitVideo();
      } else {
        shield.remove();   // last resort: expose the player so a tap can start it
        f.style.pointerEvents = "auto";
      }
    }, 4500);

    return {
      box,
      stop() { clearTimeout(timer); hs.forEach(clearTimeout); window.removeEventListener("message", onMsg); },
    };
  }

  /* Size the video to the biggest 16:9 that fits the panel, so it never scrolls. */
  function fitVideo() {
    const box = view.querySelector(".display-video");
    if (!box) return;
    const inner = box.parentElement;
    const cap = inner.querySelector(".display-trans");
    const reserve = cap ? cap.offsetHeight + 8 : 0;
    const w = inner.clientWidth, h = inner.clientHeight - reserve;
    if (w <= 0 || h <= 0) return;
    const bw = Math.floor(Math.min(w, h * 16 / 9));
    box.style.width = bw + "px";
    box.style.height = Math.floor(bw * 9 / 16) + "px";
  }
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
    view.querySelectorAll("iframe").forEach((f) => { try { f.src = "about:blank"; } catch (_) {} f.remove(); });
    view.innerHTML = "";
    view.classList.remove("is-video");
  }

  function render(d) {
    clearView();
    view.classList.toggle("is-video", d.kind === "video");
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

  window.RFM_DISPLAY = {
    show(d) {
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
