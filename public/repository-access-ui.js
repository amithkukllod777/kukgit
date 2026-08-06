const REPOSITORY_ACCESS_API = '/api/repository-access';
let renderKey = '';
let scheduled = false;
/** The page whose load already failed. See the note in `mount`. */
let failedKey = '';

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function notify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${escapeHtml(title)}</b><span>${escapeHtml(message)}</span></div>`;
  root.append(element);
  setTimeout(() => element.remove(), 4600);
}

async function request(path, options = {}) {
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

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function currentRepositoryRoute() {
  const [path] = location.hash.slice(1).split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== 'repo' || segments[3] !== 'settings' || !segments[1] || !segments[2]) return null;
  return { org: segments[1], repo: segments[2] };
}

function injectStyles() {
  if (document.querySelector('#kg-repository-access-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-repository-access-styles';
  style.textContent = `
    .kg-repository-access { margin-top:18px; }
    .kg-access-grid { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(300px,.8fr); gap:18px; }
    .kg-access-row { display:grid; grid-template-columns:minmax(180px,1fr) minmax(110px,.45fr) minmax(135px,.55fr) auto; gap:12px; align-items:center; padding:13px 0; border-top:1px solid var(--border); }
    .kg-access-row:first-child { border-top:0; }
    .kg-access-person b { display:block; }
    .kg-access-person span, .kg-access-meta { display:block; color:var(--muted); font-size:11px; line-height:1.5; }
    .kg-permission-summary { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
    .kg-permission-card { flex:1; min-width:170px; border:1px solid var(--border); border-radius:14px; padding:14px; background:rgba(255,255,255,.022); }
    .kg-permission-card b { display:block; font-size:18px; margin-top:5px; text-transform:capitalize; }
    .kg-access-form { border:1px solid var(--border); border-radius:14px; padding:14px; margin-bottom:14px; background:rgba(255,255,255,.018); }
    .kg-source-list { display:grid; gap:8px; }
    .kg-source { display:flex; justify-content:space-between; gap:12px; border:1px solid var(--border); border-radius:11px; padding:10px 12px; }
    .kg-source span { color:var(--muted); font-size:11px; }
    .kg-empty { text-align:center; color:var(--muted); padding:24px 10px; }
    .kg-access-note { margin-top:14px; }
    @media (max-width:900px) { .kg-access-grid { grid-template-columns:1fr; } .kg-access-row { grid-template-columns:1fr; } }
  `;
  document.head.append(style);
}

function permissionOptions(permissions, selected = 'read') {
  return permissions.map((permission) => `<option value="${escapeHtml(permission)}" ${permission === selected ? 'selected' : ''}>${escapeHtml(permission)}</option>`).join('');
}

function sourceMarkup(sources) {
  if (!sources.length) return '<div class="kg-empty">No repository access source.</div>';
  return `<div class="kg-source-list">${sources.map((source) => `<div class="kg-source"><div><b>${escapeHtml(source.name || source.type)}</b><span>${escapeHtml(source.type)}${source.role ? ` · ${escapeHtml(source.role)}` : ''}${source.teamRole ? ` · team ${escapeHtml(source.teamRole)}` : ''}</span></div><span class="badge public">${escapeHtml(source.permission)}</span></div>`).join('')}</div>`;
}

function collaboratorsMarkup(data) {
  if (!data.collaborators.length) return '<div class="kg-empty">No direct repository collaborators. Organization and team permissions still apply.</div>';
  return data.collaborators.map((collaborator) => `<div class="kg-access-row">
    <div class="kg-access-person"><b>${escapeHtml(collaborator.displayName)}</b><span>${escapeHtml(collaborator.email)} · org ${escapeHtml(collaborator.organizationRole)}</span></div>
    <div><span class="badge public">${escapeHtml(collaborator.permission)}</span></div>
    <div class="kg-access-meta">Added by ${escapeHtml(collaborator.addedByName)}<br />${formatDate(collaborator.updatedAt)}</div>
    <div>${data.canManage ? `<button class="btn btn-ghost kg-remove-collaborator" data-user-id="${escapeHtml(collaborator.userId)}" data-name="${escapeHtml(collaborator.displayName)}">Remove</button>` : ''}</div>
  </div>`).join('');
}

function teamGrantsMarkup(data) {
  if (!data.teamGrants.length) return '<div class="kg-empty">No teams have repository-specific access.</div>';
  return data.teamGrants.map((grant) => `<div class="kg-access-row">
    <div class="kg-access-person"><b>${escapeHtml(grant.name)}</b><span>@${escapeHtml(grant.slug)} · ${grant.memberCount} member${grant.memberCount === 1 ? '' : 's'}</span></div>
    <div><span class="badge public">${escapeHtml(grant.permission)}</span></div>
    <div class="kg-access-meta">Added by ${escapeHtml(grant.addedByName)}<br />${formatDate(grant.updatedAt)}</div>
    <div>${data.canManage ? `<button class="btn btn-ghost kg-remove-team-grant" data-team-id="${escapeHtml(grant.teamId)}" data-name="${escapeHtml(grant.name)}">Remove</button>` : ''}</div>
  </div>`).join('');
}

function panelMarkup(data) {
  const grantableMembers = data.members.filter((member) => !data.collaborators.some((collaborator) => collaborator.userId === member.id));
  const grantableTeams = data.teams.filter((team) => !data.teamGrants.some((grant) => grant.teamId === team.id));
  return `<section class="card kg-repository-access" id="kg-repository-access-panel">
    <div class="card-header"><div><h2>Repository access</h2><p>Manage direct collaborators, team grants and effective permissions.</p></div><span class="badge public">${escapeHtml(data.effectivePermission)}</span></div>
    <div class="card-body">
      <div class="kg-permission-summary">
        <div class="kg-permission-card"><span class="muted">Your effective permission</span><b>${escapeHtml(data.effectivePermission)}</b></div>
        <div class="kg-permission-card"><span class="muted">Direct collaborators</span><b>${data.collaborators.length}</b></div>
        <div class="kg-permission-card"><span class="muted">Team grants</span><b>${data.teamGrants.length}</b></div>
      </div>
      <div class="kg-access-grid">
        <div>
          <section class="card"><div class="card-header"><div><h3>Direct collaborators</h3><p>Grant an organization member repository-specific permission.</p></div></div><div class="card-body">
            ${data.canManage && grantableMembers.length ? `<form class="kg-access-form" id="kg-add-collaborator"><div class="form-grid"><div class="field"><label>Organization member</label><select class="select" name="userId">${grantableMembers.map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.displayName)} · ${escapeHtml(member.email)} · org ${escapeHtml(member.organizationRole)}</option>`).join('')}</select></div><div class="field"><label>Repository permission</label><select class="select" name="permission">${permissionOptions(data.availablePermissions, 'write')}</select></div></div><button class="btn btn-primary" type="submit">Grant direct access</button></form>` : data.canManage ? '<div class="login-demo">Every organization member already has a direct repository grant. Existing grants can be removed and recreated with another permission.</div>' : ''}
            <div id="kg-collaborator-list">${collaboratorsMarkup(data)}</div>
          </div></section>
          <section class="card" style="margin-top:16px"><div class="card-header"><div><h3>Team access</h3><p>Give every member of a team the selected permission.</p></div></div><div class="card-body">
            ${data.canManage && grantableTeams.length ? `<form class="kg-access-form" id="kg-add-team-grant"><div class="form-grid"><div class="field"><label>Organization team</label><select class="select" name="teamId">${grantableTeams.map((team) => `<option value="${escapeHtml(team.id)}">${escapeHtml(team.name)} · ${team.memberCount} members</option>`).join('')}</select></div><div class="field"><label>Repository permission</label><select class="select" name="permission">${permissionOptions(data.availablePermissions, 'write')}</select></div></div><button class="btn btn-primary" type="submit">Grant team access</button></form>` : data.canManage ? '<div class="login-demo">No additional organization team is available for a new repository grant.</div>' : ''}
            <div id="kg-team-grant-list">${teamGrantsMarkup(data)}</div>
          </div></section>
        </div>
        <aside>
          <section class="card"><div class="card-header"><div><h3>Permission sources</h3><p>KukGit uses the highest permission from every applicable source.</p></div></div><div class="card-body">${sourceMarkup(data.permissionSources)}</div></section>
          <section class="card kg-access-note"><div class="card-body"><div class="login-demo"><b>Permission model</b><br />Read → Triage → Write → Maintain → Admin. Organization role, direct grant and team grant are combined; the highest permission wins. Git push requires Write. Access management requires Admin.</div></div></section>
          ${!data.canManage ? '<section class="card kg-access-note"><div class="card-body"><div class="login-demo"><b>Read-only access settings</b><br />Only users with effective Admin permission can change repository collaborators or team grants.</div></div></section>' : ''}
        </aside>
      </div>
    </div>
  </section>`;
}

