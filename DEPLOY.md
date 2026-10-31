# Deploying Ramatlabama FM

This project is **not** a static site — it needs a Node.js server for the portal
login, admin editing, and live chat. **GitHub Pages cannot run it.** Use GitHub
for the code, and a Node host (Render) to run it.

---

## Step 0 — Install the tools (one time)

1. **Git** — https://git-scm.com/download/win  (install with defaults).
2. **GitHub CLI** (optional but easiest) — https://cli.github.com/
3. A free **GitHub account** — https://github.com
4. A free **Render account** — https://render.com (sign in with GitHub).

> After installing, close and reopen your terminal so `git` is recognised.

---

## Step 1 — Put the code on GitHub

From the project folder (`radiochat`):

```powershell
git init
git add .
git commit -m "Ramatlabama FM: listener site + station portal"
```

Then create the GitHub repo and push. **Easiest (GitHub CLI):**

```powershell
gh auth login          # opens a browser — log in to GitHub normally
gh repo create ramatlabama-fm --private --source=. --push
```

**Or manually:** create an empty repo on github.com named `ramatlabama-fm`, then:

```powershell
git remote add origin https://github.com/<your-username>/ramatlabama-fm.git
git branch -M main
git push -u origin main
```

> When git asks for a password, use a **Personal Access Token**, not your account
> password (GitHub → Settings → Developer settings → Personal access tokens →
> Fine-grained token with repo access). Never share your password.

---

## Step 2 — Deploy the running app on Render

1. Go to https://render.com → **New** → **Web Service**.
2. Connect your GitHub and pick the `ramatlabama-fm` repo.
3. Render reads `render.yaml` automatically. If asked, confirm:
   - **Build command:** `cd server && npm install`
   - **Start command:** `node server/server.js`
4. Under **Environment**, set these (so you don't use the public default passwords):
   - `GOD_PASSWORD` = your private manager password
   - `CEO_PASSWORD` = the CEO's password
   - `PRESENTER_PASSWORD` = the shared presenter password
5. Click **Create Web Service**. Render builds and gives you a URL like
   `https://ramatlabama-fm.onrender.com`.

- Listener site: `https://ramatlabama-fm.onrender.com/`
- Staff portal:  `https://ramatlabama-fm.onrender.com/portal`

HTTPS is automatic. The chat (WebSocket) works on the same URL.

---

## Step 3 — (Optional) your own domain

In Render → the service → **Settings → Custom Domains**, add
`ramatlabamafm.co.za`, then add the DNS record Render shows you at your
domain registrar. Render issues the HTTPS certificate automatically.

> Note: the domain currently redirects to famcast. Whoever controls the domain
> must repoint it to Render for the new site to appear there.

---

## Notes on data & security

- `server/users.json` and `server/content.json` are **git-ignored** — they are
  created on the server from the defaults / env vars on first run. This keeps
  passwords out of the repo.
- Because they're regenerated per deploy on Render's free tier (which has an
  ephemeral disk), member/show/news edits may reset when the service restarts.
  For persistent data, attach a Render **Disk** or move the store to a small
  database later — tell me and I'll wire it up.
- Change the default passwords via the env vars above before sharing the link.
