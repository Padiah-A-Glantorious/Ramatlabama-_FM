# Ramatlabama FM — Project Notes

Living reference for how the site is built, deployed, and operated.
Last updated: 8 Nov 2026.

---

## 1. What this project is

A live radio + community site for Ramatlabama FM:

- **Listener site** (`/`): radio player (live show, or fill-in music when nobody
  is live), news ticker, live chat, "Call the studio", the "On Air" schedule panel
  with adverts, and anything a presenter renders (scripture, text, picture, video).
- **Staff portal** (`/portal`, or the `management.` subdomain): login for staff.
  Tabs: Chat, Studio, Render, Music, News, Shows, Adverts, Members, Settings.

---

## 2. Tech + repo

- **Stack:** plain Node.js HTTP server (`server/server.js`) + vanilla HTML/CSS/JS
  front end. WebSockets (`ws` package) for chat, live updates and call signalling.
  Calls are WebRTC (browser to browser). No framework.
- **Entry point:** `node server/server.js` (serves the site and the API on one port).
- **Front-end files:**
  - Listener: `index.html`, `app.js` (player, music, chat), `display.js` (rendered
    content), `callpeer.js` + `call.js` (Call the studio), `styles.css`.
  - Portal: `presenter.html`, `presenter.js`, `studio.js` (lines, mixing, co-hosts),
    `render.js`, `music.js`, `presenter.css`.
- **GitHub repos (kept in sync, identical content):**
  - `Padiah-A-Glantorious/ramatlabama-fm`
  - `Padiah-A-Glantorious/Ramatlabama-_FM`  ← the one Render deploys from
- **Local git note:** `git` is installed at `C:\Program Files\Git\cmd\git.exe`
  (not always on PATH). The second repo is a git remote named `other`.
- **Cache busting:** scripts and CSS are loaded with `?v=N`. Bump the number in
  `index.html` / `presenter.html` whenever a file changes, or browsers keep the old one.

---

## 3. Hosting (Render)

- **Service:** deploys from GitHub (`Ramatlabama-_FM`), **Starter** plan.
- **Live URLs:** `https://www.ramatlabamafm.co.za` (main), `https://ramatlabama-fm.onrender.com`
- **Auto-deploy:** pushing to `main` on GitHub triggers a redeploy automatically.
- **Persistent Disk:** mounted at `/var/data` (1 GB). This is what makes data survive
  restarts and redeploys.
- **Environment variables (Render → Environment):**
  - `DATA_DIR = /var/data`  ← critical; without it data goes to temporary storage
  - `GOD_PASSWORD`, `CEO_PASSWORD`, `PRESENTER_PASSWORD`
  - `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` (Cloudflare TURN relay for calls, see §9).
    Never commit these values.
  - Optional: `ICE_SERVERS` (JSON, other TURN provider), `MUSIC_MAX_MB` (default 700),
    `STREAM_STATUS_URL` / `STREAM_MOUNT` (Famcast status check, defaults are correct).

### Key lesson learned
Code and data are separate. **Code** comes from GitHub and is replaced on every
deploy. **Data** (shows, news, members, chat, adverts, music, logins) lives on the
`/var/data` Disk and is NOT touched by deploys.

---

## 4. Domains (HostAfrica DNS)

- `www.ramatlabamafm.co.za` → **CNAME** → `ramatlabama-fm.onrender.com` (verified in Render).
- `ramatlabamafm.co.za` (@) → **A** → `216.24.57.1` (Render). Render redirects it to `www`.
- `management.ramatlabamafm.co.za` → CNAME → `ramatlabama-fm.onrender.com` (staff portal).
- Old **famcast** redirect removed. The stray `dan1–dan4.host-ww.net` NS records were
  deleted from the zone (they served an old copy and broke certificate checks).
- ⚠ **Email:** MX still points at `ramatlabamafm.co.za`, which now resolves to Render,
  so `@ramatlabamafm.co.za` mail no longer arrives. To fix later: add `mail` as an
  **A** record → `169.239.181.134`, and point the **MX** at `mail.ramatlabamafm.co.za`.

---

## 5. Data files (all on `/var/data` in production)

