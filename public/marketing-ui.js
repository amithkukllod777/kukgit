const MARKETING_PATHS = new Set(['/', '/features', '/security', '/pricing', '/docs']);

const pageMeta = {
  '/': {
    title: 'KukGit — Git hosting and developer collaboration',
    description: 'KukGit by Kuklabs combines Git hosting, pull requests, repository governance, status checks and operational tooling in one developer platform.',
  },
  '/features': {
    title: 'Features — KukGit',
    description: 'Explore the Git hosting, collaboration, governance and operations capabilities available in KukGit.',
  },
  '/security': {
    title: 'Security — KukGit',
    description: 'See the access controls, audit trail, backups and security boundaries built into KukGit.',
  },
  '/pricing': {
    title: 'Pricing — KukGit',
    description: 'KukGit is currently in private alpha. Commercial plans and final pricing have not been announced.',
  },
  '/docs': {
    title: 'Documentation — KukGit',
    description: 'Start using KukGit and learn about repositories, collaboration, governance and operations.',
  },
};

const capabilities = [
  ['▱', 'Git hosting', 'Create private or public repositories, manage branches and use Git smart HTTP transport.'],
  ['⑂', 'Pull requests', 'Open, review and merge changes with comparison data and an auditable activity trail.'],
  ['✓', 'Status checks', 'Record commit checks and configure required checks before a pull request can merge.'],
  ['⌘', 'Branch governance', 'Protect important branches with review, thread-resolution and direct-push rules.'],
  ['⌁', 'Webhooks', 'Send signed repository events and inspect delivery history when an integration fails.'],
  ['⌾', 'SSH and tokens', 'Manage SSH keys, deploy keys and scoped personal access tokens from account settings.'],
  ['◎', 'Collaboration', 'Use organisations, teams, roles and repository-scoped external collaborators.'],
  ['↺', 'Backup and recovery', 'Create verified, self-contained backup archives and rehearse recovery before it is needed.'],
  ['✦', 'Repository analysis', 'Inspect security, quality, documentation and delivery signals without replacing the Git workflow.'],
];

const currentFeatureGroups = [
  {
    title: 'Host and collaborate',
    copy: 'The core repository workflow available in the current v0.2.0 private-alpha build.',
    items: ['Git smart HTTP transport', 'Repositories and branches', 'Issues and comments', 'Pull requests and merge history', 'Repository import', 'Git LFS'],
  },
  {
    title: 'Review and govern',
    copy: 'Controls that make the path to merge explicit and traceable.',
    items: ['Pull-request diffs', 'Review threads', 'Required status checks', 'Branch protection policies', 'Repository access roles', 'External collaborator reviews'],
  },
  {
    title: 'Operate the instance',
    copy: 'Administration surfaces for a self-managed KukGit deployment.',
    items: ['Verified backups', 'Maintenance windows', 'Audit activity', 'Notification preferences', 'Webhook delivery history', 'Usage and health views'],
  },
  {
    title: 'Account security',
    copy: 'Identity controls already represented in the product, with deployment-specific availability.',
    items: ['Local account authentication', 'Optional connected providers', 'Two-factor authentication', 'Session and device controls', 'SSH keys', 'Personal access tokens'],
  },
];

function cleanPath(pathname) {
  const value = String(pathname || '/').replace(/\/+$/, '');
  return value || '/';
}

export function isMarketingRoute(pathname = location.pathname, hash = location.hash) {
  const path = cleanPath(pathname);
  const legacyAppHash = String(hash || '').startsWith('#/');
  return MARKETING_PATHS.has(path) && !legacyAppHash;
}

function setMeta(path) {
  const meta = pageMeta[path] || pageMeta['/'];
  document.title = meta.title;
  const description = document.querySelector('meta[name="description"]');
  if (description) description.setAttribute('content', meta.description);
}

function logo(subtitle = '') {
  return [
    '<span class="mk-logo">',
    '<img src="/assets/kuklabs-k.png" alt="" />',
    '<span><strong>KukGit</strong>',
    subtitle ? '<small>' + subtitle + '</small>' : '',
    '</span></span>',
  ].join('');
}

