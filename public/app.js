import { renderMarkdown } from './markdown.js';
import { signedOutPage } from './brand-hero.js';
import { isMarketingRoute, renderMarketingRoute } from './marketing-ui.js';

const app = document.querySelector('#app');
const toastRoot = document.querySelector('#toast-root');

const state = {
  user: null,
  organizations: [],
  repositories: [],
  route: null,
  loading: false,
  settingsObserver: null,
  repoSettingsObserver: null,
};

const navItems = [
  { id: 'overview', label: 'Home', icon: '⌂', route: '#/' },
  { id: 'repositories', label: 'Repositories', icon: '▱', route: '#/repositories' },
  { id: 'issues', label: 'Issues', icon: '○', route: '#/issues' },
  { id: 'pulls', label: 'Pull requests', icon: '⑂', route: '#/pulls' },
  { id: 'ai', label: 'AI', icon: '✦', route: '#/ai' },
];

function savedTheme() {
  try { return localStorage.getItem('kukgit-theme') || 'light'; }
  catch { return 'light'; }
}

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'dark' ? '#111318' : '#f6f7f9');
  try { localStorage.setItem('kukgit-theme', next); } catch { /* Storage can be blocked. */ }
  document.querySelector('#theme-toggle')?.setAttribute('aria-label', next === 'dark' ? 'Use light theme' : 'Use dark theme');
  document.querySelector('#theme-toggle')?.setAttribute('title', next === 'dark' ? 'Use light theme' : 'Use dark theme');
  const icon = document.querySelector('#theme-toggle [data-theme-icon]');
  if (icon) icon.textContent = next === 'dark' ? '☀' : '☾';
}

applyTheme(savedTheme());

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(date);
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'KG';
}

function toast(title, message, type = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${escapeHtml(title)}</b><span>${escapeHtml(message)}</span></div>`;
  toastRoot.append(element);
  setTimeout(() => element.remove(), 4600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function parseRoute() {
  const raw = location.hash.slice(1) || '/';
  const [pathRaw, queryRaw = ''] = raw.split('?');
  const segments = pathRaw.split('/').filter(Boolean).map(decodeURIComponent);
  return { raw, path: pathRaw || '/', segments, query: new URLSearchParams(queryRaw) };
}

function activeNav(route) {
  const first = route.segments[0];
  if (!first) return 'overview';
  if (first === 'repo' || first === 'repositories') return 'repositories';
  if (first === 'issues') return 'issues';
  if (first === 'pulls') return 'pulls';
  if (first === 'ai') return 'ai';
  return '';
}

function navigate(route) {
  location.hash = route.startsWith('#') ? route : `#${route}`;
}

/**
 * Fill in the starter credentials, but only if the server says this instance is
 * still using them. The account is published, so a page that prints it on a
 * public address is handing it out; anything other than a clear yes leaves the
 * form empty, which is what a stranger should see.
 */
async function fillDemoAccount() {
  let demoAccount = null;
  try { ({ demoAccount } = await api('/api/auth/sign-in-hints')); }
  catch { return; }
  if (!demoAccount) return;
  const form = document.querySelector('#login-form');
  if (!form) return;
  form.querySelector('input[name="email"]').value = demoAccount.email;
  form.querySelector('input[name="password"]').value = demoAccount.password;
  const box = form.querySelector('#login-demo');
  box.innerHTML = `<b>Local development account</b><br />Email: ${escapeHtml(demoAccount.email)}<br />Password: ${escapeHtml(demoAccount.password)}<br /><span>Change these values before any public deployment.</span>`;
  box.hidden = false;
}

function renderLogin() {
  app.innerHTML = signedOutPage(`<form class="login-card" id="login-form">
          <h2>Welcome to KukGit</h2>
          <p>Sign in with your KukGit account. Kuklabs Account remains an option an instance may offer, not one it needs.</p>
          <!-- Where oauth-sign-in-ui.js puts the provider buttons. A slot,
               rather than letting it insert at the top of the form, so they
               land under the heading instead of above it: a card that opens
               with two buttons and only then says what page it is reads as
               two pages stacked. -->
          <div id="kg-oauth-slot"></div>
          <div class="field"><label>Email address</label><input class="input" name="email" type="email" autocomplete="username" required /></div>
          <div class="field">
            <div class="field-head"><label>Password</label><span id="kg-forgot-slot"></span></div>
            <input class="input" name="password" type="password" autocomplete="current-password" required />
          </div>
          <div class="login-demo" id="login-demo" hidden></div>
          <button class="btn btn-primary btn-block" type="submit">Sign in to KukGit <span>→</span></button>
        </form>`);
  fillDemoAccount();
  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    button.textContent = 'Signing in…';
    const data = new FormData(event.currentTarget);
    try {
      const result = await api('/api/auth/login', { method: 'POST', body: { email: data.get('email'), password: data.get('password') } });
      // The password was right and the second factor is still owed. There is no
      // session yet and no cookie was set, so going straight to `bootstrap()`
      // lands back on this page with nothing said — which is what happened
      // before this branch existed, and it meant anybody who turned 2FA on
      // could never sign in again.
      if (result?.twoFactorRequired) return renderSecondFactor(result.challenge);
      await bootstrap();
    } catch (error) {
      toast('Sign in failed', error.message, 'error');
      button.disabled = false;
      button.innerHTML = 'Sign in to KukGit <span>→</span>';
    }
  });
}

/**
 * The second half of a sign-in.
 *
 * Rendered here rather than in a module of its own, deliberately: the sign-in
 * page is the one page that has to keep working, and an account with a second
 * factor cannot be reached at all if the file holding this step fails to load.
 *
 * The challenge is held in a closure and never written to the page or the URL.
 * It is the credential that finishes the sign-in, and a copy of it in the
 * address bar is one in browser history on a shared machine.
 */
function renderSecondFactor(challenge) {
  app.innerHTML = `
    <main class="login-page">
      <section class="login-panel" style="grid-column:1/-1">
        <form class="login-card" id="second-factor-form">
          <h2>One more step</h2>
          <p>Enter the six-digit code from your authenticator app. If your phone is gone, use one of your recovery codes instead.</p>
          <div class="field"><label>Code</label><input class="input" name="code" inputmode="text"
            autocomplete="one-time-code" autofocus required placeholder="123456" /></div>
          <div class="login-demo" id="second-factor-error" hidden></div>
          <button class="btn btn-primary btn-block" type="submit">Continue <span>→</span></button>
          <div style="display:flex;justify-content:center;margin-top:4px"><a href="#/" id="second-factor-cancel">Start again</a></div>
        </form>
      </section>
    </main>`;

  document.querySelector('#second-factor-cancel').addEventListener('click', (event) => {
    event.preventDefault();
    renderLogin();
  });

  document.querySelector('#second-factor-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    const box = document.querySelector('#second-factor-error');
    box.hidden = true;
    button.disabled = true;
    button.textContent = 'Checking…';
    const code = new FormData(event.currentTarget).get('code');
    try {
      const done = await api('/api/auth/two-factor', { method: 'POST', body: { challenge, code } });
      // Said on the one occasion somebody is certainly paying attention, and
      // only when it is true.
      if (done?.usedRecoveryCode) {
        toast('Recovery code used', `${done.recoveryCodesRemaining} left. Generate a new set from account settings.`, 'error');
      }
      await bootstrap();
    } catch (error) {
      // A spent challenge cannot be retried, so the way back is the whole
      // sign-in rather than another code into a form that can no longer work.
      box.textContent = `${error.message} Start again to get a new sign-in.`;
      box.hidden = false;
      button.disabled = false;
      button.innerHTML = 'Continue <span>→</span>';
    }
  });
}

