import { getStore } from '@netlify/blobs';
import webpushModule from 'web-push';

const webpush = webpushModule.default || webpushModule;

const TEAM_PIN = String(process.env.TEAM_PIN || '1234').trim();
const ON_DUTY_TIMEOUT_HOURS = Number(process.env.ON_DUTY_TIMEOUT_HOURS || 6);
const MAX_ON_DUTY_MS = ON_DUTY_TIMEOUT_HOURS * 60 * 60 * 1000;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:security@gallatinvalleychurch.org';

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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function readJsonBody(req) {
  try {
    const text = await req.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (_) {
    return {};
  }
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

function getActiveIncidents(incData) {
  return incData.incidents.filter((i) => i.status === 'active').sort((a, b) => b.id - a.id);
}

function getRecentResolvedIncidents(incData, limit = 8) {
  return incData.incidents
    .filter((i) => i.status === 'resolved')
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
}

function getLatestRoomIncident(incData, roomSlug) {
  const matches = incData.incidents
    .filter((i) => i.room_slug === roomSlug && i.source_type === 'classroom')
    .sort((a, b) => b.id - a.id);
  return matches[0] || null;
}

function getActiveBroadcastDirective(incData) {
  const matches = incData.incidents
    .filter((i) => i.status === 'active' && i.source_type === 'broadcast')
    .sort((a, b) => b.id - a.id);
  return matches[0] || null;
}

function pruneIncidentsForStorage(incData) {
  const active = incData.incidents.filter((i) => i.status === 'active');
  const resolved = incData.incidents
    .filter((i) => i.status === 'resolved')
    .sort((a, b) => b.id - a.id)
    .slice(0, 25);
  incData.incidents = [...active, ...resolved].sort((a, b) => a.id - b.id);
}

function pruneExpiredOnDuty(respData) {
  const cutoffMs = Date.now() - MAX_ON_DUTY_MS;
  const before = respData.onDutyResponders.length;
  respData.onDutyResponders = respData.onDutyResponders.filter((r) => {
    const t = Date.parse(r.logged_on_at);
    return !Number.isNaN(t) && t > cutoffMs;
  });
  return respData.onDutyResponders.length !== before;
}

async function loadIncidents(store) {
  const raw = await store.get('incidents', { type: 'json' });
  const incData = {
    nextIncidentId: 1,
    nextReplyId: 1,
    incidents: [],
    lastAllClear: null,
    ...(raw && typeof raw === 'object' ? raw : {})
  };
  if (!Array.isArray(incData.incidents)) incData.incidents = [];
  return incData;
}

async function saveIncidents(store, incData) {
  pruneIncidentsForStorage(incData);
  await store.setJSON('incidents', incData);
}

async function loadResponders(store) {
  const raw = await store.get('responders', { type: 'json' });
  const respData = {
    onDutyResponders: [],
    ...(raw && typeof raw === 'object' ? raw : {})
  };
  if (!Array.isArray(respData.onDutyResponders)) respData.onDutyResponders = [];
  const pruned = pruneExpiredOnDuty(respData);
  if (pruned) {
    await saveResponders(store, respData);
  }
  return respData;
}

async function saveResponders(store, respData) {
  respData.onDutyResponders.sort((a, b) => a.logged_on_at.localeCompare(b.logged_on_at));
  await store.setJSON('responders', respData);
}

async function loadSubscriptions(store) {
  const raw = await store.get('subscriptions', { type: 'json' });
  const subData = {
    subscriptions: [],
    ...(raw && typeof raw === 'object' ? raw : {})
  };
  if (!Array.isArray(subData.subscriptions)) subData.subscriptions = [];
  return subData;
}

async function saveSubscriptions(store, subData) {
  await store.setJSON('subscriptions', subData);
}

async function ensureVapid(store) {
  let publicKey = process.env.VAPID_PUBLIC_KEY || '';
  let privateKey = process.env.VAPID_PRIVATE_KEY || '';

  if (!publicKey || !privateKey) {
    const saved = await store.get('vapid', { type: 'json' });
    if (saved && saved.publicKey && saved.privateKey) {
      publicKey = saved.publicKey;
      privateKey = saved.privateKey;
    } else if (webpush && typeof webpush.generateVAPIDKeys === 'function') {
      const generated = webpush.generateVAPIDKeys();
      publicKey = generated.publicKey;
      privateKey = generated.privateKey;
      await store.setJSON('vapid', { publicKey, privateKey });
    }
  }

  let webPushConfigured = false;
  if (publicKey && privateKey && webpush) {
    try {
      webpush.setVapidDetails(VAPID_SUBJECT, publicKey, privateKey);
      webPushConfigured = true;
    } catch (err) {
      console.warn('[push] Could not configure VAPID keys:', err.message);
    }
  }

  return { publicKey, privateKey, webPushConfigured };
}

async function dispatchWebPushForIncident(store, vapid, incident, excludeDeviceId = '') {
  if (!vapid.webPushConfigured || !webpush) return { sent: 0, failed: 0 };

  const [respData, subData] = await Promise.all([
    loadResponders(store),
    loadSubscriptions(store)
  ]);

  const onDutyIds = new Set(respData.onDutyResponders.map((r) => r.device_id));
  const subscriptions = subData.subscriptions.filter((s) => onDutyIds.has(s.device_id));
  if (subscriptions.length === 0) return { sent: 0, failed: 0 };

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
  const expiredEndpoints = new Set();

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
          expiredEndpoints.add(sub.endpoint);
        }
      }
    })
  );

  if (expiredEndpoints.size > 0) {
    subData.subscriptions = subData.subscriptions.filter((s) => !expiredEndpoints.has(s.endpoint));
    await saveSubscriptions(store, subData);
  }

  return { sent, failed };
}

