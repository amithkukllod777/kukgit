const IMPORT_API = '/api/repository-imports';
let importRenderKey = '';
let importRefusedKey = '';
let importScheduled = false;
let importPreview = null;
let importWatch = null;

function importEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function importNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${importEscape(title)}</b><span>${importEscape(message)}</span></div>`;
  root.append(toast);
  setTimeout(() => toast.remove(), 4600);
}

async function importRequest(path, options = {}) {
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

function importRoute() {
  const [path] = location.hash.slice(1).split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  return segments[0] === 'repositories' ? { view: 'repositories' } : null;
}

function importStyles() {
  if (document.querySelector('#kg-import-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-import-styles';
  style.textContent = `
    .kg-import-grid { display:grid; grid-template-columns:150px minmax(0,1fr) minmax(0,1fr); gap:11px; align-items:end; }
    .kg-import-row { display:grid; grid-template-columns:22px minmax(0,1fr) 110px auto; gap:11px; align-items:center; padding:10px 0; border-top:1px solid var(--border); }
    .kg-import-row:first-child { border-top:0; }
    .kg-import-row span.kg-import-why { color:var(--muted); font-size:11px; }
    .kg-import-name b { display:block; }
    .kg-import-name span { color:var(--muted); font-size:11px; }
    .kg-import-progress { height:6px; border-radius:99px; background:rgba(255,255,255,.08); overflow:hidden; margin:10px 0; }
    .kg-import-progress i { display:block; height:100%; background:linear-gradient(90deg,#1598ff,#a728ff); }
    .kg-import-empty { padding:20px 8px; text-align:center; color:var(--muted); }
    @media(max-width:820px){ .kg-import-grid{grid-template-columns:1fr} .kg-import-row{grid-template-columns:22px 1fr} }
  `;
  document.head.append(style);
}

function importStatusLabel(status) {
  return { pending: 'Waiting', importing: 'Importing…', imported: 'Imported', failed: 'Failed', skipped: 'Skipped' }[status] ?? status;
}

function importPreviewRows(preview) {
  if (!preview) return '';
  const selected = preview.selected.map((entry) => `
    <label class="kg-import-row">
      <input type="checkbox" name="repository" value="${importEscape(entry.slug)}" checked />
      <span class="kg-import-name"><b>${importEscape(entry.name)}</b><span>${importEscape(entry.slug)}${entry.private ? ' · private' : ''}</span></span>
      <span class="badge ${entry.private ? '' : 'public'}">${entry.private ? 'private' : 'public'}</span>
      <span></span>
    </label>`).join('');
  const skipped = preview.skipped.map((entry) => `
    <div class="kg-import-row">
      <span>—</span>
      <span class="kg-import-name"><b>${importEscape(entry.name)}</b><span class="kg-import-why">${importEscape(entry.reason)}</span></span>
      <span class="badge">skipped</span>
      <span></span>
    </div>`).join('');
  return `
    ${preview.note ? `<div class="login-demo">${importEscape(preview.note)}</div>` : ''}
    <h3 style="margin-top:14px">${preview.selected.length} to import</h3>
    ${selected || '<div class="kg-import-empty">Nothing here can be imported.</div>'}
    ${skipped ? `<h3 style="margin-top:16px">${preview.skipped.length} skipped</h3>${skipped}` : ''}`;
}

function importJobRows(job) {
  const done = job.counts.imported + job.counts.failed + job.counts.skipped;
  const percent = job.total ? Math.round((done / job.total) * 100) : 0;
  return `
    <div class="kg-import-progress"><i style="width:${percent}%"></i></div>
    <p>${job.counts.imported} imported · ${job.counts.failed} failed · ${job.counts.skipped} skipped · ${job.counts.pending + job.counts.importing} to go</p>
    ${job.items.map((item) => `
      <div class="kg-import-row">
        <span>${item.status === 'imported' ? '✓' : item.status === 'failed' ? '⚠' : '·'}</span>
        <span class="kg-import-name"><b>${importEscape(item.name)}</b>${item.message ? `<span class="kg-import-why">${importEscape(item.message)}</span>` : ''}</span>
        <span class="badge">${importStatusLabel(item.status)}</span>
        <span></span>
      </div>`).join('')}`;
}

function importMarkup(organizations) {
  return `<section class="card kg-import-panel" id="kg-import-panel">
    <div class="card-header"><div><h2>Import from another host</h2><p>Bring every repository an organization or user owns on GitHub or GitLab into KukGit.</p></div></div>
    <div class="card-body">
      <form id="kg-import-form">
        <div class="kg-import-grid">
          <div class="field"><label>Host</label><select class="select" name="forge"><option value="github">GitHub</option><option value="gitlab">GitLab</option></select></div>
          <div class="field"><label>Organization or user there</label><input class="input" name="owner" placeholder="kuklabs" required /></div>
          <div class="field"><label>Import into</label><select class="select" name="orgSlug">${organizations.map((org) => `<option value="${importEscape(org.slug)}">${importEscape(org.name)}</option>`).join('')}</select></div>
        </div>
        <div class="field" style="margin-top:12px"><label>Access token <span class="muted">(needed for private repositories)</span></label><input class="input" type="password" name="accessToken" autocomplete="off" placeholder="github_pat_… or glpat-…" /><div class="field-hint">Used for this import only and never stored. Read access to repository contents is all it needs.</div></div>
        <div class="field"><label><input type="checkbox" name="includeForks" /> Include forks</label><label><input type="checkbox" name="includeArchived" /> Include archived repositories</label></div>
        <button type="button" class="btn btn-primary" id="kg-import-preview">See what would be imported</button>
      </form>
      <div id="kg-import-result"></div>
    </div>
  </section>`;
}

function importFormValues() {
  const form = document.querySelector('#kg-import-form');
  const values = new FormData(form);
  return {
    forge: values.get('forge'),
    owner: String(values.get('owner') ?? '').trim(),
    orgSlug: values.get('orgSlug'),
    // An unchecked box is absent from FormData, which is what `has` reads.
    includeForks: values.has('includeForks'),
    includeArchived: values.has('includeArchived'),
    accessToken: String(values.get('accessToken') ?? ''),
  };
}

function watchImportJob(jobId) {
  clearInterval(importWatch);
  importWatch = setInterval(async () => {
    const result = document.querySelector('#kg-import-result');
    // The panel has gone — the visitor navigated away. Polling a screen nobody
    // is looking at is how a background request becomes a permanent one.
    if (!result || !document.querySelector('#kg-import-panel')) { clearInterval(importWatch); importWatch = null; return; }
    try {
      const payload = await importRequest(`${IMPORT_API}/${encodeURIComponent(jobId)}`);
      result.innerHTML = `<h3 style="margin-top:16px">Importing from ${importEscape(payload.job.forge)}/${importEscape(payload.job.owner)}</h3>${importJobRows(payload.job)}`;
      if (payload.job.status !== 'running') {
        clearInterval(importWatch);
        importWatch = null;
        importNotify('Import finished', `${payload.job.counts.imported} imported, ${payload.job.counts.failed} failed.`, payload.job.counts.failed ? 'error' : 'success');
      }
    } catch (error) {
      clearInterval(importWatch);
      importWatch = null;
      importNotify('Lost track of the import', error.message, 'error');
    }
  }, 2000);
}

function bindImportPanel() {
  document.querySelector('#kg-import-preview')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const form = document.querySelector('#kg-import-form');
    if (!form.reportValidity()) return;
    const values = importFormValues();
    button.disabled = true;
    button.textContent = 'Asking the host…';
    try {
      const payload = await importRequest(`${IMPORT_API}/preview`, { method: 'POST', body: values });
      importPreview = payload;
      document.querySelector('#kg-import-result').innerHTML = `${importPreviewRows(payload)}
        ${payload.selected.length ? '<button type="button" class="btn btn-primary" id="kg-import-start" style="margin-top:14px">Import the selected repositories</button>' : ''}`;
      bindImportStart();
    } catch (error) {
      importNotify('Could not read that account', error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'See what would be imported';
    }
  });
}

function bindImportStart() {
  document.querySelector('#kg-import-start')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const slugs = [...document.querySelectorAll('input[name="repository"]:checked')].map((input) => input.value);
    if (!slugs.length) { importNotify('Nothing selected', 'Tick at least one repository to import.', 'error'); return; }
    if (!window.confirm(`Import ${slugs.length} repositor${slugs.length === 1 ? 'y' : 'ies'} into this organization? Each one counts towards the plan.`)) return;
    button.disabled = true;
    button.textContent = 'Starting…';
    try {
      const payload = await importRequest(IMPORT_API, { method: 'POST', body: { ...importFormValues(), slugs } });
      document.querySelector('#kg-import-result').innerHTML = importJobRows(payload.job);
      watchImportJob(payload.job.id);
    } catch (error) {
      importNotify('Import could not start', error.message, 'error');
      button.disabled = false;
      button.textContent = 'Import the selected repositories';
    }
  });
}

async function mountImport(force = false) {
  importScheduled = false;
  const route = importRoute();
  if (!route) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const key = location.hash;
  if (!force && importRenderKey === key && document.querySelector('#kg-import-panel')) return;
  // A refused load renders no panel, so the guard above can never be satisfied
  // by one — and without remembering the refusal this asks again on every DOM
  // change, which is a request per keystroke for somebody who may not import.
  if (!force && importRefusedKey === key) return;
  importRenderKey = key;
  importStyles();
  try {
    const payload = await importRequest('/api/orgs');
    const organizations = (payload.organizations ?? []).filter((org) => ['owner', 'admin', 'maintainer'].includes(org.role));
    if (!organizations.length) { importRefusedKey = key; return; }
    document.querySelector('#kg-import-panel')?.remove();
    content.insertAdjacentHTML('beforeend', importMarkup(organizations));
    bindImportPanel();
  } catch (error) {
    if (error.status === 401 || error.status === 403 || error.status === 404) { importRefusedKey = key; return; }
    if (!document.querySelector('#kg-import-panel')) {
      content.insertAdjacentHTML('beforeend', `<section class="card kg-import-panel" id="kg-import-panel"><div class="card-body kg-import-empty">${importEscape(error.message)}</div></section>`);
    }
  }
}

function scheduleImportMount() {
  if (importScheduled) return;
  importScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(() => mountImport()));
}

window.addEventListener('hashchange', scheduleImportMount);
new MutationObserver(scheduleImportMount).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleImportMount();
