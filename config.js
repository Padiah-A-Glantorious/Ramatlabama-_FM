// ============================================================
//  RADIO + CHAT CONFIG  — edit this file, nothing else needed.
// ============================================================

window.RADIO_CONFIG = {
  // ---- 1. THE RADIO STREAM -----------------------------------------
  // Paste the DIRECT audio stream URL of Ramatlabama FM here.
  //
  // How to find it (takes ~20 seconds):
  //   1. Open  http://ramatlabamafm.co.za/  in Chrome/Edge.
  //   2. Press F12  ->  go to the "Network" tab  ->  click the "Media" filter.
  //   3. Press the station's Play / Listen Live button.
  //   4. A request will appear (often ends in .mp3, /stream, /; , or has a
  //      port like :8000).  Right-click it  ->  Copy -> Copy URL.
  //   5. Paste that URL below, replacing the empty string.
  //
  // Example shapes (NOT the real one — replace with the one you copied):
  //   "https://stream.famcast.co.za:8000/ramatlabama"
  //   "https://some-host.com/ramatlabamafm/stream"
  streamUrl: "https://sv2.famcast.co.za:8845/stream",

  // ---- 2. THE STATION'S OWN PAGE (for the "Station Page" tab) -------
  // Shown in an iframe window. Many radio hosts block iframes; if it stays
  // blank, the "Open in new tab" button still works and audio keeps playing.
  stationPageUrl: "https://famcast.co.za/q/stations/ramatlabama-fm/",

  // ---- 3. CHAT BACKEND ---------------------------------------------
  // "local"  = demo mode. Messages stay in THIS browser only (great for
  //            testing the UI with zero setup).
  // "server" = real-time chat shared across all visitors AND the presenter
  //            console. Requires the included Node server to be running.
  chatMode: "server",

  // Used when chatMode === "server". Point this at your running server.
  // Local test:   "ws://localhost:3001"
  // Deployed:     "wss://your-domain.com"
  chatServerUrl: "ws://localhost:3001",

  // ---- PRESENTER CONSOLE (presenter.html) --------------------------
  // The miradio studio where presenters go live. Shown in an iframe on the
  // presenter console next to the live chat feed.
  studioUrl: "https://studio.miradio.co/v1/",

  // Passkey presenters enter to open the console. Change before going live.
  // (Also set PRESENTER_KEY env var on the server to the same value.)
  presenterPasskey: "presenter2026",

  // ---- 4. LANDING-PAGE CONTENT (station controls all of this) ------
  // Edit freely. "Now playing" headline on the hero:
  nowPlaying: {
    show: "The Morning Drive",
    desc: "Waking up the border with music, news and your calls.",
    meta: "96 kbps · Setswana & English",
  },

  // Station news feed (newest first). Add/remove items any time.
  news: [
    {
      tag: "LIVE",
      title: "Now streaming worldwide",
      body: "Listen live from anywhere. Tell family across the border in Botswana to tune in.",
      date: "25 Oct 2026",
    },
    {
      tag: "COMMUNITY",
      title: "Dedications line is open",
      body: "Send a shout-out during The Morning Drive — drop it in the chat to reach the studio.",
      date: "24 Oct 2026",
    },
    {
      tag: "EVENTS",
      title: "Miga cycling & aerobics day",
      body: "Supporting young talent in Ramatlabama & Miga. Come cheer the kids on this weekend.",
      date: "22 Oct 2026",
    },
  ],

  // ==================================================================
  //  ON-AIR SHOW LIST  (admin-editable)
  //  Add / edit / remove shows here. Each show has a start time, end
  //  time, name and host. The site automatically works out which show
  //  is "on air" right now from the current time and shows it in the
  //  "Now Broadcasting" strip, and highlights it in the On Air list.
  //  Times are 24-hour "HH:MM".  (Later this can be filled from an
  //  admin panel instead of this file.)
  // ==================================================================
  schedule: [
    { start: "06:00", end: "09:00", show: "The Morning Drive",       host: "The Breakfast Crew" },
    { start: "09:00", end: "12:00", show: "Mid-Morning Mix",         host: "DJ Kagiso" },
    { start: "12:00", end: "15:00", show: "Lunchtime Setswana Hits", host: "MC Boitumelo" },
    { start: "15:00", end: "18:00", show: "Afternoon Request Show",  host: "DJ Kagiso" },
    { start: "18:00", end: "20:00", show: "Evening News & Talk",     host: "Station Desk" },
    { start: "20:00", end: "23:00", show: "Gospel & Soul",           host: "MC Boitumelo" },
    { start: "23:00", end: "06:00", show: "Overnight Mix",           host: "Auto DJ" },
  ],

  // Community notice board.
  notices: [
    "📞 Studio line & dedications: open during live shows.",
    "⛪ Local church & funeral notices read on Evening News.",
    "🏥 Clinic mobile visit to Miga this week — check with the ward councillor.",
    "⚽ Weekend local football fixtures announced on the Afternoon Show.",
  ],
};
