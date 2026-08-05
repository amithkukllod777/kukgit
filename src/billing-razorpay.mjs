import crypto from 'node:crypto';
import { instanceSetting } from './instance-settings.mjs';
import { recordInvoice } from './billing.mjs';
import { attributionNotes, providerRequest } from './billing-checkout.mjs';

/**
 * Razorpay, as a billing adapter.
 *
 * Razorpay signs the webhook body with HMAC-SHA256 and the webhook secret, hex
 * encoded, in `x-razorpay-signature`. It also sends `x-razorpay-event-id`, which
 * is stable across its retries — that is the identifier the core deduplicates
 * on, and it is why a retried delivery cannot charge a plan change twice.
 *
 * Which organization and which plan come from the subscription's `notes`.
 * Razorpay carries them unchanged from creation to every later event, so the
 * mapping does not depend on a table we would have to keep in step with theirs.
 */

const SIGNATURE_HEADER = 'x-razorpay-signature';
const EVENT_HEADER = 'x-razorpay-event-id';

/**
 * How Razorpay's subscription states become the four the core understands.
 *
 * `halted` is Razorpay giving up after repeated failures, and `pending` is a
 * charge that failed and will be retried. Both are `past_due` here: the
 * customer's payment has not gone through, and the grace period is what decides
 * how long that is survivable.
 */
const STATUS_BY_EVENT = new Map([
  ['subscription.activated', 'active'],
  ['subscription.charged', 'active'],
  ['subscription.resumed', 'active'],
  ['subscription.authenticated', 'trialing'],
  ['subscription.pending', 'past_due'],
  ['subscription.halted', 'past_due'],
  ['subscription.paused', 'past_due'],
  ['subscription.cancelled', 'canceled'],
  ['subscription.completed', 'canceled'],
  ['subscription.expired', 'canceled'],
]);

function webhookSecret(db, config) {
  return instanceSetting(db, config, 'billing.razorpay', 'webhookSecret');
}

/**
 * The signature, compared in constant time.
 *
 * A missing secret verifies nothing rather than verifying everything: an
 * instance that has not been configured must refuse the webhook, not accept any
 * body that arrives at the URL.
 */
export function verifyRazorpaySignature(raw, headers, secret) {
  if (!secret) return false;
  const received = String(headers?.[SIGNATURE_HEADER] ?? '');
  if (!/^[0-9a-f]{64}$/i.test(received)) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(received.toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function subscriptionEntity(payload) {
  return payload?.payload?.subscription?.entity ?? null;
}

function invoiceEntity(payload) {
  return payload?.payload?.invoice?.entity ?? payload?.payload?.payment?.entity ?? null;
}

function periodFromSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const razorpayAdapter = {
  /**
   * Why a delivery was refused, for the operator looking at it afterwards.
   *
   * Called only after `verify` has already said no, and it says nothing the
   * caller did not send — a stranger learns whether their own signature was
   * malformed, which they can see anyway.
   */
  reject(raw, headers, { config, db }) {
    if (!webhookSecret(db, config)) return 'no webhook secret is configured for razorpay';
    const signature = String(headers?.[SIGNATURE_HEADER] ?? '');
    if (!signature) return `no ${SIGNATURE_HEADER} header`;
    if (!/^[0-9a-f]{64}$/i.test(signature)) return `${SIGNATURE_HEADER} is not 64 hex characters`;
    // The signature before the event id. When both are wrong the signature is
    // the one worth saying, because a missing header is visible to whoever sent
    // it and a wrong secret is not.
    if (!verifyRazorpaySignature(raw, headers, webhookSecret(db, config))) {
      return 'signature does not match the configured webhook secret';
    }
    return `no ${EVENT_HEADER} header`;
  },

  verify(raw, headers, { config, db }) {
    if (!verifyRazorpaySignature(raw, headers, webhookSecret(db, config))) return null;

    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); }
    catch { return null; }

    // Razorpay's own event id, stable across its retries. Falling back to a
    // hash of the body would make a retry look new whenever Razorpay changed
    // one byte of it, which is the opposite of what deduplication is for.
    const eventId = String(headers?.[EVENT_HEADER] ?? '').trim();
    if (!eventId) return null;

    return { eventId, type: String(payload.event ?? 'unknown'), payload };
  },

  normalize(verified, { db, config }) {
    const status = STATUS_BY_EVENT.get(verified.type);
    const subscription = subscriptionEntity(verified.payload);

    // An invoice we can record without changing anything about entitlement.
    // Recorded even when the event does not move the subscription, because a
    // payment that happened is a payment the customer should be able to see.
    if (subscription && verified.type === 'subscription.charged') {
      const invoice = invoiceEntity(verified.payload);
      const organizationId = organizationFor(db, subscription);
      const period = periodFromSeconds(subscription.current_start) ?? periodFromSeconds(verified.payload.created_at);
      if (organizationId && invoice?.amount != null && period) {
        try {
          recordInvoice(db, {
            organizationId,
            period,
            provider: 'razorpay',
            reference: String(invoice.id ?? subscription.id),
            // Razorpay reports paise, which is already the minor unit.
            amountMinor: Number(invoice.amount),
            currency: String(invoice.currency ?? 'INR'),
            status: 'paid',
            paidAt: new Date().toISOString(),
          });
        } catch { /* an unrecordable invoice must not stop the plan change */ }
      }
    }

    // Not every Razorpay event is about a subscription, and the ones that are
    // not are recorded as ignored rather than guessed at.
    if (!status || !subscription) return null;

    const organizationId = organizationFor(db, subscription);
    if (!organizationId) return null;
    const plan = String(subscription.notes?.kukgit_plan ?? '').toLowerCase();
    if (!plan) return null;

    return {
      organizationId,
      plan,
      status,
      reference: String(subscription.id ?? ''),
      currentPeriodEnd: subscription.current_end ? new Date(Number(subscription.current_end) * 1000).toISOString() : null,
    };
  },
};