function getTeamPinFromRequest(req, url, body) {
  return String(
    req.headers.get('x-team-pin') ||
      url.searchParams.get('pin') ||
      (body && body.pin) ||
      ''
  ).trim();
}

function isAuthorized(req, url, body) {
  return getTeamPinFromRequest(req, url, body) === TEAM_PIN;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();

  // Strong consistency guarantees immediate visibility across edge locations for live alerts
  const store = getStore({
    name: 'gvc-security-state',
    consistency: 'strong'
  });
  const vapid = await ensureVapid(store);

  // GET /health
  if (method === 'GET' && pathname === '/health') {
    return jsonResponse({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      dbEngine: 'netlify-blobs',
      realtimeMode: 'poll',
      webPushConfigured: vapid.webPushConfigured
    });
  }

  // POST /api/auth/verify
  if (method === 'POST' && pathname === '/api/auth/verify') {
    const body = await readJsonBody(req);
    const pin = String((body && body.pin) || '').trim();
    if (pin !== TEAM_PIN) {
      return jsonResponse({ ok: false, error: 'Incorrect Team PIN' }, 401);
    }
    return jsonResponse({
      ok: true,
      vapidPublicKey: vapid.publicKey,
      realtimeMode: 'poll'
    });
  }

  // GET /api/rooms
  if (method === 'GET' && pathname === '/api/rooms') {
    return jsonResponse({
      classrooms: CLASSROOMS.map((r) => ({
        ...r,
        url: `/room/${r.slug}`
      }))
    });
  }

  // GET /api/rooms/:slug/manifest.json
  const roomManifestMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/manifest\.json$/);
  if (method === 'GET' && roomManifestMatch) {
    const roomSlug = decodeURIComponent(roomManifestMatch[1]).toLowerCase().trim();
    const roomName = formatSlugToRoomName(roomSlug);
    return jsonResponse({
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
  }

  // GET /api/events/* (Netlify uses polling instead of SSE)
  if (method === 'GET' && pathname.startsWith('/api/events/')) {
    return jsonResponse({ realtimeMode: 'poll' });
  }

  // GET /api/rooms/:slug/status
  const roomStatusMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/status$/);
  if (method === 'GET' && roomStatusMatch) {
    const roomSlug = decodeURIComponent(roomStatusMatch[1]).toLowerCase().trim();
    const roomName = formatSlugToRoomName(roomSlug);
    const incData = await loadIncidents(store);
    const latest = getLatestRoomIncident(incData, roomSlug);
    const activeIncident = latest && latest.status === 'active' ? sanitizeRoomIncident(latest) : null;
    const activeDirective = sanitizeBroadcastDirective(getActiveBroadcastDirective(incData));

    return jsonResponse({
      roomSlug,
      roomName,
      activeIncident,
      activeDirective,
      latestIncident: sanitizeRoomIncident(latest),
      realtimeMode: 'poll',
      serverTime: new Date().toISOString()
    });
  }

  // POST /api/rooms/:slug/alerts
  const roomAlertMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/alerts$/);
  if (method === 'POST' && roomAlertMatch) {
    const roomSlug = decodeURIComponent(roomAlertMatch[1]).toLowerCase().trim();
    const roomName = formatSlugToRoomName(roomSlug);
    const body = await readJsonBody(req);
    const {
      clientAlertId = null,
      alertType = 'Urgent Security',
      category = 'urgent',
      details = '',
      deviceId = ''
    } = body || {};

    const incData = await loadIncidents(store);
    if (clientAlertId) {
      const existing = incData.incidents.find((i) => i.client_alert_id === clientAlertId);
      if (existing) {
        return jsonResponse({
          ok: true,
          deduplicated: true,
          incident: sanitizeRoomIncident(existing)
        });
      }
    }

    const now = new Date().toISOString();
    const incident = {
      id: incData.nextIncidentId++,
      client_alert_id: clientAlertId || null,
      source_type: 'classroom',
      room_slug: roomSlug,
      room_name: roomName,
      alert_type: alertType,
      category,
      sender_name: roomName,
      sender_post: 'Classroom iPad',
      sender_device_id: deviceId || '',
      details: details || '',
      status: 'active',
      created_at: now,
      resolved_at: null,
      resolved_by: null,
      replies: []
    };

    incData.incidents.push(incident);
    await saveIncidents(store, incData);

    await dispatchWebPushForIncident(store, vapid, incident).catch((err) =>
      console.error('[push] Classroom push dispatch error:', err.message)
    );

    return jsonResponse(
      {
        ok: true,
        deduplicated: false,
        incident: sanitizeRoomIncident(incident)
      },
      201
    );
  }

  // POST /api/rooms/:slug/cancel
  const roomCancelMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/cancel$/);
  if (method === 'POST' && roomCancelMatch) {
    const roomSlug = decodeURIComponent(roomCancelMatch[1]).toLowerCase().trim();
    const roomName = formatSlugToRoomName(roomSlug);
    const incData = await loadIncidents(store);
    const latest = getLatestRoomIncident(incData, roomSlug);
    if (!latest || latest.status !== 'active') {
      return jsonResponse({ ok: true, incident: null });
    }

    const now = new Date().toISOString();
    latest.replies.push({
      id: incData.nextReplyId++,
      incident_id: latest.id,
      responder_name: roomName,
      responder_post: 'Classroom',
      responder_device_id: '',
      status_label: 'Resolved',
      note: 'Cancelled by classroom',
      created_at: now
    });
    latest.status = 'resolved';
    latest.resolved_at = now;
    latest.resolved_by = roomName;

    await saveIncidents(store, incData);

    return jsonResponse({
      ok: true,
      incident: sanitizeRoomIncident(latest)
    });
  }

  // Protected Security Team Endpoints (require TEAM_PIN)
  const body = method === 'GET' ? {} : await readJsonBody(req);
  if (!isAuthorized(req, url, body)) {
    return jsonResponse({ error: 'Invalid Team PIN' }, 401);
  }

  // GET /api/push/vapid-public-key
  if (method === 'GET' && pathname === '/api/push/vapid-public-key') {
    return jsonResponse({ publicKey: vapid.publicKey, configured: vapid.webPushConfigured });
  }

  // POST /api/push/subscribe
  if (method === 'POST' && pathname === '/api/push/subscribe') {
    const { deviceId, memberName = '', memberPost = '', subscription } = body || {};
    if (!deviceId || !subscription || !subscription.endpoint || !subscription.keys) {
      return jsonResponse({ error: 'deviceId and valid subscription are required' }, 400);
    }

    const subData = await loadSubscriptions(store);
    const now = new Date().toISOString();
    const idx = subData.subscriptions.findIndex((s) => s.device_id === deviceId);
    const record = {
      device_id: deviceId,
      member_name: memberName || '',
      member_post: memberPost || '',
      endpoint: subscription.endpoint,
      keys_p256dh: subscription.keys.p256dh,
      keys_auth: subscription.keys.auth,
      updated_at: now
    };
    if (idx >= 0) {
      subData.subscriptions[idx] = record;
    } else {
      subData.subscriptions.push(record);
    }
    await saveSubscriptions(store, subData);

    return jsonResponse({ ok: true });
  }

  // GET /api/incidents
  if (method === 'GET' && pathname === '/api/incidents') {
    const [incData, respData] = await Promise.all([
      loadIncidents(store),
      loadResponders(store)
    ]);
    const deviceId = String(url.searchParams.get('deviceId') || '').trim();
    const onDutyResponders = respData.onDutyResponders;
    const onDuty = deviceId
      ? onDutyResponders.some((r) => r.device_id === deviceId)
      : null;

    return jsonResponse({
      activeIncidents: getActiveIncidents(incData),
      recentResolved: getRecentResolvedIncidents(incData, 8),
      onDutyResponders,
      onDuty,
      lastAllClear: incData.lastAllClear || null,
      maxOnDutyMs: MAX_ON_DUTY_MS,
      realtimeMode: 'poll',
      vapidPublicKey: vapid.publicKey
    });
  }

  // POST /api/responders/checkin
  if (method === 'POST' && pathname === '/api/responders/checkin') {
    const { deviceId, responderName, location = '', freshLogin = false } = body || {};
    const cleanName = String(responderName || '').trim();
    if (!deviceId || !cleanName) {
      return jsonResponse({ error: 'deviceId and responderName are required' }, 400);
    }
    const cleanLocation = String(location || '').trim() || 'Roaming';
    const respData = await loadResponders(store);
    const now = new Date().toISOString();

    const idx = respData.onDutyResponders.findIndex((r) => r.device_id === deviceId);
    if (idx < 0) {
      respData.onDutyResponders.push({
        device_id: deviceId,
        responder_name: cleanName,
        location: cleanLocation,
        logged_on_at: now,
        updated_at: now
      });
    } else {
      const existing = respData.onDutyResponders[idx];
      const loggedOnAt =
        !freshLogin && existing.responder_name.toLowerCase() === cleanName.toLowerCase()
          ? existing.logged_on_at
          : now;
      respData.onDutyResponders[idx] = {
        device_id: deviceId,
        responder_name: cleanName,
        location: cleanLocation,
        logged_on_at: loggedOnAt,
        updated_at: now
      };
    }

    await saveResponders(store, respData);
    return jsonResponse({
      ok: true,
      onDutyResponders: respData.onDutyResponders,
      maxOnDutyMs: MAX_ON_DUTY_MS
    });
  }

  // POST /api/responders/checkout
  if (method === 'POST' && pathname === '/api/responders/checkout') {
    const { deviceId } = body || {};
    const respData = await loadResponders(store);
    if (deviceId) {
      respData.onDutyResponders = respData.onDutyResponders.filter((r) => r.device_id !== deviceId);
      await saveResponders(store, respData);
    }
    return jsonResponse({ ok: true, onDutyResponders: respData.onDutyResponders });
  }

  // POST /api/incidents
  if (method === 'POST' && pathname === '/api/incidents') {
    const {
      clientAlertId = null,
      alertType,
      category = 'security',
      senderName,
      senderPost = '',
      senderDeviceId = '',
      details = '',
      broadcastAllRooms = false,
      resolveAll = false
    } = body || {};

    if (!alertType || !senderName) {
      return jsonResponse({ error: 'alertType and senderName are required' }, 400);
    }

    const incData = await loadIncidents(store);
    const now = new Date().toISOString();

    if (resolveAll) {
      for (const inc of incData.incidents) {
        if (inc.status === 'active') {
          inc.replies.push({
            id: incData.nextReplyId++,
            incident_id: inc.id,
            responder_name: senderName,
            responder_post: senderPost || '',
            responder_device_id: senderDeviceId || '',
            status_label: 'Resolved',
            note: 'All Clear',
            created_at: now
          });
          inc.status = 'resolved';
          inc.resolved_at = now;
          inc.resolved_by = senderName;
        }
      }
    }

    if (clientAlertId) {
      const existing = incData.incidents.find((i) => i.client_alert_id === clientAlertId);
      if (existing) {
        return jsonResponse({
          ok: true,
          incident: existing,
          deduplicated: true,
          activeIncidents: getActiveIncidents(incData),
          recentResolved: getRecentResolvedIncidents(incData, 8)
        });
      }
    }

    const isVenueBroadcast =
      Boolean(broadcastAllRooms) || category === 'lockdown' || category === 'evacuate';
    const sourceType = isVenueBroadcast ? 'broadcast' : 'security';

    if (sourceType === 'broadcast') {
      for (const inc of incData.incidents) {
        if (inc.status === 'active' && inc.source_type === 'broadcast') {
          inc.status = 'resolved';
          inc.resolved_at = now;
          inc.resolved_by = senderName;
        }
      }
    }

    const incident = {
      id: incData.nextIncidentId++,
      client_alert_id: clientAlertId || null,
      source_type: sourceType,
      room_slug: null,
      room_name: null,
      alert_type: alertType,
      category,
      sender_name: senderName,
      sender_post: senderPost || '',
      sender_device_id: senderDeviceId || '',
      details: details || '',
      status: 'active',
      created_at: now,
      resolved_at: null,
      resolved_by: null,
      replies: []
    };

    incData.incidents.push(incident);
    incData.lastAllClear = null;
    await saveIncidents(store, incData);

    await dispatchWebPushForIncident(store, vapid, incident, senderDeviceId).catch((err) =>
      console.error('[push] Dispatch error:', err.message)
    );

    return jsonResponse(
      {
        ok: true,
        incident,
        deduplicated: false,
        activeIncidents: getActiveIncidents(incData),
        recentResolved: getRecentResolvedIncidents(incData, 8)
      },
      201
    );
  }

  // POST /api/incidents/all-clear
  if (method === 'POST' && pathname === '/api/incidents/all-clear') {
    const {
      senderName = 'Security Team',
      senderPost = '',
      senderDeviceId = ''
    } = body || {};

    const incData = await loadIncidents(store);
    const now = new Date().toISOString();
    const active = getActiveIncidents(incData);

    for (const inc of active) {
      inc.replies.push({
        id: incData.nextReplyId++,
        incident_id: inc.id,
        responder_name: senderName,
        responder_post: senderPost || '',
        responder_device_id: senderDeviceId || '',
        status_label: 'Resolved',
        note: 'All Clear',
        created_at: now
      });
      inc.status = 'resolved';
      inc.resolved_at = now;
      inc.resolved_by = senderName;
    }

    if (active.length === 0) {
      incData.incidents.push({
        id: incData.nextIncidentId++,
        client_alert_id: `allclear_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        source_type: 'security',
        room_slug: null,
        room_name: null,
        alert_type: 'All Clear',
        category: 'clear',
        sender_name: senderName,
        sender_post: senderPost || '',
        sender_device_id: senderDeviceId || '',
        details: 'Facility All Clear',
        status: 'resolved',
        created_at: now,
        resolved_at: now,
        resolved_by: senderName,
        replies: []
      });
    }

    incData.lastAllClear = {
      by: senderName,
      post: senderPost,
      at: now
    };

    await saveIncidents(store, incData);

    return jsonResponse({
      ok: true,
      activeIncidents: getActiveIncidents(incData),
      recentResolved: getRecentResolvedIncidents(incData, 8),
      allClear: incData.lastAllClear
    });
  }

  // POST /api/incidents/:id/replies
  const replyMatch = pathname.match(/^\/api\/incidents\/(\d+)\/replies$/);
  if (method === 'POST' && replyMatch) {
    const incidentId = Number(replyMatch[1]);
    const {
      responderName,
      responderPost = '',
      responderDeviceId = '',
      statusLabel,
      note = ''
    } = body || {};

    if (!responderName || !statusLabel) {
      return jsonResponse({ error: 'responderName and statusLabel are required' }, 400);
    }

    const incData = await loadIncidents(store);
    const incident = incData.incidents.find((i) => i.id === incidentId);
    if (!incident) {
      return jsonResponse({ error: 'Incident not found' }, 404);
    }

    const now = new Date().toISOString();
    incident.replies.push({
      id: incData.nextReplyId++,
      incident_id: incidentId,
      responder_name: responderName,
      responder_post: responderPost || '',
      responder_device_id: responderDeviceId || '',
      status_label: statusLabel,
      note: note || '',
      created_at: now
    });

    if (statusLabel.toLowerCase() === 'resolved') {
      incident.status = 'resolved';
      incident.resolved_at = now;
      incident.resolved_by = responderName;
    }

    await saveIncidents(store, incData);

    return jsonResponse({
      ok: true,
      incident,
      activeIncidents: getActiveIncidents(incData),
      recentResolved: getRecentResolvedIncidents(incData, 8)
    });
  }

  return jsonResponse({ error: 'Not Found' }, 404);
}

export const config = {
  path: ['/health', '/api/*']
};
