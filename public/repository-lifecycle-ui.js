const LIFECYCLE_API = '/api/repository-lifecycle';
let lifecycleRenderKey = '';
let lifecycleScheduled = false;

function lifeEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function lifeNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${lifeEscape(title)}</b><span>${lifeEscape(message)}</span></div>`;
  root.append(element);
  setTimeout(() => element.remove(), 4800);
}

async function lifeRequest(path, options = {}) {
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

function lifeRoute() {
  const [path] = location.hash.slice(1).split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] === 'repo' && segments[1] && segments[2] && segments[3] === 'settings') {
    return { type: 'repository', org: segments[1], repo: segments[2] };
  }
  if (segments[0] === 'settings') return { type: 'trash' };
  return null;
}

function lifeDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function lifeStyles() {
  if (document.querySelector('#kg-lifecycle-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-lifecycle-styles';
  style.textContent = `
    .kg-lifecycle { margin-top:18px; }
    .kg-life-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
    .kg-life-action { border:1px solid var(--border); border-radius:14px; padding:15px; background:rgba(255,255,255,.018); }
    .kg-life-action.danger { border-color:rgba(255,91,118,.38); background:rgba(255,91,118,.045); }
    .kg-life-action h3 { margin:0 0 6px; }
    .kg-life-action p { color:var(--muted); font-size:12px; line-height:1.55; }
    .kg-life-form { display:grid; gap:10px; margin-top:12px; }
    .kg-life-status { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
    .kg-trash-row { display:grid; grid-template-columns:minmax(170px,.8fr) minmax(180px,.8fr) minmax(240px,1fr); gap:14px; padding:15px 0; border-top:1px solid var(--border); align-items:start; }
    .kg-trash-row:first-child { border-top:0; }
    .kg-trash-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:end; }
    .kg-trash-actions .input { min-width:220px; }
    .kg-life-empty { text-align:center; color:var(--muted); padding:28px 10px; }
    @media (max-width:900px) { .kg-life-grid { grid-template-columns:1fr; } .kg-trash-row { grid-template-columns:1fr; } .kg-trash-actions .input { min-width:100%; } }
  `;
  document.head.append(style);
}

function repositoryPanel(data) {
  const repo = data.repository;
  const targets = data.availableTransferOrganizations || [];
  return `<section class="card kg-lifecycle" id="kg-lifecycle-panel">
    <div class="card-header"><div><h2>Repository lifecycle</h2><p>Archive, transfer or safely remove this repository.</p></div><span class="badge ${repo.archived ? 'high' : 'public'}">${repo.archived ? 'Archived' : 'Active'}</span></div>
    <div class="card-body"><div class="kg-life-status"><span class="badge">${lifeEscape(repo.orgSlug)}/${lifeEscape(repo.slug)}</span><span class="badge">${lifeEscape(repo.visibility)}</span>${repo.archivedAt ? `<span class="badge high">Archived ${lifeDate(repo.archivedAt)}</span>` : ''}</div>
      <div class="kg-life-grid" style="margin-top:16px">
        <article class="kg-life-action"><h3>${repo.archived ? 'Unarchive repository' : 'Archive repository'}</h3><p>${repo.archived ? 'Return the repository to normal read/write operation.' : 'Make the repository read-only. Code, issues and history remain visible, while browser writes and Git pushes are blocked.'}</p><button class="btn ${repo.archived ? 'btn-primary' : ''}" id="kg-life-archive">${repo.archived ? 'Unarchive repository' : 'Archive repository'}</button></article>
        <article class="kg-life-action"><h3>Transfer ownership</h3><p>Move this repository and its bare Git storage to another organization where you are an Admin or Owner. The repository must be archived first.</p>${targets.length ? `<form class="kg-life-form" id="kg-life-transfer"><select class="select" name="targetOrgSlug">${targets.map((org) => `<option value="${lifeEscape(org.slug)}">${lifeEscape(org.name)} · ${lifeEscape(org.role)}</option>`).join('')}</select><button class="btn" type="submit" ${repo.archived ? '' : 'disabled'}>Transfer repository</button></form>` : '<div class="login-demo">No eligible target organization is available.</div>'}</article>
        <article class="kg-life-action danger" style="grid-column:1/-1"><h3>Move repository to Trash</h3><p>The repository disappears from normal listings and Git access, but Admins can restore it for ${data.retentionDays} days. Archive it first, then type the exact confirmation below.</p><form class="kg-life-form" id="kg-life-trash"><div class="field"><label>Type <code>${lifeEscape(data.confirmation)}</code></label><input class="input" name="confirmation" autocomplete="off" placeholder="${lifeEscape(data.confirmation)}" required /></div><button class="btn btn-ghost" type="submit" ${repo.archived ? '' : 'disabled'}>Move to Trash</button></form></article>
      </div>
    </div>
  </section>`;
}

function trashPanel(data) {
  const rows = data.repositories || [];
  return `<section class="card kg-lifecycle" id="kg-trash-panel">
    <div class="card-header"><div><h2>Repository Trash</h2><p>Restore deleted repositories or permanently purge them with owner confirmation.</p></div><span class="badge">${rows.length} repositories</span></div>
    <div class="card-body">${rows.length ? rows.map((repo) => {
      const confirmation = `${repo.originalOrgSlug}/${repo.originalSlug}`;
      return `<article class="kg-trash-row" data-repository-id="${lifeEscape(repo.id)}" data-confirmation="${lifeEscape(confirmation)}">
        <div><b>${lifeEscape(confirmation)}</b><div class="muted" style="font-size:11px">${lifeEscape(repo.name)} · ${lifeEscape(repo.role)}</div></div>
        <div class="muted" style="font-size:11px">Deleted ${lifeDate(repo.deletedAt)}<br />Scheduled purge ${lifeDate(repo.purgeAfter)}</div>
        <form class="kg-trash-actions"><div class="field" style="margin:0;flex:1"><label>Type <code>${lifeEscape(confirmation)}</code></label><input class="input" name="confirmation" autocomplete="off" required /></div><button class="btn kg-life-restore" type="button">Restore</button>${repo.role === 'owner' ? '<button class="btn btn-ghost kg-life-purge" type="button">Permanently purge</button>' : ''}</form>
      </article>`;
    }).join('') : '<div class="kg-life-empty">Repository Trash is empty.</div>'}</div>
  </section>`;
}

function bindRepositoryPanel(data, route) {
  const repo = data.repository;
  document.querySelector('#kg-life-archive')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await lifeRequest(`${LIFECYCLE_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/archive`, { method: repo.archived ? 'DELETE' : 'POST' });
      lifeNotify(repo.archived ? 'Repository unarchived' : 'Repository archived', repo.archived ? 'Read/write operation is restored.' : 'The repository is now read-only.');
      await mountLifecycle(true);
    } catch (error) { lifeNotify('Lifecycle update failed', error.message, 'error'); event.currentTarget.disabled = false; }
  });

  document.querySelector('#kg-life-transfer')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const targetOrgSlug = new FormData(form).get('targetOrgSlug');
    if (!window.confirm(`Transfer ${route.org}/${route.repo} to ${targetOrgSlug}?`)) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const payload = await lifeRequest(`${LIFECYCLE_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/transfer`, { method: 'POST', body: { targetOrgSlug } });
      lifeNotify('Repository transferred', `New location: ${payload.repository.orgSlug}/${payload.repository.slug}`);
      location.hash = `#/repo/${encodeURIComponent(payload.repository.orgSlug)}/${encodeURIComponent(payload.repository.slug)}/settings`;
    } catch (error) { lifeNotify('Transfer failed', error.message, 'error'); button.disabled = false; }
  });

  document.querySelector('#kg-life-trash')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    if (!window.confirm('Move this repository to Trash? Normal Git and browser access will stop immediately.')) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await lifeRequest(`${LIFECYCLE_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/trash`, { method: 'POST', body: { confirmation: new FormData(form).get('confirmation') } });
      lifeNotify('Repository moved to Trash', 'It can be restored from Settings during the retention period.');
      location.hash = '#/settings';
    } catch (error) { lifeNotify('Delete failed', error.message, 'error'); button.disabled = false; }
  });
}

