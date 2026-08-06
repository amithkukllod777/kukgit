const NOTIFICATIONS_API = '/api/notifications';
let notificationScheduled = false;
let notificationSettingsKey = '';
let notificationSettingsFailed = '';
let latestNotificationData = null;
let notificationPoll = null;

function notificationEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function notificationDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const diff = Date.now() - date.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function notificationNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${notificationEscape(title)}</b><span>${notificationEscape(message)}</span></div>`;
  root.append(toast);
  setTimeout(() => toast.remove(), 4600);
}

async function notificationRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

function notificationStyles() {
  if (document.querySelector('#kg-notification-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-notification-styles';
  style.textContent = `
    .kg-notification-button { position:relative; }
    .kg-notification-count { position:absolute; right:-5px; top:-6px; min-width:17px; height:17px; padding:0 4px; border-radius:999px; display:grid; place-items:center; background:#ff5470; color:white; font-size:9px; font-weight:800; border:2px solid #07111f; }
    .kg-notification-drawer { position:fixed; z-index:1300; top:0; right:0; width:min(430px,100vw); height:100vh; background:#081522; border-left:1px solid var(--border); box-shadow:-24px 0 70px rgba(0,0,0,.48); display:flex; flex-direction:column; }
    .kg-notification-backdrop { position:fixed; z-index:1299; inset:0; background:rgba(1,7,15,.6); backdrop-filter:blur(4px); }
    .kg-notification-head { padding:18px; display:flex; align-items:flex-start; justify-content:space-between; gap:12px; border-bottom:1px solid var(--border); }
    .kg-notification-head h2 { margin:0 0 3px; }
    .kg-notification-toolbar { padding:10px 14px; display:flex; gap:8px; border-bottom:1px solid var(--border); }
    .kg-notification-list { overflow:auto; flex:1; }
    .kg-notification-item { display:grid; grid-template-columns:34px minmax(0,1fr) auto; gap:10px; padding:14px; border-bottom:1px solid var(--border); cursor:pointer; }
    .kg-notification-item.unread { background:rgba(21,152,255,.055); }
    .kg-notification-item:hover { background:rgba(255,255,255,.035); }
    .kg-notification-icon { width:32px; height:32px; border-radius:10px; display:grid; place-items:center; background:rgba(21,152,255,.12); }
    .kg-notification-copy b { display:block; font-size:12px; }
    .kg-notification-copy p { margin:4px 0; color:var(--muted); font-size:11px; line-height:1.5; }
    .kg-notification-copy span { color:var(--muted); font-size:9px; }
    .kg-notification-dot { width:8px; height:8px; border-radius:50%; background:#1598ff; margin-top:5px; }
    .kg-notification-empty { text-align:center; color:var(--muted); padding:48px 20px; }
    .kg-notification-settings { margin-top:18px; }
    .kg-preference-row { display:grid; grid-template-columns:minmax(180px,1fr) 110px 110px; gap:12px; align-items:center; padding:13px 0; border-top:1px solid var(--border); }
    .kg-preference-row:first-child { border-top:0; }
    .kg-email-row { display:grid; grid-template-columns:minmax(190px,1fr) 90px 100px 130px auto; gap:12px; align-items:center; padding:12px 0; border-top:1px solid var(--border); }
    .kg-email-row:first-child { border-top:0; }
    .kg-email-row .muted { font-size:10px; }
    .kg-email-error { color:#ff7b91; font-size:10px; overflow-wrap:anywhere; }
    .kg-resend-invitation { margin-left:6px; }
    @media (max-width:850px) { .kg-preference-row,.kg-email-row { grid-template-columns:1fr; } }
  `;
  document.head.append(style);
}

function categoryIcon(category) {
  return ({ organization: '▦', security: '◇', pull_request: '⑂', status: '✓', operations: '⚙' })[category] || '◉';
}

function notificationItemsMarkup(data) {
  if (!data.notifications.length) return '<div class="kg-notification-empty">No notifications yet.</div>';
  return data.notifications.map((item) => `<article class="kg-notification-item ${item.readAt ? '' : 'unread'}" data-notification-id="${notificationEscape(item.id)}" data-notification-link="${notificationEscape(item.link || '')}">
    <div class="kg-notification-icon">${categoryIcon(item.category)}</div>
    <div class="kg-notification-copy"><b>${notificationEscape(item.title)}</b><p>${notificationEscape(item.body)}</p><span>${notificationDate(item.createdAt)} · ${notificationEscape(item.category.replaceAll('_', ' '))}</span></div>
    <div>${item.readAt ? '' : '<i class="kg-notification-dot"></i>'}</div>
  </article>`).join('');
}

function renderBell(data) {
  const actions = document.querySelector('.topbar-actions');
  if (!actions) return;
  let button = document.querySelector('#kg-notification-button');
  if (!button) {
    button = document.createElement('button');
    button.className = 'btn btn-ghost icon-btn kg-notification-button';
    button.id = 'kg-notification-button';
    button.title = 'Notifications';
    button.innerHTML = '<span aria-hidden="true">◔</span><span class="kg-notification-count" hidden></span>';
    actions.prepend(button);
    button.addEventListener('click', openNotificationDrawer);
  }
  const badge = button.querySelector('.kg-notification-count');
  const hidden = !data.unreadCount;
  const label = data.unreadCount > 99 ? '99+' : String(data.unreadCount);
  // Writing the same value is still a DOM change, and a DOM change is what
  // wakes the observer that gets us back here.
  if (badge.hidden !== hidden) badge.hidden = hidden;
  if (badge.textContent !== label) badge.textContent = label;
}

function closeNotificationDrawer() {
  document.querySelector('#kg-notification-drawer')?.remove();
  document.querySelector('#kg-notification-backdrop')?.remove();
}

async function openNotificationDrawer() {
  closeNotificationDrawer();
  const backdrop = document.createElement('div');
  backdrop.className = 'kg-notification-backdrop';
  backdrop.id = 'kg-notification-backdrop';
  backdrop.addEventListener('click', closeNotificationDrawer);
  const drawer = document.createElement('aside');
  drawer.className = 'kg-notification-drawer';
  drawer.id = 'kg-notification-drawer';
  drawer.innerHTML = `<div class="kg-notification-head"><div><h2>Notifications</h2><p class="muted">Loading your KukGit activity…</p></div><button class="btn btn-ghost" id="kg-close-notifications">✕</button></div><div class="kg-notification-list"><div class="kg-notification-empty">Loading…</div></div>`;
  document.body.append(backdrop, drawer);
  drawer.querySelector('#kg-close-notifications').addEventListener('click', closeNotificationDrawer);
  try {
    const data = await notificationRequest(`${NOTIFICATIONS_API}?limit=100`);
    latestNotificationData = data;
    drawer.innerHTML = `<div class="kg-notification-head"><div><h2>Notifications</h2><p class="muted">${data.unreadCount} unread · ${data.notifications.length} shown</p></div><button class="btn btn-ghost" id="kg-close-notifications">✕</button></div><div class="kg-notification-toolbar"><button class="btn" id="kg-read-all" ${data.unreadCount ? '' : 'disabled'}>Mark all read</button><button class="btn btn-ghost" id="kg-open-preferences">Preferences</button></div><div class="kg-notification-list">${notificationItemsMarkup(data)}</div>`;
    drawer.querySelector('#kg-close-notifications').addEventListener('click', closeNotificationDrawer);
    drawer.querySelector('#kg-read-all').addEventListener('click', async () => {
      await notificationRequest(`${NOTIFICATIONS_API}/read-all`, { method: 'POST', body: {} });
      data.notifications.forEach((item) => item.readAt ||= new Date().toISOString());
      data.unreadCount = 0;
      renderBell(data);
      openNotificationDrawer();
    });
    drawer.querySelector('#kg-open-preferences').addEventListener('click', () => {
      closeNotificationDrawer();
      location.hash = '#/settings';
    });
    drawer.querySelectorAll('[data-notification-id]').forEach((item) => item.addEventListener('click', async () => {
      const id = item.dataset.notificationId;
      if (item.classList.contains('unread')) {
        await notificationRequest(`${NOTIFICATIONS_API}/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} });
        item.classList.remove('unread');
        item.querySelector('.kg-notification-dot')?.remove();
        data.unreadCount = Math.max(0, data.unreadCount - 1);
        renderBell(data);
      }
      const link = item.dataset.notificationLink;
      if (link) {
        closeNotificationDrawer();
        location.hash = link.startsWith('#') ? link.slice(1) : link;
      }
    }));
  } catch (error) {
    drawer.querySelector('.kg-notification-list').innerHTML = `<div class="kg-notification-empty">${notificationEscape(error.message)}</div>`;
  }
}

