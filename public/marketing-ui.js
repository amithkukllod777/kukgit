// Visual port of Lovable project “KukGit Vision”, commit
// f8e91105cb500e319385906350ca5c26b5eeb4dc. The production app remains
// dependency-free; this module translates the approved React/Tailwind markup
// into static HTML while keeping KukGit's real routes and handlers.
const MARKETING_PATHS = new Set(['/', '/features', '/security', '/pricing', '/docs']);

const pageMeta = {
  '/': {
    title: 'KukGit — AI-first Git hosting & code review',
    description: 'KukGit by Kuklabs: Git hosting, pull requests, governed code review, CI status checks and enterprise backup — with AI that stays out of your way.',
  },
  '/features': {
    title: 'Features — KukGit',
    description: 'Hosting, pull requests, code review, branch protection, CI checks, webhooks, LFS, notifications and AI assistance in one Git platform.',
  },
  '/security': {
    title: 'Security & compliance — KukGit',
    description: 'How KukGit protects source code: encryption, access control, audit logging, verified backups, data residency and enterprise identity.',
  },
  '/pricing': {
    title: 'Pricing — KukGit',
    description: 'Free, Team, Business and Enterprise plans for KukGit Git hosting and code review.',
  },
  '/docs': {
    title: 'Documentation — KukGit',
    description: 'Guides, API reference and operations runbooks for KukGit by Kuklabs.',
  },
};

const iconPaths = {
  arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  bot: '<rect width="18" height="12" x="3" y="8" rx="2"/><path d="M12 2v4"/><path d="M8 12h.01M16 12h.01M9 16h6"/>',
  branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/>',
  circleDot: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
  download: '<path d="M12 2v12"/><path d="m7 9 5 5 5-5"/><path d="M5 22h14a2 2 0 0 0 2-2v-3H3v3a2 2 0 0 0 2 2Z"/>',
  fileCheck: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"/><polyline points="14 2 14 8 20 8"/><path d="m9 15 2 2 4-4"/>',
  fingerprint: '<path d="M12 11a1 1 0 0 0-1 1c0 2.7-.5 5.2-1.4 7.4"/><path d="M16 12a4 4 0 0 0-8 0c0 2.2-.4 4.3-1.2 6.2"/><path d="M20 12a8 8 0 0 0-16 0c0 1.5-.2 3-.6 4.4"/><path d="M16 16.2c-.2 1.7-.7 3.3-1.4 4.8"/><path d="M20 16c-.2 2-.7 3.9-1.5 5.6"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3M18 5l2 2"/>',
  lock: '<rect width="16" height="12" x="4" y="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  pull: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9M15 6h1a2 2 0 0 1 2 2v7"/><path d="m12 3 3 3-3 3"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.8-.9.8-2.2-.1-3.1a2.2 2.2 0 0 0-2.9.1Z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.9A12.7 12.7 0 0 1 22 2c0 2.7-.8 7.5-6.1 11a22 22 0 0 1-3.9 2Z"/><path d="M9 12H4s.6-3.3 2-4.5c1.6-1.3 5 0 5 0M12 15v5s3.3-.6 4.5-2c1.3-1.6 0-5 0-5"/><circle cx="16" cy="8" r="1"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01M6 18h.01M10 6h8M10 18h8"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z"/><path d="m9 12 2 2 4-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  webhook: '<path d="M18 16.98h-5.99c-1.1 0-1.99-.9-1.99-2 0-.36.1-.7.27-1l2.99-5.18"/><path d="M6 16.98h-1a3 3 0 1 1 2.6-4.5L10.6 17.7"/><path d="m12.7 5.3-.5-.87A3 3 0 1 1 17.4 7.4l-3 5.2"/><circle cx="18" cy="17" r="2"/><circle cx="6" cy="17" r="2"/><circle cx="14" cy="5" r="2"/>',
  workflow: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
};

function icon(name, className = '') {
  return `<svg class="mk-icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.check}</svg>`;
}

function mark(className = '') {
  return `<span class="mk-mark ${className}" aria-hidden="true"><img src="/assets/kukgit-logo.jpg" alt="" /></span>`;
}

function logo(subtitle = '') {
  return `<span class="mk-logo">${mark()}<span><strong>KukGit</strong>${subtitle ? `<small>${subtitle}</small>` : ''}</span></span>`;
}

function cleanPath(pathname) {
  const value = String(pathname || '/').replace(/\/+$/, '');
  return value || '/';
}

