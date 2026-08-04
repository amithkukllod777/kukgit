const KG_ADMIN_API = '/api/instance-admin';
let kgAdminStatus = null;
let kgAdminStatusRequest = null;
let kgAdminRenderKey = '';
let kgAdminRendering = false;
let kgAdminObserverQueued = false;

function kgAdminEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function kgAdminDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function kgAdminBytes(value = 0) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function kgAdminToast(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${kgAdminEscape(title)}</b><span>${kgAdminEscape(message)}</span></div>`;
  root.append(element);
  setTimeout(() => element.remove(), 4600);
}

async function kgAdminRequest(path, options = {}) {
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
    error.status = response.status;
    error.requestId = payload?.error?.requestId;
    throw error;
  }
  return payload;
}

function kgAdminRoute() {
  const raw = location.hash.slice(1) || '/';
  const [path, query = ''] = raw.split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { path, segments, query: new URLSearchParams(query) };
}

function kgAdminRouteActive() {
  return kgAdminRoute().segments[0] === 'instance-admin';
}

function kgAdminNavigate(path) {
  location.hash = path.startsWith('#') ? path : `#${path}`;
}

function installKgAdminStyles() {
  if (document.querySelector('#kg-instance-admin-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-instance-admin-styles';
  style.textContent = `
    .kg-admin-shell { display:grid; gap:18px; }
    .kg-admin-hero { border:1px solid rgba(21,152,255,.28); background:linear-gradient(135deg,rgba(21,152,255,.12),rgba(167,40,255,.08)); border-radius:16px; padding:22px; display:flex; justify-content:space-between; gap:18px; align-items:flex-start; }
    .kg-admin-hero h1 { margin:5px 0 7px; font-size:28px; }
    .kg-admin-eyebrow { color:var(--accent); font-size:10px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; }
    .kg-admin-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
    .kg-admin-metric { padding:17px; border:1px solid var(--border); background:var(--panel); border-radius:14px; min-height:116px; }
    .kg-admin-metric span { display:block; color:var(--muted); font-size:11px; }
    .kg-admin-metric b { display:block; font-size:26px; margin:10px 0 7px; }
    .kg-admin-metric small { color:var(--muted); line-height:1.45; }
    .kg-admin-two { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(300px,.8fr); gap:18px; }
    .kg-admin-search { display:grid; grid-template-columns:minmax(220px,1fr) 160px auto; gap:9px; align-items:end; }
    .kg-admin-section-title { display:flex; justify-content:space-between; gap:12px; align-items:center; margin:0 0 12px; }
    .kg-admin-section-title h2,.kg-admin-section-title h3 { margin:0; }
    .kg-admin-list { display:grid; gap:8px; }
    .kg-admin-row { display:grid; grid-template-columns:minmax(180px,1.3fr) minmax(120px,.7fr) minmax(120px,.7fr) auto; gap:12px; align-items:center; padding:12px; border:1px solid var(--border); border-radius:12px; background:rgba(255,255,255,.018); }
    .kg-admin-row b { display:block; }
    .kg-admin-row span,.kg-admin-meta { color:var(--muted); font-size:11px; line-height:1.45; }
    .kg-admin-tabs { display:flex; gap:7px; flex-wrap:wrap; margin-bottom:14px; }
    .kg-admin-tab { border:1px solid var(--border); background:transparent; color:var(--muted); border-radius:999px; padding:8px 12px; cursor:pointer; }
    .kg-admin-tab.active { color:var(--text); border-color:rgba(21,152,255,.5); background:rgba(21,152,255,.12); }
    .kg-admin-detail-grid { display:grid; grid-template-columns:minmax(0,1.3fr) minmax(300px,.7fr); gap:18px; }
    .kg-admin-kv { display:grid; grid-template-columns:150px minmax(0,1fr); gap:10px; padding:9px 0; border-top:1px solid var(--border); }
    .kg-admin-kv:first-child { border-top:0; }
    .kg-admin-kv span:first-child { color:var(--muted); }
    .kg-admin-event { padding:12px 0; border-top:1px solid var(--border); }
    .kg-admin-event:first-child { border-top:0; }
    .kg-admin-event code { display:block; margin-top:7px; padding:9px; border-radius:9px; background:rgba(0,0,0,.2); white-space:pre-wrap; overflow-wrap:anywhere; color:var(--muted); font-size:10px; }
    .kg-admin-danger { border-color:rgba(255,94,112,.3); }
    .kg-admin-empty { text-align:center; padding:24px 10px; color:var(--muted); }
    .kg-admin-toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .kg-admin-toolbar .input { min-width:240px; }
    .kg-admin-note-form { display:grid; gap:9px; }
    .kg-admin-note-form textarea { min-height:100px; resize:vertical; }
    @media(max-width:1080px){ .kg-admin-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.kg-admin-two,.kg-admin-detail-grid{grid-template-columns:1fr} }
    @media(max-width:680px){ .kg-admin-grid{grid-template-columns:1fr}.kg-admin-search,.kg-admin-row{grid-template-columns:1fr}.kg-admin-hero{flex-direction:column}.kg-admin-kv{grid-template-columns:1fr}.kg-admin-toolbar .input{min-width:0;width:100%} }
  `;
  document.head.append(style);
}

/**
 * Whether this session is an instance administrator.
 *
 * The first ask happens while the module loads, which is the sign-in page —
 * signed out, so the server says 401. Recording that as "not an admin" is what
 * kept the Instance Admin link hidden for the founder: signing in never asked
 * again, because a cached `false` is still an answer. Only a full page reload
 * cleared it, and signing in does not reload.
 *
 * So 401 means "not known yet" and is not remembered. 403 is a real answer from
 * a real session and is. Concurrent callers share one request, because the
 * observer below fires on every DOM change.
 */
async function loadKgAdminStatus() {
  if (kgAdminStatus !== null) return kgAdminStatus;
  if (kgAdminStatusRequest) return kgAdminStatusRequest;
  kgAdminStatusRequest = (async () => {
    try {
      kgAdminStatus = await kgAdminRequest(`${KG_ADMIN_API}/status`);
    } catch (error) {
      kgAdminStatus = error.status === 401 ? null : false;
    } finally {
      kgAdminStatusRequest = null;
    }
    return kgAdminStatus ?? false;
  })();
  return kgAdminStatusRequest;
}

function installAdminNavigation() {
  if (!kgAdminStatus || document.querySelector('[data-kg-admin-nav]')) return;
  const manageSections = [...document.querySelectorAll('.sidebar-section')];
  const manage = manageSections.find((node) => node.textContent.trim() === 'Manage');
  const nav = manage?.nextElementSibling;
  if (!nav?.classList.contains('nav')) return;
  const button = document.createElement('button');
  button.className = `nav-link ${kgAdminRouteActive() ? 'active' : ''}`;
  button.dataset.kgAdminNav = 'true';
  button.innerHTML = '<span class="nav-icon">⌘</span>Instance Admin';
  button.addEventListener('click', () => kgAdminNavigate('#/instance-admin'));
  nav.append(button);
}

function adminHero(title, subtitle, actions = '') {
  return `<section class="kg-admin-hero"><div><div class="kg-admin-eyebrow">Kuklabs Operations · Read-only by default</div><h1>${kgAdminEscape(title)}</h1><p>${kgAdminEscape(subtitle)}</p></div><div class="kg-admin-toolbar">${actions}<button class="btn btn-ghost" data-admin-home>Admin home</button></div></section>`;
}

function metric(label, value, copy) {
  return `<div class="kg-admin-metric"><span>${kgAdminEscape(label)}</span><b>${kgAdminEscape(value)}</b><small>${kgAdminEscape(copy)}</small></div>`;
}

function statusBadge(value) {
  const normalized = String(value || 'unknown').toLowerCase();
  const kind = ['active', 'success', 'sent', 'completed'].includes(normalized)
    ? 'public'
    : ['pending', 'processing', 'expiring', 'open'].includes(normalized)
      ? 'open'
      : ['failure', 'failed', 'cancelled', 'trashed'].includes(normalized)
        ? 'critical'
        : 'private';
  return `<span class="badge ${kind}">${kgAdminEscape(normalized)}</span>`;
}

function bindAdminCommon() {
  document.querySelectorAll('[data-admin-home]').forEach((button) => button.addEventListener('click', () => kgAdminNavigate('#/instance-admin')));
  installAdminNavigation();
}

async function renderAdminOverview(content) {
  const { overview } = await kgAdminRequest(`${KG_ADMIN_API}/overview`);
  content.innerHTML = `<div class="kg-admin-shell">
    ${adminHero('Instance Administration', 'Diagnose tenant, delivery, storage and identity issues without impersonating users.', '<button class="btn" data-admin-audit>Audit lookup</button>')}
    <div class="kg-admin-grid">
      ${metric('Users', overview.users.total, `${overview.users.centralLinked} linked to One Kuklabs Account`)}
      ${metric('Organizations', overview.organizations.total, 'Active tenant workspaces')}
      ${metric('Repositories', overview.repositories.total, `${overview.repositories.active} active · ${overview.repositories.archived} archived · ${overview.repositories.trashed} trashed`)}
      ${metric('External access', overview.externalAccess.total, `${overview.externalAccess.expiring} expiring · ${overview.externalAccess.permanent} permanent`)}
      ${metric('Email failures', overview.email.failed, `${overview.email.pending} pending · ${overview.email.sent} sent`)}
      ${metric('Webhook failures', overview.webhooks.failure, `${overview.webhooks.pending} pending · ${overview.webhooks.success} successful`)}
      ${metric('Git LFS storage', kgAdminBytes(overview.lfs.bytes), `${overview.lfs.objects} physical objects`)}
      ${metric('Verified backups', overview.backups.count, overview.backups.latest ? `Latest ${kgAdminDate(overview.backups.latest.modifiedAt)}` : 'No snapshot found')}
    </div>
    <section class="card"><div class="card-header"><div><h2>Global tenant search</h2><p>Search by name, slug, email or exact internal ID.</p></div><span class="badge public">Bounded results</span></div><div class="card-body">
      <form class="kg-admin-search" id="kg-admin-search"><div class="field"><label>Search</label><input class="input" name="q" minlength="2" maxlength="100" placeholder="Organization, repository, user or ID" required /></div><div class="field"><label>Type</label><select class="select" name="type"><option value="all">All</option><option value="organizations">Organizations</option><option value="users">Users</option><option value="repositories">Repositories</option></select></div><button class="btn btn-primary" type="submit">Search</button></form>
      <div id="kg-admin-search-results" style="margin-top:16px"><div class="kg-admin-empty">Enter at least two characters to search the instance.</div></div>
    </div></section>
    <section class="card"><div class="card-header"><div><h3>Operational posture</h3><p>Support actions require explicit confirmation and generate audit events.</p></div></div><div class="card-body"><div class="kg-admin-kv"><span>Audit activity</span><b>${overview.audit.last24Hours} events in the last 24 hours</b></div><div class="kg-admin-kv"><span>Support mode</span><b>No silent impersonation or credential access</b></div><div class="kg-admin-kv"><span>Generated</span><b>${kgAdminDate(overview.generatedAt)}</b></div></div></section>
  </div>`;
  bindAdminCommon();
  content.querySelector('[data-admin-audit]')?.addEventListener('click', () => kgAdminNavigate('#/instance-admin/audit'));
  content.querySelector('#kg-admin-search')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const root = content.querySelector('#kg-admin-search-results');
    root.innerHTML = '<div class="kg-admin-empty">Searching…</div>';
    try {
      const query = new URLSearchParams({ q: form.get('q'), type: form.get('type'), pageSize: '25' });
      const { results } = await kgAdminRequest(`${KG_ADMIN_API}/search?${query}`);
      root.innerHTML = searchResultsMarkup(results);
      bindSearchResults(root);
    } catch (error) {
      root.innerHTML = `<div class="kg-admin-empty">${kgAdminEscape(error.message)}</div>`;
    }
  });
}

