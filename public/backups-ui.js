const BACKUPS_API = '/api/backups';
let backupRenderKey = '';
let backupRefusedKey = '';
let backupScheduled = false;

function backupEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function backupNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${backupEscape(title)}</b><span>${backupEscape(message)}</span></div>`;
  root.append(element);
  setTimeout(() => element.remove(), 4800);
}

async function backupRequest(path, options = {}) {
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

function settingsRoute() {
  const [path] = location.hash.slice(1).split('?');
  return path.split('/').filter(Boolean)[0] === 'settings';
}

function backupDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function backupBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function backupStyles() {
  if (document.querySelector('#kg-backup-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-backup-styles';
  style.textContent = `
    .kg-backups { margin-top:18px; }
    .kg-backup-status { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-bottom:16px; }
    .kg-backup-metric { border:1px solid var(--border); border-radius:13px; padding:13px; background:rgba(255,255,255,.018); }
    .kg-backup-metric b { display:block; font-size:18px; margin-top:5px; }
    .kg-backup-actions { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:15px; }
    .kg-backup-row { display:grid; grid-template-columns:minmax(220px,1fr) minmax(160px,.65fr) minmax(180px,.75fr) auto; gap:14px; align-items:center; padding:14px 0; border-top:1px solid var(--border); }
    .kg-backup-row:first-child { border-top:0; }
    .kg-backup-hash { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; color:var(--muted); overflow-wrap:anywhere; }
    .kg-backup-policy { display:grid; grid-template-columns:1fr 1fr auto; gap:10px; align-items:end; padding:14px; border:1px solid var(--border); border-radius:14px; background:rgba(255,255,255,.018); margin-top:16px; }
    .kg-backup-empty { text-align:center; color:var(--muted); padding:28px 10px; }
    @media (max-width:900px) { .kg-backup-status { grid-template-columns:1fr; } .kg-backup-row { grid-template-columns:1fr; } .kg-backup-policy { grid-template-columns:1fr; } }
  `;
  document.head.append(style);
}

function backupRow(record) {
  const totals = record.totals || {};
  return `<article class="kg-backup-row" data-backup-file="${backupEscape(record.filename)}"><div><b>${backupEscape(record.filename)}</b><div class="muted" style="font-size:11px">Created ${backupDate(record.createdAt)} · ${totals.repositories ?? '—'} repositories · ${totals.refs ?? '—'} refs</div><div class="kg-backup-hash">${backupEscape(record.archiveSha256 || 'Checksum unavailable')}</div></div><div><span class="badge ${record.available ? 'public' : 'critical'}">${record.available ? 'Available' : 'Missing'}</span><div class="muted" style="font-size:11px;margin-top:5px">${backupBytes(record.archiveSize)}</div></div><div class="muted" style="font-size:11px">Last verified<br /><b>${backupDate(record.verifiedAt)}</b></div><div>${record.available ? '<button class="btn kg-verify-backup">Verify archive</button>' : ''}</div></article>`;
}

function panelMarkup(data) {
  const latest = data.backups[0];
  const maintenance = data.maintenance || { enabled: false };
  return `<section class="card kg-backups" id="kg-backups-panel"><div class="card-header"><div><h2>Verified backups and recovery</h2><p>Portable SQLite and Git bundle snapshots for disaster recovery.</p></div><span class="badge ${maintenance.enabled ? 'high' : 'public'}">${maintenance.enabled ? 'Maintenance on' : 'Writes enabled'}</span></div><div class="card-body"><div class="kg-backup-status"><div class="kg-backup-metric"><span class="muted">Snapshots</span><b>${data.backups.length}</b></div><div class="kg-backup-metric"><span class="muted">Latest verified</span><b style="font-size:13px">${latest ? backupDate(latest.verifiedAt) : 'No backup'}</b></div><div class="kg-backup-metric"><span class="muted">Retention policy</span><b style="font-size:13px">${data.policy.retentionCount} snapshots / ${data.policy.retentionDays} days</b></div></div>${maintenance.enabled ? `<div class="login-demo"><b>Maintenance mode</b><br />${backupEscape(maintenance.reason)} · enabled ${backupDate(maintenance.enabledAt)}. Read operations remain available while writes and Git pushes are blocked.</div>` : ''}<div class="kg-backup-actions"><button class="btn btn-primary" id="kg-create-backup">Create and verify backup</button><button class="btn" id="kg-refresh-backups">Refresh status</button></div><div id="kg-backup-list">${data.backups.length ? data.backups.map(backupRow).join('') : '<div class="kg-backup-empty">No verified backup snapshots exist yet.</div>'}</div><form class="kg-backup-policy" id="kg-prune-backups"><div class="field"><label>Keep at least</label><input class="input" type="number" name="keep" min="1" max="10000" value="${data.policy.retentionCount}" required /></div><div class="field"><label>Remove older than days</label><input class="input" type="number" name="days" min="1" max="36500" value="${data.policy.retentionDays}" required /></div><button class="btn btn-ghost" type="submit">Prune old snapshots</button></form><div class="login-demo" style="margin-top:14px"><b>Restore safety</b><br />Full restore is intentionally CLI-only and writes to a missing or empty data directory. Run <code>npm run backup -- restore --archive &lt;file&gt; --target &lt;empty-dir&gt; --dry-run</code> before a real restore.</div></div></section>`;
}

function bindBackupPanel(data) {
  document.querySelector('#kg-create-backup')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = 'Creating snapshot…';
    try {
      const payload = await backupRequest(BACKUPS_API, { method: 'POST' });
      backupNotify('Verified backup created', `${payload.backup.filename} passed database, checksum and Git bundle verification.`);
      await mountBackups(true);
    } catch (error) {
      backupNotify('Backup failed', error.message, 'error');
      event.currentTarget.disabled = false;
      event.currentTarget.textContent = 'Create and verify backup';
    }
  });
  document.querySelector('#kg-refresh-backups')?.addEventListener('click', () => mountBackups(true));
  document.querySelectorAll('.kg-verify-backup').forEach((button) => button.addEventListener('click', async () => {
    const row = button.closest('[data-backup-file]');
    button.disabled = true;
    button.textContent = 'Verifying…';
    try {
      const payload = await backupRequest(`${BACKUPS_API}/${encodeURIComponent(row.dataset.backupFile)}/verify`, { method: 'POST' });
      backupNotify('Backup verified', `${payload.verification.filename} is valid with ${payload.verification.verifiedRefs} Git refs.`);
      await mountBackups(true);
    } catch (error) {
      backupNotify('Verification failed', error.message, 'error');
      button.disabled = false;
      button.textContent = 'Verify archive';
    }
  }));
  document.querySelector('#kg-prune-backups')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    if (!window.confirm('Prune snapshots that fall outside this retention policy?')) return;
    const values = new FormData(form);
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const payload = await backupRequest(`${BACKUPS_API}/prune`, { method: 'POST', body: { keep: Number(values.get('keep')), days: Number(values.get('days')) } });
      backupNotify('Backup retention applied', `${payload.result.removed.length} old snapshot(s) removed.`);
      await mountBackups(true);
    } catch (error) {
      backupNotify('Prune failed', error.message, 'error');
      button.disabled = false;
    }
  });
}

async function mountBackups(force = false) {
  if (!settingsRoute()) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const key = location.hash;
  if (!force && backupRenderKey === key && document.querySelector('#kg-backups-panel')) return;
  // A refusal renders no panel, so the guard above can never be satisfied by
  // one. Without remembering it, everybody who is not an instance administrator
  // re-asks on every DOM change the settings page makes — which is most of
  // them, since half a dozen other modules render there too.
  if (!force && backupRefusedKey === key) return;
  backupRenderKey = key;
  backupStyles();
  try {
    const data = await backupRequest(BACKUPS_API);
    document.querySelector('#kg-backups-panel')?.remove();
    content.insertAdjacentHTML('beforeend', panelMarkup(data));
    bindBackupPanel(data);
  } catch (error) {
    if (error.status === 403 || error.status === 401) { backupRefusedKey = key; return; }
    if (!document.querySelector('#kg-backups-panel')) content.insertAdjacentHTML('beforeend', `<section class="card kg-backups" id="kg-backups-panel"><div class="card-body kg-backup-empty">${backupEscape(error.message)}</div></section>`);
  }
}

function scheduleBackups() {
  if (backupScheduled) return;
  backupScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    backupScheduled = false;
    await mountBackups();
  }));
}

window.addEventListener('hashchange', scheduleBackups);
new MutationObserver(scheduleBackups).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleBackups();
