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

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
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
    .kg-usage-checkout { display:flex; flex-wrap:wrap; gap:7px; margin-top:4px; }
    .kg-usage-checkout .btn { font-size:11px; padding:6px 10px; }
  `;
  document.head.append(style);
}

/**
 * The plans this person can actually buy, as buttons.
 *
 * Only what the server offered. A member who cannot change the plan gets an
 * empty list from the API and sees nothing here — a button that exists to be
 * refused is worse than no button, and the check that matters is the server's
 * either way.
 *
 * The plan somebody is already on is not offered again. "Upgrade to Team" on a
 * Team subscription is how a customer ends up paying twice.
 */
export function checkoutRow(usage, billing, slug) {
  const options = (billing?.checkout ?? []).filter((option) => option.plan !== usage.plan?.id);
  const actions = billing?.actions ?? {};
  const buttons = options.map((option) => `<button class="btn btn-ghost kg-usage-buy"
    data-kg-buy-org="${esc(slug)}" data-kg-buy-plan="${esc(option.plan)}" data-kg-buy-provider="${esc(option.provider)}"
    >Upgrade to ${esc(option.label ?? option.plan)} · ${esc(option.provider)}</button>`);

  // Cancel and Resume come from the server, which knows that Razorpay has no
  // un-cancel. Working it out here would mean the browser holding a copy of
  // what each provider supports, and being wrong about it quietly.
  if (actions.canCancel) {
    buttons.push(`<button class="btn btn-ghost kg-usage-cancel" data-kg-manage-org="${esc(slug)}">Cancel plan</button>`);
  }
  if (actions.canResume) {
    buttons.push(`<button class="btn btn-ghost kg-usage-resume" data-kg-manage-org="${esc(slug)}">Keep plan</button>`);
  }
  if (!buttons.length) return '';
  return `<div class="kg-usage-checkout">${buttons.join('')}</div>`;
}

/** What a pending cancellation means, said before somebody has to ask. */
export function cancellationNote(billing) {
  const at = billing?.subscription?.cancelsAt;
  if (!at) return '';
  const when = new Date(at);
  const date = Number.isFinite(when.getTime())
    ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(when)
    : String(at);
  return `<br />This plan ends on ${esc(date)}. Everything keeps working until then, and nothing is deleted after.`;
}

export function usagePanel(usage, billing, slug = '') {
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
      ${cancellationNote(billing)}
      ${invoice ? `<br />Last invoice ${esc(money(invoice.amountMinor, invoice.currency))} for ${esc(invoice.period)} — ${esc(invoice.status)}.` : ''}
      ${plan.recognised === false ? `<br />This organization's plan is recorded as "${esc(plan.stored)}", which is not a plan we know. It is being treated as free.` : ''}
    </div>
    ${over.length ? `<div class="kg-usage-note over">Over the plan on ${esc(over.join(', '))}. Nothing has been deleted and everything can still be read — what stops is adding more.</div>` : ''}
    ${checkoutRow(usage, billing, slug)}
  </div>`;
}

async function buy(button) {
  const { kgBuyOrg: slug, kgBuyPlan: plan, kgBuyProvider: provider } = button.dataset;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Opening payment page…';
  try {
    const { checkout } = await request(`/api/orgs/${encodeURIComponent(slug)}/billing/checkout`, {
      method: 'POST',
      body: JSON.stringify({ plan, provider }),
    });
    if (!checkout?.url) throw new Error('The payment provider did not return a link.');
    // Same tab. A payment page opened in a popup is a payment page a blocker
    // eats, and the customer sees a button that did nothing.
    window.location.assign(checkout.url);
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    // On the button rather than in a toast: the thing that failed is the thing
    // they are looking at, and a toast is gone before they finish reading it.
    button.insertAdjacentHTML('afterend', `<small class="kg-usage-note over">${esc(error.message)}</small>`);
  }
}

/**
 * Ending or keeping a plan.
 *
 * The panel is redrawn from the server's answer rather than patched here: what
 * a subscription may do next is the server's to say, and guessing it in the
 * browser is how a Resume button appears beside a provider that has no un-cancel.
 */
async function manage(button, action, working) {
  const slug = button.dataset.kgManageOrg;
  const card = button.closest('[data-kg-org-card]');
  button.disabled = true;
  const original = button.textContent;
  button.textContent = working;
  try {
    await request(`/api/orgs/${encodeURIComponent(slug)}/billing/${action}`, { method: 'POST' });
    cache.delete(slug);
    card?.querySelector('.kg-usage')?.remove();
    if (card) await fill(card, slug);
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    button.insertAdjacentHTML('afterend', `<small class="kg-usage-note over">${esc(error.message)}</small>`);
  }
}

function bindCheckout(card) {
  for (const button of card.querySelectorAll('.kg-usage-buy')) {
    button.addEventListener('click', () => buy(button));
  }
  for (const button of card.querySelectorAll('.kg-usage-cancel')) {
    button.addEventListener('click', () => manage(button, 'cancel', 'Cancelling…'));
  }
  for (const button of card.querySelectorAll('.kg-usage-resume')) {
    button.addEventListener('click', () => manage(button, 'resume', 'Keeping…'));
  }
}

async function fill(card, slug) {
  if (cache.has(slug)) {
    card.insertAdjacentHTML('beforeend', cache.get(slug));
    bindCheckout(card);
    return;
  }
  try {
    // Billing is optional here: an instance with no billing wired up should
    // still show its members what they are using.
    const [{ usage }, billing] = await Promise.all([
      request(`/api/orgs/${encodeURIComponent(slug)}/usage`),
      request(`/api/orgs/${encodeURIComponent(slug)}/billing`).catch(() => null),
    ]);
    const html = usagePanel(usage, billing, slug);
    cache.set(slug, html);
    card.insertAdjacentHTML('beforeend', html);
    // After insertion, and on every path that inserts: markup restored from the
    // cache has the same buttons and they would otherwise do nothing.
    bindCheckout(card);
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