function searchResultsMarkup(results) {
  const users = results.users.map((user) => `<div class="kg-admin-row"><div><b>${kgAdminEscape(user.displayName)}</b><span>${kgAdminEscape(user.email)}</span></div><div>${user.centralLinked ? statusBadge('central') : statusBadge(user.authSource)}</div><div class="kg-admin-meta">${user.organizationCount} organizations · ${user.directRepositoryCount} direct repos</div><button class="btn btn-ghost" data-admin-user="${kgAdminEscape(user.id)}">Open</button></div>`).join('');
  const organizations = results.organizations.map((org) => `<div class="kg-admin-row"><div><b>${kgAdminEscape(org.name)}</b><span>${kgAdminEscape(org.slug)}</span></div><div>${statusBadge(org.plan)}</div><div class="kg-admin-meta">${org.memberCount} members · ${org.repositoryCount} repositories</div><button class="btn btn-ghost" data-admin-org="${kgAdminEscape(org.slug)}">Open</button></div>`).join('');
  const repositories = results.repositories.map((repo) => `<div class="kg-admin-row"><div><b>${kgAdminEscape(repo.name)}</b><span>${kgAdminEscape(repo.orgSlug)}/${kgAdminEscape(repo.slug)}</span></div><div>${statusBadge(repo.deletedAt ? 'trashed' : repo.archivedAt ? 'archived' : repo.visibility)}</div><div class="kg-admin-meta">Updated ${kgAdminDate(repo.updatedAt)}</div><button class="btn btn-ghost" data-admin-org="${kgAdminEscape(repo.orgSlug)}">Tenant</button></div>`).join('');
  if (!users && !organizations && !repositories) return '<div class="kg-admin-empty">No matching instance records.</div>';
  return `${organizations ? `<div class="kg-admin-section-title"><h3>Organizations</h3></div><div class="kg-admin-list">${organizations}</div>` : ''}${users ? `<div class="kg-admin-section-title" style="margin-top:18px"><h3>Users</h3></div><div class="kg-admin-list">${users}</div>` : ''}${repositories ? `<div class="kg-admin-section-title" style="margin-top:18px"><h3>Repositories</h3></div><div class="kg-admin-list">${repositories}</div>` : ''}`;
}