/**
 * The organization a Razorpay subscription belongs to.
 *
 * By slug from `notes`, and only if that organization exists. A note naming an
 * organization that is not there resolves to nothing rather than to the first
 * row — a webhook must not be able to pick a customer by being wrong.
 */
function organizationFor(db, subscription) {
  const slug = String(subscription?.notes?.kukgit_org ?? '').trim().toLowerCase();
  if (!slug) return null;
  return db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug)?.id ?? null;
}

/* ------------------------------------------------------------------ checkout */

const SUBSCRIPTIONS_ENDPOINT = 'https://api.razorpay.com/v1/subscriptions';

/**
 * How many billing cycles a subscription is created for.
 *
 * Razorpay requires a count; there is no "until cancelled". Ten years of
 * monthly cycles is the closest honest approximation, and a customer who is
 * still here in 2036 renewing is a problem worth having.
 */
const TOTAL_CYCLES = 120;

/** `team` → `planIdTeam`, which is what the console asks an operator to fill in. */
function planSettingKey(plan) {
  const id = String(plan ?? '').toLowerCase();
  return `planId${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

export function razorpayCheckoutCredentials(db, config, plan) {
  return {
    keyId: instanceSetting(db, config, 'billing.razorpay', 'keyId'),
    keySecret: instanceSetting(db, config, 'billing.razorpay', 'keySecret'),
    planId: instanceSetting(db, config, 'billing.razorpay', planSettingKey(plan)),
  };
}

/**
 * Starting a Razorpay subscription.
 *
 * The price is Razorpay's — a plan created in their dashboard — and what is
 * stored here is which of their plans a KukGit plan means. `notes` carry the
 * organization and the plan, and Razorpay echoes them unchanged on every later
 * event, which is what lets the webhook attribute the money without a mapping
 * table that would drift.
 *
 * There is no idempotency key: Razorpay's subscriptions API does not offer one.
 * The protection against a double click is the reused session in
 * `billing-checkout.mjs`, and it is the only one.
 */
export const razorpayCheckout = {
  configured(db, config, plan) {
    const { keyId, keySecret, planId } = razorpayCheckoutCredentials(db, config, plan);
    return Boolean(keyId && keySecret && planId);
  },

  async create(db, config, { organization, plan, fetchImpl }) {
    const { keyId, keySecret, planId } = razorpayCheckoutCredentials(db, config, plan);
    const authorization = Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64');
    const created = await providerRequest(fetchImpl, SUBSCRIPTIONS_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Basic ${authorization}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan_id: planId,
        total_count: TOTAL_CYCLES,
        quantity: 1,
        customer_notify: 1,
        notes: attributionNotes(organization, plan),
      }),
    }, { secret: keySecret, provider: 'Razorpay' });

    // `short_url` is the hosted page a customer completes. An id without one is
    // a subscription nobody can pay, which is a failure and not a link.
    return { url: created?.short_url ?? null, reference: created?.id ? String(created.id) : null };
  },

  /**
   * Cancel at the end of the cycle the customer has paid for.
   *
   * Not immediately. They bought this period; taking it away the moment they
   * click cancel is charging for something and then withdrawing it, and it
   * turns a routine decision into a support ticket.
   */
  async cancel(db, config, { subscription, fetchImpl }) {
    const { keyId, keySecret } = razorpayCheckoutCredentials(db, config, subscription.plan);
    const authorization = Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64');
    const result = await providerRequest(
      fetchImpl,
      `${SUBSCRIPTIONS_ENDPOINT}/${encodeURIComponent(subscription.reference)}/cancel`,
      {
        method: 'POST',
        headers: { Authorization: `Basic ${authorization}`, 'Content-Type': 'application/json' },
        // A boolean, not a 1. Razorpay's own documentation says a non-boolean
        // here is a 400, and plenty of examples in the wild send the integer.
        body: JSON.stringify({ cancel_at_cycle_end: true }),
      },
      { secret: keySecret, provider: 'Razorpay', operation: 'cancellation' },
    );
    const endsAt = Number(result?.current_end ?? result?.end_at);
    return { cancelsAt: Number.isFinite(endsAt) && endsAt > 0 ? new Date(endsAt * 1000).toISOString() : null };
  },

  // Razorpay has no un-cancel. A subscription cancelled at cycle end stays
  // cancelled, and the customer buys again. Saying so is better than a button
  // that fails.
  resume: null,
};

export { STATUS_BY_EVENT as RAZORPAY_STATUS_BY_EVENT };
