const fs = require('fs');
const path = require('path');
const http = require('http');

// Load .env via dotenv if installed, otherwise parse .env directly
try {
  require('dotenv').config();
} catch (_) {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
  }
}

let express = null;
try {
  express = require('express');
} catch (_) {
  express = null;
}

let webpush = null;
try {
  webpush = require('web-push');
} catch (_) {
  webpush = null;
}

const { initDatabase } = require('./db');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TEAM_PIN = String(process.env.TEAM_PIN || '1234').trim();
const ON_DUTY_TIMEOUT_HOURS = Number(process.env.ON_DUTY_TIMEOUT_HOURS || 6);
const MAX_ON_DUTY_MS = ON_DUTY_TIMEOUT_HOURS * 60 * 60 * 1000;
const DB_PATH = process.env.DB_PATH || './data/alerts.db';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:security@gallatinvalleychurch.org';
let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';

// Auto-generate and persist VAPID keys in ./data/vapid.json if missing in .env (zero-step Docker deploy)
if ((!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) && webpush && typeof webpush.generateVAPIDKeys === 'function') {
  try {
    const dataDir = path.dirname(path.resolve(DB_PATH));
    fs.mkdirSync(dataDir, { recursive: true });
    const vapidFile = path.join(dataDir, 'vapid.json');
    if (fs.existsSync(vapidFile)) {
      const saved = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
      VAPID_PUBLIC_KEY = saved.publicKey || '';
      VAPID_PRIVATE_KEY = saved.privateKey || '';
    } else {
      const generated = webpush.generateVAPIDKeys();
      VAPID_PUBLIC_KEY = generated.publicKey;
      VAPID_PRIVATE_KEY = generated.privateKey;
      fs.writeFileSync(vapidFile, JSON.stringify(generated, null, 2), 'utf8');
      console.log('[push] Auto-generated persistent VAPID keys in', vapidFile);
    }
  } catch (err) {
    console.warn('[push] Auto-VAPID fallback skipped:', err.message);
  }
}

let webPushConfigured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  if (webpush) {
    try {
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
      webPushConfigured = true;
    } catch (err) {
      console.warn('[push] Could not configure VAPID keys:', err.message);
    }
  } else {
    webPushConfigured = true;
  }
} else {
  console.warn('[push] VAPID keys missing. Run `npm run setup` to generate .env.');
}

const CLASSROOMS = [
  { slug: 'sweet-grass-1', name: 'Sweet Grass 1' },
  { slug: 'sweet-grass-2', name: 'Sweet Grass 2' },
  { slug: 'bears-paw-1', name: 'Bears Paw 1' },
  { slug: 'bears-paw-2', name: 'Bears Paw 2' },
  { slug: 'pioneer-1', name: 'Pioneer 1' },
  { slug: 'pioneer-2', name: 'Pioneer 2' }
];

const CLASSROOM_MAP = Object.fromEntries(CLASSROOMS.map((r) => [r.slug, r.name]));

