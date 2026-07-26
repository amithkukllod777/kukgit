const REVIEW_THREADS_API = '/api/review-threads';
let threadRenderKey = '';
let threadScheduled = false;

function threadEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function threadNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${threadEscape(title)}</b><span>${threadEscape(message)}</span></div>`;
  root.append(element);
  setTimeout(() => element.remove(), 4600);
}

async function threadRequest(path, options = {}) {
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

function threadRoute() {
  const [path] = location.hash.slice(1).split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== 'repo' || !segments[1] || !segments[2]) return null;
  return { org: segments[1], repo: segments[2], tab: segments[3] || 'code' };
}

function threadFormatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function threadStyles() {
  if (document.querySelector('#kg-review-thread-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-review-thread-styles';
  style.textContent = `
    .kg-review-threads { margin-top:18px; }
    .kg-thread-policy-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(280px,.7fr); gap:18px; }
    .kg-thread-policy-form, .kg-thread-create { border:1px solid var(--border); border-radius:14px; padding:15px; background:rgba(255,255,255,.018); }
    .kg-thread-policy-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 0; border-top:1px solid var(--border); }
    .kg-thread-policy-row:first-child { border-top:0; }
    .kg-thread-pr { border:1px solid var(--border); border-radius:16px; padding:16px; margin-top:14px; background:rgba(255,255,255,.018); }
    .kg-thread-pr-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
    .kg-thread-pr-head h3 { margin:0 0 4px; }
    .kg-thread-summary { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
    .kg-thread-create-grid { display:grid; grid-template-columns:minmax(180px,1fr) 110px 110px; gap:10px; }
    .kg-thread-list { display:grid; gap:12px; margin-top:14px; }
    .kg-thread-card { border:1px solid var(--border); border-radius:14px; overflow:hidden; background:rgba(4,14,25,.55); }
    .kg-thread-card.outdated { opacity:.72; }
    .kg-thread-card.resolved { border-color:rgba(61,220,151,.32); }
    .kg-thread-card.open { border-color:rgba(247,201,72,.3); }
    .kg-thread-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; padding:13px 14px; border-bottom:1px solid var(--border); }
    .kg-thread-head b { display:block; }
    .kg-thread-head span { color:var(--muted); font-size:11px; }
    .kg-thread-comments { padding:0 14px; }
    .kg-thread-comment { display:grid; grid-template-columns:34px minmax(0,1fr); gap:10px; padding:12px 0; border-top:1px solid var(--border); }
    .kg-thread-comment:first-child { border-top:0; }
    .kg-thread-avatar { width:30px; height:30px; border-radius:50%; display:grid; place-items:center; background:rgba(21,152,255,.13); font-size:11px; font-weight:700; }
    .kg-thread-comment-copy b { font-size:12px; }
    .kg-thread-comment-copy span { color:var(--muted); font-size:10px; margin-left:6px; }
    .kg-thread-comment-copy p { margin:6px 0 0; white-space:pre-wrap; line-height:1.55; }
    .kg-thread-actions { display:flex; flex-wrap:wrap; gap:8px; padding:12px 14px; border-top:1px solid var(--border); }
    .kg-thread-reply { display:flex; gap:8px; flex:1; min-width:240px; }
    .kg-thread-reply .input { flex:1; }
    .kg-thread-empty { text-align:center; color:var(--muted); padding:26px 10px; }
    @media (max-width:900px) { .kg-thread-policy-grid { grid-template-columns:1fr; } .kg-thread-create-grid { grid-template-columns:1fr; } .kg-thread-pr-head { flex-direction:column; } .kg-thread-reply { min-width:100%; } }
  `;
  document.head.append(style);
}

function initials(value = '') {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'KG';
}

function policyMarkup(policy, canManage) {
  return `<div class="kg-thread-policy-row"><div><b>${threadEscape(policy.branch)}</b><div class="muted" style="font-size:11px">Require active threads resolved: ${policy.requireResolvedThreads ? 'Yes' : 'No'}</div></div>${canManage ? `<button class="btn btn-ghost kg-delete-thread-policy" data-branch="${threadEscape(policy.branch)}">Delete</button>` : ''}</div>`;
}

function settingsMarkup(data, branches) {
  return `<section class="card kg-review-threads" id="kg-review-threads-panel">
    <div class="card-header"><div><h2>Review conversation policy</h2><p>Require active code-review threads to be resolved before merge.</p></div><span class="badge public">${data.policies.length} configured</span></div>
    <div class="card-body"><div class="kg-thread-policy-grid"><div>
      ${data.canManage ? `<form class="kg-thread-policy-form" id="kg-thread-policy-form"><div class="form-grid"><div class="field"><label>Protected base branch</label><select class="select" name="branch">${branches.map((branch) => `<option value="${threadEscape(branch.name)}">${threadEscape(branch.name)}</option>`).join('')}</select></div><div class="field"><label>Merge requirement</label><select class="select" name="requireResolvedThreads"><option value="true">Require all active threads resolved</option><option value="false">Do not block merge</option></select></div></div><button class="btn btn-primary" type="submit">Save review-thread policy</button></form>` : '<div class="login-demo">Repository Admin permission is required to change review-thread policy.</div>'}
      <div id="kg-thread-policy-list">${data.policies.length ? data.policies.map((policy) => policyMarkup(policy, data.canManage)).join('') : '<div class="kg-thread-empty">No review-thread merge policy configured.</div>'}</div>
    </div><aside><section class="card"><div class="card-body"><div class="login-demo"><b>Active versus outdated</b><br />A thread is active only while it targets the current pull-request head SHA. New commits make older unresolved threads outdated, so they remain visible but do not block merge.</div><div class="login-demo" style="margin-top:12px"><b>Independent controls</b><br />Required approvals, change requests and required thread resolution are evaluated independently before KukGit merges a pull request.</div></div></section></aside></div></div>
  </section>`;
}

function commentMarkup(comment) {
  return `<div class="kg-thread-comment"><div class="kg-thread-avatar">${threadEscape(initials(comment.authorName))}</div><div class="kg-thread-comment-copy"><div><b>${threadEscape(comment.authorName)}</b><span>${threadFormatDate(comment.createdAt)}</span></div><p>${threadEscape(comment.body)}</p></div></div>`;
}

function threadCardMarkup(thread, canComment, canResolve) {
  const state = thread.resolved ? 'resolved' : thread.outdated ? 'outdated' : 'open';
  const anchor = thread.side === 'file' ? thread.path : `${thread.path}:${thread.lineNumber} · ${thread.side}`;
  return `<article class="kg-thread-card ${state}" data-thread-id="${threadEscape(thread.id)}">
    <div class="kg-thread-head"><div><b>${threadEscape(anchor)}</b><span>Opened by ${threadEscape(thread.authorName)} · Head ${threadEscape(thread.headSha.slice(0, 7))}</span></div><div>${thread.outdated ? '<span class="badge">Outdated</span>' : thread.resolved ? '<span class="badge public">Resolved</span>' : '<span class="badge high">Open</span>'}</div></div>
    <div class="kg-thread-comments">${thread.comments.map(commentMarkup).join('')}</div>
    <div class="kg-thread-actions">
      ${canComment ? `<form class="kg-thread-reply"><input class="input" name="body" maxlength="20000" placeholder="Reply to this review thread" required /><button class="btn" type="submit">Reply</button></form>` : ''}
      ${canResolve ? thread.resolved ? '<button class="btn btn-ghost kg-reopen-thread">Reopen</button>' : '<button class="btn btn-primary kg-resolve-thread">Resolve</button>' : ''}
    </div>
  </article>`;
}

function pathOptions(files) {
  return files.map((file) => `<option value="${threadEscape(file.path)}">${threadEscape(file.change)} · ${threadEscape(file.path)}</option>`).join('');
}

function pullMarkup(data) {
  const pull = data.pullRequest;
  const summary = pull.reviewThreads;
  const policyOn = Boolean(summary.policy?.requireResolvedThreads);
  return `<article class="kg-thread-pr" data-thread-pull="${pull.number}">
    <div class="kg-thread-pr-head"><div><h3>#${pull.number} ${threadEscape(pull.title)}</h3><div class="muted">${threadEscape(pull.headBranch)} → ${threadEscape(pull.baseBranch)} · by ${threadEscape(pull.authorName)}</div></div><span class="badge ${summary.mergeAllowed ? 'public' : 'critical'}">${policyOn ? summary.mergeAllowed ? 'Threads resolved' : 'Threads block merge' : 'Thread policy optional'}</span></div>
    <div class="kg-thread-summary"><span class="badge high">${summary.activeUnresolvedCount} active open</span><span class="badge public">${summary.resolvedCount} resolved</span><span class="badge">${summary.outdatedCount} outdated</span><span class="badge">${summary.totalThreads} total</span></div>
    ${summary.mergeBlockReason ? `<div class="login-demo">${threadEscape(summary.mergeBlockReason)}</div>` : ''}
    ${data.canComment && pull.comparison.files.length ? `<form class="kg-thread-create" data-create-thread><div class="kg-thread-create-grid"><div class="field"><label>Changed file</label><select class="select" name="path">${pathOptions(pull.comparison.files)}</select></div><div class="field"><label>Side</label><select class="select" name="side"><option value="right">Right</option><option value="left">Left</option><option value="file">File</option></select></div><div class="field"><label>Line</label><input class="input" type="number" name="lineNumber" min="1" placeholder="Optional" /></div></div><div class="field"><label>Review comment</label><textarea class="textarea" name="body" rows="3" maxlength="20000" placeholder="Explain the code change or question" required></textarea></div><button class="btn btn-primary" type="submit">Start review thread</button></form>` : data.canComment ? '<div class="login-demo">This pull request has no changed files available for a new thread.</div>' : ''}
    <div class="kg-thread-list">${summary.threads.length ? summary.threads.map((thread) => threadCardMarkup(thread, data.canComment, data.canResolve)).join('') : '<div class="kg-thread-empty">No code-review conversations yet.</div>'}</div>
  </article>`;
}

function pullsMarkup(items) {
  return `<section class="card kg-review-threads" id="kg-review-threads-panel">
    <div class="card-header"><div><h2>Code review conversations</h2><p>Discuss changed files, reply in threads and resolve completed conversations.</p></div><span class="badge public">${items.length} open PRs</span></div>
    <div class="card-body">${items.length ? items.map(pullMarkup).join('') : '<div class="kg-thread-empty">No open pull requests are available for code review.</div>'}</div>
  </section>`;
}

async function loadPullItems(route) {
  const governance = await threadRequest(`/api/governance/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`);
  return Promise.all(governance.pullRequests.map((pull) => threadRequest(`${REVIEW_THREADS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/pulls/${pull.number}`)));
}

function applyMergeButtonPolicy(items) {
  for (const data of items) {
    const summary = data.pullRequest.reviewThreads;
    if (!summary.policy?.requireResolvedThreads || summary.mergeAllowed) continue;
    const button = document.querySelector(`[data-merge-pr="${data.pullRequest.number}"]`);
    if (button) {
      button.disabled = true;
      button.title = summary.mergeBlockReason || 'Resolve active review threads before merging.';
      button.textContent = 'Resolve threads';
    }
  }
}

async function mountReviewThreads(force = false) {
  const route = threadRoute();
  if (!route || !['settings', 'pulls'].includes(route.tab)) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const key = `${route.org}/${route.repo}/${route.tab}/${location.hash}`;
  if (!force && threadRenderKey === key && document.querySelector('#kg-review-threads-panel')) return;
  threadRenderKey = key;
  threadStyles();

  let html;
  let data;
  if (route.tab === 'settings') {
    const [settings, branches] = await Promise.all([
      threadRequest(`${REVIEW_THREADS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`),
      threadRequest(`/api/repos/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/branches`),
    ]);
    data = settings;
    html = settingsMarkup(settings, branches.branches);
  } else {
    data = await loadPullItems(route);
    html = pullsMarkup(data);
  }

  const current = threadRoute();
  if (!current || current.org !== route.org || current.repo !== route.repo || current.tab !== route.tab) return;
  document.querySelector('#kg-review-threads-panel')?.remove();
  content.insertAdjacentHTML('beforeend', html);
  if (route.tab === 'pulls') applyMergeButtonPolicy(data);
  bindReviewThreads(route);
}

function bindReviewThreads(route) {
  const policyForm = document.querySelector('#kg-thread-policy-form');
  policyForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = policyForm.querySelector('button[type="submit"]');
    const values = new FormData(policyForm);
    button.disabled = true;
    try {
      await threadRequest(`${REVIEW_THREADS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/policies/${encodeURIComponent(values.get('branch'))}`, {
        method: 'PUT',
        body: { requireResolvedThreads: values.get('requireResolvedThreads') === 'true' },
      });
      threadNotify('Review policy saved', 'Merge thread requirements are active immediately.');
      await mountReviewThreads(true);
    } catch (error) {
      threadNotify('Unable to save policy', error.message, 'error');
      button.disabled = false;
    }
  });

  document.querySelectorAll('.kg-delete-thread-policy').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm(`Delete review-thread policy for ${button.dataset.branch}?`)) return;
    button.disabled = true;
    try {
      await threadRequest(`${REVIEW_THREADS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/policies/${encodeURIComponent(button.dataset.branch)}`, { method: 'DELETE' });
      threadNotify('Policy removed', `${button.dataset.branch} no longer requires thread resolution.`);
      await mountReviewThreads(true);
    } catch (error) {
      threadNotify('Unable to remove policy', error.message, 'error');
      button.disabled = false;
    }
  }));

  document.querySelectorAll('[data-create-thread]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const pullNumber = form.closest('[data-thread-pull]').dataset.threadPull;
    const values = new FormData(form);
    const side = values.get('side');
    const lineValue = values.get('lineNumber');
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await threadRequest(`${REVIEW_THREADS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/pulls/${pullNumber}/threads`, {
        method: 'POST',
        body: {
          path: values.get('path'),
          side,
          lineNumber: side === 'file' || !lineValue ? null : Number(lineValue),
          body: values.get('body'),
        },
      });
      threadNotify('Review thread created', 'The conversation is anchored to the current pull-request head.');
      await mountReviewThreads(true);
    } catch (error) {
      threadNotify('Unable to create thread', error.message, 'error');
      button.disabled = false;
    }
  }));

  document.querySelectorAll('.kg-thread-reply').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const pullNumber = form.closest('[data-thread-pull]').dataset.threadPull;
    const threadId = form.closest('[data-thread-id]').dataset.threadId;
    const body = new FormData(form).get('body');
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await threadRequest(`${REVIEW_THREADS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/pulls/${pullNumber}/threads/${encodeURIComponent(threadId)}/replies`, { method: 'POST', body: { body } });
      threadNotify('Reply added', 'The review conversation has been updated.');
      await mountReviewThreads(true);
    } catch (error) {
      threadNotify('Unable to reply', error.message, 'error');
      button.disabled = false;
    }
  }));

  document.querySelectorAll('.kg-resolve-thread, .kg-reopen-thread').forEach((button) => button.addEventListener('click', async () => {
    const pullNumber = button.closest('[data-thread-pull]').dataset.threadPull;
    const threadId = button.closest('[data-thread-id]').dataset.threadId;
    const action = button.classList.contains('kg-resolve-thread') ? 'resolve' : 'reopen';
    button.disabled = true;
    try {
      await threadRequest(`${REVIEW_THREADS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/pulls/${pullNumber}/threads/${encodeURIComponent(threadId)}/${action}`, { method: 'POST', body: {} });
      threadNotify(action === 'resolve' ? 'Thread resolved' : 'Thread reopened', 'Merge readiness has been recalculated.');
      await mountReviewThreads(true);
    } catch (error) {
      threadNotify('Unable to update thread', error.message, 'error');
      button.disabled = false;
    }
  }));
}

async function runThreadMount() {
  threadScheduled = false;
  try { await mountReviewThreads(); }
  catch (error) {
    const route = threadRoute();
    if (route && ['settings', 'pulls'].includes(route.tab) && !document.querySelector('#kg-review-threads-panel')) {
      document.querySelector('.content')?.insertAdjacentHTML('beforeend', `<section class="card kg-review-threads" id="kg-review-threads-panel"><div class="card-body kg-thread-empty">${threadEscape(error.message)}</div></section>`);
    }
  }
}

function scheduleThreadMount() {
  if (threadScheduled) return;
  threadScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(runThreadMount));
}

window.addEventListener('hashchange', scheduleThreadMount);
new MutationObserver(scheduleThreadMount).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleThreadMount();