function shell(content) {
  const active = activeNav(state.route);
  const org = state.organizations[0];
  return `
    <div class="app-shell">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-brand"><img class="brand-logo" src="/assets/kuklabs-k.png" alt="KukGit" /><div><strong>KukGit</strong><span>Developer platform</span></div></div>
        <button class="workspace-switcher" id="workspace-switcher" type="button" aria-label="Open organizations">
          <span class="workspace-mark">${initials(org?.name || 'Kuklabs')}</span>
          <span class="workspace-copy"><b>${escapeHtml(org?.name || 'Personal workspace')}</b><span>${escapeHtml(org?.role || 'Member')} workspace</span></span>
          <span aria-hidden="true">⌄</span>
        </button>
        <div class="sidebar-section">Platform</div>
        <nav class="nav">
          ${navItems.map((item) => `<button class="nav-link ${active === item.id ? 'active' : ''}" data-route="${item.route}"><span class="nav-icon">${item.icon}</span>${item.label}</button>`).join('')}
        </nav>
        <div class="sidebar-section">Workspace</div>
        <nav class="nav">
          <button class="nav-link ${state.route.segments[0] === 'organizations' ? 'active' : ''}" data-route="#/organizations"><span class="nav-icon">▦</span>Organizations & teams</button>
          <button class="nav-link ${state.route.segments[0] === 'audit' ? 'active' : ''}" data-route="#/audit"><span class="nav-icon">◷</span>Audit log</button>
          <button class="nav-link ${state.route.segments[0] === 'settings' ? 'active' : ''}" data-route="#/settings"><span class="nav-icon">⚙</span>Settings</button>
        </nav>
        <div class="sidebar-spacer"></div>
        <div class="sidebar-utility">
          <button class="nav-link" id="sidebar-help" type="button"><span class="nav-icon">?</span>Help & documentation</button>
        </div>
        <div class="sidebar-user">
          <div class="avatar">${initials(state.user.displayName)}</div>
          <div class="sidebar-user-name"><b>${escapeHtml(state.user.displayName)}</b><span>${escapeHtml(state.user.email)}</span></div>
          <button class="btn btn-ghost icon-btn" id="account-menu" title="Account settings" aria-label="Account settings">•••</button>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <button class="btn btn-ghost icon-btn mobile-menu" id="mobile-menu" aria-label="Open navigation">☰</button>
          <div class="search"><input id="global-search" placeholder="Search repositories, issues and pull requests" aria-label="Global search" /><span class="search-shortcut">Ctrl K</span></div>
          <div class="topbar-actions">
            <button class="btn btn-ghost icon-btn" id="command-trigger" title="Open command menu" aria-label="Open command menu">⌘</button>
            <button class="btn btn-ghost icon-btn" id="theme-toggle" title="Use dark theme" aria-label="Use dark theme"><span data-theme-icon>☾</span></button>
            <button class="btn btn-primary topbar-create" data-action="new-repo"><span class="desktop-label">＋ New repository</span><span class="mobile-label">＋</span></button>
          </div>
        </header>
        <section class="content">${content}</section>
      </main>
      <nav class="mobile-bottom-nav" aria-label="Primary navigation">
        ${navItems.slice(0, 4).map((item) => `<button class="${active === item.id ? 'active' : ''}" data-route="${item.route}"><span>${item.icon}</span>${item.label === 'Pull requests' ? 'Pulls' : item.label}</button>`).join('')}
      </nav>
    </div>`;
}

function bindShell() {
  document.querySelectorAll('[data-route]').forEach((element) => element.addEventListener('click', () => {
    navigate(element.dataset.route);
    document.querySelector('#sidebar')?.classList.remove('open');
  }));
  document.querySelectorAll('[data-action="new-repo"]').forEach((element) => element.addEventListener('click', openRepositoryModal));
  document.querySelector('#workspace-switcher')?.addEventListener('click', () => navigate('#/organizations'));
  document.querySelector('#account-menu')?.addEventListener('click', () => navigate('#/settings'));
  document.querySelector('#sidebar-help')?.addEventListener('click', () => toast('Documentation', 'Product documentation is available from the public KukGit docs area.'));
  document.querySelector('#command-trigger')?.addEventListener('click', openCommandPalette);
  document.querySelector('#theme-toggle')?.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  document.querySelector('#mobile-menu')?.addEventListener('click', () => document.querySelector('#sidebar')?.classList.toggle('open'));
  const search = document.querySelector('#global-search');
  search?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && search.value.trim()) navigate(`#/repositories?q=${encodeURIComponent(search.value.trim())}`);
  });
  applyTheme(document.documentElement.dataset.theme || savedTheme());
}

function openCommandPalette() {
  if (document.querySelector('#command-palette')) return;
  const commands = [
    ['⌂', 'Home', 'Workspace overview', '#/'],
    ['▱', 'Repositories', 'Browse and manage code', '#/repositories'],
    ['○', 'Issues', 'Track work across repositories', '#/issues'],
    ['⑂', 'Pull requests', 'Review proposed changes', '#/pulls'],
    ['✦', 'AI', 'Open repository intelligence', '#/ai'],
    ['▦', 'Organizations & teams', 'Manage people and access', '#/organizations'],
    ['◷', 'Audit log', 'Review workspace activity', '#/audit'],
    ['⚙', 'Settings', 'Account, security and preferences', '#/settings'],
  ];
  const wrapper = document.createElement('div');
  wrapper.className = 'modal-backdrop';
  wrapper.id = 'command-palette';
  wrapper.innerHTML = `<div class="modal command-palette" role="dialog" aria-modal="true" aria-label="Command menu"><div class="command-search"><span aria-hidden="true">⌕</span><input id="command-search-input" autocomplete="off" placeholder="Type a command or search pages…" /></div><div class="command-results" id="command-results"></div></div>`;
  document.body.append(wrapper);
  const input = wrapper.querySelector('#command-search-input');
  const results = wrapper.querySelector('#command-results');
  let filtered = commands;
  let selected = 0;
  const draw = () => {
    results.innerHTML = filtered.length ? filtered.map(([icon, title, copy, route], index) => `<button class="command-item ${index === selected ? 'active' : ''}" data-command-route="${route}"><span aria-hidden="true">${icon}</span><span><b>${title}</b><br>${copy}</span></button>`).join('') : '<div class="command-empty">No matching command.</div>';
    results.querySelectorAll('[data-command-route]').forEach((button) => button.addEventListener('click', () => { wrapper.remove(); navigate(button.dataset.commandRoute); }));
  };
  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    filtered = commands.filter(([, title, copy]) => `${title} ${copy}`.toLowerCase().includes(query));
    selected = 0;
    draw();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') wrapper.remove();
    if (event.key === 'ArrowDown') { event.preventDefault(); selected = Math.min(selected + 1, filtered.length - 1); draw(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); selected = Math.max(selected - 1, 0); draw(); }
    if (event.key === 'Enter' && filtered[selected]) { event.preventDefault(); wrapper.remove(); navigate(filtered[selected][3]); }
  });
  wrapper.addEventListener('click', (event) => { if (event.target === wrapper) wrapper.remove(); });
  draw();
  input.focus();
}

function pageHeader(title, subtitle, actions = '') {
  return `<div class="page-header"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="page-actions">${actions}</div></div>`;
}

function emptyState(icon, title, copy, action = '') {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><h3>${title}</h3><p>${copy}</p>${action}</div>`;
}

function bindListFilters({ search = '#list-search', status = '#list-status', rows = '[data-filter-row]' } = {}) {
  const searchInput = document.querySelector(search);
  const statusInput = document.querySelector(status);
  const update = () => {
    const query = String(searchInput?.value || '').trim().toLowerCase();
    const selected = String(statusInput?.value || 'all');
    document.querySelectorAll(rows).forEach((row) => {
      const matchesQuery = !query || String(row.dataset.filterText || row.textContent).toLowerCase().includes(query);
      const matchesStatus = selected === 'all' || row.dataset.filterStatus === selected;
      row.hidden = !(matchesQuery && matchesStatus);
    });
  };
  searchInput?.addEventListener('input', update);
  statusInput?.addEventListener('change', update);
  update();
}

function activityText(item) {
  const metadata = item.metadata || {};
  const target = metadata.repository ? `<b>${escapeHtml(metadata.repository)}</b>` : escapeHtml(item.targetType || 'item');
  const actions = {
    'repository.created': `created repository ${target}`,
    'repository.imported': `imported repository ${target}`,
    'repository.seeded': `seeded repository ${target}`,
    'issue.created': `opened issue #${metadata.number || ''} in ${target}`,
    'issue.closed': `closed issue #${metadata.number || ''} in ${target}`,
    'branch.created': `created branch <b>${escapeHtml(metadata.name || '')}</b> in ${target}`,
    'commit.created': `committed <b>${escapeHtml(metadata.path || '')}</b> to ${target}`,
    'pull_request.created': `opened pull request #${metadata.number || ''} in ${target}`,
    'pull_request.merged': `merged pull request #${metadata.number || ''} in ${target}`,
    'analysis.completed': `analyzed ${target} with score <b>${metadata.score ?? '—'}</b>`,
    'auth.login': 'signed in to KukGit',
  };
  return actions[item.action] || escapeHtml(item.action.replaceAll('.', ' '));
}

