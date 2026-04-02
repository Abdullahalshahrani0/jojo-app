# JOJO 🍓

Jomana's personal reminder app — stay close to the people you love.

## Run locally

```bash
npm install
node server.js
# Open http://localhost:3000
```

VAPID keys are generated automatically on first run and saved to `.env`.

---

## Deploy on Render

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "initial commit"
gh repo create jojo-app --public --push
```

### 2. Create a new Web Service on Render

1. Go to [render.com](https://render.com) → **New** → **Web Service**
2. Connect your GitHub repo
3. Set these options:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Environment:** Node

### 3. Add environment variables on Render

Run this locally first to get your keys:
```bash
node -e "const wp=require('web-push'); const k=wp.generateVAPIDKeys(); console.log(k);"
```

Then in Render → your service → **Environment**, add:

| Key | Value |
|-----|-------|
| `VAPID_PUBLIC_KEY` | (your public key) |
| `VAPID_PRIVATE_KEY` | (your private key) |

### 4. Deploy

Render auto-deploys on every push to `main`.

Open your Render URL in the browser — JOJO will be live and installable as a PWA.

---

## How it works

- **Frontend** (`index.html`) is a PWA served by Express.
- **Service worker** (`sw.js`) caches the app offline and handles push events.
- **Server** (`server.js`) runs a cron job every minute, checks schedules, and sends push notifications via web-push.
- All data lives in `data.json` (server) and `localStorage` (browser).
- No database, no accounts, no phone numbers.
