# Developer Handoff & Hosting Guide (`alerts.gallatinvalleychurch.org`)

This document is for the Gallatin Valley Church web developer deploying and maintaining the **GVC Security & Classroom Alert PWA** from `https://github.com/ryanundertrees/gvc_security_alerts` onto `https://alerts.gallatinvalleychurch.org`.

---

## 1. Architecture & Requirements

- **Runtime:** Node.js **22+ LTS** recommended (uses built-in `node:sqlite` with zero C++ build tools or `node-gyp`). Node 20+ is also supported automatically via the `sql.js` pure-JS/WASM fallback in `db.js`.
- **Database & Persistent State:** Single embedded SQLite file (`./data/alerts.db`) plus auto-generated VAPID push keys (`./data/vapid.json`). No external database server is required.
- **Transport:** Standard HTTP + Server-Sent Events (SSE) + Web Push (`web-push`). No WebSocket upgrade is needed, though reverse proxies **must disable buffering** on SSE routes.
- **Health Check:** `GET /health` returns HTTP `200` JSON (`{ "status": "ok", "uptime": ..., "dbEngine": "...", "webPushConfigured": true }`).

### Critical: Host at the Subdomain Root (`https://alerts.gallatinvalleychurch.org`)

Mount this app directly at the root of **`https://alerts.gallatinvalleychurch.org`** — do **not** mount it under a subfolder like `https://gallatinvalleychurch.org/alerts/`. The PWA Service Worker (`/sw.js`), Web App Manifests (`/manifest.json`, `/api/rooms/:slug/manifest.json`), API calls (`/api/*`), and Classroom routes (`/room/:slug`) assume root-relative paths. HTTPS is strictly required by iOS Safari and Android Chrome for Web Push notifications and Home Screen installation.

---

## 2. Environment Variables (`.env`)

Copy `.env.example` to `.env` on the server and set your values:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Internal port the Node server listens on. |
| `HOST` | `0.0.0.0` | Bind address (`0.0.0.0` for Docker/containers; `127.0.0.1` if behind local Nginx/Caddy). |
| `TEAM_PIN` | `1234` | **Change in production.** Shared PIN security team members enter to unlock `/`. |
| `ON_DUTY_TIMEOUT_HOURS` | `6` | Hours before an on-duty responder session automatically locks and stops receiving alerts. |
| `DB_PATH` | `./data/alerts.db` | SQLite database file path (parent directory is auto-created). |
| `VAPID_SUBJECT` | `mailto:security@gallatinvalleychurch.org` | Contact email sent in Web Push VAPID headers. |
| `VAPID_PUBLIC_KEY` | *(optional)* | Auto-generated and saved in `./data/vapid.json` on first boot if left blank. |
| `VAPID_PRIVATE_KEY` | *(optional)* | Auto-generated and saved in `./data/vapid.json` on first boot if left blank. |
| `CLOUDFLARE_TUNNEL_TOKEN` | *(optional)* | Only needed if deploying with the optional `cloudflare` Docker Compose profile. |

---

## 3. Deployment Options

### Option A: Native Node.js + PM2 (or systemd) on Existing Web Server

```bash
git clone https://github.com/ryanundertrees/gvc_security_alerts.git gvc_security_alerts
cd gvc_security_alerts
npm install --omit=dev
cp .env.example .env
# Edit .env: set a strong TEAM_PIN and confirm VAPID_SUBJECT=mailto:security@gallatinvalleychurch.org
# (Optionally run `npm run setup` to generate VAPID keys into .env)
```

Start and persist with PM2:

```bash
pm2 start server.js --name gvc-security
pm2 save
```

*(Note: Because SQLite is embedded in-process, run a **single instance** — do not use PM2 cluster mode.)*

---

### Option B: Docker Compose (Single App Container Behind Church Proxy)

```bash
git clone https://github.com/ryanundertrees/gvc_security_alerts.git gvc_security_alerts
cd gvc_security_alerts
cp .env.example .env
# Edit .env: set TEAM_PIN and VAPID_SUBJECT
docker compose up -d --build
```

- Persists `./data` via volume mount (`./data:/app/data`).
- Exposes port `3000` for your reverse proxy (or change `ports` to `127.0.0.1:3000:3000`).
- *(If using a Cloudflare Tunnel instead of Nginx/Caddy, populate `CLOUDFLARE_TUNNEL_TOKEN` in `.env` and run `docker compose --profile cloudflare up -d --build`.)*

---

### Option C: Reverse Proxy Configuration (Required for Live SSE Alerts)

#### Nginx Snippet

`X-Accel-Buffering: no` is set by the server, and the `/api/events/` block below ensures Nginx never buffers or times out live SSE streams:

```nginx
server {
    listen 443 ssl http2;
    server_name alerts.gallatinvalleychurch.org;

    # ssl_certificate ...;
    # ssl_certificate_key ...;

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

#### Caddy Snippet

```caddy
alerts.gallatinvalleychurch.org {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

---

## 4. Updating the App From GitHub

`.env` and `./data/` are listed in `.gitignore`, so pulling updates from GitHub **never overwrites** your `TEAM_PIN`, VAPID push keys, active devices, or incident database:

```bash
cd gvc_security_alerts
git pull origin main
npm install --omit=dev

# Restart with PM2:
pm2 restart gvc-security

# OR restart with Docker:
docker compose up -d --build
```

---

## 5. Classroom iPad & Smartphone Setup Reference

Once live at `https://alerts.gallatinvalleychurch.org`:

- **Security Team Console:** `https://alerts.gallatinvalleychurch.org/`
  - **iOS (16.4+):** Team members must open the URL in **Safari**, tap **Share → Add to Home Screen**, open the installed Home Screen icon, unlock with `TEAM_PIN`, and tap **🔔 Enable Push**.
  - **Android (Chrome):** Open URL, install/Add to Home Screen, unlock, and tap **🔔 Enable Push**.
- **6 Official Classroom iPad Kiosks** *(open each in Safari → Share → Add to Home Screen; optional Guided Access lock)*:
  - `https://alerts.gallatinvalleychurch.org/room/sweet-grass-1`
  - `https://alerts.gallatinvalleychurch.org/room/sweet-grass-2`
  - `https://alerts.gallatinvalleychurch.org/room/bears-paw-1`
  - `https://alerts.gallatinvalleychurch.org/room/bears-paw-2`
  - `https://alerts.gallatinvalleychurch.org/room/pioneer-1`
  - `https://alerts.gallatinvalleychurch.org/room/pioneer-2`