async function renderDashboard() {
  const data = await api('/api/dashboard');
  const metrics = data.metrics;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = String(state.user.displayName || 'there').trim().split(/\s+/)[0];
  const openPulls = metrics.openPulls ?? metrics.openPullRequests ?? 0;
  const content = `
    ${pageHeader(`${greeting}, ${escapeHtml(firstName)}`, 'Review active repositories, open work and recent workspace activity.', '<button class="btn" data-route="#/repositories">View repositories</button><button class="btn btn-primary" data-action="new-repo">＋ New repository</button>')}
    <div class="grid metrics-grid">
      <div class="metric-card"><div class="metric-top"><span>Repositories</span><span class="metric-icon">▱</span></div><div class="metric-value">${metrics.repositories}</div><div class="metric-foot">Across your accessible workspaces</div></div>
      <div class="metric-card"><div class="metric-top"><span>Open issues</span><span class="metric-icon">○</span></div><div class="metric-value">${metrics.openIssues}</div><div class="metric-foot">Work that still needs attention</div></div>
      <div class="metric-card"><div class="metric-top"><span>Open pull requests</span><span class="metric-icon">⑂</span></div><div class="metric-value">${openPulls}</div><div class="metric-foot">Awaiting review or merge</div></div>
      <div class="metric-card"><div class="metric-top"><span>Repository health</span><span class="metric-icon">✦</span></div><div class="metric-value">${metrics.aiHealth ?? '—'}</div><div class="metric-foot ${metrics.aiHealth >= 80 ? 'good' : ''}">${metrics.aiHealth == null ? 'No repository analysis yet' : 'Average latest analysis score'}</div></div>
    </div>
    <div class="grid dashboard-grid">
      <div>
        <section class="card">
          <div class="card-header"><div><h2>Recent repositories</h2><p>Your most recently active codebases</p></div><button class="btn btn-ghost" data-route="#/repositories">View all →</button></div>
          <div class="repo-list">${data.repositories.length ? data.repositories.map(repoRow).join('') : emptyState('◇', 'No repositories yet', 'Create your first KukGit repository or import an existing public repository.', '<button class="btn btn-primary" data-action="new-repo">Create repository</button>')}</div>
        </section>
        <section class="card">
          <div class="card-header"><div><h2>Platform capabilities</h2><p>Core modules available in the current v0.2.0 build</p></div><span class="badge">v0.2.0</span></div>
          <div class="card-body">
            <div class="analysis-metrics">
              <div class="analysis-mini"><b>Git</b><span>Smart HTTP transport</span></div>
              <div class="analysis-mini"><b>RBAC</b><span>Organization roles</span></div>
              <div class="analysis-mini"><b>AI</b><span>Repository health</span></div>
              <div class="analysis-mini"><b>Audit</b><span>Traceable actions</span></div>
            </div>
          </div>
        </section>
      </div>
      <aside>
        <section class="card ai-card">
          <div class="card-body"><div class="ai-hero"><div class="ai-orb">✦</div><div><h3>KukAI Repository Intelligence</h3><p>Find security, quality, documentation and delivery gaps before they become expensive.</p></div></div>
          <div class="ai-actions"><div class="ai-action"><span>Security patterns</span><span>Scan →</span></div><div class="ai-action"><span>CI and test readiness</span><span>Review →</span></div><div class="ai-action"><span>Technical debt signals</span><span>Analyze →</span></div></div>
          <button class="btn btn-primary btn-block" style="margin-top:14px" data-route="#/ai">Analyze a repository</button></div>
        </section>
        <section class="card">
          <div class="card-header"><div><h3>Recent activity</h3><p>Workspace audit stream</p></div></div>
          <div class="card-body"><div class="activity-list">${data.activity.length ? data.activity.map((item) => `<div class="activity-item"><div class="activity-dot">${item.action.includes('analysis') ? '✦' : item.action.includes('issue') ? '◉' : item.action.includes('pull') ? '⑂' : '◇'}</div><div><div class="activity-copy"><b>${escapeHtml(item.userName || 'System')}</b> ${activityText(item)}</div><div class="activity-time">${formatDate(item.createdAt)}</div></div></div>`).join('') : '<div class="muted">No activity yet.</div>'}</div></div>
        </section>
      </aside>
    </div>`;
  app.innerHTML = shell(content);
  bindShell();
  bindRepoRows();
}

function repoRow(repo) {
  return `<div class="repo-row" data-repo="${escapeHtml(repo.orgSlug)}/${escapeHtml(repo.slug)}" data-filter-row data-filter-status="${escapeHtml(repo.visibility)}" data-filter-text="${escapeHtml(`${repo.orgSlug} ${repo.name} ${repo.description || ''}`)}"><div class="repo-main"><div class="repo-title"><span class="repo-icon">▱</span><span class="repo-org">${escapeHtml(repo.orgSlug)} /</span> ${escapeHtml(repo.name)}</div><div class="repo-desc">${escapeHtml(repo.description || 'No description provided.')}</div><div class="repo-meta"><span>⑂ ${escapeHtml(repo.defaultBranch)}</span><span>Updated ${formatDate(repo.updatedAt)}</span></div></div><div class="repo-side"><span class="badge ${repo.visibility}">${repo.visibility}</span><span class="repo-open">Open →</span></div></div>`;
}

function bindRepoRows() {
  document.querySelectorAll('[data-repo]').forEach((row) => row.addEventListener('click', () => {
    const [org, repo] = row.dataset.repo.split('/');
    navigate(`#/repo/${org}/${repo}/code`);
  }));
}

async function renderRepositories() {
  const data = await api('/api/repos');
  state.repositories = data.repositories;
  const query = (state.route.query.get('q') || '').toLowerCase();
  const repositories = query ? data.repositories.filter((repo) => `${repo.orgSlug} ${repo.name} ${repo.description}`.toLowerCase().includes(query)) : data.repositories;
  const content = `
    ${pageHeader('Repositories', 'Host, import and manage repositories across your Kuklabs organizations.', '<button class="btn" data-action="import-repo">⇩ Import repository</button><button class="btn btn-primary" data-action="new-repo">＋ New repository</button>')}
    <section class="card">
      <div class="card-header"><div><h2>${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'}</h2><p>${query ? `Filtered by “${escapeHtml(query)}”` : 'Public, internal and private codebases'}</p></div><div style="display:flex;gap:8px"><span class="badge private">Private</span><span class="badge public">Public</span></div></div>
      <div class="list-toolbar"><input class="input" id="list-search" type="search" value="${escapeHtml(query)}" placeholder="Filter repositories…" aria-label="Filter repositories" /><select class="select" id="list-status" aria-label="Filter by visibility"><option value="all">All visibility</option><option value="private">Private</option><option value="internal">Internal</option><option value="public">Public</option></select></div>
      <div class="repo-list">${repositories.length ? repositories.map(repoRow).join('') : emptyState('◇', query ? 'No matching repositories' : 'Create your first repository', query ? 'Try another search phrase.' : 'Start a new codebase or import an existing repository.', '<button class="btn btn-primary" data-action="new-repo">New repository</button>')}</div>
    </section>`;
  app.innerHTML = shell(content);
  bindShell();
  bindRepoRows();
  bindListFilters();
  document.querySelectorAll('[data-action="import-repo"]').forEach((button) => button.addEventListener('click', () => openRepositoryModal('import')));
}

async function renderGlobalIssues() {
  const data = await api('/api/issues');
  const content = `${pageHeader('Issues', 'Track bugs, improvements and product work across every repository.', '')}
    <section class="card"><div class="card-header"><div><h2>All issues</h2><p>${data.issues.length} total</p></div></div><div class="list-toolbar"><input class="input" id="list-search" type="search" placeholder="Search issues…" aria-label="Search issues" /><select class="select" id="list-status" aria-label="Filter issues by status"><option value="all">All status</option><option value="open">Open</option><option value="closed">Closed</option></select></div>${data.issues.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Issue</th><th>Repository</th><th>Priority</th><th>Status</th><th>Created</th></tr></thead><tbody>${data.issues.map((issue) => `<tr data-filter-row data-filter-status="${escapeHtml(issue.status)}" data-filter-text="${escapeHtml(`#${issue.number} ${issue.title} ${issue.orgSlug} ${issue.repoSlug} ${issue.priority}`)}" data-route="#/repo/${issue.orgSlug}/${issue.repoSlug}/issues?issue=${issue.number}"><td><b>#${issue.number} ${escapeHtml(issue.title)}</b></td><td>${escapeHtml(issue.orgSlug)}/${escapeHtml(issue.repoSlug)}</td><td><span class="badge ${issue.priority}">${issue.priority}</span></td><td><span class="badge ${issue.status}">${issue.status}</span></td><td>${formatDate(issue.createdAt)}</td></tr>`).join('')}</tbody></table></div>` : emptyState('○', 'No issues yet', 'Issues created in any repository will appear here.')}</section>`;
  app.innerHTML = shell(content); bindShell(); bindListFilters();
}

