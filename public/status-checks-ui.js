const STATUS_CHECKS_API = '/api/status-checks';
let statusRenderKey = '';
let statusScheduled = false;

function statusEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function statusNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${statusEscape(title)}</b><span>${statusEscape(message)}</span></div>`;
  root.append(element);
  setTimeout(() => element.remove(), 4600);
}

async function statusRequest(path, options = {}) {
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

function statusRoute() {
  const [path] = location.hash.slice(1).split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== 'repo' || !segments[1] || !segments[2]) return null;
  return { org: segments[1], repo: segments[2], tab: segments[3] || 'code' };
}

function statusFormatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function statusStyles() {
  if (document.querySelector('#kg-status-check-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-status-check-styles';
  style.textContent = `
    .kg-status-checks { margin-top:18px; }
    .kg-status-grid { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr); gap:18px; }
    .kg-status-policy-form, .kg-status-publish-form { border:1px solid var(--border); border-radius:14px; padding:15px; background:rgba(255,255,255,.018); }
    .kg-status-policy-row { display:grid; grid-template-columns:minmax(150px,.45fr) minmax(220px,1fr) auto; gap:12px; align-items:center; padding:12px 0; border-top:1px solid var(--border); }
    .kg-status-policy-row:first-child { border-top:0; }
    .kg-status-policy-row span { color:var(--muted); font-size:11px; }
    .kg-status-pr { border:1px solid var(--border); border-radius:16px; padding:16px; margin-top:14px; background:rgba(255,255,255,.018); }
    .kg-status-pr.ready { border-color:rgba(61,220,151,.34); background:rgba(61,220,151,.045); }
    .kg-status-pr.blocked { border-color:rgba(255,94,122,.34); background:rgba(255,94,122,.05); }
    .kg-status-pr-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
    .kg-status-pr-head h3 { margin:0 0 4px; }
    .kg-status-summary { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
    .kg-status-list { display:grid; gap:9px; margin-top:13px; }
    .kg-status-row { display:grid; grid-template-columns:minmax(160px,1fr) 110px minmax(180px,.9fr); gap:12px; align-items:center; border:1px solid var(--border); border-radius:12px; padding:11px 12px; background:rgba(3,12,22,.46); }
    .kg-status-row b { display:block; }
    .kg-status-row span { color:var(--muted); font-size:10px; line-height:1.45; }
    .kg-status-state-success { color:#3ddc97; }
    .kg-status-state-pending, .kg-status-state-missing { color:#f7c948; }
    .kg-status-state-failure, .kg-status-state-error { color:#ff7b91; }
    .kg-status-publish-form { margin-top:14px; }
    .kg-status-empty { color:var(--muted); text-align:center; padding:25px 10px; }
    .kg-status-code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; word-break:break-all; }
    @media (max-width:900px) { .kg-status-grid { grid-template-columns:1fr; } .kg-status-policy-row, .kg-status-row { grid-template-columns:1fr; } .kg-status-pr-head { flex-direction:column; } }
  `;
  document.head.append(style);
}

function stateBadge(state) {
  const labels = { missing: 'Missing', pending: 'Pending', success: 'Success', failure: 'Failure', error: 'Error' };
  const className = state === 'success' ? 'public' : ['failure', 'error'].includes(state) ? 'critical' : 'high';
  return `<span class="badge ${className}">${statusEscape(labels[state] || state)}</span>`;
}

function policyMarkup(policy, canManage) {
  return `<div class="kg-status-policy-row"><div><b>${statusEscape(policy.branch)}</b><span>Protected base branch</span></div><div>${policy.contexts.length ? policy.contexts.map((context) => `<span class="badge">${statusEscape(context)}</span>`).join(' ') : '<span>No required contexts — merge is not gated by checks.</span>'}</div><div>${canManage ? `<button class="btn btn-ghost kg-delete-status-policy" data-branch="${statusEscape(policy.branch)}">Delete</button>` : ''}</div></div>`;
}

function settingsMarkup(data, branches) {
  const suggested = data.knownContexts.join('\n');
  return `<section class="card kg-status-checks" id="kg-status-checks-panel">
    <div class="card-header"><div><h2>Required status checks</h2><p>Require selected CI and integration contexts to succeed on the current pull-request head commit.</p></div><span class="badge public">${data.policies.length} configured</span></div>
    <div class="card-body"><div class="kg-status-grid"><div>
      ${data.canManage ? `<form class="kg-status-policy-form" id="kg-status-policy-form"><div class="field"><label>Base branch</label><select class="select" name="branch">${branches.map((branch) => `<option value="${statusEscape(branch.name)}">${statusEscape(branch.name)}</option>`).join('')}</select></div><div class="field"><label>Required check contexts</label><textarea class="textarea" name="contexts" rows="6" maxlength="7000" placeholder="build\ntest\nsecurity/scan">${statusEscape(suggested)}</textarea><span class="muted">One context per line or comma-separated. Saving an empty list keeps the policy but does not block merge.</span></div><button class="btn btn-primary" type="submit">Save status-check policy</button></form>` : '<div class="login-demo">Repository Admin permission is required to change required status checks.</div>'}
      <div id="kg-status-policy-list">${data.policies.length ? data.policies.map((policy) => policyMarkup(policy, data.canManage)).join('') : '<div class="kg-status-empty">No branch requires status checks yet.</div>'}</div>
    </div><aside><section class="card"><div class="card-body"><div class="login-demo"><b>Current commit only</b><br />KukGit evaluates checks for the pull request’s current head SHA. A new commit automatically makes previous results stale for merge purposes.</div><div class="login-demo" style="margin-top:12px"><b>Trusted publisher API</b><br />CI runners publish with a scoped <code>repo:write</code> personal access token using Bearer or HTTP Basic authentication.</div><div class="login-demo" style="margin-top:12px"><b>Merge requirement</b><br />Every selected context must exist and report Success. Missing, Pending, Failure and Error states block merge.</div></div></section></aside></div></div>
  </section>`;
}

function checkRow(check) {
  const target = check.targetUrl ? `<a href="${statusEscape(check.targetUrl)}" target="_blank" rel="noopener noreferrer">Open details</a>` : 'No details link';
  return `<div class="kg-status-row"><div><b>${statusEscape(check.context)}</b><span>${statusEscape(check.description || 'No description')}</span></div><div>${stateBadge(check.state)}</div><div><span>${check.publisherName ? `Published by ${statusEscape(check.publisherName)} · ${statusEscape(check.publisherAuthType || 'session')}` : 'No publisher'}<br />${statusEscape(target)} · ${statusFormatDate(check.updatedAt)}</span></div></div>`;
}

function publishForm(pull, data) {
  if (!data.canPublish) return '';
  return `<form class="kg-status-publish-form" data-publish-status data-sha="${statusEscape(pull.statusChecks.headSha)}"><div class="form-grid"><div class="field"><label>Context</label><input class="input" name="context" list="kg-known-status-contexts" maxlength="128" placeholder="test" required /></div><div class="field"><label>State</label><select class="select" name="state"><option value="pending">Pending</option><option value="success">Success</option><option value="failure">Failure</option><option value="error">Error</option></select></div></div><div class="form-grid"><div class="field"><label>Description</label><input class="input" name="description" maxlength="280" placeholder="All 128 tests passed" /></div><div class="field"><label>Details URL</label><input class="input" name="targetUrl" type="url" maxlength="2048" placeholder="https://ci.example.com/runs/123" /></div></div><button class="btn" type="submit">Publish status</button></form>`;
}

function pullMarkup(pull, data) {
  const summary = pull.statusChecks;
  const policyEnabled = Boolean(summary.policy?.contexts?.length);
  const className = summary.mergeAllowed ? 'ready' : 'blocked';
  const checks = summary.requiredChecks.length ? summary.requiredChecks : summary.statuses;
  return `<article class="kg-status-pr ${className}" data-status-pull="${pull.number}"><div class="kg-status-pr-head"><div><h3>#${pull.number} ${statusEscape(pull.title)}</h3><div class="muted">${statusEscape(pull.headBranch)} → ${statusEscape(pull.baseBranch)} · Head <span class="kg-status-code">${statusEscape(summary.headSha.slice(0, 12))}</span></div></div><span class="badge ${summary.mergeAllowed ? 'public' : 'critical'}">${policyEnabled ? summary.mergeAllowed ? 'Checks passed' : 'Checks block merge' : 'No required checks'}</span></div><div class="kg-status-summary"><span class="badge public">${summary.successCount}/${summary.requiredCount} success</span><span class="badge high">${summary.pendingCount} pending</span><span class="badge high">${summary.missingCount} missing</span><span class="badge critical">${summary.failureCount} failed</span><span class="badge critical">${summary.errorCount} errors</span></div>${summary.mergeBlockReasons.length ? `<div class="login-demo">${summary.mergeBlockReasons.map(statusEscape).join('<br />')}</div>` : ''}<div class="kg-status-list">${checks.length ? checks.map(checkRow).join('') : '<div class="kg-status-empty">No statuses have been published for this pull-request head.</div>'}</div>${publishForm(pull, data)}</article>`;
}

function pullsMarkup(data) {
  return `<section class="card kg-status-checks" id="kg-status-checks-panel"><div class="card-header"><div><h2>CI and integration checks</h2><p>Required statuses are evaluated against each open pull request’s current head commit.</p></div><span class="badge public">${data.pullRequests.length} open PRs</span></div><div class="card-body"><datalist id="kg-known-status-contexts">${data.knownContexts.map((context) => `<option value="${statusEscape(context)}"></option>`).join('')}</datalist>${data.pullRequests.length ? data.pullRequests.map((pull) => pullMarkup(pull, data)).join('') : '<div class="kg-status-empty">No open pull requests are available.</div>'}</div></section>`;
}

function applyStatusMergePolicy(data) {
  for (const pull of data.pullRequests) {
    const summary = pull.statusChecks;
    if (summary.mergeAllowed) continue;
    const button = document.querySelector(`[data-merge-pr="${pull.number}"]`);
    if (button) {
      button.disabled = true;
      button.title = summary.mergeBlockReasons.join(' ') || 'Required status checks must pass.';
      button.textContent = 'Checks required';
    }
  }
}

async function mountStatusChecks(force = false) {
  const route = statusRoute();
  if (!route || !['settings', 'pulls'].includes(route.tab)) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const key = `${route.org}/${route.repo}/${route.tab}/${location.hash}`;
  if (!force && statusRenderKey === key && document.querySelector('#kg-status-checks-panel')) return;
  statusRenderKey = key;
  statusStyles();
  const [data, branches] = await Promise.all([
    statusRequest(`${STATUS_CHECKS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`),
    route.tab === 'settings' ? statusRequest(`/api/repos/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/branches`) : Promise.resolve({ branches: [] }),
  ]);
  const current = statusRoute();
  if (!current || current.org !== route.org || current.repo !== route.repo || current.tab !== route.tab) return;
  document.querySelector('#kg-status-checks-panel')?.remove();
  content.insertAdjacentHTML('beforeend', route.tab === 'settings' ? settingsMarkup(data, branches.branches) : pullsMarkup(data));
  bindStatusChecks(route, data);
  if (route.tab === 'pulls') applyStatusMergePolicy(data);
}

function bindStatusChecks(route, data) {
  const policyForm = document.querySelector('#kg-status-policy-form');
  policyForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = policyForm.querySelector('button[type="submit"]');
    const values = new FormData(policyForm);
    const branch = values.get('branch');
    const contexts = String(values.get('contexts') || '').split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
    button.disabled = true;
    try {
      await statusRequest(`${STATUS_CHECKS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/policies/${encodeURIComponent(branch)}`, { method: 'PUT', body: { contexts } });
      statusNotify('Status policy saved', `${branch} now requires ${contexts.length} check context${contexts.length === 1 ? '' : 's'}.`);
      await mountStatusChecks(true);
    } catch (error) {
      statusNotify('Unable to save policy', error.message, 'error');
      button.disabled = false;
    }
  });

  document.querySelectorAll('.kg-delete-status-policy').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm(`Delete required status checks for ${button.dataset.branch}?`)) return;
    button.disabled = true;
    try {
      await statusRequest(`${STATUS_CHECKS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/policies/${encodeURIComponent(button.dataset.branch)}`, { method: 'DELETE' });
      statusNotify('Status policy deleted', `${button.dataset.branch} no longer requires commit statuses.`);
      await mountStatusChecks(true);
    } catch (error) {
      statusNotify('Unable to delete policy', error.message, 'error');
      button.disabled = false;
    }
  }));

  document.querySelectorAll('[data-publish-status]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    const body = Object.fromEntries(new FormData(form));
    button.disabled = true;
    button.textContent = 'Publishing…';
    try {
      await statusRequest(`${STATUS_CHECKS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/commits/${encodeURIComponent(form.dataset.sha)}/statuses`, { method: 'POST', body });
      statusNotify('Status published', `${body.context} is now ${body.state}.`);
      await mountStatusChecks(true);
    } catch (error) {
      statusNotify('Unable to publish status', error.message, 'error');
      button.disabled = false;
      button.textContent = 'Publish status';
    }
  }));
}

async function runStatusMount() {
  statusScheduled = false;
  try { await mountStatusChecks(); }
  catch (error) {
    const route = statusRoute();
    const content = document.querySelector('.content');
    if (route && ['settings', 'pulls'].includes(route.tab) && content && !document.querySelector('#kg-status-checks-panel')) {
      content.insertAdjacentHTML('beforeend', `<section class="card kg-status-checks" id="kg-status-checks-panel"><div class="card-body kg-status-empty">${statusEscape(error.message)}</div></section>`);
    }
  }
}

function scheduleStatusMount() {
  if (statusScheduled) return;
  statusScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(runStatusMount));
}

window.addEventListener('hashchange', scheduleStatusMount);
new MutationObserver(scheduleStatusMount).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleStatusMount();