async function loadPanel(route, force = false) {
  const content = document.querySelector('.content');
  if (!content) return;
  const key = `${route.org}/${route.repo}/${location.hash}`;
  if (!force && renderKey === key && document.querySelector('#kg-repository-access-panel')) return;
  renderKey = key;
  injectStyles();
  const data = await request(`${REPOSITORY_ACCESS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`);
  if (currentRepositoryRoute()?.org !== route.org || currentRepositoryRoute()?.repo !== route.repo) return;
  document.querySelector('#kg-repository-access-panel')?.remove();
  content.insertAdjacentHTML('beforeend', panelMarkup(data));
  bindPanel(route, data);
}

function bindPanel(route, data) {
  const collaboratorForm = document.querySelector('#kg-add-collaborator');
  collaboratorForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = collaboratorForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await request(`${REPOSITORY_ACCESS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/collaborators`, {
        method: 'POST',
        body: Object.fromEntries(new FormData(collaboratorForm)),
      });
      notify('Collaborator granted', 'The direct repository permission is active immediately.');
      await loadPanel(route, true);
    } catch (error) {
      notify('Unable to grant access', error.message, 'error');
      button.disabled = false;
    }
  });

  const teamForm = document.querySelector('#kg-add-team-grant');
  teamForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = teamForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await request(`${REPOSITORY_ACCESS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/teams`, {
        method: 'POST',
        body: Object.fromEntries(new FormData(teamForm)),
      });
      notify('Team access granted', 'Every current team member now receives the repository permission.');
      await loadPanel(route, true);
    } catch (error) {
      notify('Unable to grant team access', error.message, 'error');
      button.disabled = false;
    }
  });

  document.querySelectorAll('.kg-remove-collaborator').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm(`Remove the direct repository grant for ${button.dataset.name}? Organization and team permissions will still apply.`)) return;
    button.disabled = true;
    try {
      await request(`${REPOSITORY_ACCESS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/collaborators/${encodeURIComponent(button.dataset.userId)}`, { method: 'DELETE' });
      notify('Direct grant removed', 'Effective access was recalculated from the remaining sources.');
      await loadPanel(route, true);
    } catch (error) {
      notify('Unable to remove access', error.message, 'error');
      button.disabled = false;
    }
  }));

  document.querySelectorAll('.kg-remove-team-grant').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm(`Remove repository access for team ${button.dataset.name}?`)) return;
    button.disabled = true;
    try {
      await request(`${REPOSITORY_ACCESS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/teams/${encodeURIComponent(button.dataset.teamId)}`, { method: 'DELETE' });
      notify('Team grant removed', 'Team members now rely on their remaining access sources.');
      await loadPanel(route, true);
    } catch (error) {
      notify('Unable to remove team access', error.message, 'error');
      button.disabled = false;
    }
  }));
}

async function mount() {
  scheduled = false;
  const route = currentRepositoryRoute();
  if (!route) {
    renderKey = '';
    return;
  }
  // A failed load is an answer, and showing it is itself a DOM change — which
  // wakes the observer, which comes back here. The guard below tested for the
  // panel, which a failed load never renders, so every pass fetched again and
  // appended another copy of the same message: measured at a hundred and twenty
  // requests and a hundred and twenty identical error cards. Cleared on
  // navigation, where the answer can legitimately differ.
  if (failedKey === location.hash) return;
  try {
    await loadPanel(route);
    failedKey = '';
  } catch (error) {
    failedKey = location.hash;
    const content = document.querySelector('.content');
    if (content && currentRepositoryRoute() && !document.querySelector('#kg-repository-access-panel')) {
      document.querySelector('#kg-repository-access-error')?.remove();
      content.insertAdjacentHTML('beforeend', `<section class="card kg-repository-access" id="kg-repository-access-error"><div class="card-body kg-empty">${escapeHtml(error.message)}</div></section>`);
    }
  }
}

function scheduleMount() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(mount));
}

window.addEventListener('hashchange', scheduleMount);
new MutationObserver(scheduleMount).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleMount();