function header(path) {
  const nav = [
    ['/features', 'Features'],
    ['/security', 'Security'],
    ['/pricing', 'Pricing'],
    ['/docs', 'Docs'],
  ];
  return [
    '<header class="mk-header">',
    '<div class="mk-header-inner">',
    '<a class="mk-home-link" href="/" aria-label="KukGit home">', logo(), '</a>',
    '<nav class="mk-desktop-nav" aria-label="Primary navigation">',
    nav.map(([href, label]) => '<a class="' + (path === href ? 'active' : '') + '" href="' + href + '">' + label + '</a>').join(''),
    '</nav>',
    '<div class="mk-header-actions">',
    '<button class="mk-icon-button" id="mk-theme-toggle" type="button" aria-label="Use dark theme" title="Use dark theme">☾</button>',
    '<a class="mk-button mk-button-quiet mk-signin" href="/login">Sign in</a>',
    '<a class="mk-button mk-button-primary" href="/login#/signup">Start free</a>',
    '<button class="mk-icon-button mk-menu-button" id="mk-menu-button" type="button" aria-expanded="false" aria-controls="mk-mobile-nav" aria-label="Open navigation">☰</button>',
    '</div>',
    '</div>',
    '<nav class="mk-mobile-nav" id="mk-mobile-nav" aria-label="Mobile navigation" hidden>',
    nav.map(([href, label]) => '<a href="' + href + '">' + label + '</a>').join(''),
    '<a href="/login">Sign in</a>',
    '</nav>',
    '</header>',
  ].join('');
}

function footer() {
  return [
    '<footer class="mk-footer">',
    '<div class="mk-footer-grid">',
    '<div class="mk-footer-intro">', logo('A Kuklabs Inc. product'),
    '<p>Git hosting and developer collaboration built around readable review, clear governance and recoverable operations.</p></div>',
    '<div><h3>Product</h3><a href="/features">Git hosting</a><a href="/features">Pull requests</a><a href="/features">Status checks</a><a href="/features">Repository analysis</a></div>',
    '<div><h3>Platform</h3><a href="/security">Security</a><a href="/docs">Documentation</a><a href="/features">Backup and recovery</a><a href="/features">Webhooks</a></div>',
    '<div><h3>Access</h3><a href="/login">Sign in</a><a href="/login#/signup">Create account</a><a href="/pricing">Private alpha</a></div>',
    '</div>',
    '<div class="mk-footer-bottom"><span>© 2026 Kuklabs Inc. All rights reserved.</span><span>Terms · Privacy</span></div>',
    '</footer>',
  ].join('');
}

function productPreview() {
  return [
    '<div class="mk-product-preview" aria-label="Preview of the KukGit application">',
    '<div class="mk-browser-bar"><span></span><span></span><span></span><code>git.kuklabs.com/app</code></div>',
    '<div class="mk-preview-shell">',
    '<aside class="mk-preview-sidebar">', logo(),
    '<b class="active">⌂ &nbsp; Home</b><b>▱ &nbsp; Repositories</b><b>○ &nbsp; Issues</b><b>⑂ &nbsp; Pull requests</b><b>✦ &nbsp; AI</b>',
    '</aside>',
    '<div class="mk-preview-main">',
    '<div class="mk-preview-search">⌕ &nbsp; Search repositories, issues and pull requests <kbd>Ctrl K</kbd></div>',
    '<div class="mk-preview-title"><div><strong>Good morning, Amith</strong><span>Review active repositories and open work.</span></div><button>+ New repository</button></div>',
    '<div class="mk-preview-metrics">',
    '<article><span>Repositories</span><strong>2</strong><small>Accessible workspaces</small></article>',
    '<article><span>Open issues</span><strong>4</strong><small>Need attention</small></article>',
    '<article><span>Pull requests</span><strong>1</strong><small>Awaiting review</small></article>',
    '<article><span>Repository health</span><strong>86</strong><small>Latest analysis</small></article>',
    '</div>',
    '<div class="mk-preview-content"><section><header><strong>Recent repositories</strong><a>View all →</a></header>',
    '<div class="mk-preview-repo"><b>kuklabs / kukgit</b><span>Git hosting and developer collaboration</span><small>main · updated recently</small></div>',
    '<div class="mk-preview-repo"><b>kuklabs / authkit</b><span>Shared identity service</span><small>main · private</small></div>',
    '</section><aside><strong>Repository intelligence</strong><p>Review security, quality and delivery signals before they become expensive.</p><button>Analyze a repository</button></aside></div>',
    '</div></div></div>',
  ].join('');
}

