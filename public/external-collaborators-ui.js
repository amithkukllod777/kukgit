const EXTERNAL_ACCESS_API = '/api/repository-access';
const REPOSITORY_INVITATIONS_API = '/api/repository-invitations';
let externalRenderKey = '';
let externalRefusedKey = '';
let externalScheduled = false;
let externalLoading = false;
let oneTimeInvitation = null;

function normalizeRepositoryInvitationHash() {
  const raw = location.hash || '';
  if (!raw.startsWith('#/accept-repo-invite?')) return false;
  const token = new URLSearchParams(raw.slice(raw.indexOf('?') + 1)).get('token');
  if (!token) return false;
  history.replaceState(null, '', `${location.pathname}${location.search}#/settings?repoInviteToken=${encodeURIComponent(token)}`);
  return true;
}

normalizeRepositoryInvitationHash();
window.addEventListener('hashchange', normalizeRepositoryInvitationHash);

function escapeExternal(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function externalDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : '—';
}

function notifyExternal(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${escapeExternal(title)}</b><span>${escapeExternal(message)}</span></div>`;
  root.append(toast);
  setTimeout(() => toast.remove(), 4600);
}

async function externalRequest(path, options = {}) {
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

function repositorySettingsRoute() {
  const [path] = location.hash.slice(1).split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== 'repo' || segments[3] !== 'settings' || !segments[1] || !segments[2]) return null;
  return { org: segments[1], repo: segments[2] };
}

function acceptanceToken() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  return path === '/settings' ? new URLSearchParams(query).get('repoInviteToken') : null;
}

function installExternalStyles() {
  if (document.querySelector('#kg-external-collaborator-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-external-collaborator-styles';
  style.textContent = `
    .kg-external-panel { margin-top:18px; }
    .kg-external-grid { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(310px,.85fr); gap:18px; }
    .kg-external-form { border:1px solid var(--border); border-radius:14px; padding:14px; background:rgba(255,255,255,.018); }
    .kg-external-row { display:grid; grid-template-columns:minmax(210px,1fr) 105px 145px auto; gap:12px; align-items:center; padding:13px 0; border-top:1px solid var(--border); }
    .kg-external-row:first-child { border-top:0; }
    .kg-external-person b { display:block; }
    .kg-external-person span, .kg-external-meta { display:block; color:var(--muted); font-size:11px; line-height:1.5; }
    .kg-external-actions { display:flex; flex-wrap:wrap; gap:7px; justify-content:flex-end; }
    .kg-external-secret { border:1px solid rgba(21,152,255,.35); background:rgba(21,152,255,.075); border-radius:13px; padding:14px; margin:14px 0; }
    .kg-external-secret code { display:block; margin:9px 0; padding:10px; white-space:normal; overflow-wrap:anywhere; }
    .kg-external-empty { padding:24px 10px; text-align:center; color:var(--muted); }
    .kg-repo-invite-accept { margin-bottom:18px; border-color:rgba(21,152,255,.34); }
    .kg-repo-invite-result { margin-top:14px; }
    @media (max-width:920px) { .kg-external-grid { grid-template-columns:1fr; } .kg-external-row { grid-template-columns:1fr; } .kg-external-actions { justify-content:flex-start; } }
  `;
  document.head.append(style);
}

function permissionOptions(selected = 'read') {
  return ['read', 'triage', 'write', 'maintain', 'admin']
    .map((permission) => `<option value="${permission}" ${permission === selected ? 'selected' : ''}>${permission}</option>`)
    .join('');
}

function invitationBadge(status) {
  const className = status === 'accepted' ? 'public' : status === 'pending' ? 'open' : status === 'expired' ? 'critical' : '';
  return `<span class="badge ${className}" style="text-transform:capitalize">${escapeExternal(status)}</span>`;
}

function invitationRows(invitations) {
  if (!invitations.length) return '<div class="kg-external-empty">No repository invitations have been created.</div>';
  return invitations.map((invitation) => `<div class="kg-external-row" data-repository-invitation="${escapeExternal(invitation.id)}">
    <div class="kg-external-person"><b>${escapeExternal(invitation.email)}</b><span>Invited by ${escapeExternal(invitation.invitedByName || 'KukGit user')} · ${escapeExternal(invitation.tokenPrefix)}…</span></div>
    <div>${invitationBadge(invitation.status)}</div>
    <div class="kg-external-meta">${escapeExternal(invitation.permission)} permission<br />Expires ${externalDate(invitation.expiresAt)}</div>
    <div class="kg-external-actions">${['pending', 'expired', 'revoked'].includes(invitation.status) ? '<button class="btn btn-ghost kg-resend-repo-invite">Resend</button>' : ''}${invitation.status === 'pending' ? '<button class="btn btn-ghost kg-revoke-repo-invite">Revoke</button>' : ''}</div>
  </div>`).join('');
}

function collaboratorRows(collaborators, canManage) {
  if (!collaborators.length) return '<div class="kg-external-empty">No external collaborators currently have repository access.</div>';
  return collaborators.map((collaborator) => `<div class="kg-external-row" data-external-collaborator="${escapeExternal(collaborator.userId)}">
    <div class="kg-external-person"><b>${escapeExternal(collaborator.displayName)}</b><span>${escapeExternal(collaborator.email)} · repository-only access</span></div>
    <div><span class="badge public">External</span></div>
    <div>${canManage ? `<select class="select kg-external-permission">${permissionOptions(collaborator.permission)}</select>` : `<span class="badge public">${escapeExternal(collaborator.permission)}</span>`}</div>
    <div class="kg-external-actions">${canManage ? `<button class="btn kg-update-external-permission">Update</button><button class="btn btn-ghost kg-remove-external-collaborator" data-name="${escapeExternal(collaborator.displayName)}">Remove</button>` : ''}</div>
  </div>`).join('');
}

function secretMarkup(invitation) {
  if (!invitation) return '';
  return `<div class="kg-external-secret"><b>One-time repository invitation link</b><p class="muted">Email delivery is queued. Copy this link only when manual sharing is also required.</p><code id="kg-repository-invitation-url">${escapeExternal(invitation.acceptanceUrl)}</code><button class="btn btn-primary" id="kg-copy-repository-invitation">Copy invitation link</button></div>`;
}

function managementMarkup(route, access, invitations) {
  const externalCollaborators = access.collaborators.filter((collaborator) => collaborator.isExternal);
  return `<section class="card kg-external-panel" id="kg-external-collaborators-panel" data-org="${escapeExternal(route.org)}" data-repo="${escapeExternal(route.repo)}">
    <div class="card-header"><div><h2>External collaborators</h2><p>Share only this repository without adding a user to the organization.</p></div><span class="badge ${access.isExternalCollaborator ? 'open' : 'public'}">${access.isExternalCollaborator ? 'Repository-only access' : `${externalCollaborators.length} external`}</span></div>
    <div class="card-body">
      ${access.isExternalCollaborator ? '<div class="login-demo"><b>Your access is repository-scoped.</b><br />Other organization repositories, teams, members and administration remain private.</div>' : ''}
      ${access.canManage ? `<div class="kg-external-grid"><div>
        <form class="kg-external-form" id="kg-create-repository-invitation"><h3>Invite by email</h3><p class="muted">Acceptance grants repository access only.</p><div class="field"><label>Email address</label><input class="input" type="email" name="email" placeholder="client@example.com" required /></div><div class="form-grid"><div class="field"><label>Repository permission</label><select class="select" name="permission">${permissionOptions('read')}</select></div><div class="field"><label>Invitation expiry</label><select class="select" name="expiresInDays"><option value="7">7 days</option><option value="14" selected>14 days</option><option value="30">30 days</option></select></div></div><button class="btn btn-primary" type="submit">Send repository invitation</button></form>
        <div id="kg-repository-invitation-secret">${secretMarkup(oneTimeInvitation)}</div>
        <section class="card" style="margin-top:16px"><div class="card-header"><div><h3>Invitation history</h3><p>Pending, accepted, expired and revoked links.</p></div></div><div class="card-body">${invitationRows(invitations)}</div></section>
      </div><aside><section class="card"><div class="card-header"><div><h3>Active external access</h3><p>Update or remove repository-only collaborators.</p></div></div><div class="card-body">${collaboratorRows(externalCollaborators, true)}</div></section><section class="card" style="margin-top:16px"><div class="card-body"><div class="login-demo"><b>Boundary protection</b><br />External collaborators discover only explicitly shared repositories. Repository transfer and Trash still require organization Admin or Owner membership.</div></div></section></aside></div>` : `<div>${collaboratorRows(externalCollaborators, false)}</div>`}
    </div>
  </section>`;
}

async function copyExternalText(value) {
  try { await navigator.clipboard.writeText(value); }
  catch {
    const area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

function patchLegacyRows(access) {
  const external = new Map(access.collaborators.filter((collaborator) => collaborator.isExternal).map((collaborator) => [collaborator.userId, collaborator]));
  document.querySelectorAll('#kg-repository-access-panel .kg-remove-collaborator').forEach((button) => {
    const collaborator = external.get(button.dataset.userId);
    if (!collaborator) return;
    const label = button.closest('.kg-access-row')?.querySelector('.kg-access-person span');
    if (label) label.textContent = `${collaborator.email} · external collaborator`;
  });
}

async function loadExternalPanel(route, force = false) {
  if (externalLoading) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const key = `${route.org}/${route.repo}/${location.hash}`;
  if (!force && externalRenderKey === key && document.querySelector('#kg-external-collaborators-panel')) return;
  // 403 and 404 are answers. The guard above needs the rendered panel, which a
  // refused load never produces, so without this it asked again on every DOM
  // change for the whole time somebody sat on a repository they cannot manage.
  if (!force && externalRefusedKey === key) return;
  externalLoading = true;
  try {
    const access = await externalRequest(`${EXTERNAL_ACCESS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`);
    const invitations = access.canManage
      ? (await externalRequest(`${REPOSITORY_INVITATIONS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`)).invitations
      : [];
    if (repositorySettingsRoute()?.org !== route.org || repositorySettingsRoute()?.repo !== route.repo) return;
    externalRenderKey = key;
    document.querySelector('#kg-external-collaborators-panel')?.remove();
    content.insertAdjacentHTML('beforeend', managementMarkup(route, access, invitations));
    patchLegacyRows(access);
    bindExternalPanel(route);
  } finally {
    externalLoading = false;
  }
}

function bindExternalPanel(route) {
  document.querySelector('#kg-create-repository-invitation')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      oneTimeInvitation = (await externalRequest(`${REPOSITORY_INVITATIONS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`, {
        method: 'POST', body: Object.fromEntries(new FormData(form)),
      })).invitation;
      externalNotifySuccess('Repository invitation created', `Secure access was queued for ${oneTimeInvitation.email}.`);
      await loadExternalPanel(route, true);
    } catch (error) {
      notifyExternal('Unable to create invitation', error.message, 'error');
      button.disabled = false;
    }
  });

  document.querySelector('#kg-copy-repository-invitation')?.addEventListener('click', async () => {
    const value = document.querySelector('#kg-repository-invitation-url')?.textContent?.trim();
    if (!value) return;
    await copyExternalText(value);
    notifyExternal('Invitation copied', 'The secure repository invitation link is in your clipboard.');
  });

  document.querySelectorAll('.kg-resend-repo-invite').forEach((button) => button.addEventListener('click', async () => {
    const id = button.closest('[data-repository-invitation]').dataset.repositoryInvitation;
    if (!window.confirm('Revoke the old link and send a fresh 14-day repository invitation?')) return;
    button.disabled = true;
    try {
      oneTimeInvitation = (await externalRequest(`${REPOSITORY_INVITATIONS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/${encodeURIComponent(id)}/resend`, {
        method: 'POST', body: { expiresInDays: 14 },
      })).invitation;
      externalNotifySuccess('Invitation resent', `A fresh secure link was queued for ${oneTimeInvitation.email}.`);
      await loadExternalPanel(route, true);
    } catch (error) {
      notifyExternal('Unable to resend invitation', error.message, 'error');
      button.disabled = false;
    }
  }));

  document.querySelectorAll('.kg-revoke-repo-invite').forEach((button) => button.addEventListener('click', async () => {
    const id = button.closest('[data-repository-invitation]').dataset.repositoryInvitation;
    if (!window.confirm('Revoke this repository invitation link?')) return;
    button.disabled = true;
    try {
      await externalRequest(`${REPOSITORY_INVITATIONS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: {} });
      notifyExternal('Invitation revoked', 'The secure link can no longer be accepted.');
      await loadExternalPanel(route, true);
    } catch (error) {
      notifyExternal('Unable to revoke invitation', error.message, 'error');
      button.disabled = false;
    }
  }));

  document.querySelectorAll('.kg-update-external-permission').forEach((button) => button.addEventListener('click', async () => {
    const row = button.closest('[data-external-collaborator]');
    const permission = row.querySelector('.kg-external-permission').value;
    button.disabled = true;
    try {
      await externalRequest(`${REPOSITORY_INVITATIONS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/collaborators/${encodeURIComponent(row.dataset.externalCollaborator)}`, { method: 'PATCH', body: { permission } });
      notifyExternal('Permission updated', `External repository access is now ${permission}.`);
      await loadExternalPanel(route, true);
    } catch (error) {
      notifyExternal('Unable to update permission', error.message, 'error');
      button.disabled = false;
    }
  }));

  document.querySelectorAll('.kg-remove-external-collaborator').forEach((button) => button.addEventListener('click', async () => {
    const row = button.closest('[data-external-collaborator]');
    if (!window.confirm(`Remove repository access for ${button.dataset.name}?`)) return;
    button.disabled = true;
    try {
      await externalRequest(`${EXTERNAL_ACCESS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/collaborators/${encodeURIComponent(row.dataset.externalCollaborator)}`, { method: 'DELETE' });
      notifyExternal('External access removed', 'The user can no longer discover or use this repository.');
      await loadExternalPanel(route, true);
    } catch (error) {
      notifyExternal('Unable to remove access', error.message, 'error');
      button.disabled = false;
    }
  }));
}