export function isMarketingRoute(pathname = location.pathname, hash = location.hash) {
  const path = cleanPath(pathname);
  return MARKETING_PATHS.has(path) && !String(hash || '').startsWith('#/');
}

function setMeta(path) {
  const meta = pageMeta[path] || pageMeta['/'];
  document.title = meta.title;
  const description = document.querySelector('meta[name="description"]');
  if (description) description.setAttribute('content', meta.description);
}

function header(path) {
  const nav = [['/features', 'Features'], ['/security', 'Security'], ['/pricing', 'Pricing'], ['/docs', 'Docs']];
  return `<header class="mk-header">
    <div class="mk-header-inner">
      <div class="mk-header-left">
        <a class="mk-home-link" href="/" aria-label="KukGit home">${logo()}</a>
        <nav class="mk-desktop-nav" aria-label="Primary navigation">${nav.map(([href, label]) => `<a class="${path === href ? 'active' : ''}" href="${href}">${label}</a>`).join('')}</nav>
      </div>
      <div class="mk-header-actions">
        <button class="mk-icon-button" id="mk-theme-toggle" type="button" aria-label="Switch to dark mode">${icon('sun')}</button>
        <a class="mk-button mk-button-ghost mk-signin" href="/login">Sign in</a>
        <a class="mk-button mk-button-primary" href="/login#/signup">Start free</a>
        <button class="mk-icon-button mk-menu-button" id="mk-menu-button" type="button" aria-expanded="false" aria-controls="mk-mobile-nav" aria-label="Toggle navigation">${icon('menu')}</button>
      </div>
    </div>
    <nav class="mk-mobile-nav" id="mk-mobile-nav" aria-label="Mobile navigation" hidden>${nav.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}<a href="/login">Sign in</a></nav>
  </header>`;
}

function footer() {
  const groups = [
    ['Product', ['Git hosting', 'Pull requests', 'Code review', 'CI status checks', 'Webhooks']],
    ['Platform', ['SSH & deploy keys', 'Git LFS', 'Backup & DR', 'Audit log', 'API']],
    ['Company', ['About Kuklabs', 'Careers', 'Trust centre', 'Contact', 'Status']],
  ];
  return `<footer class="mk-footer"><div class="mk-container">
    <div class="mk-footer-grid">
      <div class="mk-footer-intro">${logo('A Kuklabs Inc. product')}<p>AI-first Git hosting and developer collaboration for teams that care about review quality, governance and recoverability.</p></div>
      ${groups.map(([title, links]) => `<div class="mk-footer-group"><h3>${title}</h3><ul>${links.map((link) => `<li><a href="/features">${link}</a></li>`).join('')}</ul></div>`).join('')}
    </div>
    <div class="mk-footer-bottom"><span>© 2026 Kuklabs Inc. All rights reserved.</span><span>Terms&nbsp;&nbsp;&nbsp; Privacy&nbsp;&nbsp;&nbsp; DPA</span></div>
  </div></footer>`;
}

function productPreview() {
  const previewNav = [['Home', 'grid'], ['Repositories', 'grid'], ['Issues', 'circleDot'], ['Pull requests', 'pull']];
  return `<div class="mk-product-preview" aria-label="Preview of the KukGit application">
    <div class="mk-browser-bar"><i></i><i></i><i></i><code>kukgit.kuklabs.com/kuklabs/kukgit-core</code></div>
    <div class="mk-preview-shell">
      <aside class="mk-preview-sidebar"><div class="mk-preview-logo">${mark()}<b>KukGit</b></div>${previewNav.map(([label, glyph], index) => `<span class="${index === 3 ? 'active' : ''}">${icon(glyph)}${label}</span>`).join('')}</aside>
      <div class="mk-preview-main">
        <div class="mk-preview-search">${icon('search')}<span>Search repositories, issues, code...</span></div>
        <div class="mk-preview-title"><div><h3>Add multi-line review threads</h3><p>#1284 · amira.k wants to merge 14 files into main</p></div><span class="mk-pill mk-pill-success">${icon('checkCircle')} Approved</span></div>
        <div class="mk-preview-metrics">${[['Required checks', '4 / 5 passing'], ['Review threads', '2 unresolved'], ['Diff', '+642 −118']].map(([title, value]) => `<article><small>${title}</small><b>${value}</b></article>`).join('')}</div>
        <div class="mk-preview-code"><header>src/review/thread.tsx</header><div class="del">- const anchor = comments[0].line;</div><div class="add">+ const anchor = comments[0].range ?? single(c);</div><div>&nbsp; return &lt;Thread anchor={anchor} /&gt;;</div></div>
      </div>
    </div>
  </div>`;
}

