# Deploying Ramatlabama FM on Render

Render runs your Node.js server (the part shared hosting can't), so the
**listener site, the portal login, admin editing, and the live chat all work.**
You keep your domain at HostAfrica and point it at Render.

---

## Part A — Create a Render account

1. Open your browser and go to **https://render.com**
2. Click **Get Started** (top-right).
3. Choose how to sign up:
   - **Sign up with GitHub** ← recommended (lets Render pull your repo).
   - or Google, or email + password.
4. Verify your email if prompted. You'll land on the Render **Dashboard**.

---

## Part B — Get the code to Render

### Option 1 — From GitHub (recommended)
1. Make sure the project is uploaded to a GitHub repo (e.g. `ramatlabama-fm`).
2. In Render: **New +** → **Web Service**.
3. Click **Connect GitHub**, authorise Render, and pick the `ramatlabama-fm` repo.

### Option 2 — No GitHub (public Git / manual)
If you didn't push to GitHub, the simplest is still to upload the clean folder
(`radiochat_upload`) to a GitHub repo via the web uploader, then use Option 1.
Render deploys from a Git repo, so a repo is the easiest route.

---

## Part C — Configure the Web Service

Render reads the included `render.yaml` automatically. If it asks, confirm:

- **Name:** `ramatlabama-fm`
- **Environment / Language:** Node
- **Build Command:** `cd server && npm install`
- **Start Command:** `node server/server.js`
- **Instance Type:** Free (to start) or Starter (~$7/mo, always-on)

---

## Part D — Set your private passwords (Environment variables)

In the service setup, open **Environment** (or **Advanced → Add Environment Variable**)
and add these so you're NOT using the public default passwords:

| Key                  | Value (choose your own)       |
|----------------------|-------------------------------|
| `GOD_PASSWORD`       | your private manager password |
| `CEO_PASSWORD`       | the CEO's password            |
| `PRESENTER_PASSWORD` | shared presenter password     |

Then click **Create Web Service**. Render builds and deploys. When it finishes
you get a URL like `https://ramatlabama-fm.onrender.com`.

- **Listener site:** `https://ramatlabama-fm.onrender.com/`
- **Staff portal:**  `https://ramatlabama-fm.onrender.com/portal`

HTTPS is automatic. The live chat works on the same URL.

---

## Part E — Point your HostAfrica domain at Render (optional)

1. In Render: open the service → **Settings → Custom Domains → Add Custom Domain**.
   Enter `ramatlabamafm.co.za` (or a subdomain like `live.ramatlabamafm.co.za`).
2. Render shows a DNS record to add (usually a **CNAME**, or an **A record** / value).
3. Log in to **HostAfrica** → your domain's **DNS / Zone Editor**.
4. Add the record exactly as Render shows it.
5. Wait for DNS to update (minutes to a few hours). Render issues the HTTPS
   certificate automatically once it sees the record.

> The domain currently redirects to famcast. Whoever controls the domain must
> change/point it to Render for the new site to show there.

---

## Things to know about the FREE tier

- **Sleeps after ~15 min idle** and takes ~30–60s to wake on the next visit.
  Fine for testing; for a live station use the **Starter** plan (~$7/mo) so it's
  always instant.
- **Data resets on restart** (members/news/shows edits) because the free disk is
  temporary. For permanent data, add a Render **Disk** or a small database —
  ask and this can be wired in.

---

## Quick recap

- **HostAfrica** = your domain name (the address).
- **Render** = runs the actual app (the engine) — listener site + portal + chat.
- Point the HostAfrica domain at Render to use your own web address.

Logins after deploy (use the passwords you set in Part D):
- Manager: `GOD_Admin`
- CEO: `CEO_Kutlwano_Nqaba`
- Presenters: their email + the shared presenter password
- Portal URL: `your-url/portal`