function preferenceLabel(category) {
  return ({
    organization: ['Organization', 'Invitations, membership and team activity'],
    security: ['Security', 'Token expiry and security-sensitive account activity'],
    pull_request: ['Pull requests', 'New pull requests, reviews and merges'],
    status: ['Status checks', 'Failed and errored CI or integration checks'],
    operations: ['Operations', 'Backup, webhook, storage and instance alerts'],
  })[category] || [category, ''];
}

function preferencesMarkup(preferences) {
  return preferences.map((preference) => {
    const [title, copy] = preferenceLabel(preference.category);
    return `<div class="kg-preference-row" data-preference-category="${notificationEscape(preference.category)}"><div><b>${notificationEscape(title)}</b><div class="muted" style="font-size:11px">${notificationEscape(copy)}</div></div><label><input type="checkbox" name="inAppEnabled" ${preference.inAppEnabled ? 'checked' : ''} /> In-app</label><label><input type="checkbox" name="emailEnabled" ${preference.emailEnabled ? 'checked' : ''} /> Email</label></div>`;
  }).join('');
}

function emailRows(data) {
  if (!data.emails.length) return '<div class="kg-notification-empty">No transactional email records yet.</div>';
  return data.emails.map((email) => `<div class="kg-email-row" data-email-id="${notificationEscape(email.id)}"><div><b>${notificationEscape(email.subject)}</b><div class="muted">To ${notificationEscape(email.toEmail)} · ${notificationEscape(email.category)}</div>${email.lastError ? `<div class="kg-email-error">${notificationEscape(email.lastError)}</div>` : ''}</div><div><span class="badge ${email.status === 'sent' ? 'public' : email.status === 'failed' ? 'critical' : ''}">${notificationEscape(email.status)}</span></div><div class="muted">${email.attemptCount}/${email.maxAttempts} attempts</div><div class="muted">${notificationDate(email.sentAt || email.nextAttemptAt || email.createdAt)}</div><div>${['failed','cancelled'].includes(email.status) ? '<button class="btn btn-ghost kg-retry-email">Retry</button>' : ''}</div></div>`).join('');
}