function formatSlugToRoomName(slug) {
  const clean = String(slug || '').trim().toLowerCase();
  if (CLASSROOM_MAP[clean]) {
    return CLASSROOM_MAP[clean];
  }
  return clean
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function sanitizeBroadcastDirective(incident) {
  if (!incident || incident.status !== 'active') return null;
  return {
    id: incident.id,
    alert_type: incident.alert_type,
    category: incident.category,
    sender_name: incident.sender_name,
    sender_post: incident.sender_post,
    created_at: incident.created_at,
    status: incident.status
  };
}

function sanitizeRoomIncident(incident) {
  if (!incident) return null;
  return {
    id: incident.id,
    client_alert_id: incident.client_alert_id,
    room_slug: incident.room_slug,
    room_name: incident.room_name,
    alert_type: incident.alert_type,
    category: incident.category,
    status: incident.status,
    created_at: incident.created_at,
    resolved_at: incident.resolved_at,
    resolved_by: incident.resolved_by,
    replies: (incident.replies || []).map((r) => ({
      id: r.id,
      responder_name: r.responder_name,
      responder_post: r.responder_post,
      status_label: r.status_label,
      note: r.note,
      created_at: r.created_at
    }))
  };
}

// Lightweight Express-compatible fallback router when `express` package is not installed
function createFallbackApp(publicDir) {
  const routes = [];

  function compilePattern(pattern) {
    const paramNames = [];
    const regexStr =
      '^' +
      pattern.replace(/:([a-zA-Z0-9_]+)/g, (_m, name) => {
        paramNames.push(name);
        return '([^/]+)';
      }) +
      '$';
    return { regex: new RegExp(regexStr), paramNames };
  }

  function addRoute(method, pattern, handlers) {
    const { regex, paramNames } = compilePattern(pattern);
    routes.push({ method, regex, paramNames, handlers });
  }

  const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  };

  function enhanceReqRes(req, res, parsedUrl) {
    req.path = parsedUrl.pathname;
    req.query = Object.fromEntries(parsedUrl.searchParams.entries());
    req.params = {};

    res.status = function (code) {
      res.statusCode = code;
      return res;
    };
    res.json = function (obj) {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      res.end(JSON.stringify(obj));
      return res;
    };
    res.sendFile = function (filePath) {
      try {
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const content = fs.readFileSync(filePath);
        res.setHeader('Content-Type', contentType);
        res.end(content);
      } catch (_) {
        res.statusCode = 404;
        res.end('Not Found');
      }
    };
  }

  function parseJsonBody(req) {
    return new Promise((resolve) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        req.body = {};
        return resolve();
      }
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) {
          req.body = {};
          return resolve();
        }
        try {
          req.body = JSON.parse(raw);
        } catch (_) {
          req.body = {};
        }
        resolve();
      });
      req.on('error', () => {
        req.body = {};
        resolve();
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    enhanceReqRes(req, res, parsedUrl);
    await parseJsonBody(req);

    // Match registered routes first
    for (const r of routes) {
      if (r.method === req.method) {
        const match = parsedUrl.pathname.match(r.regex);
        if (match) {
          req.params = {};
          r.paramNames.forEach((name, idx) => {
            req.params[name] = decodeURIComponent(match[idx + 1]);
          });
          let idx = 0;
          const next = () => {
            const fn = r.handlers[idx++];
            if (fn) fn(req, res, next);
          };
          next();
          return;
        }
      }
    }

    // Serve static files from publicDir
    if (req.method === 'GET' || req.method === 'HEAD') {
      const safeRel = path.normalize(parsedUrl.pathname).replace(/^(\.\.(\/|\\|$))+/, '');
      const candidate = path.join(publicDir, safeRel);
      if (
        candidate.startsWith(publicDir) &&
        fs.existsSync(candidate) &&
        fs.statSync(candidate).isFile()
      ) {
        return res.sendFile(candidate);
      }
    }

    res.status(404).json({ error: 'Not Found' });
  });

  return {
    use() {},
    get(pattern, ...handlers) {
      addRoute('GET', pattern, handlers);
    },
    post(pattern, ...handlers) {
      addRoute('POST', pattern, handlers);
    },
    set() {},
    listen(...listenArgs) {
      return server.listen(...listenArgs);
    }
  };
}

