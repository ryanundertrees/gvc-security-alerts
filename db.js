const fs = require('fs');
const path = require('path');

let NodeSqliteDatabaseSync = null;
try {
  ({ DatabaseSync: NodeSqliteDatabaseSync } = require('node:sqlite'));
} catch (_) {
  NodeSqliteDatabaseSync = null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_alert_id TEXT UNIQUE,
  source_type TEXT NOT NULL,
  room_slug TEXT,
  room_name TEXT,
  alert_type TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'security',
  sender_name TEXT NOT NULL,
  sender_post TEXT,
  sender_device_id TEXT,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  responder_name TEXT NOT NULL,
  responder_post TEXT,
  responder_device_id TEXT,
  status_label TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT UNIQUE NOT NULL,
  member_name TEXT,
  member_post TEXT,
  endpoint TEXT NOT NULL,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS on_duty_responders (
  device_id TEXT PRIMARY KEY,
  responder_name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'Roaming',
  logged_on_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_room_slug ON incidents(room_slug);
CREATE INDEX IF NOT EXISTS idx_replies_incident_id ON replies(incident_id);
`;

class NativeSqliteAdapter {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.engine = 'node:sqlite';
    this.db = new NodeSqliteDatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA_SQL);
  }

  run(sql, params = []) {
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return {
      lastInsertRowid: Number(result.lastInsertRowid || 0),
      changes: Number(result.changes || 0)
    };
  }

  get(sql, params = []) {
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params);
    return row ? { ...row } : null;
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params).map((r) => ({ ...r }));
  }
}

class SqlJsAdapter {
  constructor(dbPath, SQL) {
    this.dbPath = dbPath;
    this.engine = 'sql.js';
    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      this.db = new SQL.Database(fileBuffer);
    } else {
      this.db = new SQL.Database();
    }
    this.db.run('PRAGMA foreign_keys = ON;');
    this.db.run(SCHEMA_SQL);
    this.persist();
  }

  persist() {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  run(sql, params = []) {
    this.db.run(sql, params);
    const idRes = this.db.exec('SELECT last_insert_rowid() AS id, changes() AS changes');
    const lastInsertRowid = idRes[0]?.values?.[0]?.[0] ?? 0;
    const changes = idRes[0]?.values?.[0]?.[1] ?? 0;
    this.persist();
    return {
      lastInsertRowid: Number(lastInsertRowid),
      changes: Number(changes)
    };
  }

  get(sql, params = []) {
    const rows = this.all(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }
}

async function initDatabase(dbPath) {
  const resolvedPath = path.resolve(dbPath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let adapter;
  if (NodeSqliteDatabaseSync) {
    adapter = new NativeSqliteAdapter(resolvedPath);
  } else {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    adapter = new SqlJsAdapter(resolvedPath, SQL);
  }

  console.log(`[db] Initialized SQLite database at ${resolvedPath} (engine: ${adapter.engine})`);

  function hydrateIncident(incident) {
    if (!incident) return null;
    const replies = adapter.all(
      `SELECT id, incident_id, responder_name, responder_post, responder_device_id, status_label, note, created_at
       FROM replies
       WHERE incident_id = ?
       ORDER BY id ASC`,
      [incident.id]
    );
    return {
      ...incident,
      replies
    };
  }

  return {
    engine: adapter.engine,
    dbPath: resolvedPath,
    maxOnDutyMs: Number(process.env.ON_DUTY_TIMEOUT_HOURS || 6) * 60 * 60 * 1000,

    getActiveIncidents() {
      const incidents = adapter.all(
        `SELECT * FROM incidents
         WHERE status = 'active'
         ORDER BY id DESC`
      );
      return incidents.map(hydrateIncident);
    },

    getRecentResolvedIncidents(limit = 10) {
      const incidents = adapter.all(
        `SELECT * FROM incidents
         WHERE status = 'resolved'
         ORDER BY id DESC
         LIMIT ?`,
        [limit]
      );
      return incidents.map(hydrateIncident);
    },

    getIncidentById(id) {
      const incident = adapter.get(`SELECT * FROM incidents WHERE id = ?`, [Number(id)]);
      return hydrateIncident(incident);
    },

    getIncidentByClientAlertId(clientAlertId) {
      if (!clientAlertId) return null;
      const incident = adapter.get(`SELECT * FROM incidents WHERE client_alert_id = ?`, [clientAlertId]);
      return hydrateIncident(incident);
    },

    getLatestRoomIncident(roomSlug) {
      const incident = adapter.get(
        `SELECT * FROM incidents
         WHERE room_slug = ? AND source_type = 'classroom'
         ORDER BY id DESC
         LIMIT 1`,
        [roomSlug]
      );
      return hydrateIncident(incident);
    },

    getActiveBroadcastDirective() {
      const incident = adapter.get(
        `SELECT * FROM incidents
         WHERE status = 'active' AND source_type = 'broadcast'
         ORDER BY id DESC
         LIMIT 1`
      );
      return hydrateIncident(incident);
    },

    createIncident({
      clientAlertId = null,
      sourceType = 'security',
      roomSlug = null,
      roomName = null,
      alertType,
      category = 'security',
      senderName,
      senderPost = '',
      senderDeviceId = '',
      details = ''
    }) {
      if (clientAlertId) {
        const existing = this.getIncidentByClientAlertId(clientAlertId);
        if (existing) {
          return { incident: existing, deduplicated: true };
        }
      }

      const now = new Date().toISOString();

      // Ensure only one active venue-wide broadcast directive exists at a time
      if (sourceType === 'broadcast') {
        adapter.run(
          `UPDATE incidents
           SET status = 'resolved', resolved_at = ?, resolved_by = ?
           WHERE status = 'active' AND source_type = 'broadcast'`,
          [now, senderName]
        );
      }

      const { lastInsertRowid } = adapter.run(
        `INSERT INTO incidents (
          client_alert_id, source_type, room_slug, room_name,
          alert_type, category, sender_name, sender_post, sender_device_id,
          details, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [
          clientAlertId,
          sourceType,
          roomSlug,
          roomName,
          alertType,
          category,
          senderName,
          senderPost || '',
          senderDeviceId || '',
          details || '',
          now
        ]
      );

      return {
        incident: this.getIncidentById(lastInsertRowid),
        deduplicated: false
      };
    },

    addReply({
      incidentId,
      responderName,
      responderPost = '',
      responderDeviceId = '',
      statusLabel,
      note = ''
    }) {
      const incident = this.getIncidentById(incidentId);
      if (!incident) return null;

      const now = new Date().toISOString();
      adapter.run(
        `INSERT INTO replies (
          incident_id, responder_name, responder_post, responder_device_id,
          status_label, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(incidentId),
          responderName,
          responderPost || '',
          responderDeviceId || '',
          statusLabel,
          note || '',
          now
        ]
      );

      if (statusLabel.toLowerCase() === 'resolved') {
        adapter.run(
          `UPDATE incidents
           SET status = 'resolved', resolved_at = ?, resolved_by = ?
           WHERE id = ?`,
          [now, responderName, Number(incidentId)]
        );
      }

      return this.getIncidentById(incidentId);
    },

    resolveAllActive({ responderName, responderPost = '', responderDeviceId = '' }) {
      const active = this.getActiveIncidents();
      const now = new Date().toISOString();
      const updated = [];
      for (const inc of active) {
        adapter.run(
          `INSERT INTO replies (
            incident_id, responder_name, responder_post, responder_device_id,
            status_label, note, created_at
          ) VALUES (?, ?, ?, ?, 'Resolved', 'All Clear', ?)`,
          [inc.id, responderName, responderPost || '', responderDeviceId || '', now]
        );
        adapter.run(
          `UPDATE incidents
           SET status = 'resolved', resolved_at = ?, resolved_by = ?
           WHERE id = ?`,
          [now, responderName, inc.id]
        );
        updated.push(this.getIncidentById(inc.id));
      }

      // Log an All Clear event directly in resolved history if nothing was active, or as summary
      if (active.length === 0) {
        adapter.run(
          `INSERT INTO incidents (
            client_alert_id, source_type, room_slug, room_name,
            alert_type, category, sender_name, sender_post, sender_device_id,
            details, status, created_at, resolved_at, resolved_by
          ) VALUES (?, 'security', NULL, NULL, 'All Clear', 'clear', ?, ?, ?, 'Facility All Clear', 'resolved', ?, ?, ?)`,
          [
            `allclear_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            responderName,
            responderPost || '',
            responderDeviceId || '',
            now,
            now,
            responderName
          ]
        );
      }

      return updated;
    },

    saveSubscription({ deviceId, memberName = '', memberPost = '', subscription }) {
      if (!subscription || !subscription.endpoint || !subscription.keys) {
        throw new Error('Invalid push subscription payload');
      }
      const now = new Date().toISOString();
      adapter.run(
        `INSERT INTO push_subscriptions (
          device_id, member_name, member_post, endpoint, keys_p256dh, keys_auth, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          member_name = excluded.member_name,
          member_post = excluded.member_post,
          endpoint = excluded.endpoint,
          keys_p256dh = excluded.keys_p256dh,
          keys_auth = excluded.keys_auth,
          updated_at = excluded.updated_at`,
        [
          deviceId,
          memberName || '',
          memberPost || '',
          subscription.endpoint,
          subscription.keys.p256dh,
          subscription.keys.auth,
          now
        ]
      );
    },

    removeSubscriptionByEndpoint(endpoint) {
      adapter.run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [endpoint]);
    },

    getAllSubscriptions() {
      return adapter.all(`SELECT * FROM push_subscriptions`);
    },

    getOnDutySubscriptions() {
      this.pruneExpiredOnDuty();
      return adapter.all(
        `SELECT ps.*
         FROM push_subscriptions ps
         INNER JOIN on_duty_responders odr
           ON ps.device_id = odr.device_id`
      );
    },

    pruneExpiredOnDuty(customMaxAgeMs) {
      const maxAge = typeof customMaxAgeMs === 'number' ? customMaxAgeMs : this.maxOnDutyMs;
      const cutoffIso = new Date(Date.now() - maxAge).toISOString();
      const expiredRows = adapter.all(
        `SELECT device_id, responder_name FROM on_duty_responders WHERE logged_on_at <= ?`,
        [cutoffIso]
      );
      if (expiredRows.length > 0) {
        adapter.run(`DELETE FROM on_duty_responders WHERE logged_on_at <= ?`, [cutoffIso]);
      }
      return expiredRows.map((r) => r.device_id);
    },

    checkInResponder({ deviceId, responderName, location = '', freshLogin = false }) {
      this.pruneExpiredOnDuty();
      const cleanName = String(responderName || '').trim();
      if (!deviceId || !cleanName) return this.getOnDutyResponders();
      const cleanLocation = String(location || '').trim() || 'Roaming';
      const now = new Date().toISOString();

      const existing = adapter.get(
        `SELECT * FROM on_duty_responders WHERE device_id = ?`,
        [deviceId]
      );

      if (!existing) {
        adapter.run(
          `INSERT INTO on_duty_responders (device_id, responder_name, location, logged_on_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [deviceId, cleanName, cleanLocation, now, now]
        );
      } else {
        const loggedOnAt =
          !freshLogin && existing.responder_name.toLowerCase() === cleanName.toLowerCase()
            ? existing.logged_on_at
            : now;
        adapter.run(
          `UPDATE on_duty_responders
           SET responder_name = ?, location = ?, logged_on_at = ?, updated_at = ?
           WHERE device_id = ?`,
          [cleanName, cleanLocation, loggedOnAt, now, deviceId]
        );
      }

      return this.getOnDutyResponders();
    },

    checkOutResponder(deviceId) {
      this.pruneExpiredOnDuty();
      if (deviceId) {
        adapter.run(`DELETE FROM on_duty_responders WHERE device_id = ?`, [deviceId]);
      }
      return this.getOnDutyResponders();
    },

    isDeviceOnDuty(deviceId) {
      if (!deviceId) return false;
      this.pruneExpiredOnDuty();
      const row = adapter.get(
        `SELECT device_id FROM on_duty_responders WHERE device_id = ?`,
        [deviceId]
      );
      return Boolean(row);
    },

    getOnDutyResponders() {
      this.pruneExpiredOnDuty();
      return adapter.all(
        `SELECT device_id, responder_name, location, logged_on_at, updated_at
         FROM on_duty_responders
         ORDER BY logged_on_at ASC`
      );
    }
  };
}

module.exports = { initDatabase };
