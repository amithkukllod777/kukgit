const REALTIME_NOTIFICATION_PATH = '/api/notifications/socket';
const REALTIME_NOTIFICATION_API = '/api/notifications';
let realtimeSocket = null;
let realtimeReconnectTimer = null;
let realtimeRefreshTimer = null;
let realtimeBackoffMs = 1000;
let realtimeGeneration = 0;
let realtimeRefreshRunning = false;

function realtimeEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function realtimeDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const diff = Date.now() - date.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function realtimeIcon(category) {
  return ({ organization: '▦', security: '◇', pull_request: '⑂', status: '✓', operations: '⚙' })[category] || '◉';
}

async function realtimeRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `Request failed (${response.status})`);
  return payload;
}

function updateRealtimeBadge(unreadCount) {
  const badge = document.querySelector('#kg-notification-button .kg-notification-count');
  if (!badge) return;
  const count = Math.max(0, Number(unreadCount) || 0);
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? '99+' : String(count);
}

function realtimeNotificationMarkup(item) {
  return `<article class="kg-notification-item ${item.readAt ? '' : 'unread'}" data-notification-id="${realtimeEscape(item.id)}" data-notification-link="${realtimeEscape(item.link || '')}">
    <div class="kg-notification-icon">${realtimeIcon(item.category)}</div>
    <div class="kg-notification-copy"><b>${realtimeEscape(item.title)}</b><p>${realtimeEscape(item.body)}</p><span>${realtimeDate(item.createdAt)} · ${realtimeEscape(String(item.category || '').replaceAll('_', ' '))}</span></div>
    <div>${item.readAt ? '' : '<i class="kg-notification-dot"></i>'}</div>
  </article>`;
}

function bindRealtimeDrawerItems(drawer, data) {
  drawer.querySelectorAll('[data-notification-id]').forEach((item) => item.addEventListener('click', async () => {
    const id = item.dataset.notificationId;
    if (item.classList.contains('unread')) {
      await realtimeRequest(`${REALTIME_NOTIFICATION_API}/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} });
    }
    const link = item.dataset.notificationLink;
    if (link) {
      document.querySelector('#kg-notification-drawer')?.remove();
      document.querySelector('#kg-notification-backdrop')?.remove();
      location.hash = link.startsWith('#') ? link.slice(1) : link;
    }
  }));
}

function updateOpenRealtimeDrawer(data) {
  const drawer = document.querySelector('#kg-notification-drawer');
  if (!drawer) return;
  const copy = drawer.querySelector('.kg-notification-head p');
  if (copy) copy.textContent = `${data.unreadCount} unread · ${data.notifications.length} shown · live`;
  const list = drawer.querySelector('.kg-notification-list');
  if (!list) return;
  list.innerHTML = data.notifications.length
    ? data.notifications.map(realtimeNotificationMarkup).join('')
    : '<div class="kg-notification-empty">No notifications yet.</div>';
  const readAll = drawer.querySelector('#kg-read-all');
  if (readAll) readAll.disabled = !data.unreadCount;
  bindRealtimeDrawerItems(drawer, data);
}

async function refreshRealtimeNotifications() {
  if (realtimeRefreshRunning || !document.querySelector('.app-shell')) return;
  realtimeRefreshRunning = true;
  try {
    const data = await realtimeRequest(`${REALTIME_NOTIFICATION_API}?limit=100`);
    updateRealtimeBadge(data.unreadCount);
    updateOpenRealtimeDrawer(data);
    window.dispatchEvent(new CustomEvent('kukgit:notifications-synchronized', { detail: { unreadCount: data.unreadCount } }));
  } catch (error) {
    if (/Sign in/i.test(error.message)) closeRealtimeSocket();
  } finally {
    realtimeRefreshRunning = false;
  }
}

function scheduleRealtimeRefresh(delay = 25) {
  clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer = setTimeout(refreshRealtimeNotifications, delay);
}

function socketUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${REALTIME_NOTIFICATION_PATH}`;
}

function scheduleRealtimeReconnect(generation) {
  clearTimeout(realtimeReconnectTimer);
  if (generation !== realtimeGeneration || !document.querySelector('.app-shell') || !navigator.onLine) return;
  const jitter = Math.floor(Math.random() * Math.min(1000, realtimeBackoffMs / 3));
  realtimeReconnectTimer = setTimeout(() => connectRealtimeNotifications(generation), realtimeBackoffMs + jitter);
  realtimeBackoffMs = Math.min(30000, realtimeBackoffMs * 2);
}

function closeRealtimeSocket() {
  realtimeGeneration += 1;
  clearTimeout(realtimeReconnectTimer);
  clearTimeout(realtimeRefreshTimer);
  const socket = realtimeSocket;
  realtimeSocket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'KukGit view closed');
}

function connectRealtimeNotifications(generation = realtimeGeneration) {
  if (generation !== realtimeGeneration || !document.querySelector('.app-shell') || !navigator.onLine) return;
  if (realtimeSocket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(realtimeSocket.readyState)) return;
  let socket;
  try { socket = new WebSocket(socketUrl()); }
  catch {
    return scheduleRealtimeReconnect(generation);
  }
  realtimeSocket = socket;
  socket.addEventListener('open', () => {
    if (generation !== realtimeGeneration) return socket.close();
    realtimeBackoffMs = 1000;
    socket.send(JSON.stringify({ type: 'resync' }));
    window.dispatchEvent(new CustomEvent('kukgit:notification-socket', { detail: { connected: true } }));
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!['notifications.snapshot', 'notifications.changed'].includes(message.type)) return;
    updateRealtimeBadge(message.unreadCount);
    scheduleRealtimeRefresh(message.type === 'notifications.changed' ? 10 : 50);
  });
  socket.addEventListener('close', () => {
    if (realtimeSocket === socket) realtimeSocket = null;
    window.dispatchEvent(new CustomEvent('kukgit:notification-socket', { detail: { connected: false } }));
    scheduleRealtimeReconnect(generation);
  });
  socket.addEventListener('error', () => socket.close());
}

function mountRealtimeNotifications() {
  if (!('WebSocket' in window)) return;
  if (!document.querySelector('.app-shell')) {
    closeRealtimeSocket();
    return;
  }
  connectRealtimeNotifications();
}

window.addEventListener('online', () => {
  realtimeBackoffMs = 1000;
  connectRealtimeNotifications();
});
window.addEventListener('offline', closeRealtimeSocket);
window.addEventListener('beforeunload', closeRealtimeSocket);
window.addEventListener('hashchange', mountRealtimeNotifications);
new MutationObserver(mountRealtimeNotifications).observe(document.querySelector('#app'), { childList: true, subtree: true });
mountRealtimeNotifications();
