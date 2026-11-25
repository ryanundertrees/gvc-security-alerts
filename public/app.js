(function () {
  const DEFAULT_MAX_ON_DUTY_MS = 6 * 60 * 60 * 1000; // 6 hours

  const STORAGE_KEYS = {
    PIN: 'gvc_team_pin',
    NAME: 'gvc_responder_name',
    POST: 'gvc_responder_post',
    DEVICE_ID: 'gvc_device_id',
    LOCKED: 'gvc_console_locked',
    MULTI_TAB: 'gvc_multi_tab_isolated'
  };

  const urlParams = new URLSearchParams(window.location.search);
  const queryResponder = (urlParams.get('responder') || '').trim();
  const queryPost = (urlParams.get('post') || '').trim();
  const isMultiResponderTab =
    Boolean(queryResponder) ||
    urlParams.get('multi') === '1' ||
    sessionStorage.getItem(STORAGE_KEYS.MULTI_TAB) === '1';

  if (isMultiResponderTab) {
    sessionStorage.setItem(STORAGE_KEYS.MULTI_TAB, '1');
    if (queryResponder && !sessionStorage.getItem(STORAGE_KEYS.NAME)) {
      sessionStorage.setItem(STORAGE_KEYS.NAME, queryResponder);
    }
    if (urlParams.has('post') && sessionStorage.getItem(STORAGE_KEYS.POST) === null) {
      sessionStorage.setItem(STORAGE_KEYS.POST, queryPost);
    }
    if (queryResponder || urlParams.has('post')) {
      window.history.replaceState({}, '', '/?multi=1');
    }
  }

  function getOrCreateDeviceId() {
    if (isMultiResponderTab) {
      let tabDevId = sessionStorage.getItem(STORAGE_KEYS.DEVICE_ID);
      if (!tabDevId) {
        tabDevId = 'tab_' + Math.random().toString(36).slice(2, 11) + '_' + Date.now().toString(36);
        sessionStorage.setItem(STORAGE_KEYS.DEVICE_ID, tabDevId);
      }
      return tabDevId;
    }
    let id = localStorage.getItem(STORAGE_KEYS.DEVICE_ID);
    if (!id) {
      id = 'dev_' + Math.random().toString(36).slice(2, 11) + '_' + Date.now().toString(36);
      localStorage.setItem(STORAGE_KEYS.DEVICE_ID, id);
    }
    return id;
  }

  function isTabLocked() {
    if (isMultiResponderTab) {
      return sessionStorage.getItem(STORAGE_KEYS.LOCKED) === '1';
    }
    return localStorage.getItem(STORAGE_KEYS.LOCKED) === '1';
  }

  function setTabLocked(locked) {
    if (isMultiResponderTab) {
      if (locked) sessionStorage.setItem(STORAGE_KEYS.LOCKED, '1');
      else sessionStorage.removeItem(STORAGE_KEYS.LOCKED);
    } else {
      if (locked) {
        localStorage.setItem(STORAGE_KEYS.LOCKED, '1');
        localStorage.removeItem(STORAGE_KEYS.PIN);
      } else {
        localStorage.removeItem(STORAGE_KEYS.LOCKED);
      }
    }
  }

  const state = {
    pin: isTabLocked() ? '' : localStorage.getItem(STORAGE_KEYS.PIN) || '',
    name: isMultiResponderTab
      ? sessionStorage.getItem(STORAGE_KEYS.NAME) || ''
      : sessionStorage.getItem(STORAGE_KEYS.NAME) || localStorage.getItem(STORAGE_KEYS.NAME) || '',
    post: isMultiResponderTab
      ? sessionStorage.getItem(STORAGE_KEYS.POST) || ''
      : sessionStorage.getItem(STORAGE_KEYS.POST) ?? localStorage.getItem(STORAGE_KEYS.POST) ?? '',
    deviceId: getOrCreateDeviceId(),
    maxOnDutyMs: DEFAULT_MAX_ON_DUTY_MS,
    myLoggedOnAt: null,
    autoLockTimeoutId: null,
    vapidPublicKey: '',
    activeIncidents: [],
    recentResolved: [],
    onDutyResponders: [],
    selectedIncidentId: null,
    lastAllClear: null,
    realtimeMode: 'sse',
    pollTimerId: null,
    lastRenderSig: '',
    sse: null,
    connected: true
  };

  // DOM Elements
  const currentNotificationBlock = document.getElementById('current-notification-block');
  const currentNotificationBadge = document.getElementById('current-notification-badge');
  const currentNotificationContent = document.getElementById('current-notification-content');
  const allClearBtn = document.getElementById('all-clear-btn');
  const onDutyList = document.getElementById('on-duty-list');
  const onDutyCountBadge = document.getElementById('on-duty-count-badge');
  const pinGate = document.getElementById('pin-gate');
  const consoleView = document.getElementById('console-view');
  const loginForm = document.getElementById('login-form');
  const pinInput = document.getElementById('pin-input');
  const loginNameInput = document.getElementById('login-name-input');
  const loginPostInput = document.getElementById('login-post-input');
  const loginError = document.getElementById('login-error');
  const lockReasonBanner = document.getElementById('lock-reason-banner');

  const displayResponderName = document.getElementById('display-responder-name');
  const displayResponderPost = document.getElementById('display-responder-post');
  const editProfileBtn = document.getElementById('edit-profile-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const profileEditor = document.getElementById('profile-editor');
  const profileForm = document.getElementById('profile-form');
  const responderNameInput = document.getElementById('responder-name-input');
  const responderPostInput = document.getElementById('responder-post-input');
  const cancelProfileBtn = document.getElementById('cancel-profile-btn');

  const presetGrid = document.getElementById('preset-grid');
  const activeIncidentsList = document.getElementById('active-incidents-list');
  const resolvedIncidentsList = document.getElementById('resolved-incidents-list');
  const activeCountBadge = document.getElementById('active-count-badge');
  const connBadge = document.getElementById('conn-badge');
  const connText = document.getElementById('conn-text');
  const pushBtn = document.getElementById('push-btn');

  function formatTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setConnectionStatus(isConnected) {
    state.connected = isConnected;
    if (isConnected) {
      connBadge.classList.remove('reconnecting');
      connText.textContent = 'Connected';
    } else {
      connBadge.classList.add('reconnecting');
      connText.textContent = 'Reconnecting...';
    }
  }

  function updateIdentityDisplay() {
    displayResponderName.textContent = state.name || 'Responder';
    displayResponderPost.textContent = state.post || 'Roaming';
    document.title = state.name
      ? `${state.name} — GVC Security Console`
      : 'GVC Security Team Console';
    responderNameInput.value = state.name || '';
    responderPostInput.value = state.post || '';
    loginNameInput.value = state.name || '';
    loginPostInput.value = state.post || '';

    if (!state.name) {
      profileEditor.classList.remove('hidden');
    }
  }

  async function apiFetch(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'x-team-pin': state.pin,
      ...(options.headers || {})
    };
    const res = await fetch(url, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function buildResponderRoster(replies) {
    if (!Array.isArray(replies) || replies.length === 0) return [];
    const byResponder = new Map();
    for (const r of replies) {
      const key = (r.responder_name || r.responder_device_id || '').trim().toLowerCase();
      const prev = byResponder.get(key);
      const statusLabel =
        r.status_label === 'Note' && prev && prev.status_label !== 'Note'
          ? prev.status_label
          : r.status_label;
      const note = r.note || (prev ? prev.note : '');
      byResponder.set(key, {
        responder_name: r.responder_name,
        responder_post: r.responder_post || (prev ? prev.responder_post : ''),
        status_label: statusLabel,
        note,
        created_at: r.created_at
      });
    }
    return Array.from(byResponder.values());
  }

  function normalizeAlertTier(inc) {
    const cat = String((inc && inc.category) || '').toLowerCase();
    const type = String((inc && inc.alert_type) || '').toLowerCase();
    if (cat === 'lockdown' || type.includes('lockdown')) {
      return 'lockdown';
    }
    if (cat === 'evacuate' || type.includes('evacuate')) {
      return 'evacuate';
    }
    if (cat === 'urgent' || cat === 'security' || type.includes('urgent')) {
      return 'urgent';
    }
    if (cat === 'medical' || type.includes('medical')) {
      return 'medical';
    }
    if (cat === 'eyes' || cat === 'warning' || type.includes('eyes') || type.includes('assistance')) {
      return 'eyes';
    }
    return 'urgent';
  }

  const TIER_PRIORITY = {
    lockdown: 0,
    evacuate: 0,
    urgent: 1,
    medical: 2,
    eyes: 3
  };

  function sortActiveIncidents(incidents) {
    return [...(incidents || [])].sort((a, b) => {
      const pa = TIER_PRIORITY[normalizeAlertTier(a)] ?? 99;
      const pb = TIER_PRIORITY[normalizeAlertTier(b)] ?? 99;
      if (pa !== pb) return pa - pb;
      return (b.id || 0) - (a.id || 0);
    });
  }

  function renderCurrentNotification() {
    if (!currentNotificationBlock || !currentNotificationContent) return;

    currentNotificationBlock.className = 'card current-notification-card';

    if (state.activeIncidents.length === 0) {
      currentNotificationBlock.classList.add('standby');
      currentNotificationBadge.className = 'notif-status-pill standby';
      currentNotificationBadge.textContent = 'All Clear';
      const subText = state.lastAllClear
        ? `All Clear issued by ${escapeHtml(state.lastAllClear.by)}${state.lastAllClear.post ? ` (${escapeHtml(state.lastAllClear.post)})` : ''} at ${formatTime(state.lastAllClear.at)}.`
        : 'Venue and classrooms are clear. Standing by.';
      currentNotificationContent.innerHTML = `
        <div class="current-notif-standby">
          <span class="standby-check">✓</span>
          <div>
            <div class="current-notif-headline">No Active Security Notifications</div>
            <div class="current-notif-sub">${subText}</div>
          </div>
        </div>
      `;
      return;
    }

    const sortedIncidents = sortActiveIncidents(state.activeIncidents);
    const topAlert = sortedIncidents[0];
    const topTier = normalizeAlertTier(topAlert);

    currentNotificationBlock.classList.add(`active-${topTier}`);

    currentNotificationBadge.className = `notif-status-pill tier-${topTier}`;
    currentNotificationBadge.textContent =
      sortedIncidents.length > 1
        ? `${sortedIncidents.length} Active Alerts`
        : '1 Active Alert';

    const itemsHtml = sortedIncidents
      .map((inc) => {
        const tier = normalizeAlertTier(inc);
        const isClassroom = inc.source_type === 'classroom';
        const isBroadcast = inc.source_type === 'broadcast' || tier === 'lockdown' || tier === 'evacuate';
        const sourceBadge = isClassroom
          ? `<span class="incident-source-tag classroom">Classroom • ${escapeHtml(inc.room_name)}</span>`
          : isBroadcast
            ? `<span class="incident-source-tag broadcast">All Rooms &amp; Security • ${escapeHtml(inc.sender_name)}${inc.sender_post ? ` (${escapeHtml(inc.sender_post)})` : ''}</span>`
            : `<span class="incident-source-tag">Security • ${escapeHtml(inc.sender_name)}${inc.sender_post ? ` (${escapeHtml(inc.sender_post)})` : ''}</span>`;

        const responders = buildResponderRoster(inc.replies);
        const respondersListHtml =
          responders.length > 0
            ? `<ul class="responders-list current-notif-responders-list">
                ${responders
                  .map(
                    (r) => `
                  <li class="responder-item">
                    <div class="responder-item-left">
                      <span class="reply-who">✓ ${escapeHtml(r.responder_name)}${r.responder_post ? ` (${escapeHtml(r.responder_post)})` : ''}</span>
                      <span class="responder-status-tag">${escapeHtml(r.status_label)}</span>
                      ${r.note ? `<span style="color: var(--text);">"${escapeHtml(r.note)}"</span>` : ''}
                    </div>
                    <span class="reply-time">${formatTime(r.created_at)}</span>
                  </li>`
                  )
                  .join('')}
              </ul>`
            : `<div class="no-responders-yet">No responders yet — awaiting team response.</div>`;

        return `
          <article class="active-alert-item category-${tier}" data-alert-card-id="${inc.id}">
            <div class="alert-item-header">
              <div>
                ${sourceBadge}
                <h3 class="current-notif-headline" style="margin-top: 6px;">
                  ${isClassroom ? `${escapeHtml(inc.room_name)} — ` : ''}${escapeHtml(inc.alert_type)}
                </h3>
                <div class="current-notif-sub">
                  Triggered by <strong>${escapeHtml(inc.sender_name)}</strong>${inc.sender_post ? ` • ${escapeHtml(inc.sender_post)}` : ''} at ${formatTime(inc.created_at)}
                  ${inc.details ? ` — ${escapeHtml(inc.details)}` : ''}
                </div>
              </div>
              <button
                type="button"
                class="btn-clear-single hold-action-btn"
                data-hold-type="clear-single"
                data-incident-id="${inc.id}"
                title="Press and hold 1 second to clear this alert"
              >
                <span class="hold-fill-overlay" aria-hidden="true"></span>
                <span class="hold-btn-label-wrap">Clear Alert <span class="hold-hint-mini">(1s)</span></span>
                <span class="hold-bar-bottom" aria-hidden="true"></span>
              </button>
            </div>

            <div class="current-notif-responders">
              <div class="responders-heading">
                <span>Who Has Responded</span>
                <span>${responders.length} ${responders.length === 1 ? 'Responder' : 'Responders'}</span>
              </div>
              ${respondersListHtml}
            </div>

            <div class="quick-reply-row two-col-replies">
              <button type="button" class="reply-btn" data-action="reply" data-incident-id="${inc.id}" data-status="EnRoute">
                EnRoute
              </button>
              <button type="button" class="reply-btn" data-action="reply" data-incident-id="${inc.id}" data-status="Covering">
                Covering
              </button>
            </div>
          </article>
        `;
      })
      .join('');

    currentNotificationContent.innerHTML = `<div class="active-alerts-stack">${itemsHtml}</div>`;
  }

  async function lockConsole(reasonMessage = '') {
    if (state.autoLockTimeoutId) {
      clearTimeout(state.autoLockTimeoutId);
      state.autoLockTimeoutId = null;
    }
    if (state.pollTimerId) {
      clearTimeout(state.pollTimerId);
      state.pollTimerId = null;
    }
    if (state.sse) {
      state.sse.close();
      state.sse = null;
    }

    const pinToUse = state.pin || localStorage.getItem(STORAGE_KEYS.PIN) || '';
    if (pinToUse) {
      try {
        await fetch('/api/responders/checkout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-team-pin': pinToUse
          },
          body: JSON.stringify({ deviceId: state.deviceId })
        });
      } catch (_) {
        // Ignore checkout network error on lock
      }
    }

    setTabLocked(true);
    state.pin = '';
    state.myLoggedOnAt = null;
    pinInput.value = '';

    consoleView.classList.add('hidden');
    pinGate.classList.remove('hidden');

    if (lockReasonBanner) {
      if (reasonMessage) {
        lockReasonBanner.textContent = reasonMessage;
        lockReasonBanner.classList.remove('hidden');
      } else {
        lockReasonBanner.classList.add('hidden');
      }
    }
  }

  function scheduleSixHourAutoLock() {
    if (state.autoLockTimeoutId) {
      clearTimeout(state.autoLockTimeoutId);
      state.autoLockTimeoutId = null;
    }
    const me = (state.onDutyResponders || []).find((r) => r.device_id === state.deviceId);
    if (!me || !me.logged_on_at) return;

    state.myLoggedOnAt = me.logged_on_at;
    const loggedMs = Date.parse(me.logged_on_at);
    if (Number.isNaN(loggedMs)) return;

    const remainingMs = loggedMs + state.maxOnDutyMs - Date.now();
    if (remainingMs <= 0) {
      lockConsole('Session automatically locked after 6 hours on duty. Re-enter Team PIN to check back in.');
      return;
    }

    // Set exact timer (capped safely under 32-bit signed int max)
    state.autoLockTimeoutId = setTimeout(() => {
      lockConsole('Session automatically locked after 6 hours on duty. Re-enter Team PIN to check back in.');
    }, Math.min(remainingMs, 2147483000));
  }

  function renderOnDutyResponders() {
    if (!onDutyList || !onDutyCountBadge) return;
    const list = Array.isArray(state.onDutyResponders) ? state.onDutyResponders : [];
    onDutyCountBadge.textContent = `${list.length} On Duty`;
    scheduleSixHourAutoLock();

    if (list.length === 0) {
      onDutyList.innerHTML = `<li class="empty-state">No responders currently registered on duty.</li>`;
      return;
    }

    onDutyList.innerHTML = list
      .map((r) => {
        const isMe = r.device_id === state.deviceId;
        const loc = r.location || 'Roaming';
        const autoLockIso = new Date(Date.parse(r.logged_on_at) + state.maxOnDutyMs).toISOString();
        return `
          <li class="on-duty-row" data-on-duty-device="${escapeHtml(r.device_id)}">
            <div class="on-duty-left">
              <span class="on-duty-dot" aria-hidden="true"></span>
              <span class="on-duty-name">${escapeHtml(r.responder_name)}${isMe ? ' <span style="font-weight: 500; font-size: 0.78rem; color: #34d399;">(You)</span>' : ''}</span>
              <span class="on-duty-location">${escapeHtml(loc)}</span>
            </div>
            <span class="on-duty-time">Logged on ${formatTime(r.logged_on_at)} • Locks ${formatTime(autoLockIso)}</span>
          </li>
        `;
      })
      .join('');
  }

  async function checkInOnDuty({ freshLogin = false } = {}) {
    if (!state.pin || !state.name) return;
    const data = await apiFetch('/api/responders/checkin', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: state.deviceId,
        responderName: state.name,
        location: state.post || 'Roaming',
        freshLogin
      })
    });
    if (typeof data.maxOnDutyMs === 'number') {
      state.maxOnDutyMs = data.maxOnDutyMs;
    }
    if (Array.isArray(data.onDutyResponders)) {
      state.onDutyResponders = data.onDutyResponders;
      renderOnDutyResponders();
    }
  }

  function computeStateSignature(src) {
    return JSON.stringify([
      src.activeIncidents || [],
      src.recentResolved || [],
      src.onDutyResponders || [],
      src.lastAllClear || null
    ]);
  }

  function renderIncidents() {
    state.lastRenderSig = computeStateSignature(state);
    renderCurrentNotification();
    renderOnDutyResponders();
    if (activeCountBadge) {
      activeCountBadge.textContent = `${state.activeIncidents.length} Active`;
    }

    if (activeIncidentsList) {
      if (state.activeIncidents.length === 0) {
        activeIncidentsList.innerHTML = `<div class="empty-state">No active incidents. Standing by.</div>`;
      } else {
        activeIncidentsList.innerHTML = '';
      }
    }

    if (state.recentResolved.length === 0) {
      resolvedIncidentsList.innerHTML = `<div class="empty-state">No resolved incidents yet.</div>`;
    } else {
      resolvedIncidentsList.innerHTML = state.recentResolved
        .map((inc) => {
          const isClassroom = inc.source_type === 'classroom';
          return `
            <article class="incident-card status-resolved" data-resolved-id="${inc.id}">
              <div class="incident-top">
                <div>
                  <strong style="font-size: 0.96rem;">
                    ✓ ${isClassroom ? `${escapeHtml(inc.room_name)}: ` : ''}${escapeHtml(inc.alert_type)}
                  </strong>
                  <div style="font-size: 0.8rem; color: var(--text-muted);">
                    Resolved by ${escapeHtml(inc.resolved_by || 'Team')} at ${formatTime(inc.resolved_at)}
                  </div>
                </div>
                <span style="font-size: 0.78rem; color: var(--text-muted);">${formatTime(inc.created_at)}</span>
              </div>
            </article>
          `;
        })
        .join('');
    }
  }

  function connectSse() {
    if (state.sse) {
      state.sse.close();
    }
    if (!state.pin || !state.name) return;
    const url = `/api/events/security?pin=${encodeURIComponent(state.pin)}&deviceId=${encodeURIComponent(state.deviceId)}`;
    const es = new EventSource(url);
    state.sse = es;

    es.onopen = () => {
      setConnectionStatus(true);
    };

    es.addEventListener('init', (e) => {
      setConnectionStatus(true);
      const data = JSON.parse(e.data);
      state.activeIncidents = data.activeIncidents || [];
      state.recentResolved = data.recentResolved || [];
      if (Array.isArray(data.onDutyResponders)) {
        state.onDutyResponders = data.onDutyResponders;
      }
      renderIncidents();
    });

    es.addEventListener('responders_update', (e) => {
      setConnectionStatus(true);
      const data = JSON.parse(e.data);
      if (Array.isArray(data.onDutyResponders)) {
        state.onDutyResponders = data.onDutyResponders;
        const stillOnDuty = state.onDutyResponders.some((r) => r.device_id === state.deviceId);
        if (!stillOnDuty && state.pin) {
          lockConsole('Session locked or expired after 6 hours on duty.');
          return;
        }
        renderOnDutyResponders();
      }
    });

    es.addEventListener('session_locked', (e) => {
      let reason = 'Session automatically locked after 6 hours on duty.';
      try {
        const data = JSON.parse(e.data);
        if (data && data.reason) reason = data.reason;
      } catch (_) {}
      lockConsole(reason);
    });

    const handleStateEvent = (e) => {
      setConnectionStatus(true);
      const data = JSON.parse(e.data);
      if (Array.isArray(data.activeIncidents)) {
        state.activeIncidents = data.activeIncidents;
      }
      if (Array.isArray(data.recentResolved)) {
        state.recentResolved = data.recentResolved;
      }
      if (data.allClear) {
        state.lastAllClear = data.allClear;
      } else if (state.activeIncidents.length > 0) {
        state.lastAllClear = null;
      }
      renderIncidents();
    };

    es.addEventListener('incident_created', handleStateEvent);
    es.addEventListener('incident_reply', handleStateEvent);
    es.addEventListener('incident_update', handleStateEvent);

    es.addEventListener('heartbeat', () => {
      setConnectionStatus(true);
    });

    es.onerror = () => {
      setConnectionStatus(false);
    };
  }

  async function pollSecurityState() {
    if (state.pollTimerId) {
      clearTimeout(state.pollTimerId);
      state.pollTimerId = null;
    }
    if (state.realtimeMode !== 'poll' || !state.pin || !state.name) return;

    if (!document.hidden) {
      try {
        const data = await apiFetch(
          `/api/incidents?deviceId=${encodeURIComponent(state.deviceId)}`
        );
        setConnectionStatus(true);
        if (data.onDuty === false) {
          lockConsole('Session locked or expired after 6 hours on duty.');
          return;
        }
        const nextAllClear =
          data.lastAllClear !== undefined
            ? data.lastAllClear
            : (data.activeIncidents || []).length > 0
              ? null
              : state.lastAllClear;
        const sig = computeStateSignature({
          activeIncidents: data.activeIncidents || [],
          recentResolved: data.recentResolved || [],
          onDutyResponders: data.onDutyResponders || [],
          lastAllClear: nextAllClear
        });
        if (sig !== state.lastRenderSig) {
          state.activeIncidents = data.activeIncidents || [];
          state.recentResolved = data.recentResolved || [];
          state.onDutyResponders = data.onDutyResponders || [];
          state.lastAllClear = nextAllClear;
          renderIncidents();
        }
      } catch (err) {
        if (err.status === 401) {
          lockConsole('Session locked. Please re-enter Team PIN.');
          return;
        }
        setConnectionStatus(false);
      }
    }

    if (state.realtimeMode === 'poll' && state.pin && state.name && !document.hidden) {
      state.pollTimerId = setTimeout(pollSecurityState, 3000);
    }
  }

  function startSecurityPolling() {
    if (state.sse) {
      state.sse.close();
      state.sse = null;
    }
    if (state.pollTimerId) {
      clearTimeout(state.pollTimerId);
      state.pollTimerId = null;
    }
    if (!document.hidden && state.pin && state.name) {
      state.pollTimerId = setTimeout(pollSecurityState, 3000);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.realtimeMode === 'poll' && state.pin && state.name) {
      pollSecurityState();
    }
  });

  async function loadInitialConsole({ freshLogin = false } = {}) {
    if (!state.name) {
      pinGate.classList.remove('hidden');
      consoleView.classList.add('hidden');
      return;
    }

    try {
      await checkInOnDuty({ freshLogin });
      const data = await apiFetch(
        `/api/incidents?deviceId=${encodeURIComponent(state.deviceId)}`
      );
      state.activeIncidents = data.activeIncidents || [];
      state.recentResolved = data.recentResolved || [];
      state.onDutyResponders = data.onDutyResponders || state.onDutyResponders;
      if (data.lastAllClear !== undefined) {
        state.lastAllClear = data.lastAllClear;
      }
      if (typeof data.maxOnDutyMs === 'number') {
        state.maxOnDutyMs = data.maxOnDutyMs;
      }
      state.realtimeMode = data.realtimeMode || 'sse';
      state.vapidPublicKey = data.vapidPublicKey || '';

      if (lockReasonBanner) lockReasonBanner.classList.add('hidden');
      pinGate.classList.add('hidden');
      consoleView.classList.remove('hidden');
      updateIdentityDisplay();
      renderIncidents();
      if (state.realtimeMode === 'poll') {
        startSecurityPolling();
      } else {
        connectSse();
      }
      setupServiceWorkerAndPush();
    } catch (err) {
      if (err.status === 401) {
        setTabLocked(true);
        state.pin = '';
        pinGate.classList.remove('hidden');
        consoleView.classList.add('hidden');
      }
    }
  }

  // Handle Login
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.classList.add('hidden');
    const pin = pinInput.value.trim();
    const enteredName = loginNameInput.value.trim();
    const enteredPost = loginPostInput.value.trim();

    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Incorrect Team PIN');
      }

      state.pin = pin;
      setTabLocked(false);
      localStorage.setItem(STORAGE_KEYS.PIN, pin);

      if (enteredName) {
        state.name = enteredName;
        sessionStorage.setItem(STORAGE_KEYS.NAME, enteredName);
        if (!isMultiResponderTab) {
          localStorage.setItem(STORAGE_KEYS.NAME, enteredName);
        }
      }
      if (enteredPost || enteredPost === '') {
        state.post = enteredPost;
        sessionStorage.setItem(STORAGE_KEYS.POST, enteredPost);
        if (!isMultiResponderTab) {
          localStorage.setItem(STORAGE_KEYS.POST, enteredPost);
        }
      }

      await loadInitialConsole({ freshLogin: true });
    } catch (err) {
      loginError.textContent = err.message;
      loginError.classList.remove('hidden');
    }
  });

  // Handle Responder Identity Edit
  editProfileBtn.addEventListener('click', () => {
    responderNameInput.value = state.name || '';
    responderPostInput.value = state.post || '';
    profileEditor.classList.toggle('hidden');
  });

  cancelProfileBtn.addEventListener('click', () => {
    profileEditor.classList.add('hidden');
  });

  profileForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const newName = responderNameInput.value.trim();
    const newPost = responderPostInput.value.trim();
    if (!newName) return;

    state.name = newName;
    state.post = newPost;
    sessionStorage.setItem(STORAGE_KEYS.NAME, newName);
    sessionStorage.setItem(STORAGE_KEYS.POST, newPost);
    if (!isMultiResponderTab) {
      localStorage.setItem(STORAGE_KEYS.NAME, newName);
      localStorage.setItem(STORAGE_KEYS.POST, newPost);
    }
    updateIdentityDisplay();
    profileEditor.classList.add('hidden');
    checkInOnDuty();
  });

  logoutBtn.addEventListener('click', () => {
    lockConsole('Console locked — you are signed off duty and notifications are paused.');
  });

  // 1-Second Press-and-Hold Engine for all Alert & Clear buttons
  const HOLD_DURATION_MS = 1000;
  let activeHoldMeta = null;
  let holdTimerId = null;

  function findHoldButton(meta) {
    if (!meta) return null;
    if (meta.type === 'all-clear') {
      return document.getElementById('all-clear-btn');
    }
    if (meta.type === 'clear-single') {
      return document.querySelector(
        `button[data-hold-type="clear-single"][data-incident-id="${meta.incidentId}"]`
      );
    }
    if (meta.type === 'preset') {
      return meta.element;
    }
    return null;
  }

  function updateHoldVisual(btn, fraction) {
    if (!btn) return;
    const pct = Math.max(0, Math.min(100, fraction * 100));
    const fill = btn.querySelector('.hold-fill-overlay');
    const bar = btn.querySelector('.hold-bar-bottom');
    if (fill) fill.style.width = `${pct}%`;
    if (bar) bar.style.width = `${pct}%`;
  }

  function resetHoldVisual(btn) {
    if (!btn) return;
    btn.classList.remove('is-holding');
    const fill = btn.querySelector('.hold-fill-overlay');
    const bar = btn.querySelector('.hold-bar-bottom');
    if (fill) fill.style.width = '0%';
    if (bar) bar.style.width = '0%';
  }

  async function executeAllClear() {
    if (!state.name) {
      profileEditor.classList.remove('hidden');
      responderNameInput.focus();
      return;
    }
    if (allClearBtn) allClearBtn.disabled = true;
    try {
      const data = await apiFetch('/api/incidents/all-clear', {
        method: 'POST',
        body: JSON.stringify({
          senderName: state.name,
          senderPost: state.post,
          senderDeviceId: state.deviceId
        })
      });
      state.activeIncidents = data.activeIncidents || [];
      state.recentResolved = data.recentResolved || state.recentResolved;
      if (data.allClear) {
        state.lastAllClear = data.allClear;
      }
      renderIncidents();
    } catch (err) {
      console.error('Failed to issue All Clear:', err);
    } finally {
      if (allClearBtn) allClearBtn.disabled = false;
    }
  }

  async function executePresetAlert(alertType, category, broadcastAllRooms, btn) {
    if (!state.name) {
      profileEditor.classList.remove('hidden');
      responderNameInput.focus();
      return;
    }
    const clientAlertId = 'sec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    if (btn) btn.disabled = true;
    try {
      const data = await apiFetch('/api/incidents', {
        method: 'POST',
        body: JSON.stringify({
          clientAlertId,
          alertType,
          category,
          broadcastAllRooms: Boolean(broadcastAllRooms),
          senderName: state.name,
          senderPost: state.post,
          senderDeviceId: state.deviceId
        })
      });
      state.activeIncidents = data.activeIncidents || state.activeIncidents;
      state.recentResolved = data.recentResolved || state.recentResolved;
      state.lastAllClear = null;
      renderIncidents();
    } catch (err) {
      console.error('Failed to trigger preset alert:', err);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function executeClearSingle(incidentId, btn) {
    if (!state.name) {
      profileEditor.classList.remove('hidden');
      responderNameInput.focus();
      return;
    }
    if (btn) btn.disabled = true;
    try {
      const data = await apiFetch(`/api/incidents/${incidentId}/replies`, {
        method: 'POST',
        body: JSON.stringify({
          responderName: state.name,
          responderPost: state.post,
          responderDeviceId: state.deviceId,
          statusLabel: 'Resolved'
        })
      });
      state.activeIncidents = data.activeIncidents || state.activeIncidents;
      state.recentResolved = data.recentResolved || state.recentResolved;
      renderIncidents();
    } catch (err) {
      console.error('Failed to clear alert:', err);
      if (btn) btn.disabled = false;
    }
  }

  function cancelActiveHold() {
    if (holdTimerId) {
      clearInterval(holdTimerId);
      holdTimerId = null;
    }
    if (activeHoldMeta) {
      const btn = findHoldButton(activeHoldMeta);
      resetHoldVisual(btn);
      resetHoldVisual(activeHoldMeta.element);
      activeHoldMeta = null;
    }
  }

  function completeActiveHold() {
    const meta = activeHoldMeta;
    cancelActiveHold();
    if (!meta) return;

    if (meta.type === 'all-clear') {
      executeAllClear();
    } else if (meta.type === 'preset') {
      executePresetAlert(meta.alertType, meta.category, meta.broadcastAllRooms, meta.element);
    } else if (meta.type === 'clear-single') {
      executeClearSingle(meta.incidentId, findHoldButton(meta));
    }
  }

  function startHoldFromEvent(e) {
    if (e.type === 'mousedown' && e.button !== 0) return;
    const btn = e.target.closest('.hold-action-btn');
    if (!btn || btn.disabled) return;
    if (activeHoldMeta) return;

    if (e.type === 'touchstart') {
      e.preventDefault();
    }

    const holdType = btn.getAttribute('data-hold-type');
    if (!holdType) return;

    activeHoldMeta = {
      type: holdType,
      element: btn,
      incidentId: btn.getAttribute('data-incident-id') || '',
      alertType: btn.getAttribute('data-alert-type') || '',
      category: btn.getAttribute('data-category') || 'urgent',
      broadcastAllRooms: btn.getAttribute('data-broadcast-rooms') === 'true',
      startTime: Date.now()
    };

    btn.classList.add('is-holding');
    updateHoldVisual(btn, 0.03);

    holdTimerId = setInterval(() => {
      if (!activeHoldMeta) return;
      const elapsed = Date.now() - activeHoldMeta.startTime;
      const currentBtn = findHoldButton(activeHoldMeta);
      if (currentBtn) {
        currentBtn.classList.add('is-holding');
        updateHoldVisual(currentBtn, elapsed / HOLD_DURATION_MS);
      }
      if (elapsed >= HOLD_DURATION_MS) {
        completeActiveHold();
      }
    }, 25);
  }

  document.addEventListener('pointerdown', startHoldFromEvent);
  document.addEventListener('mousedown', startHoldFromEvent);
  document.addEventListener('touchstart', startHoldFromEvent, { passive: false });

  document.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      const btn = e.target.closest && e.target.closest('.hold-action-btn');
      if (btn) {
        e.preventDefault();
        startHoldFromEvent(e);
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      cancelActiveHold();
    }
  });

  window.addEventListener('pointerup', cancelActiveHold);
  window.addEventListener('pointercancel', cancelActiveHold);
  window.addEventListener('mouseup', cancelActiveHold);
  window.addEventListener('touchend', cancelActiveHold);

  // Prevent quick-taps on .hold-action-btn from doing anything
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target.closest && e.target.closest('.hold-action-btn');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  // 1-Tap Quick Status Reply (shared handler for Current Notification block and Incident Feed)
  async function handleQuickReplyClick(e) {
    const switchBtn = e.target.closest('button[data-select-incident]');
    if (switchBtn) {
      state.selectedIncidentId = Number(switchBtn.getAttribute('data-select-incident'));
      renderCurrentNotification();
      return;
    }

    const btn = e.target.closest('button[data-action="reply"]');
    if (!btn) return;

    if (!state.name) {
      profileEditor.classList.remove('hidden');
      responderNameInput.focus();
      return;
    }

    const incidentId = btn.getAttribute('data-incident-id');
    const statusLabel = btn.getAttribute('data-status');

    btn.disabled = true;
    try {
      const data = await apiFetch(`/api/incidents/${incidentId}/replies`, {
        method: 'POST',
        body: JSON.stringify({
          responderName: state.name,
          responderPost: state.post,
          responderDeviceId: state.deviceId,
          statusLabel
        })
      });
      state.activeIncidents = data.activeIncidents || state.activeIncidents;
      state.recentResolved = data.recentResolved || state.recentResolved;
      renderIncidents();
    } catch (err) {
      console.error('Failed to send reply:', err);
      btn.disabled = false;
    }
  }

  if (currentNotificationBlock) {
    currentNotificationBlock.addEventListener('click', handleQuickReplyClick);
  }
  if (activeIncidentsList) {
    activeIncidentsList.addEventListener('click', handleQuickReplyClick);
  }

  // Custom Short Text Reply
  async function handleCustomNoteSubmit(e) {
    const form = e.target.closest('form[data-note-form]');
    if (!form) return;
    e.preventDefault();

    if (!state.name) {
      profileEditor.classList.remove('hidden');
      responderNameInput.focus();
      return;
    }

    const incidentId = form.getAttribute('data-note-form');
    const input = form.querySelector('input');
    const note = (input.value || '').trim();
    if (!note) return;

    input.disabled = true;
    try {
      const data = await apiFetch(`/api/incidents/${incidentId}/replies`, {
        method: 'POST',
        body: JSON.stringify({
          responderName: state.name,
          responderPost: state.post,
          responderDeviceId: state.deviceId,
          statusLabel: 'Note',
          note
        })
      });
      input.value = '';
      state.activeIncidents = data.activeIncidents || state.activeIncidents;
      state.recentResolved = data.recentResolved || state.recentResolved;
      renderIncidents();
    } catch (err) {
      console.error('Failed to send custom note:', err);
    } finally {
      input.disabled = false;
    }
  }

  if (currentNotificationBlock) {
    currentNotificationBlock.addEventListener('submit', handleCustomNoteSubmit);
  }
  if (activeIncidentsList) {
    activeIncidentsList.addEventListener('submit', handleCustomNoteSubmit);
  }

  // Web Push & Service Worker Setup
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async function setupServiceWorkerAndPush() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      if ('PushManager' in window && state.vapidPublicKey) {
        pushBtn.classList.remove('hidden');
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
          pushBtn.textContent = '🔔 Push Active';
        }
        pushBtn.onclick = async () => {
          try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') return;
            const sub =
              (await reg.pushManager.getSubscription()) ||
              (await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(state.vapidPublicKey)
              }));
            await apiFetch('/api/push/subscribe', {
              method: 'POST',
              body: JSON.stringify({
                deviceId: state.deviceId,
                memberName: state.name,
                memberPost: state.post,
                subscription: sub
              })
            });
            pushBtn.textContent = '🔔 Push Active';
          } catch (err) {
            console.warn('Push subscription error:', err);
          }
        };
      }
    } catch (err) {
      console.warn('Service worker registration skipped:', err);
    }
  }

  // Periodic heartbeat + client-side 6-hour on-duty expiration check
  setInterval(async () => {
    if (!state.pin) return;
    if (state.myLoggedOnAt) {
      const elapsed = Date.now() - Date.parse(state.myLoggedOnAt);
      if (elapsed >= state.maxOnDutyMs) {
        lockConsole('Session automatically locked after 6 hours on duty. Re-enter Team PIN to check back in.');
        return;
      }
    }
    try {
      if (state.realtimeMode === 'sse') {
        const res = await fetch('/health', { cache: 'no-store' });
        if (res.ok && (!state.sse || state.sse.readyState === EventSource.CLOSED)) {
          if (state.pin && state.name) connectSse();
        }
      }
    } catch (_) {
      setConnectionStatus(false);
    }
  }, 10000);

  // Boot
  updateIdentityDisplay();
  if (state.pin && state.name) {
    loadInitialConsole({ freshLogin: false });
  }
})();