async function renderGlobalPulls() {
  const data = await api('/api/pulls');
  const content = `${pageHeader('Pull requests', 'Review and merge proposed code changes across your workspace.', '')}
    <section class="card"><div class="card-header"><div><h2>All pull requests</h2><p>${data.pullRequests.length} total</p></div></div><div class="list-toolbar"><input class="input" id="list-search" type="search" placeholder="Search pull requests…" aria-label="Search pull requests" /><select class="select" id="list-status" aria-label="Filter pull requests by status"><option value="all">All status</option><option value="open">Open</option><option value="merged">Merged</option><option value="closed">Closed</option></select></div>${data.pullRequests.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Pull request</th><th>Repository</th><th>Branches</th><th>Status</th><th>Created</th></tr></thead><tbody>${data.pullRequests.map((pr) => `<tr data-filter-row data-filter-status="${escapeHtml(pr.status)}" data-filter-text="${escapeHtml(`#${pr.number} ${pr.title} ${pr.orgSlug} ${pr.repoSlug} ${pr.headBranch} ${pr.baseBranch}`)}" data-route="#/repo/${pr.orgSlug}/${pr.repoSlug}/pulls"><td><b>#${pr.number} ${escapeHtml(pr.title)}</b></td><td>${escapeHtml(pr.orgSlug)}/${escapeHtml(pr.repoSlug)}</td><td><code>${escapeHtml(pr.headBranch)} → ${escapeHtml(pr.baseBranch)}</code></td><td><span class="badge ${pr.status}">${pr.status}</span></td><td>${formatDate(pr.createdAt)}</td></tr>`).join('')}</tbody></table></div>` : emptyState('⑂', 'No pull requests yet', 'Create a branch with changes and open a pull request from a repository.')}</section>`;
  app.innerHTML = shell(content); bindShell(); bindListFilters();
}

async function getRepoContext() {
  const [, org, repo, tab = 'code'] = state.route.segments;
  if (!org || !repo) throw new Error('Repository route is incomplete.');
  const data = await api(`/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`);
  return { org, repo, tab, repository: data.repository };
}

function repoHeader(context, tab, body) {
  const { repository, org, repo } = context;
  const tabs = [
    ['code', 'Code'], ['issues', `Issues ${repository.openIssues ? `<span class="badge">${repository.openIssues}</span>` : ''}`],
    ['pulls', `Pull requests ${repository.openPulls ? `<span class="badge">${repository.openPulls}</span>` : ''}`], ['ai', '✦ AI Review'], ['settings', 'Settings'],
  ];
  return `
    <section class="card repo-header-card">
      <div class="repo-breadcrumb"><span class="text-link" data-route="#/repositories">Repositories</span> / ${escapeHtml(org)} / <b>${escapeHtml(repo)}</b></div>
      <div class="repo-heading"><div><h1>${escapeHtml(repository.name)} <span class="badge ${repository.visibility}">${repository.visibility}</span></h1><p>${escapeHtml(repository.description || 'No repository description provided.')}</p></div><div class="page-actions"><button class="btn" data-copy="${escapeHtml(repository.cloneUrl)}">⧉ Clone URL</button><button class="btn btn-primary" data-repo-action="new-file">＋ Add file</button></div></div>
      <div class="clone-bar"><code>${escapeHtml(repository.cloneUrl)}</code><button class="btn" data-copy="git clone ${escapeHtml(repository.cloneUrl)}">Copy command</button></div>
    </section>
    <section class="card"><nav class="tabs">${tabs.map(([id, label]) => `<div class="tab ${tab === id ? 'active' : ''}" data-route="#/repo/${org}/${repo}/${id}">${label}</div>`).join('')}</nav>${body}</section>`;
}

async function renderRepoCode(context) {
  const ref = state.route.query.get('ref') || context.repository.defaultBranch;
  const directory = state.route.query.get('path') || '';
  const blob = state.route.query.get('blob');
  const branchesPayload = await api(`/api/repos/${context.org}/${context.repo}/branches`);
  if (!branchesPayload.branches.length) {
    const body = emptyState('◇', 'This repository is empty', `Clone the repository and push your first commit, or add a README from the browser.<br><br><code>git clone ${escapeHtml(context.repository.cloneUrl)}</code>`, '<button class="btn btn-primary" data-repo-action="new-file">Add README</button>');
    app.innerHTML = shell(repoHeader(context, 'code', body)); bindShell(); bindRepoActions(context, ref); return;
  }
  if (blob) {
    const payload = await api(`/api/repos/${context.org}/${context.repo}/blob?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(blob)}`);
    const file = payload.file;
    const body = `<div class="repo-toolbar"><button class="btn" data-back-tree>← Back</button><select class="select" data-branch-select>${branchesPayload.branches.map((branch) => `<option ${branch.name === ref ? 'selected' : ''}>${escapeHtml(branch.name)}</option>`).join('')}</select><span class="repo-path">${escapeHtml(file.path)} · ${formatBytes(file.size)}</span></div><div class="code-view"><pre>${escapeHtml(file.isBinary ? 'Binary file cannot be displayed.' : file.content)}</pre></div>`;
    app.innerHTML = shell(repoHeader(context, 'code', body)); bindShell(); bindRepoActions(context, ref); document.querySelector('[data-back-tree]')?.addEventListener('click', () => navigate(`#/repo/${context.org}/${context.repo}/code?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(file.path.split('/').slice(0, -1).join('/'))}`)); return;
  }
  const [tree, commits] = await Promise.all([
    api(`/api/repos/${context.org}/${context.repo}/tree?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(directory)}`),
    api(`/api/repos/${context.org}/${context.repo}/commits?ref=${encodeURIComponent(ref)}&limit=1`),
  ]);
  let readme = null;
  const readmeEntry = tree.entries.find((entry) => entry.type === 'blob' && /^readme(?:\.|$)/i.test(entry.name));
  if (readmeEntry) readme = await api(`/api/repos/${context.org}/${context.repo}/blob?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(readmeEntry.path)}`).catch(() => null);
  const parent = directory.split('/').slice(0, -1).join('/');
  const body = `
    <div class="repo-toolbar"><select class="select" data-branch-select>${branchesPayload.branches.map((branch) => `<option ${branch.name === ref ? 'selected' : ''}>${escapeHtml(branch.name)}</option>`).join('')}</select><button class="btn" data-repo-action="new-branch">⑂ New branch</button><span class="repo-path">/${escapeHtml(directory)}</span><span style="margin-left:auto" class="muted">${commits.commits[0] ? `${escapeHtml(commits.commits[0].shortSha)} · ${escapeHtml(commits.commits[0].subject)} · ${formatDate(commits.commits[0].committedAt)}` : ''}</span></div>
    <div class="file-list">
      ${directory ? `<div class="file-row" data-tree-path="${escapeHtml(parent)}"><div class="file-name"><span>↩</span>..</div><div class="file-sha"></div><div class="file-size"></div></div>` : ''}
      ${tree.entries.map((entry) => `<div class="file-row" ${entry.type === 'tree' ? `data-tree-path="${escapeHtml(entry.path)}"` : `data-blob-path="${escapeHtml(entry.path)}"`}><div class="file-name"><span>${entry.type === 'tree' ? '▰' : '▤'}</span>${escapeHtml(entry.name)}</div><div class="file-sha">${escapeHtml(entry.sha.slice(0, 7))}</div><div class="file-size">${entry.size == null ? 'directory' : formatBytes(entry.size)}</div></div>`).join('')}
    </div>
    ${readme ? `<div class="card-header"><div><h3>▤ ${escapeHtml(readme.file.path)}</h3><p>Rendered repository documentation</p></div></div><div class="readme">${renderMarkdown(readme.file.content)}</div>` : ''}`;
  app.innerHTML = shell(repoHeader(context, 'code', body));
  bindShell(); bindRepoActions(context, ref);
  document.querySelectorAll('[data-tree-path]').forEach((row) => row.addEventListener('click', () => navigate(`#/repo/${context.org}/${context.repo}/code?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(row.dataset.treePath)}`)));
  document.querySelectorAll('[data-blob-path]').forEach((row) => row.addEventListener('click', () => navigate(`#/repo/${context.org}/${context.repo}/code?ref=${encodeURIComponent(ref)}&blob=${encodeURIComponent(row.dataset.blobPath)}`)));
}

