import crypto from 'node:crypto';
import { audit, uid } from './db.mjs';
import { httpError } from './security.mjs';
import { PLANS, PURCHASABLE_PLANS, planFor } from './plans.mjs';
import { leaseGate } from './job-leases.mjs';

/**
 * The billing core: subscriptions, invoices, and the only writer of a plan.
 *
 * `organizations.plan` is written here and nowhere else. Two ways to change a
 * plan is two answers to "what is this customer paying for", and they diverge
 * the first time somebody uses the other one. Everything that changes a plan —
 * a provider webhook, an operator recording a bank transfer — arrives as a
 * **billing event**, is recorded, and is applied from there.
 *
 * Providers are adapters. Razorpay and Stripe verify differently, name their
 * events differently and disagree about what a subscription is; none of that
 * belongs in the part that decides what an organization is entitled to.
 *
 * Nothing here holds card data, and no provider secret is stored in these
 * tables. What is kept is a reference the provider issued and the outcome.
 */

const STATUSES = ['trialing', 'active', 'past_due', 'canceled'];
const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'];

/**
 * How long a plan survives a failed payment.
 *
 * Not zero. A card expires, a bank declines a legitimate charge, a webhook
 * arrives late — and taking somebody's plan away the same hour turns a payment
 * problem into an outage they did not cause. Fourteen days is long enough to
 * reach a human and short enough that it is not a free plan.
 */
export const GRACE_DAYS = 14;

/** How many refused deliveries are kept. Enough to debug a wiring session. */
const REJECTION_LIMIT = 200;

const providers = new Map();

/**
 * Who to tell when money goes wrong. A no-op until somebody registers one.
 *
 * A hook rather than an import, for the same reason provider adapters are
 * adapters: the part that decides what an organization is entitled to should
 * not also know how email works. It also keeps the dependency pointing one way
 * — the notifier reads `GRACE_DAYS` from here, and a direct call in the other
 * direction would close the loop.
 *
 * Failures are swallowed on purpose. A billing event that could not send an
 * email is still a billing event that must be applied; refusing the plan change
 * because the mail server is down is the more expensive failure by far.
 */
let notifier = null;

export function setBillingNotifier(fn) {
  notifier = typeof fn === 'function' ? fn : null;
}

function notify(db, payload) {
  if (!notifier) return;
  try { notifier(db, payload); }
  catch (error) { console.error('KukGit billing notification', error.message); }
}

/**
 * Register a payment provider.
 *
 * An adapter verifies a request came from its provider and turns the payload
 * into the small vocabulary below. It never touches the database: a provider
 * that could write directly is a provider that can grant plans, and the point
 * of the registry is that none of them can.
 */
export function registerBillingProvider(name, adapter) {
  const id = String(name || '').trim().toLowerCase();
  if (!id) throw new Error('A billing provider needs a name.');
  for (const method of ['verify', 'normalize']) {
    if (typeof adapter?.[method] !== 'function') throw new Error(`Billing provider ${id} has no ${method}().`);
  }
  providers.set(id, adapter);
  return id;
}

export function billingProvider(name) {
  return providers.get(String(name || '').trim().toLowerCase()) ?? null;
}

export function registeredProviders() {
  return [...providers.keys()].sort();
}

/** Test seam, and the way a host swaps a provider out. */
export function forgetBillingProviders() {
  providers.clear();
}

