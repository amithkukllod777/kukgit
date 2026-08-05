import { audit, uid } from './db.mjs';
import { httpError } from './security.mjs';
import { PURCHASABLE_PLANS, planFor } from './plans.mjs';

/**
 * Buying a plan without anybody at Kuklabs doing anything.
 *
 * Until now a customer could be moved onto a paid plan only by an operator
 * creating a subscription in the provider's dashboard and typing the
 * organization slug into its notes by hand. That is a demo, not a business: it
 * does not run at night, it does not scale past the operator, and one typo in
 * the notes attributes somebody's payment to somebody else's organization.
 *
 * What this does is create the provider object with those notes already
 * correct, and hand back the URL to send the customer to. Everything after that
 * is unchanged — the provider charges the card, sends a webhook, and
 * `billing.mjs` remains the only writer of `organizations.plan`. Checkout can
 * start a purchase; it cannot grant a plan, and that separation is deliberate.
 *
 * **No price lives here.** The provider holds the price and KukGit holds which
 * provider object a KukGit plan means. Two places holding a price is two prices.
 */

/**
 * How long a started checkout is offered again instead of starting another.
 *
 * A customer who clicks Upgrade twice, or refreshes the tab, must not end up
 * with two subscriptions to cancel. Long enough to cover a real payment
 * attempt, short enough that a session abandoned this morning is not what they
 * are shown this afternoon.
 */
export const CHECKOUT_REUSE_MINUTES = 30;

const HTTP_TIMEOUT_MS = 20_000;

const checkoutProviders = new Map();

/**
 * Register a provider that can start a purchase.
 *
 * Separate from `registerBillingProvider` because the two are separate
 * capabilities: an instance can accept Stripe webhooks for subscriptions
 * created elsewhere without being able to create one, and an adapter with no
 * `create` simply cannot be chosen at checkout.
 */
export function registerCheckoutProvider(name, adapter) {
  const id = String(name || '').trim().toLowerCase();
  if (!id) throw new Error('A checkout provider needs a name.');
  for (const method of ['configured', 'create']) {
    if (typeof adapter?.[method] !== 'function') throw new Error(`Checkout provider ${id} has no ${method}().`);
  }
  checkoutProviders.set(id, adapter);
  return id;
}

export function checkoutProvider(name) {
  return checkoutProviders.get(String(name || '').trim().toLowerCase()) ?? null;
}

/** Test seam, and the way a host swaps a provider out. */
export function forgetCheckoutProviders() {
  checkoutProviders.clear();
}