function pageHero(label, title, copy, actions = '') {
  return [
    '<section class="mk-page-hero"><div class="mk-container">',
    '<span class="mk-kicker">', label, '</span>',
    '<h1>', title, '</h1>',
    '<p>', copy, '</p>',
    actions,
    '</div></section>',
  ].join('');
}

function home() {
  return [
    '<section class="mk-hero"><div class="mk-grid-lines" aria-hidden="true"></div><div class="mk-container">',
    '<div class="mk-hero-copy">',
    '<span class="mk-pill"><i></i> v0.2.0 · Private alpha</span>',
    '<h1>Git hosting and developer collaboration, built for clarity</h1>',
    '<p>KukGit brings repositories, pull requests, governance, status checks and operational controls into one calm, readable workspace—with repository intelligence where it is useful.</p>',
    '<div class="mk-hero-actions"><a class="mk-button mk-button-primary mk-button-large" href="/login#/signup">Create an account <span>→</span></a><a class="mk-button mk-button-outline mk-button-large" href="/app">Open KukGit</a></div>',
    '<small>Built by Kuklabs Inc. · Current capabilities are marked clearly · No credit card required</small>',
    '</div>',
    productPreview(),
    '</div></section>',
    '<section class="mk-section"><div class="mk-container">',
    '<div class="mk-section-heading"><span class="mk-kicker">Current platform</span><h2>Everything the repository workflow needs</h2><p>Core Git, collaboration, governance and operations surfaces presented as one coherent product.</p></div>',
    '<div class="mk-capability-grid">',
    capabilities.map(([symbol, title, body]) => '<article class="mk-capability"><span class="mk-capability-icon">' + symbol + '</span><h3>' + title + '</h3><p>' + body + '</p></article>').join(''),
    '</div></div></section>',
    '<section class="mk-section mk-section-muted"><div class="mk-container mk-split">',
    '<div><span class="mk-kicker">Code review</span><h2>Reviews that end in decisions, not fatigue</h2><p>Readable diffs, review threads, status checks and explicit policy blockers keep the path to merge understandable.</p>',
    '<ul class="mk-check-list"><li>Pull-request file comparisons</li><li>Inline review threads and resolution state</li><li>Required checks and branch policy</li><li>Clear merge blockers before the button is pressed</li></ul>',
    '<a class="mk-button mk-button-outline" href="/features">Explore current features</a></div>',
    '<div class="mk-code-card"><header><code>src/review/thread.mjs</code><span>+18 −4</span></header><pre><span>  const comments = thread.comments;</span>\n<del>- const anchor = comments[0].line;</del>\n<ins>+ const anchor = comments[0].range;</ins>\n<ins>+ const resolved = thread.resolvedAt != null;</ins>\n<span>  return { anchor, resolved };</span></pre><footer><b>Review thread · lines 19–24</b><p>Make the blocker explicit before this can merge.</p></footer></div>',
    '</div></section>',
    '<section class="mk-section"><div class="mk-container mk-security-row">',
    '<div><span class="mk-kicker">Security and operations</span><h2>Controls you can see, test and operate</h2><p>KukGit keeps access, audit history, backups and maintenance controls inside the product instead of hiding them behind an undocumented process.</p><a class="mk-button mk-button-outline" href="/security">Read the security overview</a></div>',
    '<div class="mk-fact-grid"><article><h3>Role-based access</h3><p>Organisation, team and repository permissions.</p></article><article><h3>Audit activity</h3><p>Trace important account and repository actions.</p></article><article><h3>Verified backups</h3><p>Self-contained archives with integrity verification.</p></article><article><h3>Recovery rehearsal</h3><p>Dry-run operational checks before an incident.</p></article></div>',
    '</div></section>',
    '<section class="mk-section mk-cta-section"><div class="mk-container"><div class="mk-cta"><h2>Bring your repositories to KukGit</h2><p>Create a repository or import an existing public Git remote, then review the current private-alpha workflow.</p><div><a class="mk-button mk-button-primary mk-button-large" href="/login#/signup">Create your account</a><a class="mk-button mk-button-outline mk-button-large" href="/login">Sign in</a></div></div></div></section>',
  ].join('');
}