export function migrateBilling(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      plan TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('trialing','active','past_due','canceled')),
      provider TEXT NOT NULL,
      provider_reference TEXT,
      current_period_end TEXT,
      grace_until TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_subscription_reference
      ON billing_subscriptions(provider, provider_reference)
      WHERE provider_reference IS NOT NULL;

    CREATE TABLE IF NOT EXISTS billing_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      type TEXT NOT NULL,
      organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      applied_at TEXT,
      outcome TEXT,
      UNIQUE(provider, provider_event_id)
    );

    CREATE TABLE IF NOT EXISTS billing_invoices (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      period TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_reference TEXT,
      amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
      currency TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','open','paid','void','uncollectible')),
      issued_at TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(organization_id, period, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_billing_invoices_org
      ON billing_invoices(organization_id, period DESC);

    CREATE TABLE IF NOT EXISTS billing_webhook_rejections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      reason TEXT NOT NULL,
      body_fingerprint TEXT,
      body_bytes INTEGER NOT NULL DEFAULT 0,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_billing_rejections_recent
      ON billing_webhook_rejections(received_at DESC);
  `);

  // Added after the table shipped, so it is a column and not a rewrite.
  const columns = new Set(db.prepare('PRAGMA table_info(billing_subscriptions)').all().map((row) => String(row.name)));
  if (!columns.has('cancels_at')) db.exec('ALTER TABLE billing_subscriptions ADD COLUMN cancels_at TEXT');
}

/**
 * A timestamp that may be an ISO string we wrote or SQLite's own
 * `YYYY-MM-DD HH:MM:SS`, which is UTC but says so nowhere.
 */
function parseStamp(value) {
  if (!value) return null;
  const text = String(value);
  const date = new Date(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function shapeSubscription(row) {
  if (!row) return null;
  return {
    plan: row.plan,
    status: row.status,
    provider: row.provider,
    reference: row.provider_reference,
    currentPeriodEnd: row.current_period_end,
    graceUntil: row.grace_until,
    // When the subscription is due to end. Set by a cancellation request, and
    // overwritten by the provider where the provider reports it.
    cancelsAt: row.cancels_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function subscriptionFor(db, organizationId) {
  return shapeSubscription(db.prepare('SELECT * FROM billing_subscriptions WHERE organization_id = ?').get(organizationId));
}

/**
 * The plan an organization is entitled to right now.
 *
 * A subscription that is `past_due` keeps its plan until the grace period ends;
 * after that, and when it is `canceled`, the entitlement is `free`. Nothing is
 * deleted either way — enforcement refuses growth, never a read, so a lapsed
 * customer keeps every repository they have.
 */
export function entitlement(db, organizationId, { now = new Date() } = {}) {
  const subscription = subscriptionFor(db, organizationId);
  if (!subscription) return { plan: 'free', reason: 'no subscription' };
  if (subscription.status === 'active' || subscription.status === 'trialing') {
    return { plan: subscription.plan, reason: subscription.status };
  }
  if (subscription.status === 'past_due') {
    const grace = parseStamp(subscription.graceUntil);
    if (grace && grace > now) return { plan: subscription.plan, reason: 'in grace' };
    return { plan: 'free', reason: 'grace expired' };
  }
  return { plan: 'free', reason: 'canceled' };
}

function assertPlan(plan) {
  const id = String(plan || '').toLowerCase();
  // `founder` is refused here on purpose. It is the unlimited plan, and a
  // provider event that could select it would be a way to buy everything for
  // the price of the cheapest thing the provider will sell.
  if (!PURCHASABLE_PLANS.includes(id)) {
    throw httpError(422, `Plan must be one of ${PURCHASABLE_PLANS.join(', ')}.`, 'BILLING_PLAN_INVALID');
  }
  return id;
}

function assertStatus(status) {
  const value = String(status || '').toLowerCase();
  if (!STATUSES.includes(value)) throw httpError(422, `Status must be one of ${STATUSES.join(', ')}.`, 'BILLING_STATUS_INVALID');
  return value;
}

function graceFor(status, now) {
  if (status !== 'past_due') return null;
  return new Date(now.getTime() + GRACE_DAYS * 86_400_000).toISOString();
}

/**
 * Apply a normalized change. The only path that writes `organizations.plan`.
 *
 * Called from `ingestBillingEvent`, and directly by nothing else — every caller
 * goes through an event so that what changed a plan is always answerable.
 */
function applyChange(db, {
  organizationId, plan, status, provider, reference, currentPeriodEnd, cancelsAt,
  now, userId = null, eventType,
}) {
  const wanted = assertPlan(plan);
  const state = assertStatus(status);
  const organization = db.prepare('SELECT id, plan FROM organizations WHERE id = ?').get(organizationId);
  if (!organization) throw httpError(404, 'Organization not found.', 'ORG_NOT_FOUND');

  db.prepare(`
    INSERT INTO billing_subscriptions (
      organization_id, plan, status, provider, provider_reference, current_period_end, grace_until, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(organization_id) DO UPDATE SET
      plan = excluded.plan,
      status = excluded.status,
      provider = excluded.provider,
      provider_reference = COALESCE(excluded.provider_reference, billing_subscriptions.provider_reference),
      current_period_end = excluded.current_period_end,
      grace_until = excluded.grace_until,
      updated_at = CURRENT_TIMESTAMP
  `).run(organizationId, wanted, state, provider, reference ?? null, currentPeriodEnd ?? null, graceFor(state, now));

  // The pending-cancellation date, kept in step with whoever knows better.
  //
  // A provider that reports it is authoritative — Stripe sends `cancel_at` on
  // every subscription event, so an undo done in Stripe's own portal is
  // reflected here without KukGit being told separately. A provider that does
  // not report it leaves what the cancellation request recorded. Either way it
  // is cleared once the subscription is actually `canceled`: a date in the past
  // that says "ends soon" is worse than no date.
  if (state === 'canceled') {
    db.prepare('UPDATE billing_subscriptions SET cancels_at = NULL WHERE organization_id = ?').run(organizationId);
  } else if (cancelsAt !== undefined) {
    db.prepare('UPDATE billing_subscriptions SET cancels_at = ? WHERE organization_id = ?')
      .run(cancelsAt ?? null, organizationId);
  }

  const granted = entitlement(db, organizationId, { now }).plan;
  db.prepare('UPDATE organizations SET plan = ? WHERE id = ?').run(granted, organizationId);

  // After the write, so a notice never describes a state that failed to save.
  if (state === 'past_due') {
    notify(db, {
      organizationId, kind: 'payment_failed', plan: wanted,
      subscription: subscriptionFor(db, organizationId), graceUntil: graceFor(state, now),
    });
  } else if (state === 'canceled' && organization.plan !== 'free') {
    notify(db, { organizationId, kind: 'subscription_ended', plan: organization.plan });
  }

  audit(db, {
    organizationId,
    userId,
    action: 'billing.plan_changed',
    targetType: 'organization',
    targetId: organizationId,
    // No amounts, no references to anything the provider considers a secret —
    // an audit row is read by more people than a billing record is.
    metadata: { from: organization.plan, to: granted, status: state, provider, event: eventType ?? null },
  });

  return { plan: granted, subscription: subscriptionFor(db, organizationId) };
}

/**
 * Record and apply one provider event.
 *
 * Duplicates do nothing. Every provider retries, and a retry that charged a
 * plan change twice would be indistinguishable from two real changes. The
 * unique key is the provider's own event id, because it is the only identifier
 * both sides agree on.
 */
export function ingestBillingEvent(db, { provider, providerEventId, type, change, now = new Date(), userId = null }) {
  const providerId = String(provider || '').trim().toLowerCase();
  const eventId = String(providerEventId || '').trim();
  if (!providerId) throw httpError(422, 'A billing event needs a provider.', 'BILLING_PROVIDER_REQUIRED');
  if (!eventId) throw httpError(422, 'A billing event needs a provider event id.', 'BILLING_EVENT_ID_REQUIRED');

  const seen = db.prepare('SELECT id, outcome FROM billing_events WHERE provider = ? AND provider_event_id = ?')
    .get(providerId, eventId);
  if (seen) return { duplicate: true, id: seen.id, outcome: seen.outcome };

  const id = uid('bev');
  db.prepare(`
    INSERT INTO billing_events (id, provider, provider_event_id, type, organization_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, providerId, eventId, String(type || 'unknown'), change?.organizationId ?? null);

  if (!change) {
    // A real event that means nothing to us — a provider sends many. Recorded
    // so a support question about it has an answer, and so its retry is still
    // a duplicate.
    db.prepare("UPDATE billing_events SET applied_at = CURRENT_TIMESTAMP, outcome = 'ignored' WHERE id = ?").run(id);
    return { duplicate: false, id, outcome: 'ignored' };
  }

  try {
    const result = applyChange(db, { ...change, provider: providerId, now, userId, eventType: type });
    db.prepare("UPDATE billing_events SET applied_at = CURRENT_TIMESTAMP, outcome = 'applied' WHERE id = ?").run(id);
    return { duplicate: false, id, outcome: 'applied', ...result };
  } catch (error) {
    // The event stays recorded with why it failed. Deleting it would make the
    // provider's retry look like a first delivery, and the failure would repeat
    // silently rather than being visible once.
    db.prepare('UPDATE billing_events SET applied_at = CURRENT_TIMESTAMP, outcome = ? WHERE id = ?')
      .run(`failed: ${error.code || error.message}`, id);
    throw error;
  }
}

/**
 * Record that a subscription is due to end, or is no longer due to end.
 *
 * Deliberately narrow: it writes one column and never touches the plan or the
 * status. A cancellation is a thing that will happen, not a thing that has —
 * the customer paid for this period and keeps it. What actually changes the
 * plan is the provider's event when the period runs out, like everything else.
 */
export function recordCancellationIntent(db, organizationId, { cancelsAt = null, userId = null, provider, resumed = false }) {
  const subscription = subscriptionFor(db, organizationId);
  if (!subscription) throw httpError(404, 'This organization has no subscription.', 'BILLING_NO_SUBSCRIPTION');
  db.prepare('UPDATE billing_subscriptions SET cancels_at = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?')
    .run(cancelsAt, organizationId);
  // Only on the way out. Resuming is somebody undoing their own click a moment
  // later, and mailing the whole admin list about it is noise.
  if (!resumed && cancelsAt) {
    notify(db, {
      organizationId,
      kind: 'cancellation_scheduled',
      plan: subscription.plan,
      subscription: subscriptionFor(db, organizationId),
    });
  }
  audit(db, {
    organizationId,
    userId,
    action: resumed ? 'billing.subscription.resumed' : 'billing.subscription.cancellation_requested',
    targetType: 'organization',
    targetId: organizationId,
    metadata: { provider: provider ?? subscription.provider, plan: subscription.plan, cancelsAt },
  });
  return subscriptionFor(db, organizationId);
}

/**
 * A delivery that did not verify.
 *
 * Kept because otherwise there is nothing to look at. A webhook refused for a
 * mistyped secret answers 400 and leaves no trace, and the operator wiring up a
 * provider for the first time has no way to tell that from a URL the provider
 * never reached.
 *
 * The body is never stored — it is unverified input from a stranger, and it is
 * exactly where a real provider would have put customer data. What is kept is a
 * fingerprint, so a retry of the same rejected delivery is recognisable, and its
 * size.
 */
export function recordWebhookRejection(db, { provider, reason, raw, now = new Date() }) {
  const fingerprint = raw?.length
    ? crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)
    : null;
  db.prepare(`
    INSERT INTO billing_webhook_rejections (provider, reason, body_fingerprint, body_bytes, received_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(String(provider), String(reason).slice(0, 200), fingerprint, raw?.length ?? 0, now.toISOString());

  // Bounded, because this endpoint is reachable by anybody and a table that
  // grows on request is a way to fill the disk.
  db.prepare(`
    DELETE FROM billing_webhook_rejections WHERE id NOT IN (
      SELECT id FROM billing_webhook_rejections ORDER BY id DESC LIMIT ?
    )
  `).run(REJECTION_LIMIT);
  return { reason };
}

export function webhookRejections(db, { limit = 50 } = {}) {
  return db.prepare(`
    SELECT provider, reason, body_fingerprint AS fingerprint, body_bytes AS bytes, received_at AS receivedAt
    FROM billing_webhook_rejections ORDER BY id DESC LIMIT ?
  `).all(limit);
}

export function recordInvoice(db, {
  organizationId, period, provider, reference = null, amountMinor, currency, status = 'open', issuedAt = null, paidAt = null,
}) {
  if (!INVOICE_STATUSES.includes(status)) {
    throw httpError(422, `Invoice status must be one of ${INVOICE_STATUSES.join(', ')}.`, 'BILLING_INVOICE_STATUS_INVALID');
  }
  const amount = Number(amountMinor);
  // Minor units only. A float amount is how a rounding difference becomes a
  // recurring complaint nobody can reproduce.
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw httpError(422, 'Invoice amount must be a whole number of minor units.', 'BILLING_AMOUNT_INVALID');
  }
  const code = String(currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw httpError(422, 'Invoice currency must be a three-letter code.', 'BILLING_CURRENCY_INVALID');
  }

  const id = uid('inv');
  db.prepare(`
    INSERT INTO billing_invoices (
      id, organization_id, period, provider, provider_reference, amount_minor, currency, status, issued_at, paid_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(organization_id, period, provider) DO UPDATE SET
      status = excluded.status,
      amount_minor = excluded.amount_minor,
      currency = excluded.currency,
      provider_reference = COALESCE(excluded.provider_reference, billing_invoices.provider_reference),
      issued_at = COALESCE(excluded.issued_at, billing_invoices.issued_at),
      paid_at = COALESCE(excluded.paid_at, billing_invoices.paid_at)
  `).run(id, organizationId, period, String(provider).toLowerCase(), reference, amount, code, status, issuedAt, paidAt);

  return db.prepare('SELECT * FROM billing_invoices WHERE organization_id = ? AND period = ? AND provider = ?')
    .get(organizationId, period, String(provider).toLowerCase());
}

export function organizationInvoices(db, organizationId, { limit = 24 } = {}) {
  return db.prepare(`
    SELECT id, period, provider, amount_minor AS amountMinor, currency, status, issued_at AS issuedAt, paid_at AS paidAt
    FROM billing_invoices WHERE organization_id = ? ORDER BY period DESC LIMIT ?
  `).all(organizationId, limit);
}

export function billingEvents(db, { organizationId = null, limit = 50 } = {}) {
  const rows = organizationId
    ? db.prepare('SELECT * FROM billing_events WHERE organization_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ?').all(organizationId, limit)
    : db.prepare('SELECT * FROM billing_events ORDER BY received_at DESC, rowid DESC LIMIT ?').all(limit);
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    type: row.type,
    // The provider's own event id, so a support conversation can name the same
    // thing the provider's dashboard names.
    providerEventId: row.provider_event_id,
    receivedAt: row.received_at,
    appliedAt: row.applied_at,
    outcome: row.outcome,
  }));
}

/**
 * Drop the plan of any subscription whose grace period has run out.
 *
 * Without this a failed payment keeps its plan forever, because nothing else
 * looks at the clock — the provider sends `past_due` once and then goes quiet.
 */
export function expireGracePeriods(db, { now = new Date() } = {}) {
  const stale = db.prepare(`
    SELECT organization_id AS organizationId FROM billing_subscriptions
    WHERE status = 'past_due' AND grace_until IS NOT NULL AND grace_until < ?
  `).all(now.toISOString());

  let expired = 0;
  for (const row of stale) {
    const organization = db.prepare('SELECT plan FROM organizations WHERE id = ?').get(row.organizationId);
    if (!organization || organization.plan === 'free') continue;
    db.prepare("UPDATE organizations SET plan = 'free' WHERE id = ?").run(row.organizationId);
    // The one moment nobody is looking at a screen: a worker changed their plan
    // an hour after midnight because a card expired two weeks ago.
    notify(db, { organizationId: row.organizationId, kind: 'grace_expired', plan: organization.plan });
    audit(db, {
      organizationId: row.organizationId,
      action: 'billing.grace_expired',
      targetType: 'organization',
      targetId: row.organizationId,
      metadata: { from: organization.plan, to: 'free' },
    });
    expired += 1;
  }
  return { expired };
}

export function startBillingGraceWorker(db, { intervalMs = 3600_000, gate = leaseGate(db, 'billing-grace') } = {}) {
  const tick = () => {
    try {
      if (!gate()) return;
      expireGracePeriods(db, {});
    } catch (error) { console.error('KukGit billing grace worker', error.message); }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => { clearInterval(timer); gate.release?.(); };
}

export { PLANS, planFor };