function bindSearchResults(root) {
  root.querySelectorAll('[data-admin-org]').forEach((button) => button.addEventListener('click', () => kgAdminNavigate(`#/instance-admin/organizations/${encodeURIComponent(button.dataset.adminOrg)}`)));
  root.querySelectorAll('[data-admin-user]').forEach((button) => button.addEventListener('click', () => kgAdminNavigate(`#/instance-admin/users/${encodeURIComponent(button.dataset.adminUser)}`)));
}

function repositoryRows(rows) {
  if (!rows.length) return '<div class="kg-admin-empty">No repositories in this tenant.</div>';
  return rows.map((repo) => `<div class="kg-admin-row"><div><b>${kgAdminEscape(repo.name)}</b><span>${kgAdminEscape(repo.slug)} · ${kgAdminEscape(repo.visibility)}</span></div><div>${statusBadge(repo.deletedAt ? 'trashed' : repo.archivedAt ? 'archived' : 'active')}</div><div class="kg-admin-meta">${repo.issueCount} issues · ${repo.pullRequestCount} PRs · ${repo.directCollaboratorCount} direct grants<br />${repo.lfsObjectCount} LFS objects · ${kgAdminBytes(repo.lfsBytes)}</div><button class="btn btn-ghost" data-route-repo="${kgAdminEscape(repo.slug)}">Open repo</button></div>`).join('');
}

