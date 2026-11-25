(function () {
  const HOLD_DURATION_MS = 1000;

  const CLASSROOM_MAP = {
    'sweet-grass-1': 'Sweet Grass 1',
    'sweet-grass-2': 'Sweet Grass 2',
    'bears-paw-1': 'Bears Paw 1',
    'bears-paw-2': 'Bears Paw 2',
    'pioneer-1': 'Pioneer 1',
    'pioneer-2': 'Pioneer 2'
  };

  function extractSlugFromPath() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    return (parts[1] || 'sweet-grass-1').toLowerCase();
  }

  function formatSlugToName(slug) {
    const clean = String(slug || '').trim().toLowerCase();
    if (CLASSROOM_MAP[clean]) {
      return CLASSROOM_MAP[clean];
    }
    return clean
      .split(/[-_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

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

  const roomSlug = extractSlugFromPath();
  const roomName = formatSlugToName(roomSlug);

  const state = {
    roomSlug,
    roomName,
    activeIncident: null,
    activeDirective: null,
    pendingRetryAlert: null,
    retryIntervalId: null,
    activeHoldBtn: null,
    holdStartTime: null,
    holdTimerId: null,
    realtimeMode: null,
    pollTimerId: null,
    lastRoomSig: '',
    sse: null,
    connected: true
  };

  // DOM References
  const roomNameHeading = document.getElementById('room-name-heading');
  const standbyStatusNote = document.getElementById('standby-status-note');
  const connBadge = document.getElementById('conn-badge');
  const connText = document.getElementById('conn-text');
  const confirmationBanner = document.getElementById('confirmation-banner');
  const confirmationHeadline = document.getElementById('confirmation-headline');
  const confirmationSubtext = document.getElementById('confirmation-subtext');
  const responderFeed = document.getElementById('responder-feed');
  const cancelAlertBtn = document.getElementById('cancel-alert-btn');
  const standbyControls = document.getElementById('standby-controls');
  const venueDirectiveBanner = document.getElementById('venue-directive-banner');
  const directiveHeadline = document.getElementById('directive-headline');
  const directiveInstructions = document.getElementById('directive-instructions');
  const directiveMeta = document.getElementById('directive-meta');
  const columnButtonsGrid = document.getElementById('column-buttons-grid');
  const holdHint = document.getElementById('hold-hint');
  const retryQueueBadge = document.getElementById('retry-queue-badge');

  roomNameHeading.textContent = roomName;
  document.title = `${roomName} — Classroom Alert`;
  const manifestLink = document.getElementById('room-manifest-link');
  if (manifestLink) {
    manifestLink.setAttribute('href', `/api/rooms/${encodeURIComponent(roomSlug)}/manifest.json`);
  }
  const appleTitleMeta = document.getElementById('apple-app-title');
  if (appleTitleMeta) {
    appleTitleMeta.setAttribute('content', roomName);
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

  function renderDirectiveState() {
    if (!venueDirectiveBanner) return;
    const dir = state.activeDirective;
    if (!dir || dir.status !== 'active') {
      venueDirectiveBanner.classList.add('hidden');
      venueDirectiveBanner.classList.remove('lockdown', 'evacuate');
      standbyControls.classList.remove('has-directive');
      return;
    }

    const typeUpper = String(dir.alert_type || '').toUpperCase();
    const isEvacuate =
      String(dir.category || '').toLowerCase() === 'evacuate' || typeUpper.includes('EVACUATE');

    standbyControls.classList.add('has-directive');
    venueDirectiveBanner.classList.remove('hidden', 'lockdown', 'evacuate');

    if (isEvacuate) {
      venueDirectiveBanner.classList.add('evacuate');
      directiveHeadline.textContent = 'EVACUATE';
      directiveInstructions.textContent =
        'Calmly lead all children out via your primary evacuation route to the designated assembly area. Bring class roster.';
    } else {
      venueDirectiveBanner.classList.add('lockdown');
      directiveHeadline.textContent = 'LOCKDOWN';
      directiveInstructions.textContent =
        'Secure classroom door immediately, turn off lights, move children out of sight, and remain quiet until All Clear.';
    }

    directiveMeta.textContent = `Broadcast by Security (${dir.sender_name || 'Team'}) at ${formatTime(dir.created_at)}`;
  }

  function getRoomAlertVisuals(inc) {
    const cat = String((inc && inc.category) || '').toLowerCase();
    const type = String((inc && inc.alert_type) || '').toLowerCase();
    if (cat === 'eyes' || cat === 'warning' || type.includes('assistance')) {
      return { tierClass: 'assistance', statusColor: '#fde047' };
    }
    if (cat === 'medical' || type.includes('medical')) {
      return { tierClass: 'medical', statusColor: '#93c5fd' };
    }
    return { tierClass: 'urgent', statusColor: '#fca5a5' };
  }

  function computeRoomSignature(incident, directive) {
    return JSON.stringify([incident || null, directive || null]);
  }

  function renderRoomState(previousIncident = null) {
    state.lastRoomSig = computeRoomSignature(state.activeIncident, state.activeDirective);
    renderDirectiveState();
    const inc = state.activeIncident;

    // Auto-reset to standby when marked Resolved or when no active incident
    if (!inc || inc.status === 'resolved') {
      confirmationBanner.className = 'confirmation-banner hidden';
      standbyControls.classList.remove('hidden');
      standbyStatusNote.style.color = 'var(--success)';

      if (inc && inc.status === 'resolved') {
        const resolver = inc.resolved_by || 'Security Team';
        standbyStatusNote.textContent = `● Standby Ready (Last alert resolved by ${resolver} at ${formatTime(inc.resolved_at)})`;
        state.activeIncident = null;
      } else if (previousIncident && previousIncident.status === 'active') {
        standbyStatusNote.textContent = `● Standby Ready (Resolved)`;
      } else {
        standbyStatusNote.textContent = `● Standby Ready`;
      }
      return;
    }

    // Active alert exists for this room
    const visuals = getRoomAlertVisuals(inc);
    confirmationBanner.className = 'confirmation-banner';
    standbyStatusNote.textContent = `Active Alert: ${inc.alert_type}`;

    const replies = Array.isArray(inc.replies) ? inc.replies : [];
    if (replies.length > 0) {
      confirmationBanner.classList.add('responded');
      standbyStatusNote.style.color = '#34d399';
      confirmationHeadline.textContent = '✓ Security Team Responding';
      confirmationSubtext.textContent = `${inc.alert_type} • Triggered at ${formatTime(inc.created_at)}`;
      responderFeed.innerHTML = replies
        .map(
          (r) => `
          <div class="responder-line">
            ✓ ${escapeHtml(r.responder_name)}${r.responder_post ? ` (${escapeHtml(r.responder_post)})` : ''} — ${escapeHtml(r.status_label)}${r.note ? ` "${escapeHtml(r.note)}"` : ''} (${formatTime(r.created_at)})
          </div>
        `
        )
        .join('');
    } else {
      confirmationBanner.classList.add(`sent-${visuals.tierClass}`);
      standbyStatusNote.style.color = visuals.statusColor;
      confirmationHeadline.textContent = `${inc.alert_type} Sent`;
      confirmationSubtext.textContent = `Dispatched from ${roomName} at ${formatTime(inc.created_at)} — Waiting for responder confirmation...`;
      responderFeed.innerHTML = '';
    }
  }

  // Client-side Retry Queue (resends every 2 seconds until confirmed)
  async function attemptSendQueuedAlert() {
    if (!state.pendingRetryAlert) return;
    const payload = state.pendingRetryAlert;

    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomSlug)}/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data && data.ok) {
        state.pendingRetryAlert = null;
        if (state.retryIntervalId) {
          clearInterval(state.retryIntervalId);
          state.retryIntervalId = null;
        }
        retryQueueBadge.classList.add('hidden');
        setConnectionStatus(true);
        state.activeIncident = data.incident;
        renderRoomState();
      }
    } catch (_) {
      setConnectionStatus(false);
      retryQueueBadge.classList.remove('hidden');
    }
  }

  function triggerClassroomAlert(alertType, category) {
    const clientAlertId = `room_${roomSlug}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const payload = {
      clientAlertId,
      alertType,
      category
    };

    state.pendingRetryAlert = payload;

    // Optimistic UI feedback while confirming with server
    state.activeIncident = {
      id: 'pending',
      room_slug: roomSlug,
      room_name: roomName,
      alert_type: alertType,
      category,
      status: 'active',
      created_at: new Date().toISOString(),
      replies: []
    };
    renderRoomState();

    attemptSendQueuedAlert();

    if (state.retryIntervalId) clearInterval(state.retryIntervalId);
    state.retryIntervalId = setInterval(() => {
      if (state.pendingRetryAlert) {
        attemptSendQueuedAlert();
      } else {
        clearInterval(state.retryIntervalId);
        state.retryIntervalId = null;
      }
    }, 2000);
  }

  // Long-press logic on each of the 3 columnar buttons
  function updateButtonProgress(btn, fraction) {
    if (!btn) return;
    const pct = Math.max(0, Math.min(100, fraction * 100));
    const fill = btn.querySelector('.col-hold-fill');
    const bar = btn.querySelector('.col-progress-bar');
    const pill = btn.querySelector('.col-hold-pill');
    if (fill) fill.style.height = `${pct}%`;
    if (bar) bar.style.width = `${pct}%`;
    if (pill && fraction > 0) {
      pill.textContent = 'KEEP HOLDING...';
    }
  }

  function resetButtonVisuals(btn) {
    if (!btn) return;
    btn.classList.remove('holding');
    const fill = btn.querySelector('.col-hold-fill');
    const bar = btn.querySelector('.col-progress-bar');
    const pill = btn.querySelector('.col-hold-pill');
    if (fill) fill.style.height = '0%';
    if (bar) bar.style.width = '0%';
    if (pill) pill.textContent = 'HOLD 1s';
  }

  function startHoldOnButton(btn, e) {
    if (!btn) return;
    if (e && e.type === 'mousedown' && e.button !== 0) return;
    if (state.holdStartTime !== null) return;

    state.activeHoldBtn = btn;
    state.holdStartTime = Date.now();
    btn.classList.add('holding');
    updateButtonProgress(btn, 0.02);

    state.holdTimerId = setInterval(() => {
      if (state.holdStartTime === null || !state.activeHoldBtn) return;
      const elapsed = Date.now() - state.holdStartTime;
      const fraction = elapsed / HOLD_DURATION_MS;
      updateButtonProgress(state.activeHoldBtn, fraction);

      if (elapsed >= HOLD_DURATION_MS) {
        completeHoldOnButton();
      }
    }, 30);
  }

  function cancelHold() {
    if (state.holdTimerId) {
      clearInterval(state.holdTimerId);
      state.holdTimerId = null;
    }
    if (state.activeHoldBtn) {
      resetButtonVisuals(state.activeHoldBtn);
      state.activeHoldBtn = null;
    }
    state.holdStartTime = null;
  }

  function completeHoldOnButton() {
    const btn = state.activeHoldBtn;
    if (!btn) {
      cancelHold();
      return;
    }
    const alertType = btn.getAttribute('data-tier') || 'URGENT';
    const category = btn.getAttribute('data-category') || 'urgent';
    cancelHold();

    holdHint.textContent = `✓ ${alertType} alert triggered and sent to Security Team!`;
    setTimeout(() => {
      holdHint.innerHTML = 'Kid-Tap Safeguard: Press and hold a button for <strong>1 second</strong> to dispatch alert.';
    }, 3000);

    triggerClassroomAlert(alertType, category);
  }

  columnButtonsGrid.querySelectorAll('.col-hold-btn').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => startHoldOnButton(btn, e));
    btn.addEventListener('mousedown', (e) => startHoldOnButton(btn, e));
    btn.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        startHoldOnButton(btn, e);
      },
      { passive: false }
    );
    btn.addEventListener('keydown', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault();
        startHoldOnButton(btn, e);
      }
    });
    btn.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        cancelHold();
      }
    });
  });

  window.addEventListener('pointerup', cancelHold);
  window.addEventListener('pointercancel', cancelHold);
  window.addEventListener('mouseup', cancelHold);
  window.addEventListener('touchend', cancelHold);

  // 1-second press-and-hold to Cancel active classroom alert
  let cancelHoldStart = null;
  let cancelHoldTimer = null;

  function resetCancelBtnVisual() {
    cancelAlertBtn.classList.remove('is-holding');
    const fill = cancelAlertBtn.querySelector('.hold-fill-overlay');
    const bar = cancelAlertBtn.querySelector('.hold-bar-bottom');
    if (fill) fill.style.width = '0%';
    if (bar) bar.style.width = '0%';
  }

  async function performCancelClassroomAlert() {
    state.pendingRetryAlert = null;
    if (state.retryIntervalId) {
      clearInterval(state.retryIntervalId);
      state.retryIntervalId = null;
    }
    retryQueueBadge.classList.add('hidden');

    try {
      await fetch(`/api/rooms/${encodeURIComponent(roomSlug)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      state.activeIncident = null;
      renderRoomState();
    } catch (err) {
      console.error('Failed to cancel classroom alert:', err);
    }
  }

  function startCancelHold(e) {
    if (e && e.type === 'mousedown' && e.button !== 0) return;
    if (cancelHoldStart !== null) return;
    if (e && e.type === 'touchstart') e.preventDefault();

    cancelHoldStart = Date.now();
    cancelAlertBtn.classList.add('is-holding');
    cancelHoldTimer = setInterval(() => {
      if (cancelHoldStart === null) return;
      const elapsed = Date.now() - cancelHoldStart;
      const pct = Math.max(0, Math.min(100, (elapsed / HOLD_DURATION_MS) * 100));
      const fill = cancelAlertBtn.querySelector('.hold-fill-overlay');
      const bar = cancelAlertBtn.querySelector('.hold-bar-bottom');
      if (fill) fill.style.width = `${pct}%`;
      if (bar) bar.style.width = `${pct}%`;

      if (elapsed >= HOLD_DURATION_MS) {
        stopCancelHold();
        performCancelClassroomAlert();
      }
    }, 25);
  }

  function stopCancelHold() {
    if (cancelHoldTimer) {
      clearInterval(cancelHoldTimer);
      cancelHoldTimer = null;
    }
    cancelHoldStart = null;
    resetCancelBtnVisual();
  }

  cancelAlertBtn.addEventListener('pointerdown', startCancelHold);
  cancelAlertBtn.addEventListener('mousedown', startCancelHold);
  cancelAlertBtn.addEventListener('touchstart', startCancelHold, { passive: false });
  window.addEventListener('pointerup', stopCancelHold);
  window.addEventListener('pointercancel', stopCancelHold);
  window.addEventListener('mouseup', stopCancelHold);
  window.addEventListener('touchend', stopCancelHold);

  // Scoped SSE connection for this room
  function connectRoomSse() {
    if (state.sse) {
      state.sse.close();
    }
    const es = new EventSource(`/api/events/room/${encodeURIComponent(roomSlug)}`);
    state.sse = es;

    es.onopen = () => {
      setConnectionStatus(true);
    };

    es.addEventListener('init', (e) => {
      setConnectionStatus(true);
      const data = JSON.parse(e.data);
      state.activeIncident = data.incident || null;
      if ('directive' in data) {
        state.activeDirective = data.directive || null;
      }
      renderRoomState();
    });

    es.addEventListener('venue_directive_update', (e) => {
      setConnectionStatus(true);
      const data = JSON.parse(e.data);
      state.activeDirective = data.directive || null;
      renderDirectiveState();
    });

    es.addEventListener('room_incident_update', (e) => {
      setConnectionStatus(true);
      const prev = state.activeIncident;
      const data = JSON.parse(e.data);
      state.activeIncident = data.incident || null;
      renderRoomState(prev);
    });

    es.addEventListener('heartbeat', () => {
      setConnectionStatus(true);
    });

    es.onerror = () => {
      setConnectionStatus(false);
    };
  }

  function scheduleNextRoomPoll() {
    if (state.pollTimerId) {
      clearTimeout(state.pollTimerId);
      state.pollTimerId = null;
    }
    if (state.realtimeMode === 'poll') {
      if (document.hidden) return;
      const delay = state.activeIncident || state.activeDirective ? 2500 : 5000;
      state.pollTimerId = setTimeout(checkRoomHeartbeat, delay);
    } else {
      state.pollTimerId = setTimeout(checkRoomHeartbeat, 8000);
    }
  }

  // Initial status fetch + adaptive polling / SSE heartbeat
  async function checkRoomHeartbeat() {
    if (state.pollTimerId) {
      clearTimeout(state.pollTimerId);
      state.pollTimerId = null;
    }
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomSlug)}/status`, {
        cache: 'no-store'
      });
      if (!res.ok) throw new Error('Status check failed');
      const data = await res.json();
      setConnectionStatus(true);
      state.realtimeMode = data.realtimeMode || 'sse';

      const nextIncident = data.activeIncident || null;
      const nextDirective = 'activeDirective' in data ? data.activeDirective || null : state.activeDirective;
      const sig = computeRoomSignature(nextIncident, nextDirective);

      if (!state.lastRoomSig || sig !== state.lastRoomSig) {
        const prev = state.activeIncident;
        state.activeIncident = nextIncident;
        state.activeDirective = nextDirective;
        renderRoomState(prev);
      }

      if (state.realtimeMode === 'sse') {
        if (!state.sse || state.sse.readyState === EventSource.CLOSED) {
          connectRoomSse();
        }
      } else if (state.sse) {
        state.sse.close();
        state.sse = null;
      }
    } catch (_) {
      setConnectionStatus(false);
    } finally {
      scheduleNextRoomPoll();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.realtimeMode === 'poll') {
      checkRoomHeartbeat();
    }
  });

  checkRoomHeartbeat();
})();
