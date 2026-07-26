import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { assertSlug, httpError, originAllowed } from './security.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const COMPANY_SIZES = new Set(['solo', '2-10', '11-50', '51-200', '201-1000', '1000+']);
const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'assets', 'auth', 'account', 'billing', 'docs', 'git',
  'help', 'kukgit', 'kukgit-trash', 'kuklabs', 'login', 'logout', 'new',
  'notifications', 'onboarding', 'organizations', 'repositories', 'root',
  'security', 'settings', 'status', 'support', 'system', 'www',
]);

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function ensureColumn(db, table, column, definition) {
  if (!tableColumns(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrateOrganizationOnboarding(db) {
  ensureColumn(db, 'organizations', 'description', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'organizations', 'website', 'TEXT');
  ensureColumn(db, 'organizations', 'company_size', 'TEXT');
  ensureColumn(db, 'organizations', 'onboarding_completed_at', 'TEXT');
  ensureColumn(db, 'organizations', 'created_by', 'TEXT REFERENCES users(id) ON DELETE SET NULL');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_organizations_created_by
      ON organizations(created_by, created_at DESC);
  `);
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

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Onboarding request is too large.', 'ONBOARDING_REQUEST_TOO_LARGE');
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

function normalizeName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) {
    throw httpError(400, 'Organization name must contain 2 to 100 characters.', 'ORGANIZATION_NAME_INVALID');
  }
  return name;
}

function normalizeDescription(value) {
  const description = String(value ?? '').trim();
  if (description.length > 500) throw httpError(400, 'Organization description must be 500 characters or fewer.', 'ORGANIZATION_DESCRIPTION_INVALID');
  return description;
}

function normalizeWebsite(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); }
  catch { throw httpError(400, 'Enter a valid organization website URL.', 'ORGANIZATION_WEBSITE_INVALID'); }
  if (url.protocol !== 'https:') throw httpError(400, 'Organization website must use HTTPS.', 'ORGANIZATION_WEBSITE_HTTPS_REQUIRED');
  if (url.username || url.password) throw httpError(400, 'Organization website must not contain credentials.', 'ORGANIZATION_WEBSITE_CREDENTIALS');
  url.hash = '';
  return url.toString().slice(0, 300);
}

function normalizeCompanySize(value) {
  const size = String(value ?? 'solo').trim();
  if (!COMPANY_SIZES.has(size)) throw httpError(400, 'Select a valid company size.', 'ORGANIZATION_COMPANY_SIZE_INVALID');
  return size;
}

function validateOrganizationSlug(value) {
  const slug = assertSlug(String(value ?? '').trim().toLowerCase(), 'organization slug');
  if (RESERVED_SLUGS.has(slug)) throw httpError(409, 'This organization slug is reserved.', 'ORGANIZATION_SLUG_RESERVED');
  return slug;
}

function userIdentity(db, userId) {
  return db.prepare(`
    SELECT id, email, display_name AS displayName,
      COALESCE(auth_source, 'local') AS authSource,
      COALESCE(email_verified, 0) AS emailVerified,
      kuklabs_user_id AS kuklabsUserId
    FROM users WHERE id = ?
  `).get(userId);
}

function requireVerifiedCreator(db, userId) {
  const identity = userIdentity(db, userId);
  if (!identity) throw httpError(401, 'Sign in to continue.', 'AUTH_REQUIRED');
  if (identity.authSource === 'authkit' && !identity.emailVerified) {
    throw httpError(403, 'Verify your Kuklabs Account email before creating an organization.', 'ORGANIZATION_VERIFIED_EMAIL_REQUIRED');
  }
  return identity;
}

function ownedOrganizationCount(db, userId) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM org_members om JOIN organizations o ON o.id = om.organization_id
    WHERE om.user_id = ? AND om.role = 'owner' AND o.plan <> 'system'
  `).get(userId).count);
}

function organizationsForUser(db, userId) {
  return db.prepare(`
    SELECT o.id, o.slug, o.name, o.plan, o.description, o.website,
      o.company_size AS companySize, o.onboarding_completed_at AS onboardingCompletedAt,
      o.created_at AS createdAt, om.role
    FROM organizations o JOIN org_members om ON om.organization_id = o.id
    WHERE om.user_id = ? AND o.plan <> 'system'
    ORDER BY o.created_at DESC
  `).all(userId);
}

function suggestSlug(displayName) {
  const value = String(displayName ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (/^[a-z0-9][a-z0-9-]{1,62}$/.test(value) && !RESERVED_SLUGS.has(value)) return value;
  return 'my-workspace';
}

function slugAvailability(db, slug) {
  if (RESERVED_SLUGS.has(slug)) return { available: false, reason: 'reserved' };
  const existing = db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug);
  return { available: !existing, reason: existing ? 'taken' : null };
}

function onboardingStatus(db, config, user) {
  const identity = requireVerifiedCreator(db, user.id);
  const organizations = organizationsForUser(db, user.id);
  const ownerCount = ownedOrganizationCount(db, user.id);
  const ownerLimit = config.organizationOwnerLimit;
  return {
    user: {
      id: identity.id,
      email: identity.email,
      displayName: identity.displayName,
      authSource: identity.authSource,
      emailVerified: Boolean(identity.emailVerified),
      kuklabsUserId: identity.kuklabsUserId,
    },
    organizations,
    ownerCount,
    ownerLimit,
    canCreate: ownerCount < ownerLimit,
    suggestedSlug: suggestSlug(identity.displayName),
    companySizes: [...COMPANY_SIZES],
  };
}

function createOrganization(db, config, user, input) {
  const identity = requireVerifiedCreator(db, user.id);
  const ownerCount = ownedOrganizationCount(db, user.id);
  if (ownerCount >= config.organizationOwnerLimit) {
    throw httpError(403, `You can own up to ${config.organizationOwnerLimit} organizations on the current plan.`, 'ORGANIZATION_OWNER_LIMIT_REACHED');
  }

  const name = normalizeName(input.name);
  const slug = validateOrganizationSlug(input.slug);
  const description = normalizeDescription(input.description);
  const website = normalizeWebsite(input.website);
  const companySize = normalizeCompanySize(input.companySize);
  const organizationId = uid('org');
  const teamId = uid('team');

  db.exec('BEGIN IMMEDIATE');
  try {
    if (!slugAvailability(db, slug).available) {
      throw httpError(409, 'An organization with this slug already exists.', 'ORGANIZATION_SLUG_TAKEN');
    }
    db.prepare(`
      INSERT INTO organizations
        (id, slug, name, plan, description, website, company_size,
         onboarding_completed_at, created_by)
      VALUES (?, ?, ?, 'free', ?, ?, ?, CURRENT_TIMESTAMP, ?)
    `).run(organizationId, slug, name, description, website, companySize, user.id);
    db.prepare(`
      INSERT INTO org_members (organization_id, user_id, role)
      VALUES (?, ?, 'owner')
    `).run(organizationId, user.id);
    db.prepare(`
      INSERT INTO teams (id, organization_id, slug, name, description, created_by)
      VALUES (?, ?, 'developers', 'Developers', 'Default development team', ?)
    `).run(teamId, organizationId, user.id);
    db.prepare(`
      INSERT INTO team_members (team_id, user_id, role, added_by)
      VALUES (?, ?, 'maintainer', ?)
    `).run(teamId, user.id, user.id);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    if (String(error.message).includes('UNIQUE')) {
      throw httpError(409, 'An organization with this slug already exists.', 'ORGANIZATION_SLUG_TAKEN');
    }
    throw error;
  }

  audit(db, {
    organizationId,
    userId: user.id,
    action: 'organization.self_service_created',
    targetType: 'organization',
    targetId: organizationId,
    metadata: {
      slug,
      plan: 'free',
      companySize,
      authSource: identity.authSource,
      hasWebsite: Boolean(website),
    },
  });
  return organizationsForUser(db, user.id).find((organization) => organization.id === organizationId);
}

export function createOrganizationOnboardingApiHandler({ config, db }) {
  return async function organizationOnboardingApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/onboarding/')) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);

      if (req.method === 'GET' && pathname === '/api/onboarding/status') {
        return sendJson(res, 200, onboardingStatus(db, config, user));
      }

      let params = routeMatch(pathname, '/api/onboarding/organizations/slug/:slug');
      if (req.method === 'GET' && params) {
        const slug = validateOrganizationSlug(params.slug);
        return sendJson(res, 200, { slug, ...slugAvailability(db, slug) });
      }

      if (req.method === 'POST' && pathname === '/api/onboarding/organizations') {
        const body = await readJson(req);
        const organization = createOrganization(db, config, user, body);
        return sendJson(res, 201, {
          organization,
          next: `#/repo/${encodeURIComponent(organization.slug)}`,
        });
      }

      throw httpError(404, 'Organization onboarding endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] organization onboarding API`, error);
      return sendJson(res, status, {
        error: {
          code: error.code || 'INTERNAL_ERROR',
          message: status >= 500 ? 'An unexpected server error occurred.' : error.message,
          requestId,
        },
      });
    }
  };
}