function memberRows(rows) {
  if (!rows.length) return '<div class="kg-admin-empty">No organization members.</div>';
  return rows.map((member) => `<div class="kg-admin-row"><div><b>${kgAdminEscape(member.displayName)}</b><span>${kgAdminEscape(member.email)}</span></div><div>${statusBadge(member.role)}</div><div class="kg-admin-meta">${member.centralLinked ? 'One Kuklabs Account linked' : 'Local/development identity'}<br />Joined ${kgAdminDate(member.joinedAt)}</div><button class="btn btn-ghost" data-admin-user="${kgAdminEscape(member.id)}">User</button></div>`).join('');
}

function externalRows(rows) {
  if (!rows.length) return '<div class="kg-admin-empty">No active external repository grants.</div>';
  return rows.map((grant) => `<div class="kg-admin-row"><div><b>${kgAdminEscape(grant.displayName)}</b><span>${kgAdminEscape(grant.email)} · ${kgAdminEscape(grant.repoSlug)}</span></div><div>${statusBadge(grant.permission)}</div><div class="kg-admin-meta">Expires ${kgAdminDate(grant.expiresAt)}<br />Reviewed ${kgAdminDate(grant.lastReviewedAt)}</div><button class="btn btn-ghost" data-admin-user="${kgAdminEscape(grant.userId)}">User</button></div>`).join('');
}