// `renderMarkdown` used to live here, in nine lines that knew about headings,
// bold, inline code and lists and nothing else. It is now `markdown.js`, shared
// with the issue thread, so a README and a comment render the same way — and so
// that the rules about links and remote images live in one place.

async function renderRepoIssues(context) {
  const data = await api(`/api/repos/${context.org}/${context.repo}/issues`);
  const body = `<div class="card-header"><div><h2>Issues</h2><p>Track work, bugs and product decisions</p></div><button class="btn btn-primary" data-repo-action="new-issue">＋ New issue</button></div>${data.issues.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Issue</th><th>Priority</th><th>Author</th><th>Status</th><th>Created</th></tr></thead><tbody>${data.issues.map((issue) => `<tr data-route="#/repo/${encodeURIComponent(context.org)}/${encodeURIComponent(context.repo)}/issues?issue=${issue.number}" style="cursor:pointer"><td><b>#${issue.number} ${escapeHtml(issue.title)}</b><div class="muted" style="margin-top:5px">${escapeHtml(String(issue.body || '').slice(0, 150))}</div></td><td><span class="badge ${issue.priority}">${issue.priority}</span></td><td>${escapeHtml(issue.authorName)}</td><td><span class="badge ${issue.status}">${issue.status}</span></td><td>${formatDate(issue.createdAt)}</td></tr>`).join('')}</tbody></table></div>` : emptyState('◉', 'No issues yet', 'Create an issue to track a bug, task or product decision.', '<button class="btn btn-primary" data-repo-action="new-issue">New issue</button>')}`;
  app.innerHTML = shell(repoHeader(context, 'issues', body)); bindShell(); bindRepoActions(context, context.repository.defaultBranch);
}

async function renderRepoPulls(context) {
  const data = await api(`/api/repos/${context.org}/${context.repo}/pulls`);
  const body = `<div class="card-header"><div><h2>Pull requests</h2><p>Review branches before they reach the default branch</p></div><button class="btn btn-primary" data-repo-action="new-pr">＋ New pull request</button></div>${data.pullRequests.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Pull request</th><th>Branches</th><th>Changes</th><th>Status</th><th>Action</th></tr></thead><tbody>${data.pullRequests.map((pr) => `<tr><td><b>#${pr.number} ${escapeHtml(pr.title)}</b><div class="muted" style="margin-top:4px">by ${escapeHtml(pr.authorName)} · ${formatDate(pr.createdAt)}</div></td><td><code>${escapeHtml(pr.headBranch)} → ${escapeHtml(pr.baseBranch)}</code></td><td>${pr.comparison ? `${pr.comparison.ahead} commits · ${pr.comparison.files.length} files` : '—'}</td><td><span class="badge ${pr.status}">${pr.status}</span></td><td>${pr.status === 'open' ? `<button class="btn btn-primary" data-merge-pr="${pr.number}">Merge</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : emptyState('⑂', 'No pull requests yet', 'Create a branch, commit a change and open a pull request.', '<button class="btn btn-primary" data-repo-action="new-pr">New pull request</button>')}`;
  app.innerHTML = shell(repoHeader(context, 'pulls', body)); bindShell(); bindRepoActions(context, context.repository.defaultBranch);
  document.querySelectorAll('[data-merge-pr]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm(`Merge pull request #${button.dataset.mergePr}?`)) return;
    button.disabled = true; button.textContent = 'Merging…';
    try { await api(`/api/repos/${context.org}/${context.repo}/pulls/${button.dataset.mergePr}/merge`, { method: 'POST', body: {} }); toast('Pull request merged', 'The base branch now includes these changes.'); renderCurrentRoute(); }
    catch (error) { toast('Merge failed', error.message, 'error'); button.disabled = false; button.textContent = 'Merge'; }
  }));
}

async function renderRepoAI(context) {
  let data = await api(`/api/repos/${context.org}/${context.repo}/analyze`);
  const analysis = data.analysis;
  const body = `<div class="card-header"><div><h2>✦ KukAI Repository Review</h2><p>Deterministic local analysis now; provider-backed code reasoning comes next</p></div><button class="btn btn-primary" data-run-analysis>${analysis ? 'Run again' : 'Analyze repository'}</button></div>
    ${analysis ? analysisView(analysis) : emptyState('✦', 'No analysis yet', 'Run KukAI Review to score repository security, tests, CI, documentation and delivery readiness.', '<button class="btn btn-primary" data-run-analysis>Analyze now</button>')}`;
  app.innerHTML = shell(repoHeader(context, 'ai', body)); bindShell(); bindRepoActions(context, context.repository.defaultBranch);
  document.querySelectorAll('[data-run-analysis]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true; button.textContent = 'Analyzing…';
    try {
      data = await api(`/api/repos/${context.org}/${context.repo}/analyze`, { method: 'POST', body: { ref: context.repository.defaultBranch } });
      toast('Analysis complete', `Repository score: ${data.analysis.score}/100`);
      renderCurrentRoute();
    } catch (error) { toast('Analysis failed', error.message, 'error'); button.disabled = false; button.textContent = 'Analyze repository'; }
  }));
}

function analysisView(analysis) {
  return `<div class="card-body">
    <div class="ai-score-wrap">
      <div class="card score-card"><div class="score-ring" style="--score:${analysis.score}"><div><div class="score-number">${analysis.score}</div><div class="score-grade">GRADE ${analysis.grade}</div></div></div><h3>Repository health</h3><p>${escapeHtml(analysis.summary)}<br>Ref: ${escapeHtml(analysis.ref)}</p></div>
      <div class="card analysis-summary"><h2>Engineering readiness overview</h2><p>Generated ${formatDate(analysis.generatedAt)} by ${escapeHtml(analysis.engine)}</p><div class="analysis-metrics"><div class="analysis-mini"><b>${analysis.metrics.files}</b><span>Files scanned</span></div><div class="analysis-mini"><b>${analysis.metrics.sourceLines.toLocaleString('en-IN')}</b><span>Source lines</span></div><div class="analysis-mini"><b>${analysis.metrics.todoCount}</b><span>TODO markers</span></div><div class="analysis-mini"><b>${analysis.findings.length}</b><span>Findings</span></div></div><div class="divider"></div><div class="language-bars">${analysis.languages.length ? analysis.languages.slice(0, 6).map((lang) => `<div class="language-row"><span>${escapeHtml(lang.name)}</span><div class="bar"><span style="width:${lang.percentage}%"></span></div><b>${lang.percentage}%</b></div>`).join('') : '<span class="muted">No recognized source languages.</span>'}</div></div>
    </div>
    <section class="card" style="margin-top:16px"><div class="card-header"><div><h3>Prioritized findings</h3><p>Resolve critical and high-severity items first</p></div></div><div class="card-body"><div class="findings">${analysis.findings.length ? analysis.findings.map((finding) => `<div class="finding ${finding.severity}"><div class="finding-top"><h4>${escapeHtml(finding.title)}</h4><span class="badge ${finding.severity}">${finding.severity}</span></div><p>${escapeHtml(finding.detail)}</p></div>`).join('') : '<div class="empty-state"><div class="empty-icon">✓</div><h3>No major findings</h3><p>This repository passed all checks currently supported by the local analyzer.</p></div>'}</div></div></section>
  </div>`;
}

