# Developer Handoff & Hosting Guide (`gvc-security.netlify.app` / `alerts.gallatinvalleychurch.org`)

This document is for the Gallatin Valley Church web developer deploying and maintaining the **GVC Security & Classroom Alert PWA** from `https://github.com/ryanundertrees/gvc_security_alerts`.

---

## Option 1: Netlify Hosting (`https://gvc-security.netlify.app/` & Custom Domain) — Ready Out-of-the-Box

The repository is pre-configured for zero-config Netlify deployment via `netlify.toml` and `netlify/functions/api.mjs`:

- **Publish Directory (`netlify.toml`):** `public` (contains `index.html`, `room.html`, `app.js`, `room.js`, `styles.css`, `sw.js`, `manifest.json`, and `icons/icon.svg`).
- **Build Command:** `npm run build` (runs JS/JSON syntax and integrity checks).
- **Classroom Redirect:** `/room/*` → `/room.html` (`200` rewrite).
- **Serverless API (`netlify/functions/api.mjs`):** Netlify Functions v2 catching `/health` and `/api/*`, backed by **Netlify Blobs** (`@netlify/blobs`) for shared persistent state + auto-generated VAPID push keys, `web-push` for mobile notifications, and automatic client-side adaptive polling (`realtimeMode: "poll"`).

### Required Netlify Environment Variables

In the Netlify site dashboard (**Site configuration → Environment variables**), set:

| Variable | Value | Notes |
| :--- | :--- | :--- |
| `TEAM_PIN` | *(choose strong 4–6 digit PIN)* | **Required in production.** Replaces default `1234`. |
| `ON_DUTY_TIMEOUT_HOURS` | `6` | Auto-locks responder sessions after 6 hours. |
| `VAPID_SUBJECT` | `mailto:security@gallatinvalleychurch.org` | Contact email in Web Push headers. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | *(optional)* | Auto-generated and persisted in Netlify Blobs (`gvc-security-state` → `vapid`) on first request if left unset. |

### Netlify Free Tier Usage Note

- Netlify Free plan includes **300 credits/month** (hard cap). Because the frontend uses visibility-aware adaptive polling (pausing when tabs/iPads sleep and polling every 3s–5s only while open), typical **Sunday-only usage** uses roughly **~18–25 credits/month** when classroom iPads sleep Mon–Sat.
- If all 6 iPads are left awake and open 24/7 all week, polling can consume more function compute credits — either keep iPad screens asleep Mon–Sat, upgrade to Netlify Personal (\$9/mo), or self-host via Options 2–4 below.

### Custom Domain (`https://alerts.gallatinvalleychurch.org`)

In Netlify (**Domain management → Add a domain**), add **`alerts.gallatinvalleychurch.org`** and point the church DNS `CNAME` record for `alerts` to `gvc-security.netlify.app`. Do **not** mount the app under a `/subfolder` path (Service Worker `/` and `/room/:slug` routes require the domain/subdomain root).

---

## Option 2: Native Node.js + PM2 (Self-Hosted Server)

- **Runtime:** Node.js **22+ LTS** recommended (built-in `node:sqlite`, zero C++ build tools; Node 20+ also supported via `sql.js`).

```bash
git clone https://github.com/ryanundertrees/gvc_security_alerts.git gvc_security_alerts
cd gvc_security_alerts
npm install --omit=dev
cp .env.example .env
# Edit .env: set a strong TEAM_PIN and confirm VAPID_SUBJECT=mailto:security@gallatinvalleychurch.org
pm2 start server.js --name gvc-security
pm2 save
```

*(Run a **single instance** only — do not use PM2 cluster mode with embedded SQLite.)*

---

## Option 3: Docker Compose (Self-Hosted Container)

```bash
git clone https://github.com/ryanundertrees/gvc_security_alerts.git gvc_security_alerts
cd gvc_security_alerts
cp .env.example .env
# Edit .env: set TEAM_PIN and VAPID_SUBJECT
docker compose up -d --build
```

- Persists `./data` (`alerts.db` + `vapid.json`) via `./data:/app/data`.
- Optional Cloudflare Tunnel: populate `CLOUDFLARE_TUNNEL_TOKEN` in `.env` and run `docker compose --profile cloudflare up -d --build`.

---

## Option 4: Reverse Proxy Config (Only Needed for Options 2 & 3)

### Nginx Snippet (SSE Buffering Disabled)

```nginx
server {
    listen 443 ssl http2;
    server_name alerts.gallatinvalleychurch.org;

    location /api/events/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 86400s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Caddy Snippet

```caddy
alerts.gallatinvalleychurch.org {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

---

## Updating From GitHub

- **On Netlify:** Every push to `main` on `ryanundertrees/gvc_security_alerts` triggers an automatic rebuild & deploy. Netlify Environment Variables and Netlify Blobs (`gvc-security-state`) are preserved across deploys.
- **On Self-Hosted (PM2 / Docker):** `.env` and `./data/` are gitignored, so `git pull origin main && npm install --omit=dev` (then `pm2 restart gvc-security` or `docker compose up -d --build`) preserves live data and settings.

---

## Classroom iPad & Smartphone URLs

Using `https://gvc-security.netlify.app` (or `https://alerts.gallatinvalleychurch.org` once DNS is linked):

- **Security Team Console:** `/`
  - **iOS (16.4+):** Open in **Safari** → **Share → Add to Home Screen** → open the Home Screen icon → enter `TEAM_PIN` → tap **🔔 Enable Push**.
  - **Android (Chrome):** Open URL → **Install app / Add to Home screen** → unlock → tap **🔔 Enable Push**.
- **6 Official Classroom iPad Kiosks** *(open each in Safari → Share → Add to Home Screen; optional Guided Access lock)*:
  - `/room/sweet-grass-1`
  - `/room/sweet-grass-2`
  - `/room/bears-paw-1`
  - `/room/bears-paw-2`
  - `/room/pioneer-1`
  - `/room/pioneer-2`

---

## Post-Deploy Real-Device Verification Checklist

Before relying on the live Netlify deployment on Sunday:

1. **Health Endpoint:** Visit `https://gvc-security.netlify.app/health` and confirm HTTP `200` JSON showing `"status": "ok"`, `"dbEngine": "netlify-blobs"`, `"realtimeMode": "poll"`, and `"webPushConfigured": true`.
2. **Real Smartphone Push Test:** On an actual iPhone (Safari → *Add to Home Screen* first) and Android phone (Chrome), unlock `/` with your production `TEAM_PIN` and tap **🔔 Enable Push** → **Allow**.
3. **Classroom iPad & Live Delivery Test:** Open `/room/sweet-grass-1` on an iPad, press-and-hold **Assistance**, **MEDICAL**, or **URGENT** for 1 second, confirm the responder phone receives the Web Push alert and live banner, tap **EnRoute**, confirm the iPad turns green with attribution, and test **LOCKDOWN** + **All Clear**.