function failuresMarkup(emailFailures, webhookFailures) {
  const email = emailFailures.map((item) => `<div class="kg-admin-row kg-admin-danger"><div><b>${kgAdminEscape(item.subject)}</b><span>${kgAdminEscape(item.toEmail)} · ${kgAdminEscape(item.category)}</span></div><div>${statusBadge(item.status)}</div><div class="kg-admin-meta">${item.attemptCount} attempts · ${kgAdminEscape(item.lastError || 'Unknown error')}<br />${kgAdminDate(item.updatedAt)}</div><button class="btn" data-retry-email="${kgAdminEscape(item.id)}">Retry</button></div>`).join('');
  const webhooks = webhookFailures.map((item) => `<div class="kg-admin-row kg-admin-danger"><div><b>${kgAdminEscape(item.event)} webhook</b><span>${kgAdminEscape(item.repoSlug)} · HTTP ${kgAdminEscape(item.responseStatus || '—')}</span></div><div>${statusBadge(item.status)}</div><div class="kg-admin-meta">${item.attemptCount} attempts · ${kgAdminEscape(item.lastError || 'Unknown error')}<br />${kgAdminDate(item.updatedAt)}</div><button class="btn" data-retry-webhook="${kgAdminEscape(item.id)}">Retry</button></div>`).join('');
  return `${email ? `<h3>Failed email delivery</h3><div class="kg-admin-list">${email}</div>` : ''}${webhooks ? `<h3 style="margin-top:18px">Failed webhooks</h3><div class="kg-admin-list">${webhooks}</div>` : ''}${!email && !webhooks ? '<div class="kg-admin-empty">No failed delivery requires tenant support.</div>' : ''}`;
}

function activityMarkup(rows) {
  if (!rows.length) return '<div class="kg-admin-empty">No recent tenant activity.</div>';
  return rows.map((event) => `<div class="kg-admin-event"><b>${kgAdminEscape(event.action)}</b><div class="kg-admin-meta">${kgAdminEscape(event.userName || 'System')} · ${kgAdminDate(event.createdAt)} · ${kgAdminEscape(event.id)}</div><code>${kgAdminEscape(JSON.stringify(event.metadata || {}, null, 2))}</code></div>`).join('');
}

