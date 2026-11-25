# GVC Security & Classroom Alert PWA

A self-contained Progressive Web App (PWA) for the Gallatin Valley Church (GVC) security team and Children's Ministry classrooms.

- **Production Subdomain:** `https://alerts.gallatinvalleychurch.org`
- **GitHub Repository:** `https://github.com/ryanundertrees/gvc_security_alerts`

---

## Features

- **Security Team Console (`/`)**
  - Protected by a shared `TEAM_PIN` entered on unlock, storing responder name, post, and device ID locally.
  - **Current Security Notification Block:** Priority-sorted active alerts (**LOCKDOWN / EVACUATE** → **Urgent** → **Medical** → **Eyes**), dynamic color-coded outer wrapper matching the top alert, live **Who Has Responded** roster, **EnRoute** and **Covering** quick-reply buttons, individual **Clear Alert** (1s hold), and **All Clear** (1s hold).
  - **Facility Alerts:** Five facility areas (**Foyer**, **Sanctuary**, **Lower Hallway**, **Upper Hallway**, **Parking Lot**) × 3 levels (**Urgent**, **Eyes**, **Medical**) with a 1-second press-and-hold safeguard.
  - **Emergency Venue Broadcast:** **LOCKDOWN** and **EVACUATE** (1s hold) broadcast immediately to all unlocked on-duty responders and all classroom iPads.
  - **On-Duty Responders & 6-Hour Auto-Lock:** Only unlocked, currently on-duty team members receive Web Push and live SSE alerts, with automatic sign-off/lock after 6 hours (`ON_DUTY_TIMEOUT_HOURS=6`).
- **Classroom iPad Kiosks (6 Official Room Distributions)**
  - Pre-baked room identity & dedicated per-room PWA manifest derived directly from each room's URL:
    - `/room/sweet-grass-1` → **Sweet Grass 1**
    - `/room/sweet-grass-2` → **Sweet Grass 2**
    - `/room/bears-paw-1` → **Bears Paw 1**
    - `/room/bears-paw-2` → **Bears Paw 2**
    - `/room/pioneer-1` → **Pioneer 1**
    - `/room/pioneer-2` → **Pioneer 2**
  - **Three Columnar 1-Second Press-and-Hold Buttons:** **Assistance** (yellow fade), **MEDICAL** (blue fade), and **URGENT** (red fade).
  - **Color-Matched `"Sent"` Wrapper & Live Responder Banner:** Matches the color of the alert pressed until a responder replies, then turns green with responder attribution and auto-resets to standby when cleared.
  - **Top-Half Emergency Directive Split:** Automatically displays **LOCKDOWN** or **EVACUATE** instructions in the top half above the three room buttons when broadcast by Security.
  - **Connection Resilience:** Heartbeat-backed *Connected* / *Reconnecting...* status badge plus a 2-second client retry queue with server-side deduplication.
- **Health Endpoint (`GET /health`)**
  - Returns HTTP `200` JSON (`{ "status": "ok", "uptime": ..., "dbEngine": "...", "webPushConfigured": true }`).

---

## Documentation

- **For the Church Web Developer:** See [DEVELOPER_HANDOFF.md](./DEVELOPER_HANDOFF.md) for hosting on `https://alerts.gallatinvalleychurch.org` (Node.js / PM2 / Docker + Nginx/Caddy reverse proxy + GitHub update workflow).
- **For the Project Owner (GitHub Upload & Updates):** See [GITHUB_WORKFLOW_GUIDE.md](./GITHUB_WORKFLOW_GUIDE.md).

---

## Quick Start (Local Development or Server)

```bash
npm install
npm run setup
npm start
```

- `npm run setup` creates `./data`, writes `.env` (default `TEAM_PIN=1234`) if missing, and generates VAPID keys.
- `npm run build` validates all JS/JSON syntax and required files.
- `npm run package` builds a clean GitHub release folder and zip in `./dist/`.