const capabilities = [
  ['branch', 'Git hosting', 'Fast clones over SSH and HTTPS, partial clone, mirrors and Git LFS with per-repository quotas.'],
  ['pull', 'Pull requests', 'Stacked-friendly PRs with review state, required approvals and merge queues that respect policy.'],
  ['workflow', 'CI status checks', 'Required checks per branch, re-run controls and a check timeline that explains what blocked a merge.'],
  ['shield', 'Branch protection', 'Governance in plain language: approvals, unresolved threads, force-push and deletion blocking.'],
  ['webhook', 'Webhooks', 'Signed deliveries with full history, replay and per-event filtering for every integration.'],
  ['key', 'SSH & tokens', 'Deploy keys, scoped personal access tokens and session/device management on one account.'],
  ['users', 'External collaborators', 'Invite people outside your organisation to a single repository with a clear permission scope.'],
  ['download', 'Backup & DR', 'Verified snapshots, retention policy, restore dry-runs and maintenance mode for planned work.'],
  ['bot', 'AI, kept secondary', 'Diff summaries, review triage and semantic search that assist the workflow instead of replacing it.'],
];

function home() {
  const reviewItems = ['File navigation sidebar with viewed state', 'Sticky file headers and large-file collapsing', 'Explicit merge blockers with policy references', 'AI diff summaries you can accept or ignore'];
  const securityFacts = [
    ['SSO & SCIM ready', 'SAML and OIDC through One Kuklabs Account, with directory sync.'],
    ['Audit log', 'Exportable, tamper-evident record of every governance change.'],
    ['Verified backups', 'Nightly snapshots with automated restore verification.'],
    ['Least-privilege access', 'Read, Triage, Write, Maintain and Admin across teams.'],
    ['Data residency', 'EU, US and APAC regions with per-organisation pinning.'],
    ['Encryption', 'TLS 1.3 in transit, AES-256 at rest, customer-managed keys.'],
  ];
  return `<section class="mk-hero"><div class="mk-grid-lines" aria-hidden="true"></div><div class="mk-container mk-hero-container">
      <div class="mk-hero-copy">
        <span class="mk-pill mk-pill-accent"><i></i>KukGit 4.0 · now with review intelligence</span>
        <h1>AI-first Git hosting and<br class="mk-desktop-break" /> developer collaboration</h1>
        <p>KukGit gives engineering teams dependable Git hosting, a review experience worth using, governance your security team trusts, and AI that quietly removes the busywork.</p>
        <div class="mk-hero-actions"><a class="mk-button mk-button-primary mk-button-large" href="/login#/signup">Start free ${icon('arrow')}</a><a class="mk-button mk-button-outline mk-button-large" href="/app">Explore the product</a></div>
        <small>One Kuklabs Account · SSO-ready · No credit card required</small>
      </div>
      ${productPreview()}
    </div></section>
    <section class="mk-section"><div class="mk-container">
      <div class="mk-section-heading"><h2>Everything a serious repository needs</h2><p>The complete Git platform surface — hosting, review, automation and operations — designed as one coherent product rather than a pile of settings.</p></div>
      <div class="mk-capability-grid">${capabilities.map(([glyph, title, body]) => `<article class="mk-capability">${icon(glyph)}<h3>${title}</h3><p>${body}</p></article>`).join('')}</div>
    </div></section>
    <section class="mk-section mk-section-sunken"><div class="mk-container mk-review-grid">
      <div><span class="mk-pill">Code review</span><h2>Reviews that end in decisions, not fatigue</h2><p>Unified and split diffs, multi-line threads, resolved and outdated states, whitespace toggles and a review summary drawer that shows exactly what still blocks the merge.</p><ul class="mk-check-list">${reviewItems.map((item) => `<li>${icon('checkCircle')}<span>${item}</span></li>`).join('')}</ul><a class="mk-button mk-button-outline mk-button-large" href="/features">See the review experience</a></div>
      <div class="mk-code-card"><header><code>src/review/thread.tsx</code><span>+64 −12</span></header><pre><span>  const { comments } = props;</span><del>- const anchor = comments[0].line;</del><ins>+ const anchor = comments[0].range ?? single(comments[0]);</ins><ins>+ const isMultiLine = anchor.start !== anchor.end;</ins><span>  return &lt;Thread anchor={anchor} /&gt;;</span></pre><footer><b>Review thread · lines 19–24</b><p>“Can we memoise <code>isMultiLine</code>? This re-renders on every keystroke.”</p></footer></div>
    </div></section>
    <section class="mk-section"><div class="mk-container mk-security-grid">
      <div><span class="mk-pill">${icon('lock')} Security &amp; enterprise</span><h2>Built for teams that get audited</h2><p>Governance, recoverability and access control are first-class product surfaces in KukGit — not hidden behind support tickets.</p><a class="mk-button mk-button-outline mk-button-large" href="/security">Read the security overview</a></div>
      <dl class="mk-fact-grid">${securityFacts.map(([title, body]) => `<div><dt>${title}</dt><dd>${body}</dd></div>`).join('')}</dl>
    </div></section>
    <section class="mk-section"><div class="mk-container"><div class="mk-cta"><h2>Move your team to KukGit</h2><p>Import from any Git remote, keep your history, and bring your policies with you.</p><div><a class="mk-button mk-button-primary mk-button-large" href="/login#/signup">Create your account</a><a class="mk-button mk-button-outline mk-button-large" href="/login">Sign in</a></div></div></div></section>`;
}