function externalNotifySuccess(title, message) {
  notifyExternal(title, message, 'success');
}

function acceptanceMarkup(token) {
  return `<section class="card kg-repo-invite-accept" id="kg-repository-invitation-acceptance"><div class="card-header"><div><h2>Repository collaboration invitation</h2><p>Accept repository-only access using the signed-in email account.</p></div><span class="badge open">Secure invitation</span></div><div class="card-body"><div class="login-demo"><b>Access boundary</b><br />Only the invited repository becomes visible. Other repositories, teams and members stay private.</div><div class="kg-repo-invite-result" id="kg-repository-invitation-result"><button class="btn btn-primary" id="kg-accept-repository-invitation" data-token="${escapeExternal(token)}">Accept repository invitation</button></div></div></section>`;
}

function mountAcceptance() {
  const token = acceptanceToken();
  if (!token) {
    document.querySelector('#kg-repository-invitation-acceptance')?.remove();
    return;
  }
  const content = document.querySelector('.content');
  if (!content || document.querySelector('#kg-repository-invitation-acceptance')) return;
  content.insertAdjacentHTML('afterbegin', acceptanceMarkup(token));
  document.querySelector('#kg-accept-repository-invitation')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Accepting…';
    try {
      const result = (await externalRequest(`${REPOSITORY_INVITATIONS_API}/accept`, { method: 'POST', body: { token: button.dataset.token } })).result;
      const target = `#/repo/${result.repository.orgSlug}/${result.repository.slug}/code`;
      const root = document.querySelector('#kg-repository-invitation-result');
      root.innerHTML = `<div class="login-demo"><b>Repository access activated</b><br />You now have ${escapeExternal(result.permission)} permission for ${escapeExternal(result.repository.orgSlug)}/${escapeExternal(result.repository.slug)}.</div><button class="btn btn-primary" id="kg-open-accepted-repository" style="margin-top:12px">Open repository</button>`;
      root.querySelector('#kg-open-accepted-repository').addEventListener('click', () => { location.hash = target; });
      notifyExternal('Invitation accepted', 'Repository-only access is active.');
    } catch (error) {
      notifyExternal('Unable to accept invitation', error.message, 'error');
      button.disabled = false;
      button.textContent = 'Accept repository invitation';
    }
  });
}

async function mountExternalCollaborators() {
  externalScheduled = false;
  installExternalStyles();
  mountAcceptance();
  const route = repositorySettingsRoute();
  if (!route) {
    externalRenderKey = '';
    oneTimeInvitation = null;
    return;
  }
  try { await loadExternalPanel(route); }
  catch (error) {
    externalRefusedKey = `${route.org}/${route.repo}/${location.hash}`;
    if (![403, 404].includes(error.status)) {
      const content = document.querySelector('.content');
      if (content && !document.querySelector('#kg-external-collaborators-panel')) {
        content.insertAdjacentHTML('beforeend', `<section class="card kg-external-panel" id="kg-external-collaborators-panel"><div class="card-body kg-external-empty">${escapeExternal(error.message)}</div></section>`);
      }
    }
  }
}

function scheduleExternalCollaborators() {
  if (externalScheduled) return;
  externalScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(mountExternalCollaborators));
}

window.addEventListener('hashchange', scheduleExternalCollaborators);
new MutationObserver(scheduleExternalCollaborators).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleExternalCollaborators();