| File | Holds |
|------|-------|
| `users.json`    | staff accounts (god / elevated / presenter, plus `canRender`) |
| `content.json`  | shows (weekday/sat/sun) + news |
| `chat.json`     | chat messages (auto-deleted after 7 hours) |
| `promos.json` + `promos/` | advert metadata + images |
| `music.json` + `music/`   | fill-in music: uploaded songs, YouTube links, day genres, time slots |
| `sessions.json` | login sessions (30 days; survive deploys) |

All are **gitignored**. The server generates defaults on first run if a file is missing.
Writes are atomic; corrupt files are backed up (`*.corrupt-*.bak`), never wiped.

---

## 6. Accounts & roles

- **Roles:** `god` (top authority), `elevated` (CEO + granted managers), `presenter`.
- Manager login: `GOD_Admin`; CEO login: `CEO_Kutlwano_Nqaba`; presenters log in
  with their **email** + the shared presenter password (from env vars in production).
- Managers (god/elevated) enrol, delete, set roles and edit titles in Members.
- **Render permission:** God Admin always; God Admin grants/revokes others in Members.
- **Music tab:** God Admin only.

---

## 7. Live chat

- Shared real-time chat over WebSocket on the same host/port as the site.
- Messages show the time they were **sent** (server timestamp, reader's local time).
- Messages disappear after **7 hours** (not mentioned to listeners).
- Presenters' chat is **read-only** (they can't type). Any presenter can **Clear chat**.

---

## 8. Adverts

- Replace the On Air panel: 3 min On Air, then 60 s advert. Random entrance effect.
- Per-show targeting ("All shows" or a specific show). Max 20 adverts, 3 MB each.
- Ad-blocker safety: internal paths use `/promos/` and CSS classes `spot-*`.

---

## 9. Calls and co-hosts (`studio.js`, `callpeer.js`, `call.js`), inside 🔴 On Air

- **Host:** 🔴 On Air → **📞 Lines** panel → **Open the lines** (wear headphones). Callers
  you put through go on air on the mixer's **CALLS** fader; your voice goes on air with
  **TALK**. No Miradio needed. The waiting count shows on the On Air tab and on the
  📞 LINES button in the top bar (tap it to jump to the Lines panel).
- **Star mix:** every caller/co-host connects to the host's tab, which mixes them.
  **Mix-minus:** each person hears the host + the others, never themselves (no echo).
  Up to **8** people on the line; 40 can wait.
- **No time limit:** calls survive socket drops (screen lock, network blips) by
  resuming, and repair broken audio with an ICE restart. They end only on hang-up,
  the host closing the lines, or a long absence (10 min). Callers' screens stay awake.
- **Co-hosts:** host picks a member under **Invite co-host** → that member's portal
  rings (banner on any tab, 60 s) → **Answer** puts them straight on air. Co-hosts on
  air can **Put through** callers too.
- **Callers:** listener site → 📞 Call the studio → queue (with position). Their radio
  pauses during the call. Speakerphone is fine (browser echo cancellation).
- **TURN relay:** Cloudflare TURN gives callers on mobile data a path through.
  `/api/ice` hands browsers short-lived credentials (6 h, refreshed hourly); the
  key stays on the server.
- Keep the host's portal tab open for the whole show (closing it ends the calls).

---

## 9b. 🔴 On Air studio (`desk.js`, `desk.css`, `audiohub.js`, `server/broadcast.js`)

- A broadcast desk inside the portal, so presenters can go live from a phone (no
  Miradio TAB needed): Deck A / Deck B (waveform, CUE, PLAY, stop, load, eject),
  mixer (CH A, CH B, MIC, CALLS + meters, crossfader), TALK + TALK-OVER, AUTO NEXT,
  playlist (station music + your own files), cart wall (jingles, SFX, clips, ads).
- **On air** = decks + carts + MIC (when TALK is on) + CALLS. **Headphones** = the same
  without your own mic. **Callers hear** you, the other callers and the music.