async function renderRepoSettings(context) {
  const body = `<div class="repo-settings-layout">
    <aside class="repo-settings-nav" aria-label="Repository settings sections">
      <div class="settings-nav-title">Repository</div>
      <a class="active" href="#repo-general" data-repo-settings-target="repo-general">General</a>
      <a href="#kg-repository-access-panel" data-repo-settings-target="kg-repository-access-panel">Access</a>
      <a href="#kg-governance-panel" data-repo-settings-target="kg-governance-panel">Branch protection</a>
      <a href="#kg-status-checks-panel" data-repo-settings-target="kg-status-checks-panel">Required checks</a>
      <a href="#kg-review-threads-panel" data-repo-settings-target="kg-review-threads-panel">Review policy</a>
      <div class="settings-nav-title">Integrations</div>
      <a href="#kg-webhooks-panel" data-repo-settings-target="kg-webhooks-panel">Webhooks</a>
      <a href="#kg-deploy-ssh-panel" data-repo-settings-target="kg-deploy-ssh-panel">Deploy keys</a>
      <a href="#kg-lfs-panel" data-repo-settings-target="kg-lfs-panel">Git LFS</a>
      <div class="settings-nav-title">Lifecycle</div>
      <a href="#kg-lifecycle-panel" data-repo-settings-target="kg-lifecycle-panel">Danger zone</a>
    </aside>
    <div class="repo-settings-content" id="repo-settings-content">
      <section class="repo-settings-section" id="repo-general">
        <div class="card-header"><div><h2>General</h2><p>Repository identity and Git access</p></div></div>
        <div class="card-body"><dl class="settings-kv"><dt>Name</dt><dd>${escapeHtml(context.repository.name)}</dd><dt>Visibility</dt><dd><span class="badge ${escapeHtml(context.repository.visibility)}">${escapeHtml(context.repository.visibility)}</span></dd><dt>Default branch</dt><dd><code>${escapeHtml(context.repository.defaultBranch)}</code></dd><dt>HTTPS clone URL</dt><dd><code>${escapeHtml(context.repository.cloneUrl)}</code></dd></dl></div>
      </section>
    </div>
  </div>`;
  app.innerHTML = shell(repoHeader(context, 'settings', body));
  bindShell();
  bindRepoActions(context, context.repository.defaultBranch);
  document.querySelectorAll('[data-repo-settings-target]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    const target = document.querySelector(`#${link.dataset.repoSettingsTarget}`);
    if (!target) return toast('Section is loading', 'This repository settings panel is still being prepared.');
    document.querySelectorAll('[data-repo-settings-target]').forEach((item) => item.classList.toggle('active', item === link));
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  const root = document.querySelector('.content');
  const destination = document.querySelector('#repo-settings-content');
  const moveExtensionPanels = () => {
    for (const panel of [...root.children]) {
      if (panel.matches('.card[id^="kg-"]')) destination.append(panel);
    }
  };
  moveExtensionPanels();
  state.repoSettingsObserver = new MutationObserver(moveExtensionPanels);
  state.repoSettingsObserver.observe(root, { childList: true });
}

function bindRepoActions(context, ref) {
  document.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', async () => { await navigator.clipboard.writeText(button.dataset.copy); toast('Copied', 'Clone information copied to your clipboard.'); }));
  document.querySelectorAll('[data-repo-action="new-file"]').forEach((button) => button.addEventListener('click', () => openFileModal(context, ref)));
  document.querySelectorAll('[data-repo-action="new-branch"]').forEach((button) => button.addEventListener('click', () => openBranchModal(context, ref)));
  document.querySelectorAll('[data-repo-action="new-issue"]').forEach((button) => button.addEventListener('click', () => openIssueModal(context)));
  document.querySelectorAll('[data-repo-action="new-pr"]').forEach((button) => button.addEventListener('click', () => openPullModal(context)));
  document.querySelector('[data-branch-select]')?.addEventListener('change', (event) => navigate(`#/repo/${context.org}/${context.repo}/code?ref=${encodeURIComponent(event.target.value)}`));
}

async function renderAICenter() {
  const repos = (await api('/api/repos')).repositories;
  const content = `${pageHeader('KukAI Center', 'Repository intelligence for architecture, security, quality and DevOps readiness.', '')}
    <section class="card ai-card"><div class="card-body"><div class="ai-hero"><div class="ai-orb">✦</div><div><h3>Analyze any KukGit repository</h3><p>The foundation analyzer runs locally without sending source code to an external AI provider.</p></div></div><div class="form-grid" style="margin-top:20px"><div class="field"><label>Select repository</label><select class="select" id="ai-repo-select">${repos.map((repo) => `<option value="${repo.orgSlug}/${repo.slug}">${escapeHtml(repo.orgSlug)}/${escapeHtml(repo.slug)}</option>`).join('')}</select></div><div class="field" style="align-content:end"><button class="btn btn-primary" id="ai-open-repo">Open repository review →</button></div></div></div></section>
    <div class="grid metrics-grid" style="margin-top:16px"><div class="metric-card"><div class="metric-top"><span>Security</span><span class="metric-icon">⌾</span></div><div class="metric-value">Secrets</div><div class="metric-foot">Hard-coded credential patterns</div></div><div class="metric-card"><div class="metric-top"><span>Quality</span><span class="metric-icon">✓</span></div><div class="metric-value">Tests</div><div class="metric-foot">Test and CI readiness</div></div><div class="metric-card"><div class="metric-top"><span>Delivery</span><span class="metric-icon">↗</span></div><div class="metric-value">CI/CD</div><div class="metric-foot">Automation foundations</div></div><div class="metric-card"><div class="metric-top"><span>Governance</span><span class="metric-icon">▤</span></div><div class="metric-value">Docs</div><div class="metric-foot">README, policy and license</div></div></div>`;
  app.innerHTML = shell(content); bindShell();
  document.querySelector('#ai-open-repo')?.addEventListener('click', () => { const [org, repo] = document.querySelector('#ai-repo-select').value.split('/'); navigate(`#/repo/${org}/${repo}/ai`); });
}

async function renderOrganizations() {
  const data = await api('/api/orgs');
  const content = `${pageHeader('Organizations & teams', 'Manage workspaces, membership, roles, invitations and usage.', '')}
  <div class="org-grid">${data.organizations.map((org) => `<section class="card org-card"><div class="card-body" data-kg-org-card="${escapeHtml(org.slug)}"><div class="org-card-head"><div class="avatar">${initials(org.name)}</div><div class="org-card-copy"><h3>${escapeHtml(org.name)}</h3><div class="muted">@${escapeHtml(org.slug)} · ${escapeHtml(org.plan)} plan</div></div><span class="badge public">${escapeHtml(org.role)}</span></div><div class="org-card-actions"><button class="btn" type="button" data-org-manage="${escapeHtml(org.slug)}">Manage workspace</button></div></div></section>`).join('')}</div>`;
  app.innerHTML = shell(content); bindShell();
  document.querySelectorAll('[data-org-manage]').forEach((button) => button.addEventListener('click', () => {
    const panels = [...document.querySelectorAll('#kg-collaboration-panel')];
    const panel = panels.find((candidate) => candidate.dataset.org === button.dataset.orgManage) || panels[0];
    if (!panel) return toast('Workspace details are loading', 'Members, teams and invitations will appear below.');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

async function renderAudit() {
  const data = await api('/api/audit');
  const content = `${pageHeader('Audit log', 'Trace important authentication, repository, issue, branch and merge activity.', '')}
  <section class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Action</th><th>User</th><th>Organization</th><th>Target</th><th>Time</th></tr></thead><tbody>${data.auditLogs.map((item) => `<tr><td><b>${escapeHtml(item.action)}</b></td><td>${escapeHtml(item.userName || 'System')}</td><td>${escapeHtml(item.orgSlug || '—')}</td><td>${escapeHtml(item.targetType)}</td><td>${formatDate(item.createdAt)}</td></tr>`).join('')}</tbody></table></div></section>`;
  app.innerHTML = shell(content); bindShell();
}

function renderSettings() {
  const content = `${pageHeader('Settings', 'Manage your account, security, developer credentials and notification preferences.', '')}
  <div class="settings-layout">
    <aside class="settings-nav" aria-label="Settings sections">
      <div class="settings-nav-title">Account</div>
      <a class="active" href="#account-profile" data-settings-target="account-profile">Profile</a>
      <a href="#kg-phone-panel" data-settings-target="kg-phone-panel">Phone number</a>
      <a href="#kg-2fa-panel" data-settings-target="kg-2fa-panel">Two-factor authentication</a>
      <div class="settings-nav-title">Developer</div>
      <a href="#kg-user-ssh-panel" data-settings-target="kg-user-ssh-panel">SSH keys</a>
      <a href="#kg-token-panel" data-settings-target="kg-token-panel">Access tokens</a>
      <div class="settings-nav-title">Preferences</div>
      <a href="#account-appearance" data-settings-target="account-appearance">Appearance</a>
      <a href="#kg-notification-settings" data-settings-target="kg-notification-settings">Notifications</a>
    </aside>
    <div class="settings-content" id="settings-content">
      <section class="card settings-section" id="account-profile">
        <div class="card-header"><div><h2>Profile</h2><p>Your signed-in KukGit account</p></div><span class="badge public">Active</span></div>
        <div class="card-body"><dl class="settings-kv"><dt>Name</dt><dd>${escapeHtml(state.user.displayName)}</dd><dt>Email</dt><dd>${escapeHtml(state.user.email)}</dd><dt>Account provider</dt><dd>One Kuklabs Account</dd></dl><div class="divider"></div><button class="btn btn-danger" id="settings-sign-out">Sign out of KukGit</button></div>
      </section>
      <section class="card settings-section" id="account-appearance">
        <div class="card-header"><div><h2>Appearance</h2><p>Choose how KukGit looks on this device</p></div></div>
        <div class="card-body"><div class="field"><label for="settings-theme">Theme</label><select class="select" id="settings-theme"><option value="light">Light</option><option value="dark">Dark</option></select><div class="field-hint">This preference is stored only in this browser.</div></div></div>
      </section>
    </div>
  </div>`;
  app.innerHTML = shell(content);
  bindShell();
  const themeSelect = document.querySelector('#settings-theme');
  if (themeSelect) themeSelect.value = document.documentElement.dataset.theme || 'light';
  themeSelect?.addEventListener('change', () => applyTheme(themeSelect.value));
  document.querySelector('#settings-sign-out')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    renderLogin();
  });
  document.querySelectorAll('[data-settings-target]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    const target = document.querySelector(`#${link.dataset.settingsTarget}`);
    if (!target) return toast('Section is loading', 'This settings panel is still being prepared.');
    document.querySelectorAll('[data-settings-target]').forEach((item) => item.classList.toggle('active', item === link));
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  const root = document.querySelector('.content');
  const destination = document.querySelector('#settings-content');
  const moveExtensionPanels = () => {
    for (const panel of [...root.children]) {
      if (panel.matches('.card') && !panel.closest('.settings-layout')) destination.append(panel);
    }
  };
  moveExtensionPanels();
  state.settingsObserver = new MutationObserver(moveExtensionPanels);
  state.settingsObserver.observe(root, { childList: true });
}

function modal(title, body, footer = '') {
  const wrapper = document.createElement('div');
  wrapper.className = 'modal-backdrop';
  wrapper.innerHTML = `<div class="modal"><div class="modal-header"><h2>${title}</h2><button class="btn btn-ghost icon-btn" data-close-modal>×</button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}</div>`;
  wrapper.addEventListener('click', (event) => { if (event.target === wrapper || event.target.closest('[data-close-modal]')) wrapper.remove(); });
  document.body.append(wrapper);
  return wrapper;
}

async function openRepositoryModal(initialMode = 'create') {
  const orgs = state.organizations.length ? state.organizations : (await api('/api/orgs')).organizations;
  let mode = initialMode;
  const wrapper = modal('Create or import repository', `
    <div class="segmented"><button data-mode="create" class="${mode === 'create' ? 'active' : ''}">Create new</button><button data-mode="import" class="${mode === 'import' ? 'active' : ''}">Import existing</button></div>
    <form id="repo-form">
      <div class="field"><label>Organization</label><select class="select" name="orgSlug">${orgs.map((org) => `<option value="${escapeHtml(org.slug)}">${escapeHtml(org.name)}</option>`).join('')}</select></div>
      <div class="form-grid"><div class="field"><label>Repository name</label><input class="input" name="name" placeholder="KukGit Platform" required /></div><div class="field"><label>Repository slug</label><input class="input" name="slug" placeholder="kukgit-platform" pattern="[a-z0-9][a-z0-9-]{1,62}" required /></div></div>
      <div class="field"><label>Description</label><textarea class="textarea" name="description" placeholder="What is this repository for?"></textarea></div>
      <div class="field import-field ${mode === 'import' ? '' : 'hidden'}"><label>Source repository URL</label><input class="input" name="sourceUrl" placeholder="https://github.com/owner/repository.git" /><div class="field-hint">HTTPS or SSH. Credentials embedded in the URL are blocked — use the token field below instead.</div></div>
      <div class="field import-field ${mode === 'import' ? '' : 'hidden'}"><label>Access token <span class="muted">(only for a private repository)</span></label><input class="input" type="password" name="accessToken" autocomplete="off" placeholder="github_pat_… or glpat-…" /><div class="field-hint">Used for this one import and never stored. It needs read access to the repository contents and nothing else.</div></div>
      <div class="field"><label>Visibility</label><select class="select" name="visibility"><option value="private">Private — organization members only</option><option value="public">Public — anyone can clone</option><option value="internal">Internal — Kuklabs users</option></select></div>
    </form>`, '<button class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" id="repo-submit">Create repository</button>');
  const nameInput = wrapper.querySelector('[name="name"]');
  const slugInput = wrapper.querySelector('[name="slug"]');
  let slugTouched = false;
  slugInput.addEventListener('input', () => slugTouched = true);
  nameInput.addEventListener('input', () => { if (!slugTouched) slugInput.value = nameInput.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 63); });
  function updateMode(next) {
    mode = next;
    wrapper.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
    // All of them. There is more than one import field now, and hiding only the
    // first left a token box on screen in create mode.
    wrapper.querySelectorAll('.import-field').forEach((field) => field.classList.toggle('hidden', mode !== 'import'));
    wrapper.querySelector('[name="sourceUrl"]').required = mode === 'import';
    wrapper.querySelector('#repo-submit').textContent = mode === 'import' ? 'Import repository' : 'Create repository';
  }
  wrapper.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => updateMode(button.dataset.mode)));
  wrapper.querySelector('#repo-submit').addEventListener('click', async () => {
    const form = wrapper.querySelector('#repo-form');
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    // A blank token is not a token, and a token has no business being in a
    // create request at all.
    if (mode !== 'import' || !data.accessToken) delete data.accessToken;
    const button = wrapper.querySelector('#repo-submit'); button.disabled = true; button.textContent = mode === 'import' ? 'Importing…' : 'Creating…';
    try {
      const payload = await api(mode === 'import' ? '/api/repos/import' : '/api/repos', { method: 'POST', body: data });
      wrapper.remove(); toast('Repository ready', `${payload.repository.orgSlug}/${payload.repository.slug} is available in KukGit.`); navigate(`#/repo/${payload.repository.orgSlug}/${payload.repository.slug}/code`);
    } catch (error) { toast(mode === 'import' ? 'Import failed' : 'Creation failed', error.message, 'error'); button.disabled = false; updateMode(mode); }
  });
  updateMode(mode); nameInput.focus();
}

function openFileModal(context, ref) {
  const wrapper = modal('Add or update file', `<form id="file-form"><div class="form-grid"><div class="field"><label>Branch</label><input class="input" name="branch" value="${escapeHtml(ref || context.repository.defaultBranch)}" required /></div><div class="field"><label>File path</label><input class="input" name="path" value="README.md" required /></div></div><div class="field"><label>File content</label><textarea class="textarea" name="content" style="min-height:250px" required># ${escapeHtml(context.repository.name)}\n\nBuilt and hosted on KukGit.\n</textarea></div><div class="field"><label>Commit message</label><input class="input" name="message" value="Add README" required /></div></form>`, '<button class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" id="file-submit">Commit changes</button>');
  wrapper.querySelector('#file-submit').addEventListener('click', async () => {
    const form = wrapper.querySelector('#file-form'); if (!form.reportValidity()) return;
    const body = Object.fromEntries(new FormData(form)); const button = wrapper.querySelector('#file-submit'); button.disabled = true; button.textContent = 'Committing…';
    try { await api(`/api/repos/${context.org}/${context.repo}/files`, { method: 'POST', body }); wrapper.remove(); toast('Commit created', `${body.path} was committed to ${body.branch}.`); navigate(`#/repo/${context.org}/${context.repo}/code?ref=${encodeURIComponent(body.branch)}`); }
    catch (error) { toast('Commit failed', error.message, 'error'); button.disabled = false; button.textContent = 'Commit changes'; }
  });
}

function openBranchModal(context, ref) {
  const wrapper = modal('Create branch', `<form id="branch-form"><div class="field"><label>New branch name</label><input class="input" name="name" placeholder="feature/ai-review" required /></div><div class="field"><label>Create from</label><input class="input" name="fromRef" value="${escapeHtml(ref || context.repository.defaultBranch)}" required /></div></form>`, '<button class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" id="branch-submit">Create branch</button>');
  wrapper.querySelector('#branch-submit').addEventListener('click', async () => {
    const form = wrapper.querySelector('#branch-form'); if (!form.reportValidity()) return;
    const body = Object.fromEntries(new FormData(form)); const button = wrapper.querySelector('#branch-submit'); button.disabled = true;
    try { await api(`/api/repos/${context.org}/${context.repo}/branches`, { method: 'POST', body }); wrapper.remove(); toast('Branch created', `${body.name} is ready.`); navigate(`#/repo/${context.org}/${context.repo}/code?ref=${encodeURIComponent(body.name)}`); }
    catch (error) { toast('Branch creation failed', error.message, 'error'); button.disabled = false; }
  });
}

function openIssueModal(context) {
  const wrapper = modal('Create issue', `<form id="issue-form"><div class="field"><label>Issue title</label><input class="input" name="title" placeholder="Describe the problem or work item" required /></div><div class="field"><label>Description</label><textarea class="textarea" name="body" placeholder="Expected outcome, context and acceptance criteria"></textarea></div><div class="field"><label>Priority</label><select class="select" name="priority"><option>medium</option><option>high</option><option>critical</option><option>low</option></select></div></form>`, '<button class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" id="issue-submit">Create issue</button>');
  wrapper.querySelector('#issue-submit').addEventListener('click', async () => {
    const form = wrapper.querySelector('#issue-form'); if (!form.reportValidity()) return;
    const body = Object.fromEntries(new FormData(form)); const button = wrapper.querySelector('#issue-submit'); button.disabled = true;
    try { const payload = await api(`/api/repos/${context.org}/${context.repo}/issues`, { method: 'POST', body }); wrapper.remove(); toast('Issue created', `Issue #${payload.issue.number} is open.`); renderCurrentRoute(); }
    catch (error) { toast('Issue creation failed', error.message, 'error'); button.disabled = false; }
  });
}

async function openPullModal(context) {
  const branchData = await api(`/api/repos/${context.org}/${context.repo}/branches`);
  if (branchData.branches.length < 2) { toast('Another branch is required', 'Create a feature branch and commit changes before opening a pull request.', 'error'); return; }
  const heads = branchData.branches.filter((branch) => branch.name !== context.repository.defaultBranch);
  const wrapper = modal('Open pull request', `<form id="pr-form"><div class="field"><label>Title</label><input class="input" name="title" placeholder="Describe the proposed change" required /></div><div class="form-grid"><div class="field"><label>Base branch</label><select class="select" name="baseBranch">${branchData.branches.map((branch) => `<option ${branch.name === context.repository.defaultBranch ? 'selected' : ''}>${escapeHtml(branch.name)}</option>`).join('')}</select></div><div class="field"><label>Head branch</label><select class="select" name="headBranch">${heads.map((branch) => `<option>${escapeHtml(branch.name)}</option>`).join('')}</select></div></div><div class="field"><label>Description</label><textarea class="textarea" name="body" placeholder="What changed, why, testing and rollout notes"></textarea></div></form>`, '<button class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" id="pr-submit">Open pull request</button>');
  wrapper.querySelector('#pr-submit').addEventListener('click', async () => {
    const form = wrapper.querySelector('#pr-form'); if (!form.reportValidity()) return;
    const body = Object.fromEntries(new FormData(form)); const button = wrapper.querySelector('#pr-submit'); button.disabled = true;
    try { const payload = await api(`/api/repos/${context.org}/${context.repo}/pulls`, { method: 'POST', body }); wrapper.remove(); toast('Pull request opened', `Pull request #${payload.pullRequest.number} is ready for review.`); renderCurrentRoute(); }
    catch (error) { toast('Pull request failed', error.message, 'error'); button.disabled = false; }
  });
}

async function renderRepo() {
  const context = await getRepoContext();
  if (context.tab === 'issues') return renderRepoIssues(context);
  if (context.tab === 'pulls') return renderRepoPulls(context);
  if (context.tab === 'ai') return renderRepoAI(context);
  if (context.tab === 'settings') return renderRepoSettings(context);
  return renderRepoCode(context);
}

/**
 * Routes another module renders into `.content`.
 *
 * Without this they fall through to the reset below, which sends any route this
 * file does not recognise back to the dashboard. That made the whole instance
 * administration panel unreachable: the sidebar link set the hash, this
 * function did not know the route, and the hash was put back before anything
 * could paint. Typing the address or reloading the page did the same.
 *
 * The shell has to be rendered here regardless, because `.content` is what the
 * owning module renders into and it does not exist until this runs.
 */
const EXTENSION_ROUTES = new Set(['instance-admin']);

/**
 * Routes another module renders as the *whole page*, for somebody who is not
 * signed in.
 *
 * The same trap as above and a worse landing: these fall through to the reset,
 * which put the address back to `#/` before `account-screens-ui.js` could look
 * at it. Opening one of them directly worked — a page load never fires
 * `hashchange`, so this function does not run — but *clicking* the link on the
 * sign-in form did not. "Forgot your password?" and "Create an account" were
 * both links that appeared to do nothing, on a live instance, while every test
 * passed, because every test opened the address instead of clicking it.
 *
 * They are not in `EXTENSION_ROUTES` because that renders the application
 * shell, and the shell is for people who are signed in. These take the page
 * over instead, so the right thing for this file to do is nothing at all.
 */
const WHOLE_PAGE_ROUTES = new Set(['signup', 'verify-email', 'reset-password', 'forgot-password']);

function renderExtensionRoute() {
  app.innerHTML = shell('<div class="empty-state"><div class="empty-icon">⌘</div><h3>Loading…</h3></div>');
  bindShell();
}

async function renderCurrentRoute() {
  state.settingsObserver?.disconnect();
  state.settingsObserver = null;
  state.repoSettingsObserver?.disconnect();
  state.repoSettingsObserver = null;
  state.route = parseRoute();
  try {
    // `await`, every one of them. `return somePromise()` inside a `try` hands
    // the promise back before it settles, so the rejection is delivered outside
    // the block and this `catch` never runs — which meant the error page below
    // had never been shown to anybody, and an expired session left whatever was
    // on screen instead of returning to sign-in.
    const first = state.route.segments[0];
    // Before anything is drawn, and before the session is consulted: whoever
    // owns these owns the page, and this file touching `#app` at all would be
    // rendering over them.
    if (WHOLE_PAGE_ROUTES.has(first)) return;
    if (!first) return await renderDashboard();
    if (first === 'repositories') return await renderRepositories();
    if (first === 'repo') return await renderRepo();
    if (first === 'issues') return await renderGlobalIssues();
    if (first === 'pulls') return await renderGlobalPulls();
    if (first === 'ai') return await renderAICenter();
    if (first === 'organizations') return await renderOrganizations();
    if (first === 'audit') return await renderAudit();
    if (first === 'settings') return await renderSettings();
    if (EXTENSION_ROUTES.has(first)) return renderExtensionRoute();
    navigate('#/');
  } catch (error) {
    if (error.status === 401) { state.user = null; return renderLogin(); }
    // Nobody signed in, so there is no shell to draw: it reads a name, an
    // address and initials off `state.user`, and reaches for `displayName` on
    // null. That threw *inside the catch block*, which turned a page error into
    // an unhandled rejection and a blank screen — and it is reachable by
    // pressing "Back to sign in" from a screen somebody opened without an
    // account. The sign-in form is where a signed-out person belongs anyway.
    if (!state.user) return renderLogin();
    app.innerHTML = shell(emptyState('⚠', 'Unable to load this page', escapeHtml(error.message), '<button class="btn" data-route="#/">Return to dashboard</button>'));
    bindShell();
    toast('Page error', error.message, 'error');
  }
}

async function bootstrap() {
  const marketingRoute = isMarketingRoute();
  const path = String(location.pathname || '/').replace(/\/+$/, '') || '/';
  const marketingHome = marketingRoute && path === '/';

  if (marketingRoute && !marketingHome) {
    renderMarketingRoute(app);
    return;
  }

  try {
    const data = await api('/api/auth/me');
    if (!data.user) {
      if (marketingHome) return renderMarketingRoute(app);
      return renderLogin();
    }
    state.user = data.user;
    state.organizations = data.organizations || [];
    await renderCurrentRoute();
  } catch (error) {
    if (marketingHome) return renderMarketingRoute(app);
    app.innerHTML = `<div class="empty-state" style="padding-top:20vh"><div class="empty-icon">⚠</div><h3>KukGit server is unavailable</h3><p>${escapeHtml(error.message)}. Start the server with <code>npm start</code>.</p></div>`;
  }
}

window.addEventListener('hashchange', renderCurrentRoute);
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); document.querySelector('#global-search')?.focus(); }
});
document.addEventListener('click', (event) => {
  const routeElement = event.target.closest('[data-route]');
  if (routeElement) navigate(routeElement.dataset.route);
});

bootstrap();