async function renderNotificationSettings(force = false) {
  const route = location.hash.split('?')[0];
  if (route !== '#/settings') return;
  const content = document.querySelector('.content');
  if (!content) return;
  const key = `${route}:${document.querySelector('.sidebar-user-name span')?.textContent || ''}`;
  if (!force && notificationSettingsKey === key && document.querySelector('#kg-notification-settings')) return;
  // Set before the fetch and never cleared on failure, so the guard below —
  // which also needs the rendered panel — let every DOM change ask again.
  notificationSettingsKey = key;
  if (!force && notificationSettingsFailed === key) return;
  try {
    const preferences = (await notificationRequest(`${NOTIFICATIONS_API}/preferences`)).preferences;
    document.querySelector('#kg-notification-settings')?.remove();
    content.insertAdjacentHTML('beforeend', `<section class="card kg-notification-settings" id="kg-notification-settings"><div class="card-header"><div><h2>Notification preferences</h2><p>Choose which KukGit events reach the in-app inbox and your email.</p></div></div><div class="card-body"><form id="kg-notification-preferences-form">${preferencesMarkup(preferences)}<button class="btn btn-primary" type="submit" style="margin-top:14px">Save notification preferences</button></form></div></section>`);
    const form = document.querySelector('#kg-notification-preferences-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      const values = [...form.querySelectorAll('[data-preference-category]')].map((row) => ({
        category: row.dataset.preferenceCategory,
        inAppEnabled: row.querySelector('[name="inAppEnabled"]').checked,
        emailEnabled: row.querySelector('[name="emailEnabled"]').checked,
      }));
      try {
        await notificationRequest(`${NOTIFICATIONS_API}/preferences`, { method: 'PUT', body: { preferences: values } });
        notificationNotify('Preferences saved', 'Notification delivery settings were updated.');
      } catch (error) {
        notificationNotify('Unable to save preferences', error.message, 'error');
      } finally { button.disabled = false; }
    });
    await renderEmailAdministration(content);
    notificationSettingsFailed = '';
  } catch {
    // Remembered, because the guard above needs the rendered panel and a failed
    // load never renders one. Cleared by a different key, which is what a
    // different page or a different signed-in person produces.
    notificationSettingsFailed = key;
  }
}