const featureSections = [
  ['branch', 'Hosting & Git protocol', [['SSH, HTTPS and signed pushes', 'Ed25519 and RSA keys, per-repository deploy keys, and commit signature verification.'], ['Large repositories', 'Partial clone, sparse checkout, ref batching and background maintenance.'], ['Git LFS', 'Per-repository quota, storage insights and lifecycle rules for old objects.']]],
  ['pull', 'Pull requests & review', [['Unified & split diffs', 'Whitespace toggle, large-file collapse and a file navigation sidebar with viewed state.'], ['Multi-line threads', 'Anchored ranges, resolved and outdated states, and a review summary drawer.'], ['Merge box', 'Explicit blockers: approvals, required checks, unresolved threads and protected-branch rules.']]],
  ['workflow', 'Automation & checks', [['Status checks', 'Required per branch pattern, with re-run, logs and timing on every attempt.'], ['Webhooks', 'Signed payloads, delivery history, replay and per-event subscriptions.'], ['Tokens', 'Fine-grained personal access tokens with expiry and last-used auditing.']]],
  ['shield', 'Governance & access', [['Branch protection', 'Written in plain language, previewed before it applies.'], ['Permissions', 'Read, Triage, Write, Maintain and Admin across org, team, direct and external access.'], ['Audit log', 'Every governance change recorded with actor, target and source address.']]],
  ['download', 'Operations', [['Backup & DR', 'Verified snapshots, retention policy and restore dry-runs.'], ['Maintenance mode', 'Planned read-only windows with a clear banner for every collaborator.'], ['Repository lifecycle', 'Archive, transfer, trash with restore, and a guarded permanent purge.']]],
  ['bot', 'AI, deliberately secondary', [['Diff summaries', 'A short, factual description of what a pull request changes.'], ['Review triage', 'Suggested reviewers and risk signals based on ownership and history.'], ['Semantic search', 'Ask questions about a codebase and jump straight to the definition.']]],
];

function pageIntro(label, title, copy, actions = '') {
  return `<section class="mk-page-intro"><div class="mk-container"><span class="mk-eyebrow">${label}</span><h1>${title}</h1><p>${copy}</p>${actions}</div></section>`;
}

function features() {
  return `${pageIntro('Features', 'One platform for hosting, review and governance', 'Each surface below exists in the product today. Nothing here is a placeholder for a feature you would have to assemble yourself.', '<div class="mk-page-actions"><a class="mk-button mk-button-primary mk-button-large" href="/login#/signup">Start free</a><a class="mk-button mk-button-outline mk-button-large" href="/pricing">Compare plans</a></div>')}
    ${featureSections.map(([glyph, title, items], index) => `<section class="mk-feature-section ${index % 2 ? 'sunken' : ''}"><div class="mk-container mk-feature-row"><div>${icon(glyph)}<h2>${title}</h2></div><dl>${items.map(([name, body]) => `<div><dt>${name}</dt><dd>${body}</dd></div>`).join('')}</dl></div></section>`).join('')}
    <section class="mk-section"><div class="mk-container mk-card-grid">${[['users', 'External collaborators', 'Scope outside contributors to a single repository.'], ['webhook', 'Notifications', 'In-app and email preferences per category and repository.'], ['key', 'One Kuklabs Account', 'One identity across every Kuklabs product, with device management.']].map(([glyph, title, body]) => `<article class="mk-surface-card">${icon(glyph)}<h3>${title}</h3><p>${body}</p></article>`).join('')}</div></section>`;
}

