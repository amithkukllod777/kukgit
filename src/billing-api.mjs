import { requireUser } from './auth.mjs';
import { orgAccess, uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';
import { PURCHASABLE_PLANS } from './plans.mjs';
import {
  billingEvents,
  billingProvider,
  entitlement,
  ingestBillingEvent,
  organizationInvoices,
  recordInvoice,
  recordWebhookRejection,
  registeredProviders,
  subscriptionFor,
  webhookRejections,
} from './billing.mjs';
import { CHECKOUT_PLANS, checkoutOptions, startCheckout } from './billing-checkout.mjs';

const MAX_WEBHOOK_BYTES = 256 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
  return true;
}

/**
 * The raw bytes, because a signature is over bytes.
 *
 * Parsing and re-serialising changes key order and whitespace, and the
 * signature then fails for reasons nobody can see. Every provider signs the
 * body as sent.
 */
async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_WEBHOOK_BYTES) throw httpError(413, 'Webhook body is too large.', 'BILLING_WEBHOOK_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readRaw(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

/**
 * Who may spend an organization's money.
 *
 * Owner and admin. A maintainer can merge to `main`; that is not the same
 * question as whether they may put the organization on a recurring charge, and
 * conflating the two is how somebody's card gets billed by a colleague.
 *
 * External repository collaborators are refused whatever role they appear to
 * carry: their access is to one repository, granted by somebody else, and it
 * was never access to the organization.
 */
function canPurchase(organization) {
  if (organization?.externalRepositoryAccess) return false;
  return organization?.role === 'owner' || organization?.role === 'admin';
}

/**
 * Billing over HTTP.
 *
 * Three audiences, and they see different things. A member sees what their
 * organization is on and what it has been invoiced. An operator can record a
 * subscription taken outside any provider — a bank transfer, an agreement —
 * because that path has to exist before a provider is wired up, and because it
 * is how an enterprise agreement will always work.
 *
 * A provider webhook is unauthenticated by definition and authenticated by
 * signature. It is the only place a stranger can change what an organization is
 * entitled to, so it verifies before it reads.
 */
export function createBillingApiHandler({ config, db, isInstanceAdmin }) {
  return async function billingApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const webhook = /^\/api\/billing\/webhooks\/([a-z0-9-]+)$/.exec(url.pathname);
    const organizationRoute = /^\/api\/orgs\/([^/]+)\/billing$/.exec(url.pathname);
    const checkoutRoute = /^\/api\/orgs\/([^/]+)\/billing\/checkout$/.exec(url.pathname);
    const operatorSubscriptions = url.pathname === '/api/instance-admin/billing/subscriptions';
    const operatorInvoices = url.pathname === '/api/instance-admin/billing/invoices';
    const operatorEvents = url.pathname === '/api/instance-admin/billing/events';
    if (!webhook && !organizationRoute && !checkoutRoute && !operatorSubscriptions && !operatorInvoices && !operatorEvents) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    const method = String(req.method || 'GET').toUpperCase();

    try {
      if (webhook) {
        if (method !== 'POST') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
        const name = webhook[1];
        const adapter = billingProvider(name);
        // An unknown provider is a 404 and not a hint about which ones exist.
        if (!adapter) throw httpError(404, 'Unknown billing provider.', 'BILLING_PROVIDER_UNKNOWN');

        const raw = await readRaw(req);
        // Verification first, and on the bytes. Anything that reads the payload
        // before this is trusting a stranger to tell it who they are.
        const verified = adapter.verify(raw, req.headers, { config, db });
        if (!verified?.eventId) {
          // Recorded before the refusal, so wiring a provider up for the first
          // time is something an operator can look at rather than guess about.
          const reason = typeof adapter.reject === 'function'
            ? adapter.reject(raw, req.headers, { config, db })
            : 'signature rejected';
          recordWebhookRejection(db, { provider: name, reason, raw });
          throw httpError(400, 'Webhook signature is not valid.', 'BILLING_SIGNATURE_INVALID');
        }

        const change = adapter.normalize(verified, { db, config });
        const result = ingestBillingEvent(db, {
          provider: name,
          providerEventId: verified.eventId,
          type: verified.type,
          change,
        });
        // 200 for a duplicate too. A provider that gets anything else retries,
        // and retrying a delivery already handled is how a queue never drains.
        return sendJson(res, 200, { received: true, duplicate: Boolean(result.duplicate), outcome: result.outcome, requestId });
      }

      const user = requireUser(db, req);

      if (organizationRoute) {
        if (method !== 'GET') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
        const orgSlug = decodeURIComponent(organizationRoute[1]);
        const organization = orgAccess(db, user.id, orgSlug, 'viewer');
        if (!organization) throw httpError(404, 'Organization not found.', 'ORG_NOT_FOUND');
        return sendJson(res, 200, {
          subscription: subscriptionFor(db, organization.id),
          entitlement: entitlement(db, organization.id),
          invoices: organizationInvoices(db, organization.id),
          // What this person could buy, if they are allowed to buy anything. A
          // viewer sees an empty list rather than buttons that would refuse
          // them.
          checkout: canPurchase(organization) ? checkoutOptions(db, config) : [],
        });
      }

      if (checkoutRoute) {
        if (method !== 'POST') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
        if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
        const orgSlug = decodeURIComponent(checkoutRoute[1]);
        // Membership first, permission second, and they are different answers.
        // A maintainer knows this organization exists — telling them it does not
        // is a lie they can disprove — so they are refused, not hidden from. A
        // stranger gets the 404.
        const organization = orgAccess(db, user.id, orgSlug, 'viewer');
        if (!organization) throw httpError(404, 'Organization not found.', 'ORG_NOT_FOUND');
        // The role is read off the row rather than asked for as a minimum:
        // `orgAccess` returns early for a request already inside a
        // repository-access context and does not compare roles on that path,
        // and spending an organization's money is not somewhere to depend on
        // which caller happens to reach this line.
        if (!canPurchase(organization)) {
          throw httpError(403, 'Organization administrator access is required to change the plan.', 'ORG_ADMIN_REQUIRED');
        }
        const body = await readJson(req);
        const session = await startCheckout(db, config, {
          organization,
          plan: body.plan,
          provider: body.provider,
          userId: user.id,
        });
        return sendJson(res, 201, { checkout: session, requestId });
      }

      if (!isInstanceAdmin(config, user)) {
        throw httpError(403, 'KukGit instance administrator access is required.', 'INSTANCE_ADMIN_REQUIRED');
      }

      if (operatorEvents) {
        if (method !== 'GET') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
        return sendJson(res, 200, {
          events: billingEvents(db, {}),
          rejected: webhookRejections(db, {}),
          providers: registeredProviders(),
        });
      }

      if (method !== 'POST') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const body = await readJson(req);
      const organization = db.prepare('SELECT id FROM organizations WHERE slug = ?').get(String(body.orgSlug ?? ''));
      if (!organization) throw httpError(404, 'Organization not found.', 'ORG_NOT_FOUND');

      if (operatorSubscriptions) {
        // Recorded as an event like any other, so "what changed this plan" has
        // one answer whoever changed it. The operator is named in the audit row.
        const result = ingestBillingEvent(db, {
          provider: 'manual',
          providerEventId: `manual:${uid('sub')}`,
          type: 'subscription.recorded',
          userId: user.id,
          change: {
            organizationId: organization.id,
            plan: body.plan,
            status: body.status ?? 'active',
            reference: body.reference ?? null,
            currentPeriodEnd: body.currentPeriodEnd ?? null,
          },
        });
        return sendJson(res, 201, { ...result, requestId });
      }

      const invoice = recordInvoice(db, {
        organizationId: organization.id,
        period: String(body.period ?? ''),
        provider: 'manual',
        reference: body.reference ?? null,
        amountMinor: body.amountMinor,
        currency: body.currency,
        status: body.status ?? 'open',
        issuedAt: body.issuedAt ?? null,
        paidAt: body.paidAt ?? null,
      });
      return sendJson(res, 201, { invoice, requestId });
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'BILLING_FAILED',
          message: status >= 500 ? 'Billing is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}

export { PURCHASABLE_PLANS, CHECKOUT_PLANS, canPurchase };
