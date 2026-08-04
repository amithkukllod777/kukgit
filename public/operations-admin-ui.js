/**
 * Screens for the operator work that only had an API.
 *
 * Abuse cases, maintenance windows, status incidents, support access and
 * blocked content were all built server-side, with tests, and then reached only
 * by hand-written requests. An operator decision that needs curl is a decision
 * that gets made late, or by whoever happens to know the endpoint — so these are
 * the same routes with somewhere to click.
 *
 * Written against the `.kg-admin-*` styles installed by `instance-admin-ui.js`,
 * which owns the panel these sections live in.
 */

const KG_OPS_API = '/api/instance-admin';

export const KG_OPS_SECTIONS = [
  { id: 'abuse', label: 'Abuse', title: 'Abuse cases', subtitle: 'Reports, appeals and repositories currently disabled.' },
  { id: 'maintenance', label: 'Maintenance', title: 'Maintenance windows', subtitle: 'Announced downtime, and what it actually cost.' },
  { id: 'status', label: 'Status', title: 'Status incidents', subtitle: 'What the public status page is saying right now.' },
  { id: 'support-access', label: 'Support access', title: 'Support access', subtitle: 'Time-bound grants into customer repositories.' },
  { id: 'blocked-content', label: 'Blocked content', title: 'Blocked content', subtitle: 'Content refused by hash, everywhere it appears.' },
  { id: 'integrations', label: 'Integrations', title: 'Integrations', subtitle: 'Keys for email, payments and sign-in. Stored encrypted; never shown again.' },
];

const KG_OPS_IDS = new Set(KG_OPS_SECTIONS.map((section) => section.id));