function bindTrashPanel() {
  document.querySelectorAll('.kg-trash-row').forEach((row) => {
    const form = row.querySelector('form');
    const confirmation = () => new FormData(form).get('confirmation');
    row.querySelector('.kg-life-restore')?.addEventListener('click', async (event) => {
      if (!form.reportValidity()) return;
      event.currentTarget.disabled = true;
      try {
        const payload = await lifeRequest(`${LIFECYCLE_API}/trash/${encodeURIComponent(row.dataset.repositoryId)}/restore`, { method: 'POST', body: { confirmation: confirmation() } });
        lifeNotify('Repository restored', `${payload.repository.orgSlug}/${payload.repository.slug} is available again.`);
        await mountLifecycle(true);
      } catch (error) { lifeNotify('Restore failed', error.message, 'error'); event.currentTarget.disabled = false; }
    });
    row.querySelector('.kg-life-purge')?.addEventListener('click', async (event) => {
      if (!form.reportValidity()) return;
      if (!window.confirm('Permanently purge this repository? This destroys Git data, issues, pull requests, settings and history and cannot be undone.')) return;
      event.currentTarget.disabled = true;
      try {
        await lifeRequest(`${LIFECYCLE_API}/trash/${encodeURIComponent(row.dataset.repositoryId)}`, { method: 'DELETE', body: { confirmation: confirmation() } });
        lifeNotify('Repository permanently purged', 'Repository data and Git storage were removed.');
        await mountLifecycle(true);
      } catch (error) { lifeNotify('Purge failed', error.message, 'error'); event.currentTarget.disabled = false; }
    });
  });
}

async function mountLifecycle(force = false) {
  const route = lifeRoute();
  if (!route) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const key = `${route.type}/${route.org || ''}/${route.repo || ''}/${location.hash}`;
  const selector = route.type === 'repository' ? '#kg-lifecycle-panel' : '#kg-trash-panel';
  if (!force && lifecycleRenderKey === key && document.querySelector(selector)) return;
  lifecycleRenderKey = key;
  lifeStyles();
  try {
    if (route.type === 'repository') {
      const data = await lifeRequest(`${LIFECYCLE_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`);
      document.querySelector('#kg-lifecycle-panel')?.remove();
      content.insertAdjacentHTML('beforeend', repositoryPanel(data));
      bindRepositoryPanel(data, route);
    } else {
      const data = await lifeRequest(`${LIFECYCLE_API}/trash`);
      document.querySelector('#kg-trash-panel')?.remove();
      content.insertAdjacentHTML('beforeend', trashPanel(data));
      bindTrashPanel();
    }
  } catch (error) {
    if (!document.querySelector(selector)) content.insertAdjacentHTML('beforeend', `<section class="card kg-lifecycle" id="${selector.slice(1)}"><div class="card-body kg-life-empty">${lifeEscape(error.message)}</div></section>`);
  }
}

function scheduleLifecycle() {
  if (lifecycleScheduled) return;
  lifecycleScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    lifecycleScheduled = false;
    await mountLifecycle();
  }));
}

window.addEventListener('hashchange', scheduleLifecycle);
new MutationObserver(scheduleLifecycle).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleLifecycle();
