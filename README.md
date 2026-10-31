# Ramatlabama FM — Live Radio + Community Chat

A website that plays Ramatlabama FM continuously while visitors chat. The radio
player sits in a fixed bar at the bottom of the page and **never stops** when you
switch tabs or send chat messages — that is the whole point of the design.

```
radiochat/
├── index.html        the page (top bar · chat/station views · radio bar)
├── styles.css        styling
├── config.js         <-- THE ONLY FILE YOU NEED TO EDIT
├── app.js            player control, tab switching, chat logic
├── README.md         this file
└── server/           optional real-time chat backend
    ├── server.js
    └── package.json
```

## Step 1 — Add the radio stream URL (required)

Open `config.js` and set `streamUrl`. To find the real stream link:

1. Open <http://ramatlabamafm.co.za/> in Chrome or Edge.
2. Press **F12** → **Network** tab → click the **Media** filter.
3. Press the station's **Play / Listen Live** button.
4. A media request appears (often ends in `.mp3`, `/stream`, `/;`, or uses a
   port like `:8000`). Right-click it → **Copy → Copy URL**.
5. Paste it into `streamUrl` in `config.js`.

> If the stream host does not send CORS headers, a browser may refuse to play it
> from your own domain. If that happens, the fix is a tiny server-side proxy for
> the audio — tell me the stream URL you found and I'll add it to `server.js`.

## Step 2 — Run it

### Quick preview (chat is local to your browser)

Just double-click `index.html`, or serve the folder. Chat messages stay in your
own browser (they even sync across two tabs of the same browser). Good for
checking the UI and the radio.

### Full version (chat shared across all visitors)

1. Install Node.js (18+).
2. In a terminal:
   ```powershell
   cd radiochat/server
   npm install
   npm start
   ```
3. Open <http://localhost:3001>.
4. In `config.js`, set:
   ```js
   chatMode: "server",
   chatServerUrl: "ws://localhost:3001",
   ```
   When you deploy behind HTTPS, use `wss://your-domain.com` instead.

## Two ways the radio is integrated

- **Primary — direct stream player** (the bottom bar). Robust, keeps playing
  through everything. This is what `streamUrl` drives.
- **Secondary — "Station Page" tab.** Loads the official station page in an
  embedded window. Many radio hosts block embedding; if the frame is blank,
  the "Open in new tab" button works and the bottom player keeps the audio
  going regardless.

## Notes

- The chat sanitizes input and escapes HTML to avoid injection.
- No analytics, trackers, or external dependencies on the front end.
- Deploy the static files to any host (Netlify, Vercel, GitHub Pages, your own
  server). For shared real-time chat you need the Node server running somewhere.