- **GO LIVE:** the page records the mix (MediaRecorder) and streams it over the
  WebSocket; the server converts it with ffmpeg (`ffmpeg-static`) to MP3 and sends it
  to Famcast as an Icecast source (HTTP PUT). One presenter live at a time; managers
  can take over. Reconnects by itself after a blip (short gap on air).
- **Render env vars:** `FAMCAST_SOURCE_PASSWORD` (required to really go live),
  optional `FAMCAST_SOURCE_URL` (default `https://sv2.famcast.co.za:8845/stream`) and
  `FAMCAST_SOURCE_USER` (default `source`). Without the password GO LIVE runs a
  **preview** only; staff hear it with LISTEN (`/api/broadcast/listen`).
- Miradio and the portal can't both be live on the same Famcast mount: stop one first
  (the studio shows "Famcast is busy" and keeps retrying).
- Phones: keep the studio on screen while live (screen is kept awake; going to the
  background may pause the broadcast).
- YouTube links can't go on air (browsers can't capture them and YouTube's terms
  forbid rebroadcasting): the decks play uploaded files only.

---

## 10. Render tab (`render.js`, `display.js`)

- Scripture (bible-api.com: KJV, WEB, BBE, Open English), custom text, pictures,
  YouTube video. Replaces the listener chat (and On Air + call button on phones).
- Video: autoplay, no controls, can't be paused, fills the box at 16:9. With sound by
  default: the radio pauses while it plays, resumes after. (Sound needs one tap on
  the page first; until then it plays silently and the radio carries on.)
- **Stop & bring back chat** works over HTTP; listener pages re-sync when they wake.

---

## 11. Fill-in music (`music.js`, Music tab, `app.js`)

- Every 10 s the server checks Famcast (`status-json.xsl`). Nobody live → the website
  plays fill-in music; presenter goes live → switches to the stream automatically.
- God Admin uploads songs (MP3/M4A/OGG, 15 MB) and adds YouTube playlists/videos by
  genre (audio only, hidden player). Rotates playlists every 3 songs. Can't be paused.
- Per-day **time slots** (Sunday default: 05–12 Gospel, 12–18 Jazz, 18–22 Gospel) +
  a default genre per day. Empty slot → day genre → any music.
- Refreshing the page carries on the same song. Website only (not Famcast's player/FM).

---

## 12. API quick reference

Public (GET): `/api/content`, `/api/promos`, `/promos/<file>`, `/api/music/now`,
`/music/<file>`, `/api/display`, `/api/ice`
Auth (POST, needs token): `/api/login`, `/api/me`, `/api/news`, `/api/shows`,
`/api/members*` (incl. `/api/members/render`), `/api/promos*`, `/api/me/*`,
`/api/bible`, `/api/display`, `/api/music/admin|settings|upload|delete|link|link/delete`.
WebSocket: chat (`chat`, `history`, `clear`), `display`, `onair`, `music-changed`,
studio (`staff-hello`, `host-start/stop`, `call-request/resume/accept/end`,
`cohost-invite/answer/decline/cancel`, `rtc`).

---

## 13. Common operations

**Deploy new code:** push to GitHub `main` (both repos) → Render auto-redeploys.

```
# from the radiochat folder
& "C:\Program Files\Git\cmd\git.exe" add <files>
& "C:\Program Files\Git\cmd\git.exe" commit -m "message"
& "C:\Program Files\Git\cmd\git.exe" push origin main
& "C:\Program Files\Git\cmd\git.exe" push other main:main
```

**Run locally:** `node server/server.js` → http://localhost:3001.
If it says `EADDRINUSE`, an old copy is still running on port 3001: stop it first.

**Restart on Render:** Manual Deploy → Restart.

---

## 14. Still to do

- [ ] Fix email (see §4): `mail` A record + MX → `mail.ramatlabamafm.co.za`.
- [ ] Rotate the Cloudflare TURN API token (it was shared in chat) and update
      `CF_TURN_API_TOKEN` in Render.
- [ ] Add music on the live site: 2–3 YouTube playlists + a few uploads per genre
      (Gospel, Jazz), uploads as a backup for iPhones.
- [ ] First live test of the studio with real phones on mobile data + Miradio TAB.
- [ ] Re-enter real shows/news and upload real adverts if not done yet.
