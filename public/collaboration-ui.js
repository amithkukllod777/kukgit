const COLLABORATION_API = '/api/collaboration';
const PENDING_INVITATION_KEY = 'kukgit_pending_invitation';
let organizationRenderKey = '';
let scheduling = false;

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
    error.code = payload?.error?.code;
    error.status = response.status;
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

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
}

function captureInvitationToken() {
  const raw = location.hash.slice(1);
  const [route, query = ''] = raw.split('?');
  if (route !== '/accept-invite') return;
  const token = new URLSearchParams(query).get('token');
  if (token?.startsWith('kgi_')) sessionStorage.setItem(PENDING_INVITATION_KEY, token);
}

function injectStyles() {
  if (document.querySelector('#kg-collaboration-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-collaboration-styles';
  style.textContent = `
    .kg-collaboration { margin-top:18px; }
    .kg-collaboration-tabs { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px; }
    .kg-collaboration-tab { border:1px solid var(--border); background:rgba(255,255,255,.025); color:inherit; border-radius:10px; padding:9px 12px; cursor:pointer; }
    .kg-collaboration-tab.active { border-color:rgba(21,152,255,.55); background:rgba(21,152,255,.11); }
    .kg-collaboration-grid { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(300px,.75fr); gap:18px; }
    .kg-member-row, .kg-invite-row, .kg-team-member { display:grid; grid-template-columns:minmax(170px,1fr) minmax(120px,.55fr) minmax(120px,.55fr) auto; gap:12px; align-items:center; padding:13px 0; border-top:1px solid var(--border); }
    .kg-member-row:first-child, .kg-invite-row:first-child, .kg-team-member:first-child { border-top:0; }
    .kg-person b { display:block; }
    .kg-person span, .kg-meta { display:block; color:var(--muted); font-size:11px; line-height:1.5; }
    .kg-team-card { border:1px solid var(--border); border-radius:14px; padding:15px; margin-top:12px; background:rgba(255,255,255,.018); }
    .kg-team-head { display:flex; align-items:flex-start; gap:12px; justify-content:space-between; }
    .kg-team-head h3 { margin:0 0 4px; }
    .kg-team-actions { display:flex; gap:8px; align-items:end; margin-top:13px; }
    .kg-team-actions .field { margin:0; flex:1; }
    .kg-one-time { border:1px solid rgba(247,201,72,.35); background:rgba(247,201,72,.08); border-radius:14px; padding:14px; margin-bottom:14px; }
    .kg-one-time code { display:block; padding:11px; border-radius:9px; background:#06101c; margin:9px 0; overflow:auto; user-select:all; color:#fff; }
    .kg-status-pending { color:#f7c948; }
    .kg-status-accepted { color:#3ddc97; }
    .kg-status-revoked, .kg-status-expired { color:#ff7b91; }
    .kg-invite-backdrop { position:fixed; inset:0; z-index:1200; display:grid; place-items:center; padding:20px; background:rgba(1,7,15,.82); backdrop-filter:blur(10px); }
    .kg-invite-dialog { width:min(540px,100%); border:1px solid var(--border); border-radius:20px; background:#091522; box-shadow:0 24px 80px rgba(0,0,0,.5); padding:24px; }
    .kg-invite-dialog h2 { margin:0 0 8px; }
    .kg-empty { text-align:center; color:var(--muted); padding:24px 10px; }
    @media (max-width:900px) { .kg-collaboration-grid { grid-template-columns:1fr; } .kg-member-row, .kg-invite-row, .kg-team-member { grid-template-columns:1fr; } .kg-team-actions { flex-direction:column; align-items:stretch; } }
  `;
  document.head.append(style);
}

function roleOptions(selected = 'developer') {
  return ['admin', 'maintainer', 'developer', 'viewer'].map((role) => `<option value="${role}" ${role === selected ? 'selected' : ''}>${role}</option>`).join('');
}

function membersMarkup(members) {
  if (!members.length) return '<div class="kg-empty">No organization members.</div>';
  return members.map((member) => `<div class="kg-member-row">
    <div class="kg-person"><b>${escapeHtml(member.displayName)}</b><span>${escapeHtml(member.email)}</span></div>
    <div><span class="badge public">${escapeHtml(member.role)}</span></div>
    <div class="kg-meta">Joined ${formatDate(member.joinedAt)}</div>
    <div></div>
  </div>`).join('');
}

function invitationsMarkup(invitations, canManage) {
  if (!canManage) return '<div class="kg-empty">Only organization owners and admins can manage invitations.</div>';
  if (!invitations.length) return '<div class="kg-empty">No invitations yet.</div>';
  return invitations.map((invitation) => `<div class="kg-invite-row">
    <div class="kg-person"><b>${escapeHtml(invitation.email)}</b><span>Invited by ${escapeHtml(invitation.invitedByName || 'KukGit admin')}</span></div>
    <div><span class="badge">${escapeHtml(invitation.role)}</span></div>
    <div class="kg-meta"><span class="kg-status-${escapeHtml(invitation.status)}">${escapeHtml(invitation.status)}</span><br />Expires ${formatDate(invitation.expiresAt)}</div>
    <div>${invitation.status === 'pending' ? `<button class="btn btn-ghost kg-revoke-invite" data-invitation-id="${escapeHtml(invitation.id)}">Revoke</button>` : ''}</div>
  </div>`).join('');
}

function teamMarkup(team, allMembers, canManage) {
  const available = allMembers.filter((member) => !team.members.some((existing) => existing.id === member.id));
  return `<article class="kg-team-card" data-team-id="${escapeHtml(team.id)}">
    <div class="kg-team-head"><div><h3>${escapeHtml(team.name)}</h3><div class="kg-meta">@${escapeHtml(team.slug)} · ${team.members.length} member${team.members.length === 1 ? '' : 's'}</div><p class="muted">${escapeHtml(team.description || 'No description')}</p></div>${canManage ? `<button class="btn btn-ghost kg-delete-team">Delete</button>` : ''}</div>
    <div>${team.members.length ? team.members.map((member) => `<div class="kg-team-member"><div class="kg-person"><b>${escapeHtml(member.displayName)}</b><span>${escapeHtml(member.email)}</span></div><div><span class="badge">${escapeHtml(member.teamRole)}</span></div><div class="kg-meta">Org: ${escapeHtml(member.organizationRole)}</div><div>${canManage ? `<button class="btn btn-ghost kg-remove-team-member" data-user-id="${escapeHtml(member.id)}">Remove</button>` : ''}</div></div>`).join('') : '<div class="kg-empty">No team members.</div>'}</div>
    ${canManage && available.length ? `<form class="kg-team-actions kg-add-team-member"><div class="field"><label>Add organization member</label><select class="select" name="userId">${available.map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.displayName)} · ${escapeHtml(member.email)}</option>`).join('')}</select></div><div class="field"><label>Team role</label><select class="select" name="role"><option value="member">member</option><option value="maintainer">maintainer</option></select></div><button class="btn" type="submit">Add member</button></form>` : ''}
  </article>`;
}

function panelMarkup(data, organizations) {
  const org = data.organization;
  return `<section class="card kg-collaboration" id="kg-collaboration-panel" data-org="${escapeHtml(org.slug)}">
    <div class="card-header"><div><h2>Organization collaboration</h2><p>Invite people, manage members and organize developers into teams.</p></div><span class="badge public">${escapeHtml(org.role)}</span></div>
    <div class="card-body">
      <div class="kg-collaboration-tabs">${organizations.map((item) => `<button class="kg-collaboration-tab ${item.slug === org.slug ? 'active' : ''}" data-org-slug="${escapeHtml(item.slug)}">${escapeHtml(item.name)}</button>`).join('')}</div>
      <div id="kg-invitation-secret"></div>
      <div class="kg-collaboration-grid">
        <div>
          <section class="card"><div class="card-header"><div><h3>Members</h3><p>${data.members.length} organization member${data.members.length === 1 ? '' : 's'}</p></div></div><div class="card-body">${membersMarkup(data.members)}</div></section>
          <section class="card" style="margin-top:16px"><div class="card-header"><div><h3>Teams</h3><p>Reusable groups for engineering and repository access.</p></div></div><div class="card-body">
            ${data.canManage ? `<form id="kg-create-team"><div class="form-grid"><div class="field"><label>Team name</label><input class="input" name="name" placeholder="Platform Engineering" maxlength="100" required /></div><div class="field"><label>Team slug</label><input class="input" name="slug" placeholder="platform-engineering" pattern="[a-z0-9][a-z0-9-]{1,62}" required /></div></div><div class="field"><label>Description</label><input class="input" name="description" maxlength="500" placeholder="Owns the KukGit platform and infrastructure" /></div><button class="btn" type="submit">Create team</button></form>` : ''}
            <div id="kg-team-list">${data.teams.length ? data.teams.map((team) => teamMarkup(team, data.members, data.canManage)).join('') : '<div class="kg-empty">Create the first team for this organization.</div>'}</div>
          </div></section>
        </div>
        <aside>
          <section class="card"><div class="card-header"><div><h3>Invitations</h3><p>Invite an existing KukGit user by email.</p></div></div><div class="card-body">
            ${data.canManage ? `<form id="kg-create-invitation"><div class="field"><label>Email address</label><input class="input" type="email" name="email" placeholder="developer@example.com" required /></div><div class="form-grid"><div class="field"><label>Organization role</label><select class="select" name="role">${roleOptions()}</select></div><div class="field"><label>Expires in</label><select class="select" name="expiresInDays"><option value="7">7 days</option><option value="14" selected>14 days</option><option value="30">30 days</option></select></div></div><button class="btn btn-primary" type="submit">Create invitation</button></form><hr style="border:0;border-top:1px solid var(--border);margin:18px 0" />` : ''}
            <div id="kg-invitation-list">${invitationsMarkup(data.invitations, data.canManage)}</div>
          </div></section>
          <section class="card" style="margin-top:16px"><div class="card-body"><div class="login-demo"><b>Private alpha boundary</b><br />Invitation acceptance currently requires an existing KukGit account with the same email. One Kuklabs Account signup and email delivery are the next identity milestones.</div></div></section>
        </aside>
      </div>
    </div>
  </section>`;
}

async function loadOrganization(slug) {
  return request(`${COLLABORATION_API}/orgs/${encodeURIComponent(slug)}`);
}

function bindPanel(data, organizations) {
  const panel = document.querySelector('#kg-collaboration-panel');
  if (!panel) return;
  const orgSlug = data.organization.slug;

  panel.querySelectorAll('[data-org-slug]').forEach((button) => button.addEventListener('click', async () => {
    organizationRenderKey = '';
    await renderOrganizationPanel(button.dataset.orgSlug, organizations, true);
  }));

  const invitationForm = panel.querySelector('#kg-create-invitation');
  invitationForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!invitationForm.reportValidity()) return;
    const button = invitationForm.querySelector('button[type="submit"]');
    const body = Object.fromEntries(new FormData(invitationForm));
    body.expiresInDays = Number(body.expiresInDays);
    button.disabled = true;
    button.textContent = 'Creating invitation…';
    try {
      const payload = await request(`${COLLABORATION_API}/orgs/${encodeURIComponent(orgSlug)}/invitations`, { method: 'POST', body });
      const invitation = payload.invitation;
      const secret = document.querySelector('#kg-invitation-secret');
      secret.innerHTML = `<div class="kg-one-time"><b>Copy this invitation link now</b><p class="muted">The secure invitation token is shown only in this response.</p><code id="kg-invitation-url">${escapeHtml(invitation.acceptanceUrl)}</code><button class="btn btn-primary" id="kg-copy-invitation">Copy invitation link</button></div>`;
      document.querySelector('#kg-copy-invitation').addEventListener('click', async () => {
        await copyText(invitation.acceptanceUrl);
        notify('Invitation copied', `Send the secure link to ${invitation.email}.`);
      });
      invitationForm.reset();
      notify('Invitation created', `${invitation.email} can join as ${invitation.role}.`);
      await renderOrganizationPanel(orgSlug, organizations, true, true);
    } catch (error) {
      notify('Invitation failed', error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Create invitation';
    }
  });

  panel.querySelectorAll('.kg-revoke-invite').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('Revoke this pending invitation?')) return;
    button.disabled = true;
    try {
      await request(`${COLLABORATION_API}/orgs/${encodeURIComponent(orgSlug)}/invitations/${encodeURIComponent(button.dataset.invitationId)}`, { method: 'DELETE' });
      notify('Invitation revoked', 'The invitation link can no longer be accepted.');
      await renderOrganizationPanel(orgSlug, organizations, true);
    } catch (error) {
      notify('Revocation failed', error.message, 'error');
      button.disabled = false;
    }
  }));

  const teamForm = panel.querySelector('#kg-create-team');
  if (teamForm) {
    const nameInput = teamForm.querySelector('[name="name"]');
    const slugInput = teamForm.querySelector('[name="slug"]');
    let slugTouched = false;
    slugInput.addEventListener('input', () => slugTouched = true);
    nameInput.addEventListener('input', () => {
      if (!slugTouched) slugInput.value = nameInput.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
    });
    teamForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!teamForm.reportValidity()) return;
      const button = teamForm.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await request(`${COLLABORATION_API}/orgs/${encodeURIComponent(orgSlug)}/teams`, { method: 'POST', body: Object.fromEntries(new FormData(teamForm)) });
        notify('Team created', 'The new team is ready for members and repository access.');
        await renderOrganizationPanel(orgSlug, organizations, true);
      } catch (error) {
        notify('Team creation failed', error.message, 'error');
        button.disabled = false;
      }
    });
  }

  panel.querySelectorAll('.kg-add-team-member').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const teamId = form.closest('[data-team-id]').dataset.teamId;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await request(`${COLLABORATION_API}/orgs/${encodeURIComponent(orgSlug)}/teams/${encodeURIComponent(teamId)}/members`, { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      notify('Team updated', 'The organization member was added to the team.');
      await renderOrganizationPanel(orgSlug, organizations, true);
    } catch (error) {
      notify('Unable to add member', error.message, 'error');
      button.disabled = false;
    }
  }));

  panel.querySelectorAll('.kg-remove-team-member').forEach((button) => button.addEventListener('click', async () => {
    const teamId = button.closest('[data-team-id]').dataset.teamId;
    if (!window.confirm('Remove this member from the team?')) return;
    button.disabled = true;
    try {
      await request(`${COLLABORATION_API}/orgs/${encodeURIComponent(orgSlug)}/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(button.dataset.userId)}`, { method: 'DELETE' });
      notify('Member removed', 'The user remains an organization member.');
      await renderOrganizationPanel(orgSlug, organizations, true);
    } catch (error) {
      notify('Removal failed', error.message, 'error');
      button.disabled = false;
    }
  }));

  panel.querySelectorAll('.kg-delete-team').forEach((button) => button.addEventListener('click', async () => {
    const card = button.closest('[data-team-id]');
    if (!window.confirm('Delete this team? Organization membership will not be affected.')) return;
    button.disabled = true;
    try {
      await request(`${COLLABORATION_API}/orgs/${encodeURIComponent(orgSlug)}/teams/${encodeURIComponent(card.dataset.teamId)}`, { method: 'DELETE' });
      notify('Team deleted', 'The team and its memberships were removed.');
      await renderOrganizationPanel(orgSlug, organizations, true);
    } catch (error) {
      notify('Delete failed', error.message, 'error');
      button.disabled = false;
    }
  }));
}

async function renderOrganizationPanel(preferredSlug = '', organizations = null, force = false, preserveSecret = false) {
  if (location.hash.split('?')[0] !== '#/organizations') return;
  const content = document.querySelector('.content');
  if (!content) return;
  injectStyles();

  // The guard runs before the fetch, not after it.
  //
  // When the panel is already on the page its slug is on the panel, so nothing
  // has to be fetched to find out we have nothing to do. Asking first and
  // checking afterwards meant every DOM change fetched the organization list —
  // forty times in six seconds on this page, ending at the rate limiter, with
  // the render correctly skipped every time.
  const knownSlug = preferredSlug || document.querySelector('#kg-collaboration-panel')?.dataset.org || '';
  if (!force && knownSlug
    && organizationRenderKey === `${location.hash}:${knownSlug}`
    && document.querySelector('#kg-collaboration-panel')) return;

  const orgList = organizations || (await request('/api/orgs')).organizations;
  if (!orgList.length) return;
  const currentSlug = knownSlug || orgList[0].slug;
  const key = `${location.hash}:${currentSlug}`;
  if (!force && organizationRenderKey === key && document.querySelector('#kg-collaboration-panel')) return;
  organizationRenderKey = key;
  const previousSecret = preserveSecret ? document.querySelector('#kg-invitation-secret')?.innerHTML || '' : '';
  const data = await loadOrganization(currentSlug);
  document.querySelector('#kg-collaboration-panel')?.remove();
  content.insertAdjacentHTML('beforeend', panelMarkup(data, orgList));
  if (previousSecret) document.querySelector('#kg-invitation-secret').innerHTML = previousSecret;
  bindPanel(data, orgList);
}

function showInvitationDialog() {
  const token = sessionStorage.getItem(PENDING_INVITATION_KEY);
  if (!token || document.querySelector('#kg-invite-dialog')) return;
  const loggedInShell = document.querySelector('.app-shell');
  if (!loggedInShell) return;
  injectStyles();
  const backdrop = document.createElement('div');
  backdrop.className = 'kg-invite-backdrop';
  backdrop.id = 'kg-invite-dialog';
  backdrop.innerHTML = `<div class="kg-invite-dialog"><div class="eyebrow">Organization invitation</div><h2>Join this KukGit organization</h2><p>The invitation will be accepted for the email address of your currently signed-in account.</p><div class="login-demo">For security, KukGit verifies the invitation token, expiry and exact account email before adding membership.</div><div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px"><button class="btn" id="kg-invite-later">Later</button><button class="btn btn-primary" id="kg-accept-invitation">Accept invitation</button></div></div>`;
  document.body.append(backdrop);
  document.querySelector('#kg-invite-later').addEventListener('click', () => backdrop.remove());
  document.querySelector('#kg-accept-invitation').addEventListener('click', async () => {
    const button = document.querySelector('#kg-accept-invitation');
    button.disabled = true;
    button.textContent = 'Accepting…';
    try {
      const payload = await request(`${COLLABORATION_API}/invitations/accept`, { method: 'POST', body: { token } });
      sessionStorage.removeItem(PENDING_INVITATION_KEY);
      backdrop.remove();
      notify('Invitation accepted', `You joined ${payload.invitation.organization.name} as ${payload.invitation.role}.`);
      location.hash = '#/organizations';
    } catch (error) {
      notify('Unable to accept invitation', error.message, 'error');
      button.disabled = false;
      button.textContent = 'Accept invitation';
    }
  });
}

async function mount() {
  scheduling = false;
  captureInvitationToken();
  try {
    await renderOrganizationPanel();
  } catch (error) {
    const root = document.querySelector('.content');
    if (root && location.hash.split('?')[0] === '#/organizations' && !document.querySelector('#kg-collaboration-panel')) {
      root.insertAdjacentHTML('beforeend', `<section class="card kg-collaboration"><div class="card-body kg-empty">${escapeHtml(error.message)}</div></section>`);
    }
  }
  showInvitationDialog();
}

function scheduleMount() {
  if (scheduling) return;
  scheduling = true;
  requestAnimationFrame(() => requestAnimationFrame(mount));
}

captureInvitationToken();
window.addEventListener('hashchange', scheduleMount);
new MutationObserver(scheduleMount).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleMount();