async function renderOrganization(content, slug) {
  const data = await kgAdminRequest(`${KG_ADMIN_API}/organizations/${encodeURIComponent(slug)}`);
  const org = data.organization;
  content.innerHTML = `<div class="kg-admin-shell">
    ${adminHero(org.name, `${org.slug} · ${org.plan} plan · created ${kgAdminDate(org.createdAt)}`, '<button class="btn" data-admin-audit-org>Tenant audit</button>')}
    <div class="kg-admin-detail-grid"><div class="kg-admin-shell">
      <section class="card"><div class="card-header"><div><h2>Repositories</h2><p>Tenant-scoped code, collaboration and LFS usage.</p></div><span class="badge public">${data.repositories.length}</span></div><div class="card-body"><div class="kg-admin-list">${repositoryRows(data.repositories)}</div></div></section>
      <section class="card"><div class="card-header"><div><h2>Members</h2><p>Organization membership only; no passwords or sessions exposed.</p></div></div><div class="card-body"><div class="kg-admin-list">${memberRows(data.members)}</div></div></section>
      <section class="card"><div class="card-header"><div><h2>External access</h2><p>Repository-only client, agency and contractor grants.</p></div></div><div class="card-body"><div class="kg-admin-list">${externalRows(data.externalAccess)}</div></div></section>
      <section class="card"><div class="card-header"><div><h2>Delivery failures</h2><p>Retry requires typing the exact delivery ID and creates an audit event.</p></div></div><div class="card-body" id="kg-admin-failures">${failuresMarkup(data.emailFailures, data.webhookFailures)}</div></section>
      <section class="card"><div class="card-header"><div><h2>Recent audit activity</h2><p>Metadata is recursively redacted before display.</p></div></div><div class="card-body">${activityMarkup(data.activity)}</div></section>
    </div><aside class="kg-admin-shell">
      <section class="card"><div class="card-header"><div><h3>Tenant profile</h3></div></div><div class="card-body"><div class="kg-admin-kv"><span>Description</span><b>${kgAdminEscape(org.description || '—')}</b></div><div class="kg-admin-kv"><span>Website</span><b>${kgAdminEscape(org.websiteUrl || '—')}</b></div><div class="kg-admin-kv"><span>Company size</span><b>${kgAdminEscape(org.companySize || '—')}</b></div><div class="kg-admin-kv"><span>Onboarding</span><b>${org.onboardingCompletedAt ? kgAdminDate(org.onboardingCompletedAt) : 'Incomplete'}</b></div></div></section>
      <section class="card"><div class="card-header"><div><h3>Support note</h3><p>Notes are visible only to instance administrators.</p></div></div><div class="card-body"><form class="kg-admin-note-form" id="kg-admin-note-form"><textarea class="input" name="note" maxlength="4000" placeholder="Diagnosis, customer confirmation or next action" required></textarea><div class="field"><label>Type ${kgAdminEscape(org.slug)} to confirm</label><input class="input" name="confirm" autocomplete="off" required /></div><button class="btn btn-primary" type="submit">Add support note</button></form></div></section>
      <section class="card"><div class="card-header"><div><h3>Support notes</h3></div></div><div class="card-body" id="kg-admin-notes">${data.notes.length ? data.notes.map((note) => `<div class="kg-admin-event"><b>${kgAdminEscape(note.authorName)}</b><div class="kg-admin-meta">${kgAdminDate(note.createdAt)}</div><p>${kgAdminEscape(note.body)}</p></div>`).join('') : '<div class="kg-admin-empty">No support notes.</div>'}</div></section>
    </aside></div>
  </div>`;
  bindAdminCommon();
  content.querySelector('[data-admin-audit-org]')?.addEventListener('click', () => kgAdminNavigate(`#/instance-admin/audit?org=${encodeURIComponent(org.slug)}`));
  content.querySelectorAll('[data-admin-user]').forEach((button) => button.addEventListener('click', () => kgAdminNavigate(`#/instance-admin/users/${encodeURIComponent(button.dataset.adminUser)}`)));
  content.querySelectorAll('[data-route-repo]').forEach((button) => button.addEventListener('click', () => kgAdminNavigate(`#/repo/${encodeURIComponent(org.slug)}/${encodeURIComponent(button.dataset.routeRepo)}/code`)));
  content.querySelector('#kg-admin-note-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(event.currentTarget));
      await kgAdminRequest(`${KG_ADMIN_API}/organizations/${encodeURIComponent(org.slug)}/notes`, { method: 'POST', body });
      kgAdminToast('Support note added', 'The tenant support record was saved and audited.');
      kgAdminRenderKey = '';
      await renderKgAdminRoute();
    } catch (error) {
      kgAdminToast('Unable to add note', error.message, 'error');
      button.disabled = false;
    }
  });
  bindRetryButtons(content, org.slug);
}

function bindRetryButtons(content, orgSlug) {
  content.querySelectorAll('[data-retry-email]').forEach((button) => button.addEventListener('click', async () => {
    const id = button.dataset.retryEmail;
    const confirm = window.prompt(`Type the email delivery ID to retry:\n${id}`);
    if (confirm === null) return;
    button.disabled = true;
    try {
      await kgAdminRequest(`${KG_ADMIN_API}/email/${encodeURIComponent(id)}/retry`, { method: 'POST', body: { confirm } });
      kgAdminToast('Email retry queued', `Delivery ${id} returned to the email queue.`);
      kgAdminRenderKey = '';
      kgAdminNavigate(`#/instance-admin/organizations/${encodeURIComponent(orgSlug)}`);
      await renderKgAdminRoute();
    } catch (error) {
      kgAdminToast('Email retry failed', error.message, 'error');
      button.disabled = false;
    }
  }));
  content.querySelectorAll('[data-retry-webhook]').forEach((button) => button.addEventListener('click', async () => {
    const id = button.dataset.retryWebhook;
    const confirm = window.prompt(`Type the webhook delivery ID to retry:\n${id}`);
    if (confirm === null) return;
    button.disabled = true;
    try {
      await kgAdminRequest(`${KG_ADMIN_API}/webhooks/${encodeURIComponent(id)}/retry`, { method: 'POST', body: { confirm } });
      kgAdminToast('Webhook retry queued', `Delivery ${id} returned to the webhook queue.`);
      kgAdminRenderKey = '';
      await renderKgAdminRoute();
    } catch (error) {
      kgAdminToast('Webhook retry failed', error.message, 'error');
      button.disabled = false;
    }
  }));
}

