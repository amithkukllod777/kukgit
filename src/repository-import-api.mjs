import { requireUser } from './auth.mjs';
import { orgAccess, uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';
import { normalizeImportToken } from './repository-import.mjs';
import {
  cancelBulkImportJob,
  createBulkImportJob,
  importJobStatus,
  listImportJobs,
  migrateRepositoryImportJobs,
  previewBulkImport,
  runBulkImportJob,
} from './repository-import-jobs.mjs';

export { migrateRepositoryImportJobs };

const MAX_BODY_BYTES = 32 * 1024;
const ROLE_RANK = Object.freeze({ viewer: 1, developer: 2, maintainer: 3, admin: 4, owner: 5 });

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

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'IMPORT_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

function routeMatch(pathname, pattern) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  }) + '$');
  const match = pathname.match(regex);
  if (!match) return null;
  try { return Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])); }
  catch { throw httpError(400, 'Invalid request path.', 'INVALID_PATH'); }
}

/**
 * Importing repositories in bulk, over HTTP.
 *
 * Two steps on purpose. `preview` says what would happen and imports nothing;
 * `start` does it. Forty repositories arriving in an organization is not
 * something to find out about afterwards, and the reasons a repository was
 * skipped are worth reading before rather than after.
 */
export function createBulkImportApiHandler({ config, db, runJob = runBulkImportJob, fetchImpl = undefined }) {
  return async function handleBulkImportApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/repository-imports')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);

      // Importing creates repositories and spends the organization's plan, so
      // it is a maintainer's decision, not a member's.
      const requireOrganization = (slug, minimum = 'maintainer') => {
        const organization = db.prepare('SELECT id, slug FROM organizations WHERE slug = ?').get(String(slug ?? ''));
        if (!organization) throw httpError(404, 'Organization not found.', 'ORGANIZATION_NOT_FOUND');
        const access = orgAccess(db, user.id, organization.slug);
        if (!access || (ROLE_RANK[access.role] ?? 0) < ROLE_RANK[minimum]) {
          throw httpError(403, 'You do not have permission to import repositories into this organization.', 'FORBIDDEN');
        }
        return organization;
      };

      if (req.method === 'POST' && pathname === '/api/repository-imports/preview') {
        const body = await readJson(req);
        requireOrganization(body.orgSlug);
        const token = normalizeImportToken(body.accessToken);
        const preview = await previewBulkImport({
          forge: body.forge,
          owner: body.owner,
          token,
          includeForks: Boolean(body.includeForks),
          includeArchived: Boolean(body.includeArchived),
        }, fetchImpl ? { fetchImpl } : {});
        // The token is not echoed, and neither is anything derived from it.
        return sendJson(res, 200, {
          forge: preview.forge,
          owner: preview.owner,
          authenticated: preview.authenticated,
          truncated: preview.truncated,
          note: preview.note,
          selected: preview.selected,
          skipped: preview.skipped,
        });
      }

      if (req.method === 'POST' && pathname === '/api/repository-imports') {
        const body = await readJson(req);
        const organization = requireOrganization(body.orgSlug);
        const token = normalizeImportToken(body.accessToken);
        const preview = await previewBulkImport({
          forge: body.forge,
          owner: body.owner,
          token,
          includeForks: Boolean(body.includeForks),
          includeArchived: Boolean(body.includeArchived),
        }, fetchImpl ? { fetchImpl } : {});

        // A caller who previewed and then chose a subset gets that subset. The
        // list is re-read from the forge either way, so a name that was not in
        // the listing cannot be smuggled in through this field.
        const wanted = Array.isArray(body.slugs) && body.slugs.length
          ? new Set(body.slugs.map((slug) => String(slug)))
          : null;
        const selected = wanted ? preview.selected.filter((entry) => wanted.has(entry.slug)) : preview.selected;

        const jobId = createBulkImportJob(db, {
          organizationId: organization.id,
          userId: user.id,
          forge: preview.forge,
          owner: preview.owner,
          authenticated: preview.authenticated,
          note: preview.note,
          selected,
          skipped: preview.skipped,
          token,
        });

        // Deliberately not awaited: the clones take minutes and the caller gets
        // a job to watch instead of a held connection. A failure in here is the
        // job's failure and is recorded against it, so the rejection is logged
        // and dropped rather than becoming an unhandled rejection.
        Promise.resolve(runJob(db, config, jobId)).catch((error) => {
          console.error(`[${requestId}] bulk import job ${jobId}`, error);
        });

        return sendJson(res, 202, { job: importJobStatus(db, jobId, { organizationId: organization.id }) });
      }

      let params = routeMatch(pathname, '/api/repository-imports/:jobId');
      if (req.method === 'GET' && params) {
        const job = importJobStatus(db, params.jobId);
        requireOrganization(db.prepare('SELECT slug FROM organizations WHERE id = ?').get(job.organizationId)?.slug, 'viewer');
        return sendJson(res, 200, { job });
      }

      if (req.method === 'DELETE' && params) {
        const job = importJobStatus(db, params.jobId);
        const organization = requireOrganization(db.prepare('SELECT slug FROM organizations WHERE id = ?').get(job.organizationId)?.slug);
        return sendJson(res, 200, { job: cancelBulkImportJob(db, params.jobId, { organizationId: organization.id }) });
      }

      params = routeMatch(pathname, '/api/repository-imports/organization/:orgSlug');
      if (req.method === 'GET' && params) {
        const organization = requireOrganization(params.orgSlug, 'viewer');
        return sendJson(res, 200, { jobs: listImportJobs(db, organization.id) });
      }

      throw httpError(404, 'Repository import endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] repository import API`, error);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: {
            code: error.code || 'INTERNAL_ERROR',
            message: status >= 500 ? 'An unexpected server error occurred.' : error.message,
            requestId,
          },
        });
      } else res.end();
    }
    return true;
  };
}
