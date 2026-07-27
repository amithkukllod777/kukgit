const KG_EMAIL_HEALTH_API = '/api/email-provider/admin';
let kgEmailHealthRendering = false;
let kgEmailHealthQueued = false;
let kgEmailHealthKey = '';

function kgEmailEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function kgEmailDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function kgEmailToast(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${kgEmailEscape(title)}</b><span>${kgEmailEscape(message)}</span></div>`;
  root.append(item);
  setTimeout(() => item.remove(), 4600);
}

async function kgEmailRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

function kgEmailRouteActive() {
  const segments = (location.hash.slice(1) || '/').split('?')[0].split('/').filter(Boolean);
  return segments[0] === 'instance-admin' && segments[1] === 'email-health';
}

function installKgEmailStyles() {
  if (document.querySelector('#kg-email-health-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-email-health-styles';
  style.textContent = `
    .kg-email-health-shell { display:grid; gap:18px; }
    .kg-email-health-hero { border:1px solid rgba(255,173,51,.32); background:linear-gradient(135deg,rgba(255,173,51,.12),rgba(255,94,112,.07)); border-radius:16px; padding:22px; display:flex; justify-content:space-between; align-items:flex-start; gap:18px; }
    .kg-email-health-hero h1 { margin:5px 0 7px; font-size:28px; }
    .kg-email-health-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
    .kg-email-health-metric { padding:17px; border:1px solid var(--border); background:var(--panel); border-radius:14px; }
    .kg-email-health-metric span { display:block; color:var(--muted); font-size:11px; }
    .kg-email-health-metric b { display:block; font-size:25px; margin-top:9px; }
    .kg-email-health-row { display:grid; grid-template-columns:minmax(220px,1.25fr) minmax(130px,.55fr) minmax(200px,.8fr) auto; gap:12px; align-items:center; padding:12px; border:1px solid var(--border); border-radius:12px; background:rgba(255,255,255,.018); }
    .kg-email-health-row span,.kg-email-health-meta { color:var(--muted); font-size:11px; line-height:1.5; }
    .kg-email-health-list { display:grid; gap:8px; }
    .kg-email-health-toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:end; }
    .kg-email-health-toolbar .field { min-width:220px; margin:0; }
    .kg-email-health-empty { padding:24px; text-align:center; color:var(--muted); }
    @media(max-width:900px){.kg-email-health-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.kg-email-health-row{grid-template-columns:1fr}}
    @media(max-width:560px){.kg-email-health-grid{grid-template-columns:1fr}.kg-email-health-hero{flex-direction:column}}
  `;
  document.head.append(style);
}

function metric(label, value) {
  return `<div class="kg-email-health-metric"><span>${kgEmailEscape(label)}</span><b>${kgEmailEscape(value)}</b></div>`;
}

function suppressionRows(rows) {
  if (!rows.length) return '<div class="kg-email-health-empty">No matching email suppression.</div>';
  return rows.map((row) => `<div class="kg-email-health-row">
    <div><b>${kgEmailEscape(row.email)}</b><span>${kgEmailEscape(row.provider || 'provider event')} · ${kgEmailEscape(row.providerEventId || 'no source ID')}</span></div>
    <div><span class="badge critical">${kgEmailEscape(row.reason)}</span></div>
    <div class="kg-email-health-meta">Suppressed ${kgEmailDate(row.suppressedAt)}<br />Expires ${row.expiresAt ? kgEmailDate(row.expiresAt) : 'only after reviewed unsuppress'}${row.softBounceCount ? `<br />${row.softBounceCount} soft bounces` : ''}</div>
    <button class="btn" type="button" data-email-unsuppress="${kgEmailEscape(row.email)}">Review & unsuppress</button>
  </div>`).join('');
}

function eventRows(rows) {
  if (!rows.length) return '<div class="kg-email-health-empty">No provider event received.</div>';
  return rows.map((row) => `<div class="kg-email-health-row">
    <div><b>${kgEmailEscape(row.eventType)}</b><span>${kgEmailEscape(row.recipient)} · ${kgEmailEscape(row.provider)}</span></div>
    <div><span class="badge ${row.eventType === 'delivered' ? 'public' : row.eventType === 'deferred' ? 'open' : 'critical'}">${kgEmailEscape(row.eventType)}</span></div>
    <div class="kg-email-health-meta">Occurred ${kgEmailDate(row.occurredAt)}<br />Event ${kgEmailEscape(row.providerEventId)} · ${kgEmailEscape(row.payloadBytes)} bytes</div>
    <code title="Payload SHA-256">${kgEmailEscape(String(row.payloadSha256 || '').slice(0, 16))}…</code>
  </div>`).join('');
}

async function renderKgEmailHealth() {
  if (!kgEmailRouteActive() || kgEmailHealthRendering) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const key = location.hash;
  if (kgEmailHealthKey === key && content.querySelector('.kg-email-health-shell')) return;
  kgEmailHealthRendering = true;
  content.innerHTML = '<div class="kg-email-health-empty">Loading email delivery health…</div>';
  try {
    const query = new URLSearchParams(location.hash.split('?')[1] || '');
    const q = query.get('q') || '';
    const active = query.get('active') !== 'false';
    const [suppressionData, eventData] = await Promise.all([
      kgEmailRequest(`${KG_EMAIL_HEALTH_API}/suppressions?${new URLSearchParams({ q, active: String(active), limit: '200' })}`),
      kgEmailRequest(`${KG_EMAIL_HEALTH_API}/events?limit=100`),
    ]);
    const stats = suppressionData.stats;
    content.innerHTML = `<div class="kg-admin-shell kg-email-health-shell">
      <section class="kg-email-health-hero"><div><div class="kg-admin-eyebrow">Kuklabs Operations · Recipient safety</div><h1>Email delivery health</h1><p>Review signed provider events and prevent repeated delivery to invalid or complaint-reporting recipients.</p></div><div class="kg-email-health-toolbar"><button class="btn btn-ghost" type="button" data-email-admin-home>Admin home</button></div></section>
      <div class="kg-email-health-grid">${metric('Active suppressions', stats.active)}${metric('Hard bounces', stats.hardBounces)}${metric('Complaints', stats.complaints)}${metric('Soft-bounce thresholds', stats.softBounceSuppressions)}</div>
      <section class="card"><div class="card-header"><div><h2>Recipient suppressions</h2><p>Unsuppress only after the address and recipient consent are verified.</p></div></div><div class="card-body"><form class="kg-email-health-toolbar" id="kg-email-health-filter"><div class="field"><label>Search email</label><input class="input" name="q" value="${kgEmailEscape(q)}" maxlength="120" /></div><div class="field"><label>State</label><select class="select" name="active"><option value="true" ${active ? 'selected' : ''}>Active only</option><option value="false" ${active ? '' : 'selected'}>All history</option></select></div><button class="btn btn-primary" type="submit">Apply</button></form><div class="kg-email-health-list" style="margin-top:16px">${suppressionRows(suppressionData.suppressions)}</div></div></section>
      <section class="card"><div class="card-header"><div><h2>Recent provider events</h2><p>Payload bodies are not retained; only normalized metadata and SHA-256 evidence are stored.</p></div></div><div class="card-body"><div class="kg-email-health-list">${eventRows(eventData.events)}</div></div></section>
    </div>`;
    content.querySelector('[data-email-admin-home]')?.addEventListener('click', () => { location.hash = '#/instance-admin'; });
    content.querySelector('#kg-email-health-filter')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      location.hash = `#/instance-admin/email-health?${new URLSearchParams(data)}`;
    });
    content.querySelectorAll('[data-email-unsuppress]').forEach((button) => button.addEventListener('click', async () => {
      const email = button.dataset.emailUnsuppress;
      const confirmEmail = window.prompt(`Type the exact email address to confirm:\n${email}`);
      if (confirmEmail === null) return;
      const note = window.prompt('Document why delivery is safe to resume (minimum 3 characters):');
      if (note === null) return;
      button.disabled = true;
      try {
        await kgEmailRequest(`${KG_EMAIL_HEALTH_API}/suppressions/${encodeURIComponent(email)}/unsuppress`, {
          method: 'POST',
          body: { confirmEmail, note },
        });
        kgEmailToast('Recipient unsuppressed', `${email} may receive newly queued messages.`);
        kgEmailHealthKey = '';
        await renderKgEmailHealth();
      } catch (error) {
        kgEmailToast('Unsuppress failed', error.message, 'error');
        button.disabled = false;
      }
    }));
    kgEmailHealthKey = key;
  } catch (error) {
    content.innerHTML = `<div class="kg-admin-shell kg-email-health-shell"><section class="card"><div class="kg-email-health-empty"><b>${kgEmailEscape(error.message)}</b><br /><button class="btn btn-ghost" type="button" onclick="location.hash='#/instance-admin'">Return to Admin</button></div></section></div>`;
  } finally {
    kgEmailHealthRendering = false;
  }
}