async function renderUser(content, userId) {
  const data = await kgAdminRequest(`${KG_ADMIN_API}/users/${encodeURIComponent(userId)}`);
  const user = data.user;
  content.innerHTML = `<div class="kg-admin-shell">
    ${adminHero(user.displayName, `${user.email} · created ${kgAdminDate(user.createdAt)}`)}
    <div class="kg-admin-grid">${metric('Organizations', data.memberships.length, 'Current tenant memberships')}${metric('Direct repositories', data.directAccess.length, 'Direct repository grants')}${metric('Active PATs', data.security.activePersonalAccessTokens, 'Counts only; no token material')}${metric('Active SSH keys', data.security.activeSshKeys, 'Public-key records only')}</div>
    <div class="kg-admin-detail-grid"><div class="kg-admin-shell"><section class="card"><div class="card-header"><div><h2>Organization memberships</h2></div></div><div class="card-body"><div class="kg-admin-list">${data.memberships.length ? data.memberships.map((item) => `<div class="kg-admin-row"><div><b>${kgAdminEscape(item.name)}</b><span>${kgAdminEscape(item.slug)}</span></div><div>${statusBadge(item.role)}</div><div class="kg-admin-meta">Joined ${kgAdminDate(item.joinedAt)}</div><button class="btn btn-ghost" data-admin-org="${kgAdminEscape(item.slug)}">Tenant</button></div>`).join('') : '<div class="kg-admin-empty">No memberships.</div>'}</div></div></section><section class="card"><div class="card-header"><div><h2>Direct repository access</h2></div></div><div class="card-body"><div class="kg-admin-list">${data.directAccess.length ? data.directAccess.map((item) => `<div class="kg-admin-row"><div><b>${kgAdminEscape(item.repoName)}</b><span>${kgAdminEscape(item.orgSlug)}/${kgAdminEscape(item.repoSlug)}</span></div><div>${statusBadge(item.permission)}</div><div class="kg-admin-meta">Expires ${kgAdminDate(item.expiresAt)}</div><button class="btn btn-ghost" data-admin-org="${kgAdminEscape(item.orgSlug)}">Tenant</button></div>`).join('') : '<div class="kg-admin-empty">No direct repository access.</div>'}</div></div></section></div><aside><section class="card"><div class="card-header"><div><h3>Identity and security counts</h3></div></div><div class="card-body"><div class="kg-admin-kv"><span>One Kuklabs Account ID</span><b>${kgAdminEscape(user.kuklabsUserId || 'Not linked')}</b></div><div class="kg-admin-kv"><span>Auth source</span><b>${kgAdminEscape(user.authSource)}</b></div><div class="kg-admin-kv"><span>Email verified</span><b>${user.emailVerified ? 'Yes' : 'No'}</b></div><div class="kg-admin-kv"><span>Active sessions</span><b>${data.security.activeSessions}</b></div><div class="kg-admin-kv"><span>Notifications</span><b>${data.notifications.unread} unread / ${data.notifications.total} total</b></div></div></section></aside></div>
  </div>`;
  bindAdminCommon();
  content.querySelectorAll('[data-admin-org]').forEach((button) => button.addEventListener('click', () => kgAdminNavigate(`#/instance-admin/organizations/${encodeURIComponent(button.dataset.adminOrg)}`)));
}