async function startServer() {
  const db = await initDatabase(DB_PATH);
  const publicDir = path.join(__dirname, 'public');
  const app = express ? express() : createFallbackApp(publicDir);

  if (express) {
    if (typeof app.set === 'function') {
      app.set('trust proxy', 1);
    }
    app.use(express.json());
    app.use(express.static(publicDir));
  }

  // SSE Client pools
  // securityClients: Set<{ res, deviceId }>
  const securityClients = new Set();
  const roomClients = new Map();

  function sendSse(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function broadcastToSecurity(event, payload, { requireOnDuty = true } = {}) {
    const onDutyIds = requireOnDuty
      ? new Set(db.getOnDutyResponders().map((r) => r.device_id))
      : null;

    for (const client of securityClients) {
      if (requireOnDuty && (!client.deviceId || !onDutyIds.has(client.deviceId))) {
        continue;
      }
      try {
        sendSse(client.res, event, payload);
      } catch (_) {
        securityClients.delete(client);
      }
    }
  }

  function evictLockedOrExpiredClients(deviceIds, reason) {
    const idSet = new Set(deviceIds || []);
    if (idSet.size === 0) return;
    for (const client of securityClients) {
      if (client.deviceId && idSet.has(client.deviceId)) {
        try {
          sendSse(client.res, 'session_locked', { reason });
          client.res.end();
        } catch (_) {
          // Ignore write errors
        }
        securityClients.delete(client);
      }
    }
  }

  function broadcastToRoom(roomSlug, event, payload) {
    if (!roomSlug) return;
    const slug = String(roomSlug).toLowerCase();
    const clients = roomClients.get(slug);
    if (!clients) return;
    for (const client of clients) {
      try {
        sendSse(client, event, payload);
      } catch (_) {
        clients.delete(client);
      }
    }
  }

  function broadcastToAllRooms(event, payload) {
    for (const [, clients] of roomClients.entries()) {
      for (const client of clients) {
        try {
          sendSse(client, event, payload);
        } catch (_) {
          clients.delete(client);
        }
      }
    }
  }

  function broadcastStateUpdate(incident, eventType = 'incident_update') {
    broadcastToSecurity(eventType, {
      incident,
      activeIncidents: db.getActiveIncidents(),
      recentResolved: db.getRecentResolvedIncidents(8)
    });

    if (incident && incident.room_slug) {
      broadcastToRoom(incident.room_slug, 'room_incident_update', {
        incident: sanitizeRoomIncident(incident)
      });
    }

    if (incident && incident.source_type === 'broadcast') {
      broadcastToAllRooms('venue_directive_update', {
        directive: sanitizeBroadcastDirective(db.getActiveBroadcastDirective())
      });
    }
  }

  async function dispatchWebPushForIncident(incident, excludeDeviceId = '') {
    if (!webPushConfigured || !webpush) return { sent: 0, failed: 0 };
    // ONLY send Web Push notifications to devices currently registered as On Duty (unlocked & within 6h limit)
    const subscriptions = db.getOnDutySubscriptions();
    const title =
      incident.source_type === 'classroom'
        ? `${incident.room_name}: ${incident.alert_type}`
        : incident.source_type === 'broadcast'
          ? `VENUE ${String(incident.alert_type).toUpperCase()}`
          : `${incident.alert_type}`;
    const body =
      incident.source_type === 'classroom'
        ? `Classroom help request from ${incident.room_name}${incident.details ? ` — ${incident.details}` : ''}`
        : incident.source_type === 'broadcast'
          ? `Venue-wide ${incident.alert_type} broadcast by ${incident.sender_name}${incident.sender_post ? ` (${incident.sender_post})` : ''}`
          : `Triggered by ${incident.sender_name}${incident.sender_post ? ` (${incident.sender_post})` : ''}${incident.details ? ` — ${incident.details}` : ''}`;

    const payload = JSON.stringify({
      title,
      body,
      incidentId: incident.id,
      category: incident.category,
      url: '/',
      timestamp: Date.now()
    });

    let sent = 0;
    let failed = 0;

    await Promise.all(
      subscriptions.map(async (sub) => {
        if (excludeDeviceId && sub.device_id === excludeDeviceId) {
          return;
        }
        const pushSub = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys_p256dh,
            auth: sub.keys_auth
          }
        };
        try {
          await webpush.sendNotification(pushSub, payload);
          sent += 1;
        } catch (err) {
          failed += 1;
          if (err.statusCode === 404 || err.statusCode === 410) {
            db.removeSubscriptionByEndpoint(sub.endpoint);
          }
        }
      })
    );

    return { sent, failed };
  }

  // Middleware to verify TEAM_PIN on security endpoints
  function requireTeamPin(req, res, next) {
    const pin = String(
      req.headers['x-team-pin'] || (req.query && req.query.pin) || (req.body && req.body.pin) || ''
    ).trim();
    if (pin !== TEAM_PIN) {
      return res.status(401).json({ error: 'Invalid Team PIN' });
    }
    next();
  }

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      dbEngine: db.engine,
      realtimeMode: 'sse',
      webPushConfigured
    });
  });

  // Verify PIN endpoint
  app.post('/api/auth/verify', (req, res) => {
    const pin = String((req.body && req.body.pin) || '').trim();
    if (pin !== TEAM_PIN) {
      return res.status(401).json({ ok: false, error: 'Incorrect Team PIN' });
    }
    return res.json({
      ok: true,
      vapidPublicKey: VAPID_PUBLIC_KEY
    });
  });

  // Public VAPID key lookup
  app.get('/api/push/vapid-public-key', requireTeamPin, (_req, res) => {
    res.json({ publicKey: VAPID_PUBLIC_KEY, configured: webPushConfigured });
  });

  // Save Web Push Subscription
  app.post('/api/push/subscribe', requireTeamPin, (req, res) => {
    try {
      const { deviceId, memberName, memberPost, subscription } = req.body || {};
      if (!deviceId || !subscription) {
        return res.status(400).json({ error: 'deviceId and subscription are required' });
      }
      db.saveSubscription({ deviceId, memberName, memberPost, subscription });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Security view initial state
  app.get('/api/incidents', requireTeamPin, (req, res) => {
    const onDutyResponders = db.getOnDutyResponders();
    const deviceId = String((req.query && req.query.deviceId) || '').trim();
    const onDuty = deviceId
      ? onDutyResponders.some((r) => r.device_id === deviceId)
      : null;

    res.json({
      activeIncidents: db.getActiveIncidents(),
      recentResolved: db.getRecentResolvedIncidents(8),
      onDutyResponders,
      onDuty,
      maxOnDutyMs: MAX_ON_DUTY_MS,
      realtimeMode: 'sse',
      vapidPublicKey: VAPID_PUBLIC_KEY
    });
  });

  // Register / Update On-Duty Responder
  app.post('/api/responders/checkin', requireTeamPin, (req, res) => {
    const { deviceId, responderName, location = '', freshLogin = false } = req.body || {};
    if (!deviceId || !responderName) {
      return res.status(400).json({ error: 'deviceId and responderName are required' });
    }
    const onDutyResponders = db.checkInResponder({
      deviceId,
      responderName,
      location,
      freshLogin: Boolean(freshLogin)
    });
    broadcastToSecurity('responders_update', { onDutyResponders });
    res.json({ ok: true, onDutyResponders, maxOnDutyMs: MAX_ON_DUTY_MS });
  });

  // Sign Off / Lock Responder (stops SSE + Web Push notifications until unlocked again)
  app.post('/api/responders/checkout', requireTeamPin, (req, res) => {
    const { deviceId } = req.body || {};
    const onDutyResponders = db.checkOutResponder(deviceId);
    if (deviceId) {
      evictLockedOrExpiredClients([deviceId], 'Console locked.');
    }
    broadcastToSecurity('responders_update', { onDutyResponders });
    res.json({ ok: true, onDutyResponders });
  });

  // Trigger preset alert from Security Team view (or All Clear)
  app.post('/api/incidents', requireTeamPin, async (req, res) => {
    const {
      clientAlertId,
      alertType,
      category = 'security',
      senderName,
      senderPost = '',
      senderDeviceId = '',
      details = '',
      broadcastAllRooms = false,
      resolveAll = false
    } = req.body || {};

    if (!alertType || !senderName) {
      return res.status(400).json({ error: 'alertType and senderName are required' });
    }

    if (resolveAll) {
      const resolvedList = db.resolveAllActive({
        responderName: senderName,
        responderPost: senderPost,
        responderDeviceId: senderDeviceId
      });
      for (const inc of resolvedList) {
        if (inc && inc.room_slug) {
          broadcastToRoom(inc.room_slug, 'room_incident_update', {
            incident: sanitizeRoomIncident(inc)
          });
        }
      }
      broadcastToAllRooms('venue_directive_update', { directive: null });
    }

    const isVenueBroadcast =
      Boolean(broadcastAllRooms) ||
      category === 'lockdown' ||
      category === 'evacuate';

    const { incident, deduplicated } = db.createIncident({
      clientAlertId: clientAlertId || null,
      sourceType: isVenueBroadcast ? 'broadcast' : 'security',
      roomSlug: null,
      roomName: null,
      alertType,
      category,
      senderName,
      senderPost,
      senderDeviceId,
      details
    });

    if (!deduplicated) {
      broadcastStateUpdate(incident, 'incident_created');
      dispatchWebPushForIncident(incident, senderDeviceId).catch((err) =>
        console.error('[push] Dispatch error:', err.message)
      );
    }

    res.status(deduplicated ? 200 : 201).json({
      ok: true,
      incident,
      deduplicated,
      activeIncidents: db.getActiveIncidents(),
      recentResolved: db.getRecentResolvedIncidents(8)
    });
  });

  // All Clear action: resolves all active notifications and returns console + rooms to All Clear
  app.post('/api/incidents/all-clear', requireTeamPin, (req, res) => {
    const {
      senderName = 'Security Team',
      senderPost = '',
      senderDeviceId = ''
    } = req.body || {};

    const resolvedList = db.resolveAllActive({
      responderName: senderName,
      responderPost: senderPost,
      responderDeviceId: senderDeviceId
    });

    for (const inc of resolvedList) {
      if (inc && inc.room_slug) {
        broadcastToRoom(inc.room_slug, 'room_incident_update', {
          incident: sanitizeRoomIncident(inc)
        });
      }
    }

    broadcastToAllRooms('venue_directive_update', { directive: null });

    const now = new Date().toISOString();
    const payload = {
      activeIncidents: db.getActiveIncidents(),
      recentResolved: db.getRecentResolvedIncidents(8),
      allClear: {
        by: senderName,
        post: senderPost,
        at: now
      }
    };

    broadcastToSecurity('incident_update', payload);

    res.json({
      ok: true,
      ...payload
    });
  });

  // 1-Tap Responder Reply or Custom Note (SSE only — no Web Push notification storm!)
  app.post('/api/incidents/:id/replies', requireTeamPin, (req, res) => {
    const incidentId = Number(req.params.id);
    const {
      responderName,
      responderPost = '',
      responderDeviceId = '',
      statusLabel,
      note = ''
    } = req.body || {};

    if (!responderName || !statusLabel) {
      return res.status(400).json({ error: 'responderName and statusLabel are required' });
    }

    const updatedIncident = db.addReply({
      incidentId,
      responderName,
      responderPost,
      responderDeviceId,
      statusLabel,
      note
    });

    if (!updatedIncident) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    // Update all open clients via SSE without sending Web Push
    broadcastStateUpdate(updatedIncident, 'incident_reply');

    res.json({
      ok: true,
      incident: updatedIncident,
      activeIncidents: db.getActiveIncidents(),
      recentResolved: db.getRecentResolvedIncidents(8)
    });
  });

  // Security Team SSE stream (ONLY permitted for unlocked, active on-duty devices)
  app.get('/api/events/security', requireTeamPin, (req, res) => {
    const deviceId = String((req.query && req.query.deviceId) || '').trim();
    if (!deviceId || !db.isDeviceOnDuty(deviceId)) {
      return res.status(403).json({
        error: 'Device is not registered on duty or session has locked after 6 hours.'
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const clientEntry = { res, deviceId };
    securityClients.add(clientEntry);

    sendSse(res, 'init', {
      activeIncidents: db.getActiveIncidents(),
      recentResolved: db.getRecentResolvedIncidents(8),
      onDutyResponders: db.getOnDutyResponders(),
      maxOnDutyMs: MAX_ON_DUTY_MS,
      timestamp: new Date().toISOString()
    });

    const heartbeat = setInterval(() => {
      if (!db.isDeviceOnDuty(deviceId)) {
        clearInterval(heartbeat);
        evictLockedOrExpiredClients(
          [deviceId],
          `Automatically locked after ${ON_DUTY_TIMEOUT_HOURS} hours on duty.`
        );
        return;
      }
      try {
        sendSse(res, 'heartbeat', { timestamp: new Date().toISOString() });
      } catch (_) {
        clearInterval(heartbeat);
        securityClients.delete(clientEntry);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      securityClients.delete(clientEntry);
    });
  });

  // Periodic background sweep to auto-expire & lock any responder after 6 hours on duty
  setInterval(() => {
    const expiredIds = db.pruneExpiredOnDuty();
    if (expiredIds.length > 0) {
      evictLockedOrExpiredClients(
        expiredIds,
        `Automatically locked after ${ON_DUTY_TIMEOUT_HOURS} hours on duty.`
      );
      broadcastToSecurity('responders_update', {
        onDutyResponders: db.getOnDutyResponders()
      });
    }
  }, 15000);

  // Official Classroom iPad Distributions list + per-room PWA manifest
  app.get('/api/rooms', (_req, res) => {
    res.json({
      classrooms: CLASSROOMS.map((r) => ({
        ...r,
        url: `/room/${r.slug}`
      }))
    });
  });

  app.get('/api/rooms/:slug/manifest.json', (req, res) => {
    const roomSlug = String(req.params.slug || '').toLowerCase().trim();
    const roomName = formatSlugToRoomName(roomSlug);
    res.json({
      name: `${roomName} — GVC Classroom Alert`,
      short_name: roomName,
      description: `Classroom Alert iPad Kiosk for ${roomName}`,
      start_url: `/room/${roomSlug}`,
      scope: `/room/${roomSlug}`,
      display: 'standalone',
      background_color: '#0b1120',
      theme_color: '#0f172a',
      orientation: 'any',
      icons: [
        {
          src: '/icons/icon.svg',
          sizes: '192x192 512x512',
          type: 'image/svg+xml',
          purpose: 'any maskable'
        }
      ]
    });
  });

  // Scoped Classroom API: Get current room identity & active incident + venue directive
  app.get('/api/rooms/:slug/status', (req, res) => {
    const roomSlug = String(req.params.slug || '').toLowerCase().trim();
    const roomName = formatSlugToRoomName(roomSlug);
    const latest = db.getLatestRoomIncident(roomSlug);
    const activeIncident = latest && latest.status === 'active' ? sanitizeRoomIncident(latest) : null;
    const activeDirective = sanitizeBroadcastDirective(db.getActiveBroadcastDirective());

    res.json({
      roomSlug,
      roomName,
      activeIncident,
      activeDirective,
      latestIncident: sanitizeRoomIncident(latest),
      realtimeMode: 'sse',
      serverTime: new Date().toISOString()
    });
  });

  // Scoped Classroom API: Trigger classroom help alert (with retry deduplication)
  app.post('/api/rooms/:slug/alerts', async (req, res) => {
    const roomSlug = String(req.params.slug || '').toLowerCase().trim();
    const roomName = formatSlugToRoomName(roomSlug);
    const {
      clientAlertId,
      alertType = 'Urgent Security',
      category = 'urgent',
      details = '',
      deviceId = ''
    } = req.body || {};

    const { incident, deduplicated } = db.createIncident({
      clientAlertId: clientAlertId || null,
      sourceType: 'classroom',
      roomSlug,
      roomName,
      alertType,
      category,
      senderName: roomName,
      senderPost: 'Classroom iPad',
      senderDeviceId: deviceId,
      details
    });

    if (!deduplicated) {
      broadcastStateUpdate(incident, 'incident_created');
      dispatchWebPushForIncident(incident).catch((err) =>
        console.error('[push] Classroom push dispatch error:', err.message)
      );
    }

    res.status(deduplicated ? 200 : 201).json({
      ok: true,
      deduplicated,
      incident: sanitizeRoomIncident(incident)
    });
  });

  // Scoped Classroom API: Teacher cancels their own active room alert
  app.post('/api/rooms/:slug/cancel', (req, res) => {
    const roomSlug = String(req.params.slug || '').toLowerCase().trim();
    const roomName = formatSlugToRoomName(roomSlug);
    const latest = db.getLatestRoomIncident(roomSlug);
    if (!latest || latest.status !== 'active') {
      return res.json({ ok: true, incident: null });
    }

    const updated = db.addReply({
      incidentId: latest.id,
      responderName: roomName,
      responderPost: 'Classroom',
      statusLabel: 'Resolved',
      note: 'Cancelled by classroom'
    });

    broadcastStateUpdate(updated, 'incident_reply');

    res.json({
      ok: true,
      incident: sanitizeRoomIncident(updated)
    });
  });

  // Scoped Classroom SSE stream (only receives this room's updates + heartbeat)
  app.get('/api/events/room/:slug', (req, res) => {
    const roomSlug = String(req.params.slug || '').toLowerCase().trim();
    const roomName = formatSlugToRoomName(roomSlug);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    if (!roomClients.has(roomSlug)) {
      roomClients.set(roomSlug, new Set());
    }
    roomClients.get(roomSlug).add(res);

    const latest = db.getLatestRoomIncident(roomSlug);
    const activeDirective = sanitizeBroadcastDirective(db.getActiveBroadcastDirective());
    sendSse(res, 'init', {
      roomSlug,
      roomName,
      incident: latest && latest.status === 'active' ? sanitizeRoomIncident(latest) : null,
      directive: activeDirective,
      timestamp: new Date().toISOString()
    });

    const heartbeat = setInterval(() => {
      try {
        sendSse(res, 'heartbeat', { timestamp: new Date().toISOString() });
      } catch (_) {
        clearInterval(heartbeat);
        roomClients.get(roomSlug)?.delete(res);
      }
    }, 10000);

    req.on('close', () => {
      clearInterval(heartbeat);
      roomClients.get(roomSlug)?.delete(res);
    });
  });

  // Route `/room/:slug` to the Classroom iPad view HTML
  app.get('/room/:slug', (_req, res) => {
    res.sendFile(path.join(publicDir, 'room.html'));
  });

  // Route `/` to the Security Team view HTML
  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.listen(PORT, HOST, () => {
    console.log(`[server] Church Venue Security & Classroom Alert PWA running at http://localhost:${PORT}`);
    console.log(`[server] Health check: http://localhost:${PORT}/health`);
  });
}

startServer().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