function features() {
  return [
    pageHero('Features', 'One platform for hosting, review and governance', 'KukGit v0.2.0 is a private-alpha product. The capabilities below separate what is available now from what remains on the roadmap.', '<div class="mk-hero-actions"><a class="mk-button mk-button-primary" href="/login#/signup">Create account</a><a class="mk-button mk-button-outline" href="/docs">Read the docs</a></div>'),
    '<section class="mk-section"><div class="mk-container"><span class="mk-status-label available">Available in the current build</span><div class="mk-feature-groups">',
    currentFeatureGroups.map((group) => '<article><h2>' + group.title + '</h2><p>' + group.copy + '</p><ul class="mk-check-list">' + group.items.map((item) => '<li>' + item + '</li>').join('') + '</ul></article>').join(''),
    '</div></div></section>',
    '<section class="mk-section mk-section-muted"><div class="mk-container"><span class="mk-status-label roadmap">Roadmap, not a current promise</span><div class="mk-section-heading"><h2>What KukGit is building toward</h2><p>These areas require more engineering and production evidence before they should be marketed as available.</p></div>',
    '<div class="mk-roadmap-grid"><article><h3>Production identity</h3><p>Complete One Kuklabs Account rollout, organisation SSO and lifecycle automation.</p></article><article><h3>Hosted CI runners</h3><p>Hardened runner operations, queue management and production isolation.</p></article><article><h3>Package registry</h3><p>Repository-linked package publishing, retention and access controls.</p></article><article><h3>Enterprise assurance</h3><p>Independent security evidence, published service objectives and formal compliance work.</p></article></div>',
    '</div></section>',
  ].join('');
}

function security() {
  const facts = [
    ['Access control', 'Organisation roles, teams, direct grants and external collaborators define who can reach each repository.'],
    ['Two-factor authentication', 'Local accounts can use a second factor and recovery codes when the instance enables the feature.'],
    ['Protected changes', 'Branch governance and status-check policy can block changes that do not meet review requirements.'],
    ['Audit trail', 'Important authentication, repository and administration actions are recorded for review.'],
    ['Verified backup archives', 'Backups include integrity metadata and verification before they are treated as recoverable.'],
    ['Secrets separation', 'Runtime secrets use distinct encryption keys and remain outside the source checkout.'],
  ];
  return [
    pageHero('Security', 'A private alpha with explicit security boundaries', 'KukGit includes meaningful security controls, but it is not being presented as independently certified or universally production-ready. This page states the current boundary plainly.'),
    '<section class="mk-section"><div class="mk-container"><div class="mk-security-cards">',
    facts.map(([title, copy]) => '<article><span>✓</span><h2>' + title + '</h2><p>' + copy + '</p></article>').join(''),
    '</div></div></section>',
    '<section class="mk-section mk-section-muted"><div class="mk-container mk-split"><div><span class="mk-kicker">Deployment responsibility</span><h2>Security depends on instance configuration</h2><p>KukGit can run with local authentication or connected identity providers. TLS termination, production environment flags, token scope, backups and update discipline still belong to the operator.</p></div>',
    '<div class="mk-boundary-card"><h3>Current production follow-ups</h3><ul class="mk-check-list warning"><li>Run the instance with NODE_ENV=production</li><li>Replace broad development Git credentials</li><li>Keep backup verification and rollback evidence</li><li>Require review and checks before future merges</li></ul></div>',
    '</div></section>',
  ].join('');
}

