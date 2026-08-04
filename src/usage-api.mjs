import { requireUser } from './auth.mjs';
import { orgAccess, uid } from './db.mjs';
import { httpError } from './security.mjs';
import { PLANS, PURCHASABLE_PLANS } from './plans.mjs';
import { billingPeriod, exceeded, instanceUsage, organizationUsage } from './usage.mjs';
import { instancePeriod, organizationPeriods } from './usage-history.mjs';

/** The most recent period that has actually ended, which is what a bill is for. */
function previousPeriodId(now = new Date()) {
  return billingPeriod(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))).id;
}

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
 * Usage, for the organization that incurs it and for the operator who bills it.
 *
 * Read-only. Nothing here changes a plan: a plan changes when money changes
 * hands, and that path does not exist yet. Until it does, an endpoint that
 * could set `organizations.plan` would be a way to give away the product.
 */
export function createUsageApiHandler({ config, db, isInstanceAdmin }) {
  return async function usageApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const organizationRoute = /^\/api\/orgs\/([^/]+)\/usage$/.exec(url.pathname);
    const organizationHistory = /^\/api\/orgs\/([^/]+)\/usage\/history$/.exec(url.pathname);
    const operatorRoute = url.pathname === '/api/instance-admin/usage';
    const operatorHistory = url.pathname === '/api/instance-admin/usage/history';
    const planCatalogue = url.pathname === '/api/plans';
    if (!organizationRoute && !organizationHistory && !operatorRoute && !operatorHistory && !planCatalogue) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (String(req.method || 'GET').toUpperCase() !== 'GET') {
        throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      }

      // The plan catalogue is what a signed-in customer compares before asking
      // to move plan. It carries limits and no prices — pricing is not decided
      // here, and a number in this file would become the one somebody quotes.
      if (planCatalogue) {
        requireUser(db, req);
        return sendJson(res, 200, { plans: PURCHASABLE_PLANS.map((id) => PLANS[id]) });
      }

      const user = requireUser(db, req);

      if (operatorRoute || operatorHistory) {
        if (!isInstanceAdmin(config, user)) {
          throw httpError(403, 'KukGit instance administrator access is required.', 'INSTANCE_ADMIN_REQUIRED');
        }
        if (operatorHistory) {
          const period = url.searchParams.get('period') || previousPeriodId();
          return sendJson(res, 200, instancePeriod(db, period));
        }
        return sendJson(res, 200, instanceUsage(db, config, {}));
      }

      const orgSlug = decodeURIComponent((organizationRoute ?? organizationHistory)[1]);
      // Every member, not only owners. People are asked to stay inside a limit
      // they cannot see otherwise, and the person who fills the disk is rarely
      // the person who bought the plan.
      const organization = orgAccess(db, user.id, orgSlug, 'viewer');
      if (!organization) throw httpError(404, 'Organization not found.', 'ORG_NOT_FOUND');

      if (organizationHistory) {
        return sendJson(res, 200, { periods: organizationPeriods(db, organization.id) });
      }

      const usage = organizationUsage(db, config, { organizationId: organization.id });
      return sendJson(res, 200, { usage: { ...usage, exceeded: exceeded(usage) } });
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'USAGE_FAILED',
          message: status >= 500 ? 'Usage reporting is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}