let kgOpsRendering = false;
let kgOpsQueued = false;
let kgOpsKey = '';

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function when(value, fallback = '—') {
  if (!value) return fallback;
  const date = new Date(String(value).includes('T') ? value : `${String(value).replace(' ', 'T')}Z`);
  if (!Number.isFinite(date.getTime())) return fallback;
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function minutes(value) {
  if (value === null || value === undefined) return '—';
  const total = Number(value);
  if (!Number.isFinite(total)) return '—';
  if (total < 60) return `${total}m`;
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

function toast(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${esc(title)}</b><span>${esc(message)}</span></div>`;
  root.append(item);
  setTimeout(() => item.remove(), 4600);
}

async function request(path, options = {}) {
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
    error.requestId = payload?.error?.requestId;
    throw error;
  }
  return payload;
}

export function kgOpsRoute() {
  const raw = (location.hash.slice(1) || '/').split('?')[0];
  const segments = raw.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== 'instance-admin' || !KG_OPS_IDS.has(segments[1])) return null;
  return { section: segments[1], segments };
}

function hero(section, actions = '') {
  return `<section class="kg-admin-hero">
    <div>
      <div class="kg-admin-eyebrow">Kuklabs Operations · Every action is audited</div>
      <h1>${esc(section.title)}</h1>
      <p>${esc(section.subtitle)}</p>
    </div>
    <div class="kg-admin-toolbar">${actions}<button class="btn btn-ghost" data-ops-home>Admin home</button></div>
  </section>`;
}

function empty(message) {
  return `<div class="kg-admin-empty">${esc(message)}</div>`;
}

function badge(value) {
  const normalized = String(value || 'unknown').toLowerCase();
  const kind = ['resolved', 'completed', 'dismissed', 'approved', 'answered'].includes(normalized) ? 'public'
    : ['open', 'scheduled', 'investigating', 'identified', 'monitoring', 'in_progress'].includes(normalized) ? 'open'
      : ['sev1', 'outage', 'disabled', 'actioned', 'escalated', 'cancelled'].includes(normalized) ? 'critical'
        : 'private';
  return `<span class="badge ${kind}">${esc(normalized.replace(/_/g, ' '))}</span>`;
}

/** A textarea plus a button, which is the shape of almost every decision here. */
function reasonForm(action, label, placeholder, extra = '') {
  return `<form class="kg-admin-note-form" data-ops-form="${esc(action)}">
    ${extra}
    <textarea class="input" name="reason" placeholder="${esc(placeholder)}" required></textarea>
    <button class="btn btn-primary" type="submit">${esc(label)}</button>
  </form>`;
}

function select(name, values, selected = '') {
  const options = values.map((value) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(String(value).replace(/_/g, ' '))}</option>`).join('');
  return `<select class="input" name="${esc(name)}">${options}</select>`;
}

// ---------------------------------------------------------------- abuse

async function renderAbuse(content, section) {
  const [{ cases }, { appeals }, { repositories }] = await Promise.all([
    request(`${KG_OPS_API}/abuse/cases?status=open`),
    request(`${KG_OPS_API}/abuse/appeals?status=open`),
    request(`${KG_OPS_API}/abuse/disabled`),
  ]);

  const caseCards = cases.map((item) => `
    <article class="card kg-admin-card">
      <header class="kg-admin-row">
        <div>
          <b>${esc(item.target.label)}</b>
          <small>${esc(item.category)} · ${badge(item.status)}</small>
        </div>
        <div class="kg-admin-kv">
          <div><span>Reports</span><b>${esc(item.reportCount)}</b></div>
          <div><span>Distinct sources</span><b>${esc(item.distinctReporters)}</b></div>
          <div><span>Last reported</span><b>${esc(when(item.lastReportedAt))}</b></div>
        </div>
      </header>
      ${item.reports.length ? `<div class="kg-admin-event"><code>${esc(item.reports[0].detail)}</code></div>` : ''}
      ${reasonForm(`case:${item.id}`, 'Record decision', 'Why — this is what somebody reads when the same repository is reported again.', `<div class="kg-admin-toolbar">${select('action', ['dismiss', 'warn', 'disable', 'escalate'])}</div>`)}
    </article>`).join('');

  const appealCards = appeals.map((item) => `
    <article class="card kg-admin-card">
      <header class="kg-admin-row">
        <div><b>${esc(item.repository)}</b><small>${badge(item.status)} · filed ${esc(when(item.createdAt))}</small></div>
      </header>
      <div class="kg-admin-event"><code>${esc(item.body)}</code></div>
      ${reasonForm(`appeal:${item.id}`, 'Answer appeal', 'The answer the customer receives, in full.')}
    </article>`).join('');

  const disabledCards = repositories.map((item) => `
    <article class="card kg-admin-card">
      <header class="kg-admin-row">
        <div><b>${esc(item.orgSlug)}/${esc(item.repoSlug)}</b><small>disabled ${esc(when(item.disabledAt))}</small></div>
      </header>
      <div class="kg-admin-event"><code>${esc(item.reason || 'No reason recorded.')}</code></div>
      ${reasonForm(`reinstate:${item.orgSlug}/${item.repoSlug}`, 'Reinstate repository', 'Why this is being put back. The bytes were never deleted.')}
    </article>`).join('');

  content.innerHTML = `<div class="kg-admin-shell">
    ${hero(section)}
    <section class="card"><h2>Open cases</h2>${cases.length ? caseCards : empty('No open abuse cases.')}</section>
    <section class="card"><h2>Appeals awaiting an answer</h2>${appeals.length ? appealCards : empty('No appeals waiting.')}</section>
    <section class="card kg-admin-danger"><h2>Disabled repositories</h2>${repositories.length ? disabledCards : empty('No repository is disabled.')}</section>
  </div>`;

  bind(content, async (key, form) => {
    const reason = form.reason.value;
    if (key.startsWith('case:')) {
      await request(`${KG_OPS_API}/abuse/cases/${encodeURIComponent(key.slice(5))}/resolve`, {
        method: 'POST', body: { action: form.action.value, resolution: reason },
      });
      return 'Case recorded';
    }
    if (key.startsWith('appeal:')) {
      await request(`${KG_OPS_API}/abuse/appeals/${encodeURIComponent(key.slice(7))}/answer`, { method: 'POST', body: { answer: reason } });
      return 'Appeal answered';
    }
    const [org, repo] = key.slice(10).split('/');
    await request(`${KG_OPS_API}/abuse/disabled/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/reinstate`, { method: 'POST', body: { reason } });
    return 'Repository reinstated';
  });
}

// ---------------------------------------------------------- maintenance

async function renderMaintenance(content, section) {
  const { windows, policy } = await request(`${KG_OPS_API}/maintenance/windows`);

  const steps = (item) => {
    const available = item.status === 'scheduled' ? ['approve', 'cancel']
      : item.status === 'approved' ? ['start', 'cancel']
        : item.status === 'in_progress' ? ['end'] : [];
    return available.map((step) => `<button class="btn${step === 'cancel' ? '' : ' btn-primary'}" data-ops-step="${esc(item.id)}:${step}">${esc(step)}</button>`).join('');
  };

  const cards = windows.map((item) => `
    <article class="card kg-admin-card">
      <header class="kg-admin-row">
        <div><b>${esc(item.summary)}</b><small>${badge(item.status)} · ${esc(item.kind)}</small></div>
        <div class="kg-admin-toolbar">${steps(item)}</div>
      </header>
      <div class="kg-admin-kv">
        <div><span>Starts</span><b>${esc(when(item.startsAt))}</b></div>
        <div><span>Ends</span><b>${esc(when(item.endsAt))}</b></div>
        <div><span>Notice given</span><b>${esc(minutes(item.noticeMinutes))}</b></div>
        <div><span>Planned</span><b>${esc(minutes(item.plannedMinutes))}</b></div>
        <div><span>Actual</span><b>${esc(minutes(item.actualMinutes))}</b></div>
      </div>
      ${item.detail ? `<div class="kg-admin-event"><code>${esc(item.detail)}</code></div>` : ''}
      ${item.reason ? `<div class="kg-admin-event"><code>Reason: ${esc(item.reason)}</code></div>` : ''}
    </article>`).join('');

  content.innerHTML = `<div class="kg-admin-shell">
    ${hero(section)}
    <section class="card">
      <h2>Schedule a window</h2>
      <p class="kg-admin-eyebrow">Less than ${esc(Math.round(policy.plannedNoticeMinutes / 60))}h notice is not planned, whatever it is labelled — it becomes expedited and needs a written reason. Maximum ${esc(policy.maximumHours)}h.</p>
      <form class="kg-admin-note-form" data-ops-form="schedule">
        <input class="input" name="summary" placeholder="What is happening, in one line" required />
        <textarea class="input" name="detail" placeholder="Detail customers will see (optional)"></textarea>
        <div class="kg-admin-toolbar">
          ${select('kind', policy.kinds)}
          <input class="input" name="startsAt" type="datetime-local" required />
          <input class="input" name="endsAt" type="datetime-local" required />
        </div>
        <textarea class="input" name="reason" placeholder="Reason — required for anything short-notice, at least ${esc(policy.minimumReasonLength)} characters"></textarea>
        <button class="btn btn-primary" type="submit">Schedule window</button>
      </form>
    </section>
    <section class="card">
      <h2>Windows</h2>
      <p class="kg-admin-eyebrow">Approval has to come from a different operator than the one who scheduled it. Your own windows will refuse your approve.</p>
      ${windows.length ? cards : empty('No maintenance window has been scheduled.')}
    </section>
  </div>`;

  bind(content, async (key, form) => {
    const iso = (value) => (value ? new Date(value).toISOString() : '');
    await request(`${KG_OPS_API}/maintenance/windows`, {
      method: 'POST',
      body: {
        summary: form.summary.value,
        detail: form.detail.value,
        kind: form.kind.value,
        startsAt: iso(form.startsAt.value),
        endsAt: iso(form.endsAt.value),
        reason: form.reason.value,
      },
    });
    return 'Window scheduled';
  });

  bindSteps(content, async (id, step) => {
    await request(`${KG_OPS_API}/maintenance/windows/${encodeURIComponent(id)}/${step}`, { method: 'POST', body: {} });
    return `Window ${step === 'end' ? 'ended' : `${step}${step.endsWith('e') ? 'd' : 'ed'}`}`;
  });
}

// --------------------------------------------------------------- status

async function renderStatus(content, section) {
  const { incidents } = await request(`${KG_OPS_API}/status/incidents`);

  const cards = incidents.map((item) => `
    <article class="card kg-admin-card">
      <header class="kg-admin-row">
        <div><b>${esc(item.title)}</b><small>${badge(item.severity)} ${badge(item.state)} · started ${esc(when(item.startedAt))}</small></div>
      </header>
      ${item.updates.map((update) => `<div class="kg-admin-event"><b>${esc(update.state)}</b> · ${esc(when(update.at))}<code>${esc(update.body)}</code></div>`).join('')}
      ${item.state === 'resolved' ? '' : `
        <form class="kg-admin-note-form" data-ops-form="update:${esc(item.id)}">
          <div class="kg-admin-toolbar">${select('state', ['investigating', 'identified', 'monitoring', 'resolved'], item.state)}</div>
          <textarea class="input" name="body" placeholder="What changed since the last update" required></textarea>
          <button class="btn btn-primary" type="submit">Post update</button>
        </form>`}
    </article>`).join('');

  content.innerHTML = `<div class="kg-admin-shell">
    ${hero(section, '<a class="btn" href="/status" target="_blank" rel="noreferrer">Open public page</a>')}
    <section class="card">
      <h2>Publish an incident</h2>
      <p class="kg-admin-eyebrow">The public banner is derived from what is open here. An open sev1 makes the page say outage; nobody sets that separately.</p>
      <form class="kg-admin-note-form" data-ops-form="incident">
        <input class="input" name="title" placeholder="What customers are seeing" required />
        <div class="kg-admin-toolbar">${select('severity', ['sev1', 'sev2', 'sev3'], 'sev2')}</div>
        <textarea class="input" name="body" placeholder="First update — what is known so far" required></textarea>
        <button class="btn btn-primary" type="submit">Publish incident</button>
      </form>
    </section>
    <section class="card"><h2>Incidents</h2>${incidents.length ? cards : empty('No incident has been published.')}</section>
  </div>`;

  bind(content, async (key, form) => {
    if (key.startsWith('update:')) {
      await request(`${KG_OPS_API}/status/incidents/${encodeURIComponent(key.slice(7))}/updates`, {
        method: 'POST', body: { state: form.state.value, body: form.body.value },
      });
      return 'Update posted';
    }
    await request(`${KG_OPS_API}/status/incidents`, {
      method: 'POST', body: { title: form.title.value, severity: form.severity.value, body: form.body.value },
    });
    return 'Incident published';
  });
}

// ------------------------------------------------------- support access

async function renderSupportAccess(content, section) {
  const { grants } = await request(`${KG_OPS_API}/support-access`);

  const cards = grants.map((item) => `
    <article class="card kg-admin-card">
      <header class="kg-admin-row">
        <div>
          <b>${esc(item.orgSlug)}${item.repository ? `/${esc(item.repository)}` : ''}</b>
          <small>${badge(item.active ? 'open' : 'expired')} · ${esc(item.scope)} scope · ${esc(item.uses)} use${item.uses === 1 ? '' : 's'}</small>
        </div>
        <div class="kg-admin-kv">
          <div><span>Granted</span><b>${esc(when(item.createdAt))}</b></div>
          <div><span>Expires</span><b>${esc(when(item.expiresAt))}</b></div>
          <div><span>Revoked</span><b>${esc(when(item.revokedAt))}</b></div>
        </div>
      </header>
      <div class="kg-admin-event"><code>${esc(item.reason)}</code></div>
      ${item.events.length ? `<div class="kg-admin-event">${item.events.slice(0, 10).map((event) => `<div>${esc(when(event.at))} · ${esc(event.action)}${event.repoSlug ? ` · ${esc(event.repoSlug)}` : ''}</div>`).join('')}</div>` : ''}
    </article>`).join('');

  content.innerHTML = `<div class="kg-admin-shell">
    ${hero(section)}
    <section class="card">
      <h2>Grants held by this account</h2>
      <p class="kg-admin-eyebrow">Read-only here on purpose. A grant is asked for and revoked inside the customer's own organization, where their members can see it — an operator who could grant themselves access from the operations panel would be the whole point of the feature undone.</p>
      ${grants.length ? cards : empty('This account holds no support access grants.')}
    </section>
  </div>`;
}

// ------------------------------------------------------ blocked content

async function renderBlockedContent(content, section) {
  const { blocked } = await request(`${KG_OPS_API}/blocked-content?all=true`);
  const live = blocked.filter((item) => !item.removedAt);
  const lifted = blocked.filter((item) => item.removedAt);

  const card = (item) => `
    <article class="card kg-admin-card">
      <header class="kg-admin-row">
        <div>
          <b><code>${esc(item.digest.slice(0, 16))}…</code></b>
          <small>${esc(item.source)}${item.caseId ? ` · case ${esc(item.caseId)}` : ''} · blocked ${esc(when(item.createdAt))}</small>
        </div>
        <div class="kg-admin-kv"><div><span>Affected repositories</span><b>${esc(item.affected.length)}</b></div></div>
      </header>
      <div class="kg-admin-event"><code>${esc(item.reason)}</code></div>
      ${item.affected.length ? `<div class="kg-admin-event">${item.affected.slice(0, 20).map((row) => `<div>${esc(row.orgSlug)}/${esc(row.repoSlug)}</div>`).join('')}</div>` : ''}
      ${item.removedAt
    ? `<div class="kg-admin-event"><b>Unblocked ${esc(when(item.removedAt))}</b><code>${esc(item.removedReason || '')}</code></div>`
    : reasonForm(`unblock:${item.digest}`, 'Unblock', 'Why this is no longer refused. It becomes fetchable everywhere it appears.')}
    </article>`;

  content.innerHTML = `<div class="kg-admin-shell">
    ${hero(section)}
    <section class="card">
      <h2>Block by hash</h2>
      <p class="kg-admin-eyebrow">Blocking is by content, not by repository — the same bytes are refused wherever they are, including copies uploaded later.</p>
      <form class="kg-admin-note-form" data-ops-form="block">
        <input class="input" name="digest" placeholder="SHA-256 digest (64 hex characters)" pattern="[0-9a-fA-F]{64}" required />
        <textarea class="input" name="reason" placeholder="Why this content is refused" required></textarea>
        <button class="btn btn-primary" type="submit">Block content</button>
      </form>
    </section>
    <section class="card kg-admin-danger"><h2>Currently blocked</h2>${live.length ? live.map(card).join('') : empty('Nothing is blocked.')}</section>
    ${lifted.length ? `<section class="card"><h2>Previously blocked</h2>${lifted.map(card).join('')}</section>` : ''}
  </div>`;

  bind(content, async (key, form) => {
    if (key.startsWith('unblock:')) {
      await request(`${KG_OPS_API}/blocked-content/${encodeURIComponent(key.slice(8))}/unblock`, { method: 'POST', body: { reason: form.reason.value } });
      return 'Content unblocked';
    }
    await request(`${KG_OPS_API}/blocked-content`, {
      method: 'POST', body: { digest: form.digest.value.toLowerCase(), reason: form.reason.value },
    });
    return 'Content blocked';
  });
}

// --------------------------------------------------------- integrations

async function renderIntegrations(content, section) {
  const { integrations } = await request(`${KG_OPS_API}/integrations`);

  const field = (integration, item) => {
    const state = item.set
      ? `${badge(item.source === 'environment' ? 'environment' : 'set')}${item.fingerprint ? ` <code>${esc(item.fingerprint)}</code>` : ''}`
      : badge('not set');
    // A secret that is set shows a fingerprint and nothing else. There is no
    // endpoint that returns the value, so there is nothing to reveal here.
    const shown = item.secret ? '' : (item.value ? `<div class="kg-admin-event"><code>${esc(item.value)}</code></div>` : '');
    const fromEnvironment = item.source === 'environment';
    return `<article class="card kg-admin-card">
      <header class="kg-admin-row">
        <div><b>${esc(item.label)}</b><small>${item.secret ? 'secret' : 'not secret'} · ${state}</small></div>
        <div class="kg-admin-toolbar">${item.set && !fromEnvironment ? `<button class="btn" data-ops-clear="${esc(integration)}:${esc(item.key)}">Clear</button>` : ''}</div>
      </header>
      ${shown}
      ${fromEnvironment
    ? `<div class="kg-admin-event"><code>Set by ${esc(item.environmentVariable)} in the environment. The console cannot change it while that is set.</code></div>`
    : `<form class="kg-admin-note-form" data-ops-form="setting:${esc(integration)}:${esc(item.key)}">
        <input class="input" name="value" type="${item.secret ? 'password' : 'text'}" autocomplete="off" placeholder="${item.set ? 'Replace this value' : 'Paste the value'}" required />
        <button class="btn btn-primary" type="submit">${item.set ? 'Replace' : 'Save'}</button>
      </form>`}
    </article>`;
  };

  const cards = integrations.map((entry) => `
    <section class="card">
      <div class="kg-admin-row">
        <div><h2>${esc(entry.label)}</h2><small>${esc(entry.summary)}</small></div>
        <div class="kg-admin-toolbar">
          ${badge(entry.complete ? 'complete' : 'incomplete')}
          ${badge(entry.enabled ? 'enabled' : 'disabled')}
          <button class="btn${entry.enabled ? '' : ' btn-primary'}" data-ops-toggle="${esc(entry.id)}:${entry.enabled ? 'off' : 'on'}">${entry.enabled ? 'Disable' : 'Enable'}</button>
        </div>
      </div>
      ${entry.fields.map((item) => field(entry.id, item)).join('')}
    </section>`).join('');

  content.innerHTML = `<div class="kg-admin-shell">
    ${hero(section)}
    <section class="card">
      <p class="kg-admin-eyebrow">A secret is stored encrypted and is never shown again — not here, not through any endpoint. What you get back is whether it is set, a fingerprint so two people can agree they mean the same key, and who set it. To change one, replace it.</p>
      <p class="kg-admin-eyebrow">Where an environment variable is set, it wins and the console will not overwrite it. That is so an environment file cannot look authoritative while something else is quietly in charge.</p>
    </section>
    ${cards}
  </div>`;

  bind(content, async (key, form) => {
    const [, integration, name] = key.split(':');
    await request(`${KG_OPS_API}/integrations/${encodeURIComponent(integration)}/fields/${encodeURIComponent(name)}`, {
      method: 'PUT', body: { value: form.value.value },
    });
    return 'Saved';
  });

  content.querySelectorAll('[data-ops-clear]').forEach((button) => {
    button.addEventListener('click', async () => {
      const [integration, name] = button.dataset.opsClear.split(':');
      button.disabled = true;
      try {
        await request(`${KG_OPS_API}/integrations/${encodeURIComponent(integration)}/fields/${encodeURIComponent(name)}`, { method: 'DELETE' });
        toast('Done', 'Cleared');
        kgOpsKey = '';
        await renderKgOps();
      } catch (error) { toast('Failed', error.message, 'error'); button.disabled = false; }
    });
  });

  content.querySelectorAll('[data-ops-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      const [integration, state] = button.dataset.opsToggle.split(':');
      button.disabled = true;
      try {
        await request(`${KG_OPS_API}/integrations/${encodeURIComponent(integration)}/enabled`, {
          method: 'PUT', body: { enabled: state === 'on' },
        });
        toast('Done', state === 'on' ? 'Enabled' : 'Disabled');
        kgOpsKey = '';
        await renderKgOps();
      } catch (error) { toast('Failed', error.message, 'error'); button.disabled = false; }
    });
  });
}