async function renderAudit(content, route) {
  content.innerHTML = `<div class="kg-admin-shell">${adminHero('Audit Lookup', 'Search request IDs, action names, target IDs and redacted metadata across the instance.')}
    <section class="card"><div class="card-body"><form class="kg-admin-search" id="kg-admin-audit-form"><div class="field"><label>Request, target or text</label><input class="input" name="q" maxlength="120" value="${kgAdminEscape(route.query.get('q') || '')}" /></div><div class="field"><label>Organization slug</label><input class="input" name="org" value="${kgAdminEscape(route.query.get('org') || '')}" /></div><div class="field"><label>Action contains</label><input class="input" name="action" value="${kgAdminEscape(route.query.get('action') || '')}" /></div><button class="btn btn-primary" type="submit">Search audit</button></form></div></section><section class="card"><div class="card-header"><div><h2>Redacted events</h2><p>Credential-like metadata keys are replaced before they leave the server.</p></div></div><div class="card-body" id="kg-admin-audit-results"><div class="kg-admin-empty">Run an audit search.</div></div></section></div>`;
  bindAdminCommon();
  const form = content.querySelector('#kg-admin-audit-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const params = new URLSearchParams(Object.entries(data).filter(([, value]) => String(value).trim()));
    const root = content.querySelector('#kg-admin-audit-results');
    root.innerHTML = '<div class="kg-admin-empty">Searching…</div>';
    try {
      const result = await kgAdminRequest(`${KG_ADMIN_API}/audit?${params}`);
      root.innerHTML = activityMarkup(result.audit.events);
    } catch (error) {
      root.innerHTML = `<div class="kg-admin-empty">${kgAdminEscape(error.message)}</div>`;
    }
  });
  if ([...route.query.values()].some(Boolean)) form?.requestSubmit();
}

async function renderKgAdminRoute() {
  if (!kgAdminRouteActive() || kgAdminRendering) return;
  if (!kgAdminShellReady()) return;
  if (!(await loadKgAdminStatus())) return;
  installAdminNavigation();
  const content = document.querySelector('.content');
  if (!content) return;
  const route = kgAdminRoute();
  const key = location.hash;
  if (kgAdminRenderKey === key && content.querySelector('.kg-admin-shell')) return;
  kgAdminRendering = true;
  content.innerHTML = '<div class="kg-admin-empty">Loading instance administration…</div>';
  try {
    if (route.segments[1] === 'organizations' && route.segments[2]) await renderOrganization(content, route.segments[2]);
    else if (route.segments[1] === 'users' && route.segments[2]) await renderUser(content, route.segments[2]);
    else if (route.segments[1] === 'audit') await renderAudit(content, route);
    else await renderAdminOverview(content);
    kgAdminRenderKey = key;
  } catch (error) {
    content.innerHTML = `${adminHero('Instance Administration', 'The requested support view could not be loaded.')}<section class="card"><div class="kg-admin-empty"><b>${kgAdminEscape(error.message)}</b>${error.requestId ? `<br />Request ID: ${kgAdminEscape(error.requestId)}` : ''}</div></section>`;
    bindAdminCommon();
  } finally {
    kgAdminRendering = false;
  }
}

/**
 * The signed-in shell, which is also the thing the navigation attaches to.
 * Asking before it exists means asking on the sign-in page, and the observer
 * below fires on every DOM change there too.
 */
function kgAdminShellReady() {
  return [...document.querySelectorAll('.sidebar-section')].some((node) => node.textContent.trim() === 'Manage');
}

async function reconcileKgAdminUi() {
  kgAdminObserverQueued = false;
  if (!kgAdminShellReady()) return;
  const status = await loadKgAdminStatus();
  if (!status) return;
  installAdminNavigation();
  await renderKgAdminRoute();
}

function scheduleKgAdminUi() {
  if (kgAdminObserverQueued) return;
  kgAdminObserverQueued = true;
  queueMicrotask(reconcileKgAdminUi);
}

// Guarded so the module can be imported without a browser. Everything above is
// a declaration; this is the only part that touches the page, and a test that
// cannot import the file is a test that never checks who gets to see the
// administration panel.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  installKgAdminStyles();
  window.addEventListener('hashchange', () => {
    kgAdminRenderKey = '';
    scheduleKgAdminUi();
  });
  new MutationObserver(scheduleKgAdminUi).observe(document.documentElement, { childList: true, subtree: true });
  scheduleKgAdminUi();
}

export { loadKgAdminStatus, kgAdminShellReady };
