const KG_EXTERNAL_ACCESS_API = '/api/external-access';
const KG_EXTERNAL_HISTORY_API = '/api/external-access-history';
const KG_EXTERNAL_INVITATION_DURATION_API = '/api/external-access-invitations';
const KG_INVITATIONS_API = '/api/repository-invitations';
const KG_ACCESS_DURATIONS = [7, 30, 90, 180, 365];
let kgExternalLifecycleKey = '';
let kgReviewCampaignKey = '';
let kgLifecycleBusy = false;
let kgCampaignBusy = false;

function kgEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function kgDate(value) {
  if (!value) return 'Permanent';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : '—';
}

function kgToast(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${kgEscape(title)}</b><span>${kgEscape(message)}</span></div>`;
  root.append(element);
  setTimeout(() => element.remove(), 4600);
}

async function kgRequest(path, options = {}) {
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

function kgRepoSettingsRoute() {
  const [path] = location.hash.slice(1).split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== 'repo' || segments[3] !== 'settings' || !segments[1] || !segments[2]) return null;
  return { org: segments[1], repo: segments[2] };
}

function kgDurationOptions(selected = 90, includePermanent = false) {
  const options = KG_ACCESS_DURATIONS.map((days) => `<option value="${days}" ${Number(selected) === days ? 'selected' : ''}>${days} days</option>`);
  if (includePermanent) options.push(`<option value="permanent" ${selected === null || selected === 'permanent' ? 'selected' : ''}>Permanent</option>`);
  return options.join('');
}

function kgPermissionOptions(selected = 'read') {
  return ['read', 'triage', 'write', 'maintain', 'admin']
    .map((permission) => `<option value="${permission}" ${permission === selected ? 'selected' : ''}>${permission}</option>`)
    .join('');
}

function kgStatusBadge(status) {
  const className = status === 'active' || status === 'permanent'
    ? 'public'
    : status === 'expiring'
      ? 'open'
      : 'critical';
  return `<span class="badge ${className}" style="text-transform:capitalize">${kgEscape(status)}</span>`;
}

function installKgExternalReviewStyles() {
  if (document.querySelector('#kg-external-access-review-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-external-access-review-styles';
  style.textContent = `
    .kg-access-lifecycle { margin-top:18px; }
    .kg-access-lifecycle-grid { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr); gap:18px; }
    .kg-access-life-row { display:grid; grid-template-columns:minmax(190px,1fr) 105px minmax(150px,.65fr) auto; gap:11px; align-items:center; padding:13px 0; border-top:1px solid var(--border); }
    .kg-access-life-row:first-child { border-top:0; }
    .kg-access-life-person b { display:block; }
    .kg-access-life-person span, .kg-access-life-meta { color:var(--muted); font-size:11px; line-height:1.5; }
    .kg-access-life-controls { display:flex; flex-wrap:wrap; gap:7px; justify-content:flex-end; }
    .kg-review-campaigns { margin-top:18px; }
    .kg-review-row { display:grid; grid-template-columns:minmax(190px,1fr) 100px 140px auto; gap:11px; align-items:center; padding:12px 0; border-top:1px solid var(--border); }
    .kg-review-row:first-child { border-top:0; }
    .kg-review-item { border:1px solid var(--border); border-radius:12px; padding:13px; margin-top:10px; background:rgba(255,255,255,.018); }
    .kg-review-item-controls { display:grid; grid-template-columns:120px 120px 145px minmax(160px,1fr) auto; gap:8px; align-items:end; margin-top:10px; }
    .kg-review-item-controls .field { margin:0; }
    .kg-access-empty { padding:22px 8px; text-align:center; color:var(--muted); }
    @media(max-width:940px){ .kg-access-lifecycle-grid{grid-template-columns:1fr}.kg-access-life-row,.kg-review-row{grid-template-columns:1fr}.kg-access-life-controls{justify-content:flex-start}.kg-review-item-controls{grid-template-columns:1fr} }
  `;
  document.head.append(style);
}

function installInvitationAccessDurationField() {
  const form = document.querySelector('#kg-create-repository-invitation');
  if (!form || form.querySelector('[name="accessDurationDays"]')) return;
  const grid = form.querySelector('.form-grid') || form;
  const field = document.createElement('div');
  field.className = 'field';
  field.innerHTML = `<label>Accepted access duration</label><select class="select" name="accessDurationDays">${kgDurationOptions(90)}</select><small class="muted">Starts when the invitation is accepted.</small>`;
  grid.append(field);
}

function installInvitationDurationTransport() {
  if (window.__kgExternalInvitationDurationInstalled) return;
  window.__kgExternalInvitationDurationInstalled = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function kgExternalDurationFetch(input, init = {}) {
    const response = await originalFetch(input, init);
    try {
      const requestUrl = new URL(typeof input === 'string' ? input : input.url, location.origin);
      const segments = requestUrl.pathname.split('/').filter(Boolean);
      const method = String(init?.method || (typeof input !== 'string' ? input.method : 'GET') || 'GET').toUpperCase();
      if (method !== 'POST' || segments.length !== 4 || segments[0] !== 'api' || segments[1] !== 'repository-invitations' || !response.ok) return response;
      let body = init?.body;
      if (body && typeof body !== 'string') body = await new Response(body).text();
      const parsedBody = body ? JSON.parse(body) : {};
      const accessDurationDays = Number(parsedBody.accessDurationDays || 90);
      if (!KG_ACCESS_DURATIONS.includes(accessDurationDays)) return response;
      const payload = await response.clone().json().catch(() => ({}));
      const invitationId = payload?.invitation?.id;
      if (!invitationId) return response;
      await originalFetch(`${KG_EXTERNAL_INVITATION_DURATION_API}/${encodeURIComponent(segments[2])}/${encodeURIComponent(segments[3])}/${encodeURIComponent(invitationId)}/duration`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessDurationDays }),
      });
    } catch (error) {
      console.warn('[KukGit] Invitation access duration defaulted to 90 days.', error);
    }
    return response;
  };
}

function grantRows(data) {
  if (!data.grants.length) return '<div class="kg-access-empty">No active external repository access.</div>';
  return data.grants.map((grant) => {
    const remaining = grant.expiresAt ? `Expires ${kgDate(grant.expiresAt)}` : 'No expiry';
    const controls = data.canManage ? `<div class="kg-access-life-controls">
      <select class="select kg-access-permission">${kgPermissionOptions(grant.permission)}</select>
      <select class="select kg-access-duration">${kgDurationOptions(90, data.organizationAdmin)}</select>
      <button class="btn kg-update-access-lifecycle">Update</button>
    </div>` : `<span class="badge public">${kgEscape(grant.permission)}</span>`;
    return `<div class="kg-access-life-row" data-grant-user="${kgEscape(grant.userId)}">
      <div class="kg-access-life-person"><b>${kgEscape(grant.displayName)}</b><span>${kgEscape(grant.email)} · ${kgEscape(grant.permission)} permission</span></div>
      <div>${kgStatusBadge(grant.status)}</div>
      <div class="kg-access-life-meta">${kgEscape(remaining)}<br />Last reviewed ${kgDate(grant.lastReviewedAt)}</div>
      ${controls}
    </div>`;
  }).join('');
}

function historyRows(history, canManage) {
  const restorable = history.filter((item) => !item.restoredAt);
  if (!restorable.length) return '<div class="kg-access-empty">No expired or revoked external grants awaiting review.</div>';
  return restorable.map((item) => `<div class="kg-access-life-row" data-history-id="${kgEscape(item.id)}">
    <div class="kg-access-life-person"><b>${kgEscape(item.displayName)}</b><span>${kgEscape(item.email)} · ${kgEscape(item.archivedReason)}</span></div>
    <div><span class="badge critical">${kgEscape(item.permission)}</span></div>
    <div class="kg-access-life-meta">Archived ${kgDate(item.archivedAt)}<br />Expired ${kgDate(item.expiresAt)}</div>
    <div class="kg-access-life-controls">${canManage ? `<select class="select kg-renew-permission">${kgPermissionOptions(item.permission)}</select><select class="select kg-renew-duration">${kgDurationOptions(90)}</select><button class="btn kg-renew-external-access">Renew</button>` : ''}</div>
  </div>`).join('');
}

function lifecycleMarkup(route, data, history) {
  return `<section class="card kg-access-lifecycle" id="kg-external-access-lifecycle" data-org="${kgEscape(route.org)}" data-repo="${kgEscape(route.repo)}">
    <div class="card-header"><div><h2>External access lifecycle</h2><p>Time-bound access, renewals and review history across browser, Git HTTP, SSH and Git LFS.</p></div><span class="badge ${data.grants.some((grant) => grant.status === 'expiring') ? 'open' : 'public'}">${data.grants.length} active</span></div>
    <div class="card-body"><div class="kg-access-lifecycle-grid"><div><section class="card"><div class="card-header"><div><h3>Active grants</h3><p>Update permission and replace the expiry from today.</p></div></div><div class="card-body">${grantRows(data)}</div></section></div><aside><section class="card"><div class="card-header"><div><h3>Expired access history</h3><p>Renew access without creating a new identity.</p></div></div><div class="card-body">${historyRows(history, data.canManage)}</div></section></aside></div></div>
  </section>`;
}

async function loadRepositoryLifecycle(force = false) {
  const route = kgRepoSettingsRoute();
  if (!route || kgLifecycleBusy) return;
  installInvitationAccessDurationField();
  const key = `${route.org}/${route.repo}/${location.hash}`;
  if (!force && kgExternalLifecycleKey === key && document.querySelector('#kg-external-access-lifecycle')) return;
  const content = document.querySelector('.content');
  if (!content) return;
  kgLifecycleBusy = true;
  try {
    const data = await kgRequest(`${KG_EXTERNAL_ACCESS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`);
    const history = data.canManage
      ? (await kgRequest(`${KG_EXTERNAL_HISTORY_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`)).history
      : [];
    if (!kgRepoSettingsRoute() || kgRepoSettingsRoute().org !== route.org || kgRepoSettingsRoute().repo !== route.repo) return;
    document.querySelector('#kg-external-access-lifecycle')?.remove();
    const anchor = document.querySelector('#kg-external-collaborators-panel');
    if (anchor) anchor.insertAdjacentHTML('afterend', lifecycleMarkup(route, data, history));
    else content.insertAdjacentHTML('beforeend', lifecycleMarkup(route, data, history));
    kgExternalLifecycleKey = key;
    bindRepositoryLifecycle(route);
  } catch (error) {
    if (![401, 403, 404].includes(error.status)) console.error('[KukGit] external access lifecycle', error);
  } finally {
    kgLifecycleBusy = false;
  }
}

function bindRepositoryLifecycle(route) {
  const panel = document.querySelector('#kg-external-access-lifecycle');
  if (!panel) return;
  panel.querySelectorAll('.kg-update-access-lifecycle').forEach((button) => button.addEventListener('click', async () => {
    const row = button.closest('[data-grant-user]');
    button.disabled = true;
    try {
      await kgRequest(`${KG_EXTERNAL_ACCESS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/collaborators/${encodeURIComponent(row.dataset.grantUser)}`, {
        method: 'PATCH',
        body: {
          permission: row.querySelector('.kg-access-permission').value,
          accessDays: row.querySelector('.kg-access-duration').value,
        },
      });
      kgToast('External access updated', 'Permission and access duration were updated.');
      await loadRepositoryLifecycle(true);
    } catch (error) {
      kgToast('Unable to update access', error.message, 'error');
      button.disabled = false;
    }
  }));
  panel.querySelectorAll('.kg-renew-external-access').forEach((button) => button.addEventListener('click', async () => {
    const row = button.closest('[data-history-id]');
    button.disabled = true;
    try {
      await kgRequest(`${KG_EXTERNAL_HISTORY_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/${encodeURIComponent(row.dataset.historyId)}/renew`, {
        method: 'POST',
        body: {
          permission: row.querySelector('.kg-renew-permission').value,
          accessDays: Number(row.querySelector('.kg-renew-duration').value),
        },
      });
      kgToast('External access renewed', 'The collaborator can use the repository again.');
      await loadRepositoryLifecycle(true);
    } catch (error) {
      kgToast('Unable to renew access', error.message, 'error');
      button.disabled = false;
    }
  }));
}

function campaignRows(campaigns) {
  if (!campaigns.length) return '<div class="kg-access-empty">No external access review campaigns yet.</div>';
  return campaigns.map((campaign) => `<div class="kg-review-row" data-campaign-id="${kgEscape(campaign.id)}">
    <div><b>${kgEscape(campaign.name)}</b><div class="kg-access-life-meta">Created by ${kgEscape(campaign.createdByName)} · ${campaign.totalItems} grants</div></div>
    <div><span class="badge ${campaign.status === 'completed' ? 'public' : campaign.overdue ? 'critical' : 'open'}">${campaign.overdue ? 'overdue' : kgEscape(campaign.status)}</span></div>
    <div class="kg-access-life-meta">Due ${kgDate(campaign.dueAt)}<br />${campaign.pendingItems} pending</div>
    <div><button class="btn btn-ghost kg-open-access-review">Open review</button></div>
  </div>`).join('');
}

function campaignItemMarkup(item, campaign) {
  const canDecide = campaign.status === 'open' && item.decision === 'pending';
  return `<article class="kg-review-item" data-review-item="${kgEscape(item.id)}">
    <div><b>${kgEscape(item.repoName)} · ${kgEscape(item.displayName)}</b><div class="kg-access-life-meta">${kgEscape(item.email)} · snapshot ${kgEscape(item.permissionSnapshot)} · current ${kgEscape(item.currentPermission || 'revoked')}</div></div>
    ${canDecide ? `<div class="kg-review-item-controls"><div class="field"><label>Decision</label><select class="select kg-review-decision"><option value="keep">Keep</option><option value="renew">Renew</option><option value="reduce">Reduce</option><option value="revoke">Revoke</option></select></div><div class="field"><label>Permission</label><select class="select kg-review-permission">${kgPermissionOptions(item.currentPermission || item.permissionSnapshot)}</select></div><div class="field"><label>Duration</label><select class="select kg-review-duration">${kgDurationOptions(90)}</select></div><div class="field"><label>Review note</label><input class="input kg-review-note" maxlength="500" placeholder="Reason or contract reference" /></div><button class="btn kg-decide-access-review">Apply</button></div>` : `<div class="kg-access-life-meta" style="margin-top:8px">Decision: ${kgEscape(item.decision)}${item.decidedByName ? ` by ${kgEscape(item.decidedByName)}` : ''} · ${kgDate(item.decidedAt)}</div>`}
  </article>`;
}

function campaignDetailsMarkup(campaign) {
  return `<section class="card" style="margin-top:16px" id="kg-access-review-detail" data-campaign-id="${kgEscape(campaign.id)}"><div class="card-header"><div><h3>${kgEscape(campaign.name)}</h3><p>${campaign.items.length} external grants · due ${kgDate(campaign.dueAt)}</p></div><span class="badge ${campaign.status === 'completed' ? 'public' : campaign.overdue ? 'critical' : 'open'}">${campaign.overdue ? 'overdue' : kgEscape(campaign.status)}</span></div><div class="card-body">${campaign.items.map((item) => campaignItemMarkup(item, campaign)).join('')}</div></section>`;
}

function campaignsMarkup(orgSlug, campaigns) {
  return `<section class="card kg-review-campaigns" id="kg-external-access-reviews" data-org="${kgEscape(orgSlug)}"><div class="card-header"><div><h2>External access reviews</h2><p>Periodically certify, renew, reduce or revoke repository-only access.</p></div><span class="badge public">${campaigns.length} campaigns</span></div><div class="card-body"><form id="kg-create-access-review"><div class="form-grid"><div class="field"><label>Campaign name</label><input class="input" name="name" maxlength="120" value="Quarterly external access review" required /></div><div class="field"><label>Due in</label><select class="select" name="dueInDays"><option value="7">7 days</option><option value="14" selected>14 days</option><option value="30">30 days</option></select></div></div><button class="btn btn-primary" type="submit">Start access review</button></form><hr style="border:0;border-top:1px solid var(--border);margin:18px 0" /><div id="kg-access-review-list">${campaignRows(campaigns)}</div><div id="kg-access-review-detail-root"></div></div></section>`;
}

async function loadCampaignPanel(force = false) {
  const collaboration = document.querySelector('#kg-collaboration-panel[data-org]');
  if (!collaboration || kgCampaignBusy) return;
  const org = collaboration.dataset.org;
  const key = `${org}/${location.hash}`;
  if (!force && kgReviewCampaignKey === key && document.querySelector('#kg-external-access-reviews')) return;
  kgCampaignBusy = true;
  try {
    const data = await kgRequest(`${KG_EXTERNAL_ACCESS_API}/${encodeURIComponent(org)}/reviews`);
    if (document.querySelector('#kg-collaboration-panel')?.dataset.org !== org) return;
    document.querySelector('#kg-external-access-reviews')?.remove();
    collaboration.insertAdjacentHTML('afterend', campaignsMarkup(org, data.campaigns));
    kgReviewCampaignKey = key;
    bindCampaignPanel(org);
  } catch (error) {
    if (![401, 403, 404].includes(error.status)) console.error('[KukGit] external access campaigns', error);
  } finally {
    kgCampaignBusy = false;
  }
}

function bindCampaignPanel(org) {
  const panel = document.querySelector('#kg-external-access-reviews');
  if (!panel) return;
  panel.querySelector('#kg-create-access-review')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form));
      body.dueInDays = Number(body.dueInDays);
      const result = await kgRequest(`${KG_EXTERNAL_ACCESS_API}/${encodeURIComponent(org)}/reviews`, { method: 'POST', body });
      kgToast('Access review started', `${result.campaign.items.length} external grants require review.`);
      await loadCampaignPanel(true);
      await openCampaign(org, result.campaign.id);
    } catch (error) {
      kgToast('Unable to start review', error.message, 'error');
      button.disabled = false;
    }
  });
  panel.querySelectorAll('.kg-open-access-review').forEach((button) => button.addEventListener('click', () => {
    openCampaign(org, button.closest('[data-campaign-id]').dataset.campaignId);
  }));
}

async function openCampaign(org, campaignId) {
  try {
    const result = await kgRequest(`${KG_EXTERNAL_ACCESS_API}/${encodeURIComponent(org)}/reviews/${encodeURIComponent(campaignId)}`);
    const root = document.querySelector('#kg-access-review-detail-root');
    if (!root) return;
    root.innerHTML = campaignDetailsMarkup(result.campaign);
    root.querySelectorAll('.kg-decide-access-review').forEach((button) => button.addEventListener('click', async () => {
      const item = button.closest('[data-review-item]');
      button.disabled = true;
      try {
        const decision = item.querySelector('.kg-review-decision').value;
        const body = {
          decision,
          permission: item.querySelector('.kg-review-permission').value,
          accessDays: Number(item.querySelector('.kg-review-duration').value),
          note: item.querySelector('.kg-review-note').value,
        };
        const updated = await kgRequest(`${KG_EXTERNAL_ACCESS_API}/${encodeURIComponent(org)}/reviews/${encodeURIComponent(campaignId)}/items/${encodeURIComponent(item.dataset.reviewItem)}`, { method: 'POST', body });
        kgToast('Access review recorded', `Decision “${decision}” was applied.`);
        root.innerHTML = campaignDetailsMarkup(updated.campaign);
        await loadCampaignPanel(true);
        await openCampaign(org, campaignId);
      } catch (error) {
        kgToast('Unable to apply review', error.message, 'error');
        button.disabled = false;
      }
    }));
  } catch (error) {
    kgToast('Unable to load review', error.message, 'error');
  }
}

function scheduleKgExternalReviewRender() {
  installInvitationAccessDurationField();
  queueMicrotask(() => {
    loadRepositoryLifecycle();
    loadCampaignPanel();
  });
}

installKgExternalReviewStyles();
installInvitationDurationTransport();
window.addEventListener('hashchange', () => {
  kgExternalLifecycleKey = '';
  kgReviewCampaignKey = '';
  scheduleKgExternalReviewRender();
});
new MutationObserver(scheduleKgExternalReviewRender).observe(document.documentElement, { childList: true, subtree: true });
scheduleKgExternalReviewRender();