async function renderEmailAdministration(content) {
  try {
    const data = await notificationRequest(`${NOTIFICATIONS_API}/admin/outbox?limit=100`);
    document.querySelector('#kg-email-delivery-admin')?.remove();
    content.insertAdjacentHTML('beforeend', `<section class="card kg-notification-settings" id="kg-email-delivery-admin"><div class="card-header"><div><h2>Transactional email delivery</h2><p>${data.configured ? 'SMTP worker is configured.' : 'SMTP is not configured; queued email remains pending.'}</p></div><div style="display:flex;gap:8px"><span class="badge ${data.configured ? 'public' : 'critical'}">${data.configured ? 'Configured' : 'Disabled'}</span><button class="btn" id="kg-process-email">Process queue</button></div></div><div class="card-body"><div class="kg-notification-toolbar">${['pending','processing','sent','failed','cancelled'].map((status) => `<span class="badge">${status}: ${data.counts[status] || 0}</span>`).join('')}</div><div id="kg-email-list">${emailRows(data)}</div></div></section>`);
    document.querySelector('#kg-process-email').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = (await notificationRequest(`${NOTIFICATIONS_API}/admin/process`, { method: 'POST', body: {} })).result;
        notificationNotify('Email queue processed', `${result.sent} sent, ${result.failed} failed.`);
        await renderNotificationSettings(true);
      } catch (error) {
        notificationNotify('Email processing failed', error.message, 'error');
        button.disabled = false;
      }
    });
    document.querySelectorAll('.kg-retry-email').forEach((button) => button.addEventListener('click', async () => {
      const id = button.closest('[data-email-id]').dataset.emailId;
      button.disabled = true;
      try {
        await notificationRequest(`${NOTIFICATIONS_API}/admin/outbox/${encodeURIComponent(id)}/retry`, { method: 'POST', body: {} });
        notificationNotify('Email queued', 'The failed delivery will be attempted again.');
        await renderNotificationSettings(true);
      } catch (error) {
        notificationNotify('Retry failed', error.message, 'error');
        button.disabled = false;
      }
    }));
  } catch (error) {
    if (error.status !== 403) console.warn('Email administration unavailable:', error.message);
  }
}

function enhanceInvitationResend() {
  document.querySelectorAll('.kg-revoke-invite').forEach((revoke) => {
    const invitationId = revoke.dataset.invitationId;
    const parent = revoke.parentElement;
    if (!invitationId || parent.querySelector('.kg-resend-invitation')) return;
    const button = document.createElement('button');
    button.className = 'btn btn-ghost kg-resend-invitation';
    button.textContent = 'Resend email';
    button.dataset.invitationId = invitationId;
    parent.insertBefore(button, revoke);
    button.addEventListener('click', async () => {
      const panel = button.closest('#kg-collaboration-panel');
      const org = panel?.dataset.org;
      if (!org || !window.confirm('Revoke the current link and email a fresh 14-day invitation?')) return;
      button.disabled = true;
      try {
        const payload = await notificationRequest(`/api/collaboration/orgs/${encodeURIComponent(org)}/invitations/${encodeURIComponent(invitationId)}/resend`, { method: 'POST', body: { expiresInDays: 14 } });
        const secret = panel.querySelector('#kg-invitation-secret');
        if (secret) secret.innerHTML = `<div class="kg-one-time"><b>Fresh invitation created and queued for email</b><p class="muted">Copy this link only if you also need to share it manually.</p><code id="kg-invitation-url">${notificationEscape(payload.invitation.acceptanceUrl)}</code><button class="btn btn-primary" id="kg-copy-invitation">Copy invitation link</button></div>`;
        notificationNotify('Invitation resent', `A fresh invitation was queued for ${payload.invitation.email}.`);
        setTimeout(() => location.hash = '#/organizations', 200);
      } catch (error) {
        notificationNotify('Unable to resend invitation', error.message, 'error');
        button.disabled = false;
      }
    });
  });
}

/**
 * How often the unread count is worth asking for.
 *
 * The bell does not depend on the route, so a page change is not a reason to
 * ask again — and rendering the bell changes the DOM, which wakes the observer
 * that renders the bell. Without a floor that loop asked forty-three times in
 * six seconds and ended at the rate limiter. The minute poll below is what
 * actually keeps the number fresh.
 */
const SUMMARY_MIN_INTERVAL_MS = 15_000;
let lastNotificationSummaryAt = 0;

async function refreshNotificationSummary({ force = false } = {}) {
  if (!document.querySelector('.app-shell')) return;
  const now = Date.now();
  if (!force && now - lastNotificationSummaryAt < SUMMARY_MIN_INTERVAL_MS) return;
  lastNotificationSummaryAt = now;
  try {
    const data = await notificationRequest(`${NOTIFICATIONS_API}?limit=20`);
    latestNotificationData = data;
    renderBell(data);
  } catch {
    // A failure holds the floor too. Retrying at DOM speed is exactly how a
    // failure becomes a storm, and the minute poll below is what retries.
  }
}

function mountNotifications() {
  notificationScheduled = false;
  notificationStyles();
  refreshNotificationSummary();
  renderNotificationSettings();
  enhanceInvitationResend();
  // Forced: the poll is the thing that keeps the number fresh, and the floor
  // above is there to stop the observer, not the clock.
  if (!notificationPoll) notificationPoll = setInterval(() => refreshNotificationSummary({ force: true }), 60000);
}

function scheduleNotifications() {
  if (notificationScheduled) return;
  notificationScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(mountNotifications));
}

window.addEventListener('hashchange', scheduleNotifications);
new MutationObserver(scheduleNotifications).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleNotifications();