// ------------------------------------------------------------ plumbing

/**
 * One submit handler for every form on the page.
 *
 * The button is disabled while the request is in flight, because every action
 * here is one somebody should not be able to fire twice by tapping again — two
 * `disable` decisions on one case, two incidents about one outage.
 */
function bind(content, submit) {
  content.querySelectorAll('[data-ops-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      const label = button.textContent;
      button.disabled = true;
      button.textContent = 'Working…';
      try {
        toast('Done', await submit(form.dataset.opsForm, form.elements));
        kgOpsKey = '';
        await renderKgOps();
      } catch (error) {
        toast('Failed', error.requestId ? `${error.message} (${error.requestId})` : error.message, 'error');
        button.disabled = false;
        button.textContent = label;
      }
    });
  });
}

function bindSteps(content, run) {
  content.querySelectorAll('[data-ops-step]').forEach((button) => {
    button.addEventListener('click', async () => {
      const [id, step] = button.dataset.opsStep.split(':');
      button.disabled = true;
      try {
        toast('Done', await run(id, step));
        kgOpsKey = '';
        await renderKgOps();
      } catch (error) {
        toast('Failed', error.message, 'error');
        button.disabled = false;
      }
    });
  });
}

const RENDERERS = {
  abuse: renderAbuse,
  maintenance: renderMaintenance,
  status: renderStatus,
  'support-access': renderSupportAccess,
  'blocked-content': renderBlockedContent,
  integrations: renderIntegrations,
};

