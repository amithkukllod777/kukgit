const GOVERNANCE_API = '/api/governance';
let governanceRenderKey = '';
let governanceScheduled = false;

function governanceEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function governanceNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${governanceEscape(title)}</b><span>${governanceEscape(message)}</span></div>`;
  root.append(element);
  setTimeout(() => element.remove(), 4600);
}

async function governanceRequest(path, options = {}) {
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

function governanceRoute() {
  const [path] = location.hash.slice(1).split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== 'repo' || !segments[1] || !segments[2]) return null;
  return { org: segments[1], repo: segments[2], tab: segments[3] || 'code' };
}

function governanceStyles() {
  if (document.querySelector('#kg-governance-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-governance-styles';
  style.textContent = `
    .kg-governance { margin-top:18px; }
    .kg-governance-grid { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr); gap:18px; }
    .kg-rule-card, .kg-review-card { border:1px solid var(--border); border-radius:14px; padding:15px; margin-top:12px; background:rgba(255,255,255,.018); }
    .kg-rule-head, .kg-review-head { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .kg-rule-head h3, .kg-review-head h3 { margin:0 0 5px; }
    .kg-policy-list { display:grid; gap:7px; margin-top:12px; color:var(--muted); font-size:12px; }
    .kg-policy-item { display:flex; justify-content:space-between; gap:12px; border-top:1px solid var(--border); padding-top:8px; }
    .kg-rule-form { border:1px solid var(--border); border-radius:14px; padding:15px; background:rgba(255,255,255,.018); }
    .kg-check { display:flex; gap:10px; align-items:flex-start; padding:10px 0; }
    .kg-check input { margin-top:3px; }
    .kg-check b { display:block; }
    .kg-check span { display:block; color:var(--muted); font-size:11px; margin-top:2px; }
    .kg-review-summary { display:flex; gap:8px; flex-wrap:wrap; margin:10px 0; }
    .kg-review-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
    .kg-review-row { display:grid; grid-template-columns:minmax(160px,1fr) minmax(120px,.5fr) minmax(150px,.7fr); gap:12px; padding:11px 0; border-top:1px solid var(--border); }
    .kg-review-row:first-child { border-top:0; }
    .kg-review-row span { color:var(--muted); font-size:11px; }
    .kg-policy-blocked { border-color:rgba(255,94,122,.35); background:rgba(255,94,122,.06); }
    .kg-policy-ready { border-color:rgba(61,220,151,.35); background:rgba(61,220,151,.05); }
    .kg-empty-governance { color:var(--muted); text-align:center; padding:25px 10px; }
    @media (max-width:900px) { .kg-governance-grid { grid-template-columns:1fr; } .kg-review-row { grid-template-columns:1fr; } }
  `;
  document.head.append(style);
}

function ruleMarkup(rule, canManage) {
  return `<article class="kg-rule-card" data-rule-branch="${governanceEscape(rule.branch)}">
    <div class="kg-rule-head"><div><h3>${governanceEscape(rule.branch)}</h3><span class="badge public">Protected</span></div>${canManage ? `<button class="btn btn-ghost kg-delete-rule" data-branch="${governanceEscape(rule.branch)}">Delete</button>` : ''}</div>
    <div class="kg-policy-list">
      <div class="kg-policy-item"><span>Pull request required</span><b>${rule.requirePullRequest ? 'Yes' : 'No'}</b></div>
      <div class="kg-policy-item"><span>Required approvals</span><b>${rule.requiredApprovals}</b></div>
      <div class="kg-policy-item"><span>Dismiss stale approvals</span><b>${rule.dismissStaleApprovals ? 'Yes' : 'No'}</b></div>
      <div class="kg-policy-item"><span>Block direct pushes</span><b>${rule.blockDirectPushes ? 'Yes' : 'No'}</b></div>
    </div>
  </article>`;
}

function settingsPanel(data, branches) {
  return `<section class="card kg-governance" id="kg-governance-panel">
    <div class="card-header"><div><h2>Branch protection</h2><p>Require reviewed pull requests before critical branches can change.</p></div><span class="badge public">${data.rules.length} protected</span></div>
    <div class="card-body"><div class="kg-governance-grid"><div>
      ${data.canManage ? `<form class="kg-rule-form" id="kg-rule-form">
        <div class="form-grid"><div class="field"><label>Branch</label><select class="select" name="branch">${branches.map((branch) => `<option value="${governanceEscape(branch.name)}">${governanceEscape(branch.name)}</option>`).join('')}</select></div><div class="field"><label>Required approvals</label><input class="input" type="number" name="requiredApprovals" min="0" max="10" value="1" required /></div></div>
        <label class="kg-check"><input type="checkbox" name="requirePullRequest" checked /><span><b>Require a pull request</b><span>Protected branch changes must arrive through KukGit pull requests.</span></span></label>
        <label class="kg-check"><input type="checkbox" name="dismissStaleApprovals" checked /><span><b>Dismiss stale approvals</b><span>New commits invalidate approvals created for an older head commit.</span></span></label>
        <label class="kg-check"><input type="checkbox" name="blockDirectPushes" checked /><span><b>Block direct pushes</b><span>Git smart HTTP and browser commits cannot update this branch directly.</span></span></label>
        <button class="btn btn-primary" type="submit">Save protection rule</button>
      </form>` : '<div class="login-demo">Repository Admin permission is required to change branch-protection rules.</div>'}
      <div id="kg-rule-list">${data.rules.length ? data.rules.map((rule) => ruleMarkup(rule, data.canManage)).join('') : '<div class="kg-empty-governance">No protected branches yet.</div>'}</div>
    </div><aside>
      <section class="card"><div class="card-header"><div><h3>Merge policy</h3><p>How KukGit evaluates protected pull requests.</p></div></div><div class="card-body"><div class="login-demo"><b>Approval integrity</b><br />KukGit stores every review against the pull request head SHA. When stale approvals are dismissed, a new commit automatically makes older approvals inactive.</div><div class="login-demo" style="margin-top:12px"><b>Defense in depth</b><br />The browser API blocks direct commits, merge policy blocks non-compliant pull requests, and a Git pre-receive hook blocks direct pushes.</div></div></section>
    </aside></div></div>
  </section>`;
}

function reviewStateLabel(state) {
  return state === 'approved' ? 'Approved' : state === 'changes_requested' ? 'Changes requested' : 'Commented';
}

function reviewCard(pull, canReview) {
  const governance = pull.governance;
  const ready = governance.mergeAllowed;
  return `<article class="kg-review-card ${ready ? 'kg-policy-ready' : 'kg-policy-blocked'}" data-pull-number="${pull.number}">
    <div class="kg-review-head"><div><h3>#${pull.number} ${governanceEscape(pull.title)}</h3><span class="muted">${governanceEscape(pull.headBranch)} → ${governanceEscape(pull.baseBranch)} · by ${governanceEscape(pull.authorName)}</span></div><span class="badge ${ready ? 'public' : 'critical'}">${ready ? 'Ready to merge' : 'Merge blocked'}</span></div>
    <div class="kg-review-summary"><span class="badge public">${governance.approvalCount}/${governance.requiredApprovals} approvals</span><span class="badge ${governance.changeRequestCount ? 'critical' : ''}">${governance.changeRequestCount} change requests</span><span class="badge">${governance.reviews.filter((review) => review.stale).length} stale</span></div>
    ${governance.mergeBlockReasons.length ? `<div class="login-demo">${governance.mergeBlockReasons.map(governanceEscape).join('<br />')}</div>` : '<div class="login-demo"><b>Policy satisfied.</b> A maintainer may merge this pull request.</div>'}
    ${canReview ? `<div class="kg-review-actions"><button class="btn btn-primary kg-submit-review" data-state="approved">Approve</button><button class="btn kg-submit-review" data-state="changes_requested">Request changes</button><button class="btn btn-ghost kg-submit-review" data-state="commented">Comment</button></div>` : ''}
    <div style="margin-top:12px">${governance.reviews.length ? governance.reviews.map((review) => `<div class="kg-review-row"><div><b>${governanceEscape(review.reviewerName)}</b><span>${governanceEscape(review.reviewerEmail)}</span></div><div><span class="badge ${review.state === 'changes_requested' ? 'critical' : review.state === 'approved' ? 'public' : ''}">${reviewStateLabel(review.state)}${review.stale ? ' · stale' : ''}</span></div><div><span>${review.body ? governanceEscape(review.body) : 'No review note'}<br />Head ${governanceEscape(review.headSha.slice(0, 7))}</span></div></div>`).join('') : '<div class="kg-empty-governance">No reviews submitted.</div>'}</div>
  </article>`;
}

function pullsPanel(data) {
  return `<section class="card kg-governance" id="kg-governance-panel">
    <div class="card-header"><div><h2>Review policy</h2><p>Approvals, change requests and protected-branch merge readiness.</p></div><span class="badge public">${data.pullRequests.length} open</span></div>
    <div class="card-body">${data.pullRequests.length ? data.pullRequests.map((pull) => reviewCard(pull, data.canReview)).join('') : '<div class="kg-empty-governance">No open pull requests require review.</div>'}</div>
  </section>`;
}

async function mountGovernance(force = false) {
  const route = governanceRoute();
  if (!route || !['settings', 'pulls'].includes(route.tab)) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const key = `${route.org}/${route.repo}/${route.tab}/${location.hash}`;
  if (!force && governanceRenderKey === key && document.querySelector('#kg-governance-panel')) return;
  governanceRenderKey = key;
  governanceStyles();
  const [data, branchData] = await Promise.all([
    governanceRequest(`${GOVERNANCE_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`),
    route.tab === 'settings' ? governanceRequest(`/api/repos/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/branches`) : Promise.resolve({ branches: [] }),
  ]);
  const current = governanceRoute();
  if (!current || current.org !== route.org || current.repo !== route.repo || current.tab !== route.tab) return;
  document.querySelector('#kg-governance-panel')?.remove();
  content.insertAdjacentHTML('beforeend', route.tab === 'settings' ? settingsPanel(data, branchData.branches) : pullsPanel(data));
  bindGovernance(route, data);
}

function bindGovernance(route, data) {
  const form = document.querySelector('#kg-rule-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const values = new FormData(form);
    const branch = values.get('branch');
    button.disabled = true;
    try {
      await governanceRequest(`${GOVERNANCE_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/rules/${encodeURIComponent(branch)}`, {
        method: 'PUT',
        body: {
          requiredApprovals: Number(values.get('requiredApprovals')),
          requirePullRequest: values.has('requirePullRequest'),
          dismissStaleApprovals: values.has('dismissStaleApprovals'),
          blockDirectPushes: values.has('blockDirectPushes'),
        },
      });
      governanceNotify('Branch protected', `${branch} now enforces the selected review policy.`);
      await mountGovernance(true);
    } catch (error) {
      governanceNotify('Unable to protect branch', error.message, 'error');
      button.disabled = false;
    }
  });

  document.querySelectorAll('.kg-delete-rule').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm(`Delete protection for ${button.dataset.branch}?`)) return;
    button.disabled = true;
    try {
      await governanceRequest(`${GOVERNANCE_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/rules/${encodeURIComponent(button.dataset.branch)}`, { method: 'DELETE' });
      governanceNotify('Protection removed', `${button.dataset.branch} no longer has a KukGit branch policy.`);
      await mountGovernance(true);
    } catch (error) {
      governanceNotify('Unable to remove rule', error.message, 'error');
      button.disabled = false;
    }
  }));

  document.querySelectorAll('.kg-submit-review').forEach((button) => button.addEventListener('click', async () => {
    const card = button.closest('[data-pull-number]');
    const state = button.dataset.state;
    const promptText = state === 'approved' ? 'Optional approval note' : state === 'changes_requested' ? 'Describe the required changes' : 'Add a review comment';
    const body = window.prompt(promptText, '') ?? null;
    if (body === null) return;
    card.querySelectorAll('button').forEach((item) => item.disabled = true);
    try {
      await governanceRequest(`${GOVERNANCE_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/pulls/${card.dataset.pullNumber}/reviews`, {
        method: 'POST',
        body: { state, body },
      });
      governanceNotify('Review submitted', reviewStateLabel(state));
      await mountGovernance(true);
    } catch (error) {
      governanceNotify('Review failed', error.message, 'error');
      card.querySelectorAll('button').forEach((item) => item.disabled = false);
    }
  }));
}

async function governanceMountScheduled() {
  governanceScheduled = false;
  try { await mountGovernance(); }
  catch (error) {
    const route = governanceRoute();
    if (route && ['settings', 'pulls'].includes(route.tab) && !document.querySelector('#kg-governance-panel')) {
      document.querySelector('.content')?.insertAdjacentHTML('beforeend', `<section class="card kg-governance" id="kg-governance-panel"><div class="card-body kg-empty-governance">${governanceEscape(error.message)}</div></section>`);
    }
  }
}

function scheduleGovernanceMount() {
  if (governanceScheduled) return;
  governanceScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(governanceMountScheduled));
}

window.addEventListener('hashchange', scheduleGovernanceMount);
new MutationObserver(scheduleGovernanceMount).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleGovernanceMount();