function security() {
  const pillars = [
    ['key', 'Encryption', 'TLS 1.3 in transit and AES-256 at rest. Customer-managed keys available on Enterprise.'],
    ['fingerprint', 'Identity', 'One Kuklabs Account with SAML/OIDC SSO, SCIM provisioning, enforced 2FA and device sessions.'],
    ['fileCheck', 'Audit logging', 'Governance, access and token events recorded with actor, target and IP, exportable to your SIEM.'],
    ['server', 'Recoverability', 'Nightly verified snapshots, retention windows, restore dry-runs and documented RTO/RPO targets.'],
    ['globe', 'Data residency', 'Choose EU, US or APAC storage per organisation. Metadata stays in-region.'],
    ['shield', 'Assurance', 'Independent penetration testing, vulnerability disclosure programme and a public trust centre.'],
  ];
  const controls = [
    ['Protected branches', 'Require pull requests, a minimum number of approvals and resolution of every review thread.'],
    ['Required status checks', 'Nominate the checks that must pass, and block merges when a required check has not reported.'],
    ['Force-push & deletion blocking', 'Protect history on release branches, with a break-glass path that is logged.'],
    ['Permission model', 'Read, Triage, Write, Maintain and Admin, assignable to organisations, teams, individuals and externals.'],
    ['Token governance', 'Expiry enforcement, scope limits and last-used visibility for every personal access token.'],
    ['Maintenance mode', 'Planned read-only windows with clear communication to all collaborators.'],
  ];
  return `${pageIntro('<span class="mk-pill mk-pill-accent">Security</span>', 'Your source code deserves boring, dependable security', 'KukGit is built so that the safe path is the default one, and so that your security and compliance teams can verify it without asking engineering for screenshots.')}
    <section class="mk-section"><div class="mk-container mk-pillar-grid">${pillars.map(([glyph, title, body]) => `<article>${icon(glyph)}<h2>${title}</h2><p>${body}</p></article>`).join('')}</div></section>
    <section class="mk-section mk-section-sunken"><div class="mk-container"><div class="mk-section-heading"><h2>Controls you configure in the product</h2><p>Every control below is a first-class settings screen, written in language a reviewer can understand.</p></div><div class="mk-control-list">${controls.map(([title, body]) => `<div><h3>${title}</h3><p>${body}</p></div>`).join('')}</div></div></section>
    <section class="mk-section"><div class="mk-container"><div class="mk-cta"><h2>Need a security review pack?</h2><p>We publish architecture notes, subprocessor lists and test summaries for evaluation teams.</p><div><a class="mk-button mk-button-primary mk-button-large" href="/login#/signup">Talk to us</a><a class="mk-button mk-button-outline mk-button-large" href="/docs">Read the docs</a></div></div></div></section>`;
}

const plans = [
  ['Free', '$0', 'per user / month', 'For individuals and small side projects.', ['Unlimited public and private repositories', 'Pull requests and code review', 'Community CI minutes', 'Basic branch protection', 'Email support'], 'Start free'],
  ['Team', '$9', 'per user / month', 'For product teams shipping together.', ['Everything in Free', 'Required approvals and status checks', 'Teams and permission levels', 'Webhook delivery history', 'Git LFS with expanded quota'], 'Start Team trial', true],
  ['Business', '$21', 'per user / month', 'For organisations with compliance needs.', ['Everything in Team', 'SSO via One Kuklabs Account', 'Audit log export', 'External collaborator controls', 'Verified backups and restore dry-runs'], 'Start Business trial'],
  ['Enterprise', 'Custom', 'annual agreement', 'For regulated and large-scale estates.', ['Everything in Business', 'SCIM provisioning and data residency', 'Customer-managed encryption keys', 'Dedicated DR targets and support', 'Onboarding and migration assistance'], 'Contact sales'],
];