async function renderKgOps() {
  const route = kgOpsRoute();
  if (!route || kgOpsRendering) return;
  const content = document.querySelector('.content');
  if (!content) return;
  if (kgOpsKey === location.hash && content.querySelector('.kg-admin-shell')) return;

  kgOpsRendering = true;
  content.innerHTML = '<div class="kg-admin-empty">Loading…</div>';
  const section = KG_OPS_SECTIONS.find((entry) => entry.id === route.section);
  try {
    await RENDERERS[route.section](content, section);
    kgOpsKey = location.hash;
  } catch (error) {
    content.innerHTML = `<div class="kg-admin-shell">${hero(section)}<section class="card">${empty(error.message)}</section></div>`;
  } finally {
    content.querySelectorAll('[data-ops-home]').forEach((button) => button.addEventListener('click', () => { location.hash = '#/instance-admin'; }));
    kgOpsRendering = false;
  }
}

/** The way into these sections from the admin overview. */
function installEntries() {
  if (kgOpsRoute()) return;
  const toolbar = document.querySelector('.kg-admin-shell .kg-admin-hero .kg-admin-toolbar');
  if (!toolbar || toolbar.querySelector('[data-ops-entry]')) return;
  for (const section of [...KG_OPS_SECTIONS].reverse()) {
    const button = document.createElement('button');
    button.className = 'btn';
    button.type = 'button';
    button.dataset.opsEntry = section.id;
    button.textContent = section.label;
    button.addEventListener('click', () => { location.hash = `#/instance-admin/${section.id}`; });
    toolbar.prepend(button);
  }
}

async function reconcile() {
  kgOpsQueued = false;
  if (kgOpsRoute()) await renderKgOps();
  else installEntries();
}

function schedule() {
  if (kgOpsQueued) return;
  kgOpsQueued = true;
  queueMicrotask(reconcile);
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    kgOpsKey = '';
    schedule();
  });
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
}
