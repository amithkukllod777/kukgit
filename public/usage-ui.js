/**
 * What an organization is using, on the page its members already visit.
 *
 * The measurement, the limits and the invoices all had APIs and no screen. A
 * limit somebody cannot see is a limit they find out about by being refused,
 * usually in the middle of doing something — and the person who fills the disk
 * is rarely the person who bought the plan.
 *
 * Attached to the organizations page rather than owning a route of its own, so
 * it is where somebody already goes to ask "what is this organization".
 */

const KG_USAGE_MARK = 'data-kg-usage';
let queued = false;
const cache = new Map();

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

export function bytes(value = 0) {
  const amount = Number(value) || 0;
  if (amount < 1024) return `${amount} B`;
  if (amount < 1024 ** 2) return `${(amount / 1024).toFixed(1)} KB`;
  if (amount < 1024 ** 3) return `${(amount / 1024 ** 2).toFixed(1)} MB`;
  if (amount < 1024 ** 4) return `${(amount / 1024 ** 3).toFixed(1)} GB`;
  return `${(amount / 1024 ** 4).toFixed(2)} TB`;
}

export function money(minor, currency) {
  const amount = Number(minor) || 0;
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: String(currency || 'INR') })
      .format(amount / 100);
  } catch {
    return `${amount / 100} ${esc(currency ?? '')}`;
  }
}

/**
 * A limit as something to look at.
 *
 * An unlimited plan gets no bar at all rather than an empty one — a bar implies
 * a ceiling, and drawing one where there is none invites the question of how
 * close it is.
 */
export function meter(label, used, limit, format = (value) => value) {
  if (limit === null || limit === undefined) {
    return `<div class="kg-usage-row"><span>${esc(label)}</span><b>${esc(format(used))}</b><small>no limit</small></div>`;
  }
  const ratio = limit === 0 ? 1 : Math.min(1, used / limit);
  const state = used > limit ? 'over' : ratio >= 0.8 ? 'near' : 'fine';
  return `<div class="kg-usage-row">
    <span>${esc(label)}</span>
    <b>${esc(format(used))} <small>of ${esc(format(limit))}</small></b>
    <div class="kg-usage-bar ${state}"><i style="width:${Math.round(ratio * 100)}%"></i></div>
  </div>`;
}

async function request(path) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `Request failed (${response.status})`);
  return payload;
}

function installStyles() {
  if (document.querySelector('#kg-usage-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-usage-styles';
  style.textContent = `
    .kg-usage { display:grid; gap:9px; margin-top:14px; padding-top:14px; border-top:1px solid var(--border); }
    .kg-usage-row { display:grid; grid-template-columns:minmax(120px,1fr) auto; gap:6px 12px; align-items:baseline; }
    .kg-usage-row span { color:var(--muted); font-size:11px; }
    .kg-usage-row b { font-size:12px; }
    .kg-usage-row small { color:var(--muted); font-weight:400; }
    .kg-usage-bar { grid-column:1 / -1; height:5px; border-radius:999px; background:rgba(255,255,255,.07); overflow:hidden; }
    .kg-usage-bar i { display:block; height:100%; border-radius:999px; background:linear-gradient(90deg,#1598ff,#a728ff); }
    .kg-usage-bar.near i { background:linear-gradient(90deg,#ffad33,#ff8a3d); }
    .kg-usage-bar.over i { background:linear-gradient(90deg,#ff5e70,#ff2d55); }
    .kg-usage-note { color:var(--muted); font-size:10px; line-height:1.5; }
    .kg-usage-note.over { color:#ff8fa0; }
  `;
  document.head.append(style);
}

export function usagePanel(usage, billing) {
  const { limits, storage, ci, people, plan } = usage;
  const over = usage.exceeded ?? [];

  const invoice = billing?.invoices?.[0];
  const subscription = billing?.subscription;

  return `<div class="kg-usage">
    ${meter('Storage', limits.storageBytes.used, limits.storageBytes.limit, bytes)}
    ${meter('Repositories', limits.repositories.used, limits.repositories.limit)}
    ${meter('Members', limits.seats.used, limits.seats.limit)}
    ${meter(`CI minutes · ${esc(usage.period.id)}`, limits.ciMinutesPerMonth.used, limits.ciMinutesPerMonth.limit)}
    <div class="kg-usage-note">
      Git ${esc(bytes(storage.gitBytes))} · LFS ${esc(bytes(storage.lfsBytes))} · artifacts ${esc(bytes(storage.artifactBytes))} · caches ${esc(bytes(storage.cacheBytes))}
      ${storage.lfsSavedBytes ? `<br />Deduplication is saving ${esc(bytes(storage.lfsSavedBytes))} of Git LFS storage.` : ''}
      ${ci.running ? `<br />${esc(ci.running)} CI job${ci.running === 1 ? '' : 's'} still running, already counted.` : ''}
      ${people.externalCollaborators ? `<br />${esc(people.externalCollaborators)} external collaborator${people.externalCollaborators === 1 ? '' : 's'}, outside the seat count above.` : ''}
      ${subscription ? `<br />Subscription ${esc(subscription.status)} via ${esc(subscription.provider)}.` : ''}
      ${invoice ? `<br />Last invoice ${esc(money(invoice.amountMinor, invoice.currency))} for ${esc(invoice.period)} — ${esc(invoice.status)}.` : ''}
      ${plan.recognised === false ? `<br />This organization's plan is recorded as "${esc(plan.stored)}", which is not a plan we know. It is being treated as free.` : ''}
    </div>
    ${over.length ? `<div class="kg-usage-note over">Over the plan on ${esc(over.join(', '))}. Nothing has been deleted and everything can still be read — what stops is adding more.</div>` : ''}
  </div>`;
}

async function fill(card, slug) {
  if (cache.has(slug)) {
    card.insertAdjacentHTML('beforeend', cache.get(slug));
    return;
  }
  try {
    // Billing is optional here: an instance with no billing wired up should
    // still show its members what they are using.
    const [{ usage }, billing] = await Promise.all([
      request(`/api/orgs/${encodeURIComponent(slug)}/usage`),
      request(`/api/orgs/${encodeURIComponent(slug)}/billing`).catch(() => null),
    ]);
    const html = usagePanel(usage, billing);
    cache.set(slug, html);
    card.insertAdjacentHTML('beforeend', html);
  } catch {
    // Silent. A usage panel that could not load must not take the page it is
    // attached to with it.
  }
}

function attach() {
  queued = false;
  const cards = document.querySelectorAll(`[data-kg-org-card]:not([${KG_USAGE_MARK}])`);
  for (const card of cards) {
    card.setAttribute(KG_USAGE_MARK, 'true');
    fill(card, card.dataset.kgOrgCard);
  }
}

function schedule() {
  if (queued) return;
  queued = true;
  queueMicrotask(attach);
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  installStyles();
  // The organizations page is re-rendered on every navigation, so the cards are
  // new elements each time and have to be found again.
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('hashchange', () => { cache.clear(); schedule(); });
  schedule();
}