function addKgEmailHealthEntry() {
  if (kgEmailRouteActive()) return;
  const overview = document.querySelector('.kg-admin-shell');
  if (!overview || document.querySelector('[data-email-health-entry]')) return;
  const toolbar = overview.querySelector('.kg-admin-hero .kg-admin-toolbar');
  if (!toolbar) return;
  const button = document.createElement('button');
  button.className = 'btn';
  button.type = 'button';
  button.dataset.emailHealthEntry = 'true';
  button.textContent = 'Email health';
  button.addEventListener('click', () => { location.hash = '#/instance-admin/email-health'; });
  toolbar.prepend(button);
}

async function reconcileKgEmailHealth() {
  kgEmailHealthQueued = false;
  if (kgEmailRouteActive()) await renderKgEmailHealth();
  else addKgEmailHealthEntry();
}

function scheduleKgEmailHealth() {
  if (kgEmailHealthQueued) return;
  kgEmailHealthQueued = true;
  queueMicrotask(reconcileKgEmailHealth);
}

installKgEmailStyles();
window.addEventListener('hashchange', () => {
  kgEmailHealthKey = '';
  scheduleKgEmailHealth();
});
new MutationObserver(scheduleKgEmailHealth).observe(document.documentElement, { childList: true, subtree: true });
scheduleKgEmailHealth();
