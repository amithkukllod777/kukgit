import crypto from 'node:crypto';
import { instanceSetting } from './instance-settings.mjs';
import { recordInvoice } from './billing.mjs';

/**
 * Stripe, as a billing adapter.
 *
 * Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256 and the webhook
 * signing secret, and sends `stripe-signature: t=…,v1=…`. The timestamp is
 * inside the signed material, so a captured delivery cannot be replayed after
 * the tolerance window — Razorpay has no equivalent, which is worth knowing
 * when comparing the two adapters.
 *
 * The event id is Stripe's own `evt_…`, stable across its retries.
 */

const SIGNATURE_HEADER = 'stripe-signature';

/**
 * How long a signed delivery stays acceptable.
 *
 * Stripe's own default. Long enough for a slow network and a queued retry,
 * short enough that a body captured off a proxy log is not a working request
 * tomorrow.
 */
export const TOLERANCE_SECONDS = 300;

/**
 * Stripe's subscription statuses, mapped to the four the core understands.
 *
 * `unpaid` and `incomplete` are `past_due`: money was expected and did not
 * arrive, and the grace period decides how long that is survivable.
 * `incomplete_expired` is a subscription that never started — `canceled`,
 * because there is nothing to keep alive.
 */
const STATUS_BY_STRIPE = new Map([
  ['trialing', 'trialing'],
  ['active', 'active'],
  ['past_due', 'past_due'],
  ['unpaid', 'past_due'],
  ['incomplete', 'past_due'],
  ['paused', 'past_due'],
  ['incomplete_expired', 'canceled'],
  ['canceled', 'canceled'],
]);

function signingSecret(db, config) {
  return instanceSetting(db, config, 'billing.stripe', 'webhookSecret');
}

function parseHeader(value) {
  const parts = String(value ?? '').split(',');
  let timestamp = null;
  const signatures = [];
  for (const part of parts) {
    const [key, item] = part.split('=', 2);
    if (key?.trim() === 't') timestamp = Number(item);
    // Stripe sends more than one `v1` while a secret is being rotated, and both
    // are valid. Taking only the first would break exactly the deployment that
    // is trying to rotate safely.
    if (key?.trim() === 'v1' && item) signatures.push(item.trim());
  }
  return { timestamp, signatures };
}

function matches(expected, received) {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function verifyStripeSignature(raw, headers, secret, { now = Date.now(), tolerance = TOLERANCE_SECONDS } = {}) {
  if (!secret) return false;
  const { timestamp, signatures } = parseHeader(headers?.[SIGNATURE_HEADER]);
  if (!Number.isFinite(timestamp) || !signatures.length) return false;
  // Both directions. A delivery from the future is as much a sign of a forged
  // header as one from last week.
  if (Math.abs(Math.floor(now / 1000) - timestamp) > tolerance) return false;

  const expected = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${raw.toString('utf8')}`)
    .digest('hex');
  return signatures.some((candidate) => matches(expected, candidate));
}

function subscriptionObject(payload) {
  const object = payload?.data?.object;
  if (!object) return null;
  if (object.object === 'subscription') return object;
  return null;
}

function periodFromSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function organizationFor(db, metadata) {
  const slug = String(metadata?.kukgit_org ?? '').trim().toLowerCase();
  if (!slug) return null;
  return db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug)?.id ?? null;
}

export const stripeAdapter = {
  verify(raw, headers, { config, db }) {
    if (!verifyStripeSignature(raw, headers, signingSecret(db, config))) return null;

    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); }
    catch { return null; }

    const eventId = String(payload?.id ?? '').trim();
    if (!eventId.startsWith('evt_')) return null;
    return { eventId, type: String(payload.type ?? 'unknown'), payload };
  },

  normalize(verified, { db, config }) {
    const object = verified.payload?.data?.object ?? {};

    // A paid invoice is recorded and changes nothing about entitlement — the
    // subscription event that follows does that. Recorded either way, because a
    // payment that happened is one the customer should be able to see.
    if (verified.type === 'invoice.paid' || verified.type === 'invoice.payment_succeeded') {
      const organizationId = organizationFor(db, object.subscription_details?.metadata ?? object.metadata);
      const period = periodFromSeconds(object.period_start ?? object.created);
      if (organizationId && object.amount_paid != null && period) {
        try {
          recordInvoice(db, {
            organizationId,
            period,
            provider: 'stripe',
            reference: String(object.id ?? ''),
            // Stripe reports minor units already — cents, paise, whichever the
            // currency is. Nothing is converted.
            amountMinor: Number(object.amount_paid),
            currency: String(object.currency ?? 'usd'),
            status: 'paid',
            paidAt: new Date().toISOString(),
          });
        } catch { /* an unrecordable invoice must not stop the plan change */ }
      }
      return null;
    }

    if (verified.type === 'invoice.payment_failed') {
      const organizationId = organizationFor(db, object.subscription_details?.metadata ?? object.metadata);
      const plan = String((object.subscription_details?.metadata ?? object.metadata)?.kukgit_plan ?? '').toLowerCase();
      if (!organizationId || !plan) return null;
      return { organizationId, plan, status: 'past_due', reference: String(object.subscription ?? '') };
    }

    const subscription = subscriptionObject(verified.payload);
    if (!subscription) return null;

    // `deleted` is the only event whose status is the event rather than the
    // object: Stripe sends the subscription as it last was, which may still say
    // `active`.
    const status = verified.type === 'customer.subscription.deleted'
      ? 'canceled'
      : STATUS_BY_STRIPE.get(String(subscription.status ?? ''));
    if (!status) return null;

    const organizationId = organizationFor(db, subscription.metadata);
    if (!organizationId) return null;
    const plan = String(subscription.metadata?.kukgit_plan ?? '').toLowerCase();
    if (!plan) return null;

    return {
      organizationId,
      plan,
      status,
      reference: String(subscription.id ?? ''),
      currentPeriodEnd: subscription.current_period_end
        ? new Date(Number(subscription.current_period_end) * 1000).toISOString()
        : null,
    };
  },
};

export { STATUS_BY_STRIPE as STRIPE_STATUS_MAP };