function pricing() {
  const questions = [['Who counts as a billable user?', 'Anyone who pushes, reviews or administers a repository during the billing period. Read-only external collaborators are free.'], ['Can we self-host?', 'Enterprise agreements include a self-managed deployment option with the same product surface.'], ['What happens when a trial ends?', 'Your repositories stay available on the Free plan. Paid-only policies are paused, never deleted.'], ['Do you offer discounts?', 'Yes, for education, non-profits and open-source maintainers.']];
  return `<section class="mk-page-intro mk-page-intro-centered"><div class="mk-container"><span class="mk-pill mk-pill-accent">Pricing</span><h1>Plans that scale with your team</h1><p>Prices are indicative for this preview. Billing is per active contributor, and you can change plan at any time.</p></div></section>
    <section class="mk-section"><div class="mk-container mk-plan-grid">${plans.map(([name, price, cadence, blurb, items, cta, featured]) => `<article class="mk-plan ${featured ? 'featured' : ''}"><div class="mk-plan-title"><h2>${name}</h2>${featured ? '<span class="mk-pill mk-pill-accent">Popular</span>' : ''}</div><p>${blurb}</p><strong>${price}</strong><small>${cadence}</small><a class="mk-button ${featured ? 'mk-button-primary' : 'mk-button-outline'} mk-button-large" href="/login#/signup">${cta}</a><ul>${items.map((item) => `<li>${icon('check')}<span>${item}</span></li>`).join('')}</ul></article>`).join('')}</div></section>
    <section class="mk-section"><div class="mk-container mk-faq"><h2>Common questions</h2>${questions.map(([question, answer]) => `<div><h3>${question}</h3><p>${answer}</p></div>`).join('')}</div></section>`;
}

function docs() {
  const groups = [['Getting started', ['Quickstart', 'Import a repository', 'Install the CLI', 'Connect SSH']], ['Collaboration', ['Pull requests', 'Code review', 'Review policies', 'Notifications']], ['Automation', ['Status checks', 'Webhooks', 'Deploy keys', 'Access tokens']], ['Operations', ['Backup & restore', 'Maintenance mode', 'Audit log', 'Data residency']]];
  return `<section class="mk-page-intro mk-doc-intro"><div class="mk-container"><h1>Documentation</h1><p>Everything you need to run KukGit, from your first clone to a verified disaster-recovery drill.</p><label class="mk-doc-search">${icon('search')}<input type="search" placeholder="Search documentation…" aria-label="Search documentation" /></label></div></section>
    <section class="mk-section"><div class="mk-container mk-card-grid">${[['rocket', 'Quickstart', 'Create a repository, push your first commit and open a pull request.'], ['terminal', 'CLI reference', 'Authenticate, clone, review and manage policies from the terminal.'], ['shield', 'Governance guide', 'Design branch protection that your auditors will accept.']].map(([glyph, title, body]) => `<a class="mk-surface-card" href="/docs">${icon(glyph)}<h3>${title} ${icon('arrow')}</h3><p>${body}</p></a>`).join('')}</div></section>
    <section class="mk-section"><div class="mk-container mk-doc-layout"><aside><b>On this page</b>${groups.map(([title]) => `<a href="#">${title}</a>`).join('')}</aside><div class="mk-doc-groups">${groups.map(([title, items]) => `<section><h2>${title}</h2><ul>${items.map((item) => `<li><a href="/docs">${item}</a></li>`).join('')}</ul></section>`).join('')}<section class="mk-api-card"><h2>API reference</h2><p>REST and GraphQL endpoints for repositories, pull requests, reviews, checks, webhooks and administration.</p><pre>curl https://api.kukgit.com/v1/repos/kuklabs/kukgit-core/pulls \\\n  -H "Authorization: Bearer $KUKGIT_TOKEN"</pre></section></div></div></section>`;
}

function bindMarketingUi() {
  const menuButton = document.querySelector('#mk-menu-button');
  const menu = document.querySelector('#mk-mobile-nav');
  menuButton?.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') === 'true';
    menuButton.setAttribute('aria-expanded', String(!open));
    menuButton.innerHTML = icon(open ? 'menu' : 'x');
    menu.hidden = open;
  });

  const themeButton = document.querySelector('#mk-theme-toggle');
  themeButton?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    themeButton.innerHTML = icon(next === 'dark' ? 'sun' : 'sun');
    themeButton.setAttribute('aria-label', next === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    try { localStorage.setItem('kukgit-theme', next); } catch { /* Storage can be blocked. */ }
  });
}

export function renderMarketingRoute(root, pathname = location.pathname) {
  const path = cleanPath(pathname);
  const render = { '/': home, '/features': features, '/security': security, '/pricing': pricing, '/docs': docs }[path] || home;
  setMeta(path);
  root.innerHTML = `<div class="marketing-site">${header(path)}<main>${render()}</main>${footer()}</div>`;
  bindMarketingUi();
}