export function migrateBillingCheckout(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_checkout_sessions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      plan TEXT NOT NULL,
      provider_reference TEXT,
      url TEXT NOT NULL,
      started_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_billing_checkout_recent
      ON billing_checkout_sessions(organization_id, provider, plan, expires_at DESC);
  `);
}

/**
 * Plans somebody can actually buy at checkout.
 *
 * `free` is purchasable in the sense that an organization may be on it, but
 * there is nothing to charge for and no provider object to create. Downgrading
 * to free is a cancellation, which is a different operation with different
 * consequences, and pretending it is a purchase would hide that.
 */
export const CHECKOUT_PLANS = Object.freeze(PURCHASABLE_PLANS.filter((plan) => plan !== 'free'));

function assertCheckoutPlan(plan) {
  const id = String(plan || '').trim().toLowerCase();
  if (!CHECKOUT_PLANS.includes(id)) {
    throw httpError(422, `Checkout is available for ${CHECKOUT_PLANS.join(' and ')}.`, 'BILLING_CHECKOUT_PLAN_INVALID');
  }
  return id;
}

/**
 * Which provider a customer can be sent to.
 *
 * Reported per plan, because a provider configured for Team and not for
 * Business is a real state — somebody set up the first price and stopped — and
 * showing a button that fails is worse than showing no button.
 */
export function checkoutOptions(db, config) {
  const options = [];
  for (const [provider, adapter] of [...checkoutProviders.entries()].sort()) {
    for (const plan of CHECKOUT_PLANS) {
      let configured = false;
      try { configured = Boolean(adapter.configured(db, config, plan)); }
      catch { configured = false; }
      if (configured) options.push({ provider, plan, label: planFor(plan).label });
    }
  }
  return options;
}

function reusableSession(db, { organizationId, provider, plan, now }) {
  const row = db.prepare(`
    SELECT * FROM billing_checkout_sessions
    WHERE organization_id = ? AND provider = ? AND plan = ? AND expires_at > ?
    ORDER BY expires_at DESC LIMIT 1
  `).get(organizationId, provider, plan, now.toISOString());
  return row ?? null;
}

function shapeSession(row, { reused = false } = {}) {
  return {
    id: row.id,
    provider: row.provider,
    plan: row.plan,
    url: row.url,
    reference: row.provider_reference,
    expiresAt: row.expires_at,
    reused,
  };
}

/**
 * Start a purchase and return where to send the customer.
 *
 * The caller has already decided this person may spend the organization's
 * money; this decides nothing about authorization and everything about not
 * creating two subscriptions for one intention.
 */
export async function startCheckout(db, config, {
  organization,
  plan,
  provider,
  userId = null,
  now = new Date(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!organization?.id || !organization?.slug) throw httpError(404, 'Organization not found.', 'ORG_NOT_FOUND');
  const planId = assertCheckoutPlan(plan);
  const providerId = String(provider || '').trim().toLowerCase();
  const adapter = checkoutProvider(providerId);
  // An unconfigured provider and an unknown one give the same answer. Which
  // providers exist on an instance is not something an unauthenticated guess
  // should be able to enumerate, and by here the caller cannot do anything
  // useful with the difference anyway.
  if (!adapter || !adapter.configured(db, config, planId)) {
    throw httpError(422, 'That payment provider is not available for this plan.', 'BILLING_CHECKOUT_UNAVAILABLE');
  }

  const existing = reusableSession(db, { organizationId: organization.id, provider: providerId, plan: planId, now });
  if (existing) return shapeSession(existing, { reused: true });

  const created = await adapter.create(db, config, {
    organization,
    plan: planId,
    // Where the provider sends somebody back to, paid or cancelled. The
    // organizations page, because that is where the plan they just changed is
    // shown — and it is a route that exists: `#/orgs` is not one, and a return
    // URL nobody checks is a customer landing on an empty page after paying.
    returnUrl: `${config.baseUrl.replace(/\/$/, '')}/#/organizations`,
    fetchImpl,
  });
  if (!created?.url) throw httpError(502, 'The payment provider did not return a checkout link.', 'BILLING_CHECKOUT_FAILED');

  const id = uid('chk');
  const expiresAt = new Date(now.getTime() + CHECKOUT_REUSE_MINUTES * 60_000).toISOString();
  db.prepare(`
    INSERT INTO billing_checkout_sessions
      (id, organization_id, provider, plan, provider_reference, url, started_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, organization.id, providerId, planId, created.reference ?? null, String(created.url), userId, expiresAt);

  // The reference and the plan, and nothing else. An audit row is read by more
  // people than a billing record is, and a checkout URL is a link that starts a
  // payment — it does not belong in a log somebody can page through.
  audit(db, {
    organizationId: organization.id,
    userId,
    action: 'billing.checkout.started',
    targetType: 'organization',
    targetId: organization.id,
    metadata: { provider: providerId, plan: planId, reference: created.reference ?? null },
  });

  return shapeSession({
    id, provider: providerId, plan: planId, url: String(created.url),
    provider_reference: created.reference ?? null, expires_at: expiresAt,
  });
}

/**
 * Everything a provider must carry so the webhook can attribute the money.
 *
 * Both adapters put these on the object the provider will echo back — Razorpay
 * `notes`, Stripe `metadata` — because the alternative is a table of provider
 * references that has to be kept in step with theirs, and it will not be.
 */
export function attributionNotes(organization, plan) {
  return { kukgit_org: String(organization.slug).toLowerCase(), kukgit_plan: String(plan).toLowerCase() };
}

/** Removes a credential from anything the provider said back to us. */
export function redactSecret(text, secret) {
  const value = String(text ?? '');
  if (!secret) return value;
  return value.split(secret).join('[redacted]');
}

/**
 * One HTTP call to a payment provider.
 *
 * The error path matters more than the success path here: a provider's refusal
 * is stored, shown to an operator, and often pasted into a support message, and
 * providers echo credentials back in their error bodies. So the secret is
 * removed from the message before it leaves this function, not before it is
 * displayed — by then it has already been written down.
 */
export async function providerRequest(fetchImpl, url, options, { secret, provider }) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (cause) {
    const error = httpError(502, `${provider} could not be reached.`, 'BILLING_PROVIDER_UNREACHABLE');
    error.cause = cause;
    throw error;
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.description ?? parsed?.error?.message ?? parsed?.message ?? detail;
    } catch { /* not JSON */ }
    throw httpError(
      response.status >= 500 ? 502 : 400,
      `${provider} refused the checkout: ${redactSecret(detail, secret)}`,
      'BILLING_CHECKOUT_REFUSED',
    );
  }
  try { return JSON.parse(text); }
  catch { throw httpError(502, `${provider} returned a response we could not read.`, 'BILLING_CHECKOUT_FAILED'); }
}

/**
 * Stripe's form encoding, which is nested keys rather than JSON.
 *
 * `{ line_items: [{ price: 'p' }] }` becomes `line_items[0][price]=p`. Getting
 * this wrong produces a 400 that names a parameter Stripe thinks is missing,
 * which reads like the value is wrong rather than the shape.
 */
export function formEncode(value, prefix = '', into = new URLSearchParams()) {
  if (value === null || value === undefined) return into;
  if (Array.isArray(value)) {
    value.forEach((item, index) => formEncode(item, `${prefix}[${index}]`, into));
    return into;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      formEncode(item, prefix ? `${prefix}[${key}]` : key, into);
    }
    return into;
  }
  into.append(prefix, String(value));
  return into;
}