function pricing() {
  return [
    pageHero('Pricing', 'Commercial pricing is not announced yet', 'KukGit is in private alpha. Publishing invented per-user prices now would create a commitment before hosting costs, support scope and production limits are established.'),
    '<section class="mk-section"><div class="mk-container"><div class="mk-pricing-grid">',
    '<article class="featured"><span class="mk-status-label available">Available now</span><h2>Private alpha</h2><strong>Early access</strong><p>Use the current product, test real repository workflows and help identify the production gaps.</p><ul class="mk-check-list"><li>Current v0.2.0 capabilities</li><li>Self-service account where enabled</li><li>Direct product feedback</li><li>No fake SLA or compliance promise</li></ul><a class="mk-button mk-button-primary" href="/login#/signup">Create account</a></article>',
    '<article><span class="mk-status-label roadmap">Planned structure</span><h2>Team</h2><strong>Price to be announced</strong><p>For small product and engineering teams that need governed collaboration.</p><ul class="mk-check-list"><li>Team permissions</li><li>Required reviews and checks</li><li>Operational support boundary</li></ul></article>',
    '<article><span class="mk-status-label roadmap">Planned structure</span><h2>Business</h2><strong>Price to be announced</strong><p>For organisations that need stronger identity, audit and recovery controls.</p><ul class="mk-check-list"><li>Organisation governance</li><li>Identity integrations</li><li>Backup and audit requirements</li></ul></article>',
    '</div></div></section>',
  ].join('');
}

function docs() {
  const groups = [
    ['Getting started', ['Create an account', 'Create a repository', 'Import a Git remote', 'Clone and push']],
    ['Collaboration', ['Issues', 'Pull requests', 'Review threads', 'Notifications']],
    ['Governance', ['Repository access', 'Protected branches', 'Required checks', 'Audit activity']],
    ['Operations', ['Backups', 'Maintenance windows', 'Webhooks', 'Instance health']],
  ];
  return [
    pageHero('Documentation', 'Start with the workflow that exists today', 'Guides for the current KukGit private-alpha surface—from the first repository to access, review and backup operations.', '<div class="mk-doc-search">⌕ <input type="search" aria-label="Search documentation" placeholder="Search documentation" /></div>'),
    '<section class="mk-section"><div class="mk-container"><div class="mk-doc-cards"><article><span>→</span><h2>Quickstart</h2><p>Create a repository, copy its clone URL and push the first branch.</p></article><article><span>⌘</span><h2>Governance</h2><p>Configure access, protected branches and required status checks.</p></article><article><span>↺</span><h2>Operations</h2><p>Create and verify backups before changing the production instance.</p></article></div>',
    '<div class="mk-doc-layout"><aside><b>Documentation</b>' + groups.map(([title]) => '<a href="#' + title.toLowerCase().replaceAll(' ', '-') + '">' + title + '</a>').join('') + '</aside>',
    '<div class="mk-doc-groups">' + groups.map(([title, items]) => '<section id="' + title.toLowerCase().replaceAll(' ', '-') + '"><h2>' + title + '</h2><ul>' + items.map((item) => '<li><a href="/docs">' + item + '<span>→</span></a></li>').join('') + '</ul></section>').join('') + '</div></div>',
    '<div class="mk-clone-example"><div><span class="mk-kicker">Clone pattern</span><h2>Every repository provides its own URL</h2><p>Copy the exact URL shown inside the repository instead of guessing the organisation or slug.</p></div><code>git clone https://git.kuklabs.com/git/ORG/REPOSITORY.git</code></div>',
    '</div></section>',
  ].join('');
}

function bindMarketingUi() {
  const menuButton = document.querySelector('#mk-menu-button');
  const menu = document.querySelector('#mk-mobile-nav');
  menuButton?.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') === 'true';
    menuButton.setAttribute('aria-expanded', String(!open));
    menuButton.textContent = open ? '☰' : '×';
    menu.hidden = open;
  });

  const themeButton = document.querySelector('#mk-theme-toggle');
  themeButton?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    themeButton.textContent = next === 'dark' ? '☀' : '☾';
    themeButton.setAttribute('aria-label', next === 'dark' ? 'Use light theme' : 'Use dark theme');
    themeButton.setAttribute('title', next === 'dark' ? 'Use light theme' : 'Use dark theme');
    try { localStorage.setItem('kukgit-theme', next); } catch { /* Storage can be blocked. */ }
  });
}

export function renderMarketingRoute(root, pathname = location.pathname) {
  const path = cleanPath(pathname);
  const render = {
    '/': home,
    '/features': features,
    '/security': security,
    '/pricing': pricing,
    '/docs': docs,
  }[path] || home;

  setMeta(path);
  document.body.classList.add('marketing-body');
  root.innerHTML = '<div class="marketing-site">' + header(path) + '<main>' + render() + '</main>' + footer() + '</div>';
  bindMarketingUi();
}
