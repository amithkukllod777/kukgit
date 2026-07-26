const LFS_API = '/api/lfs';
let lfsRenderKey = '';
let lfsScheduled = false;

function lfsEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function lfsBytes(value = 0) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function lfsDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : '—';
}

function lfsNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${lfsEscape(title)}</b><span>${lfsEscape(message)}</span></div>`;
  root.append(toast);
  setTimeout(() => toast.remove(), 4600);
}

async function lfsRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = payload?.error?.code || payload?.code;
    throw error;
  }
  return payload;
}

function lfsRoute() {
  const [path] = location.hash.slice(1).split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== 'repo' || segments[3] !== 'settings' || !segments[1] || !segments[2]) return null;
  return { org: segments[1], repo: segments[2] };
}

function lfsStyles() {
  if (document.querySelector('#kg-lfs-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-lfs-styles';
  style.textContent = `
    .kg-lfs-panel { margin-top:18px; }
    .kg-lfs-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-bottom:16px; }
    .kg-lfs-metric { border:1px solid var(--border); border-radius:13px; padding:14px; background:rgba(255,255,255,.018); }
    .kg-lfs-metric span { display:block; color:var(--muted); font-size:11px; }
    .kg-lfs-metric b { display:block; margin-top:6px; font-size:18px; }
    .kg-lfs-progress { height:8px; overflow:hidden; border-radius:999px; background:rgba(255,255,255,.06); margin-top:10px; }
    .kg-lfs-progress i { display:block; height:100%; background:linear-gradient(90deg,#1598ff,#a728ff); }
    .kg-lfs-actions { display:flex; flex-wrap:wrap; gap:9px; align-items:center; }
    .kg-lfs-object { display:grid; grid-template-columns:minmax(230px,1fr) 110px 130px 130px auto; gap:12px; align-items:center; padding:12px 0; border-top:1px solid var(--border); }
    .kg-lfs-object:first-child { border-top:0; }
    .kg-lfs-oid { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; word-break:break-all; }
    .kg-lfs-empty { padding:26px 10px; text-align:center; color:var(--muted); }
    @media (max-width:950px) { .kg-lfs-metrics { grid-template-columns:1fr 1fr; } .kg-lfs-object { grid-template-columns:1fr; } }
    @media (max-width:520px) { .kg-lfs-metrics { grid-template-columns:1fr; } }
  `;
  document.head.append(style);
}

function lfsObjectRows(objects) {
  if (!objects.length) return '<div class="kg-lfs-empty">No Git LFS objects are attached to this repository yet.</div>';
  return objects.map((object) => `<div class="kg-lfs-object" data-lfs-object="${lfsEscape(object.oid)}">
    <div><div class="kg-lfs-oid">${lfsEscape(object.oid)}</div><div class="muted" style="font-size:10px">Attached ${lfsDate(object.attachedAt)}</div></div>
    <div><b>${lfsBytes(object.size)}</b></div>
    <div class="muted">Accessed<br />${lfsDate(object.lastAccessedAt)}</div>
    <div class="muted">Verified<br />${lfsDate(object.lastVerifiedAt)}</div>
    <div><button class="btn btn-ghost kg-lfs-verify" ${object.available ? '' : 'disabled'}>${object.available ? 'Verify' : 'Missing'}</button></div>
  </div>`).join('');
}

function lfsMarkup(data) {
  const repositoryPercent = data.quotaBytes ? Math.min(100, Math.round((data.usageBytes / data.quotaBytes) * 100)) : 0;
  const instancePercent = data.instanceQuotaBytes ? Math.min(100, Math.round((data.instanceUsageBytes / data.instanceQuotaBytes) * 100)) : 0;
  return `<section class="card kg-lfs-panel" id="kg-lfs-panel" data-lfs-org="${lfsEscape(data.repository.orgSlug)}" data-lfs-repo="${lfsEscape(data.repository.slug)}">
    <div class="card-header"><div><h2>Git Large File Storage</h2><p>Store large binaries outside normal Git objects with verified SHA-256 content addressing.</p></div><span class="badge public">${data.objectCount} objects</span></div>
    <div class="card-body">
      <div class="kg-lfs-metrics">
        <div class="kg-lfs-metric"><span>Repository usage</span><b>${lfsBytes(data.usageBytes)}</b><div class="kg-lfs-progress"><i style="width:${repositoryPercent}%"></i></div><span>${repositoryPercent}% of ${lfsBytes(data.quotaBytes)}</span></div>
        <div class="kg-lfs-metric"><span>Repository remaining</span><b>${lfsBytes(data.remainingBytes)}</b><span>Deduplicated associations count once per repository.</span></div>
        <div class="kg-lfs-metric"><span>Instance usage</span><b>${lfsBytes(data.instanceUsageBytes)}</b><div class="kg-lfs-progress"><i style="width:${instancePercent}%"></i></div><span>${instancePercent}% of ${lfsBytes(data.instanceQuotaBytes)}</span></div>
        <div class="kg-lfs-metric"><span>Maximum object</span><b>${lfsBytes(data.maxObjectBytes)}</b><span>Uploads are streamed and hash verified before attachment.</span></div>
      </div>
      <div class="login-demo"><b>Enable in a repository</b><br /><code>git lfs install</code><br /><code>git lfs track "*.zip"</code><br /><code>git add .gitattributes</code><br />Commit normally; KukGit handles Batch API upload and download actions over HTTP or SSH remotes.</div>
      <div class="card" style="margin-top:16px"><div class="card-header"><div><h3>Object inventory</h3><p>Latest 250 objects attached to this repository.</p></div><div class="kg-lfs-actions"><button class="btn" id="kg-lfs-refresh">Refresh</button><button class="btn btn-ghost" id="kg-lfs-gc">Run orphan GC</button></div></div><div class="card-body" id="kg-lfs-object-list">${lfsObjectRows(data.objects)}</div></div>
    </div>
  </section>`;
}

function bindLfsPanel(route) {
  document.querySelector('#kg-lfs-refresh')?.addEventListener('click', () => mountLfs(true));
  document.querySelector('#kg-lfs-gc')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!window.confirm('Remove all unreferenced Git LFS objects from this KukGit instance?')) return;
    button.disabled = true;
    try {
      const payload = await lfsRequest(`${LFS_API}/gc`, { method: 'POST', body: {} });
      lfsNotify('LFS garbage collection complete', `${payload.result.objectsRemoved} orphan object(s) removed; ${lfsBytes(payload.result.bytesRemoved)} reclaimed.`);
      await mountLfs(true);
    } catch (error) {
      lfsNotify('Garbage collection failed', error.message, 'error');
      button.disabled = false;
    }
  });
  document.querySelectorAll('.kg-lfs-verify').forEach((button) => button.addEventListener('click', async () => {
    const oid = button.closest('[data-lfs-object]').dataset.lfsObject;
    button.disabled = true;
    button.textContent = 'Verifying…';
    try {
      await lfsRequest(`${LFS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/objects/${oid}/verify`, { method: 'POST', body: {} });
      lfsNotify('Object verified', `${oid.slice(0, 12)}… passed size and SHA-256 verification.`);
      await mountLfs(true);
    } catch (error) {
      lfsNotify('Object verification failed', error.message, 'error');
      button.disabled = false;
      button.textContent = 'Verify';
    }
  }));
}

async function mountLfs(force = false) {
  lfsScheduled = false;
  const route = lfsRoute();
  if (!route) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const key = `${route.org}/${route.repo}/${location.hash}`;
  if (!force && lfsRenderKey === key && document.querySelector('#kg-lfs-panel')) return;
  lfsRenderKey = key;
  lfsStyles();
  try {
    const data = await lfsRequest(`${LFS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`);
    document.querySelector('#kg-lfs-panel')?.remove();
    content.insertAdjacentHTML('beforeend', lfsMarkup(data));
    bindLfsPanel(route);
  } catch (error) {
    if (error.status === 403 || error.status === 404) return;
    if (!document.querySelector('#kg-lfs-panel')) {
      content.insertAdjacentHTML('beforeend', `<section class="card kg-lfs-panel" id="kg-lfs-panel"><div class="card-body kg-lfs-empty">${lfsEscape(error.message)}</div></section>`);
    }
  }
}

function scheduleLfsMount() {
  if (lfsScheduled) return;
  lfsScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(() => mountLfs()));
}

window.addEventListener('hashchange', scheduleLfsMount);
new MutationObserver(scheduleLfsMount).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleLfsMount();
