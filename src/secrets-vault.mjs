import crypto from 'node:crypto';
import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { requireRepositoryAccess } from './repository-access.mjs';
import { currentRepositoryAccess } from './access-context.mjs';
import { httpError, originAllowed } from './security.mjs';

export const SECRET_SCOPES = new Set(['organization', 'repository']);

export const SECRET_LIMITS = {
  maxValueBytes: 48 * 1024,
  maxPerScope: 100,
  maxNameLength: 100,
  minMaskLength: 5,
};

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The runner owns these prefixes. A secret that could take one of these names
// could impersonate the runner's own environment to every step in a job.
const RESERVED_PREFIXES = ['GITHUB_', 'KUKGIT_', 'RUNNER_', 'CI_KUKGIT'];
const MAX_BODY_BYTES = 64 * 1024;
const ORG_ROLE_RANK = { viewer: 1, developer: 2, maintainer: 3, admin: 4, owner: 5 };

export function migrateSecrets(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK(scope IN ('organization','repository')),
      scope_id TEXT NOT NULL,
      name TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      value_sha256 TEXT NOT NULL,
      value_bytes INTEGER NOT NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      UNIQUE(scope, scope_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_secrets_scope ON secrets(scope, scope_id, name);
  `);
}

function vaultKey(config) {
  const secret = String(config.secretsEncryptionKey || '');
  // Failing closed here is the point: an instance without a dedicated key must
  // not silently fall back to storing anything readable.
  if (secret.length < 32) {
    throw httpError(503, 'The secrets vault is not configured on this instance.', 'SECRETS_VAULT_UNAVAILABLE');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

// The scope and name are authenticated along with the value. A ciphertext copied
// from one repository's row into another's, or renamed, fails to decrypt rather
// than silently becoming a different secret.
function associatedData(scope, scopeId, name) {
  return `kukgit-secret:v1:${scope}:${scopeId}:${name}`;
}

export function encryptSecretValue(config, value, { scope, scopeId, name }) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey(config), iv);
  cipher.setAAD(Buffer.from(associatedData(scope, scopeId, name)));
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecretValue(config, envelope, { scope, scopeId, name }) {
  try {
    const [version, ivRaw, tagRaw, bodyRaw] = String(envelope || '').split('.');
    if (version !== 'v1' || !ivRaw || !tagRaw || !bodyRaw) throw new Error('invalid envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey(config), Buffer.from(ivRaw, 'base64url'));
    decipher.setAAD(Buffer.from(associatedData(scope, scopeId, name)));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(bodyRaw, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error?.status) throw error;
    throw httpError(500, 'A stored secret could not be decrypted.', 'SECRET_DECRYPTION_FAILED');
  }
}

export function normalizeSecretName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw httpError(400, 'A secret name is required.', 'SECRET_NAME_REQUIRED');
  if (name.length > SECRET_LIMITS.maxNameLength) throw httpError(400, 'Secret name is too long.', 'SECRET_NAME_INVALID');
  if (!SECRET_NAME.test(name)) {
    throw httpError(400, 'A secret name must start with a letter or underscore and contain only letters, numbers and underscores.', 'SECRET_NAME_INVALID');
  }
  if (RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw httpError(400, `Secret names starting with ${RESERVED_PREFIXES.join(', ')} are reserved for the runner.`, 'SECRET_NAME_RESERVED');
  }
  return name;
}

function normalizeSecretValue(value) {
  if (typeof value !== 'string') throw httpError(400, 'A secret value must be a string.', 'SECRET_VALUE_INVALID');
  if (!value.length) throw httpError(400, 'A secret value must not be empty.', 'SECRET_VALUE_INVALID');
  if (Buffer.byteLength(value) > SECRET_LIMITS.maxValueBytes) {
    throw httpError(413, 'Secret value is too large.', 'SECRET_VALUE_TOO_LARGE');
  }
  return value;
}

/**
 * Stores a secret, replacing any existing one with the same name in the same
 * scope.
 *
 * The plaintext is never returned, not even to the caller who just supplied it.
 * A secret that can be read back is a secret that can be exfiltrated by anyone
 * who reaches the read path, and there is no legitimate need for the API to have
 * one — an operator who has lost a value replaces it.
 */
export function putSecret(db, config, { scope, scopeId, name, value, actorId = null }) {
  if (!SECRET_SCOPES.has(scope)) throw httpError(400, 'Unknown secret scope.', 'SECRET_SCOPE_INVALID');
  const secretName = normalizeSecretName(name);
  const secretValue = normalizeSecretValue(value);

  const existing = db.prepare('SELECT id FROM secrets WHERE scope = ? AND scope_id = ? AND name = ?')
    .get(scope, scopeId, secretName);
  if (!existing) {
    const count = db.prepare('SELECT COUNT(*) AS count FROM secrets WHERE scope = ? AND scope_id = ?')
      .get(scope, scopeId).count;
    if (count >= SECRET_LIMITS.maxPerScope) {
      throw httpError(409, `A scope may hold at most ${SECRET_LIMITS.maxPerScope} secrets.`, 'SECRET_LIMIT_REACHED');
    }
  }

  const ciphertext = encryptSecretValue(config, secretValue, { scope, scopeId, name: secretName });
  // A digest of the value, so an operator can confirm two scopes hold the same
  // secret, or that a rotation actually changed it, without anyone reading it.
  const digest = crypto.createHash('sha256').update(secretValue).digest('hex');
  const bytes = Buffer.byteLength(secretValue);

  if (existing) {
    db.prepare(`
      UPDATE secrets SET ciphertext = ?, value_sha256 = ?, value_bytes = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(ciphertext, digest, bytes, actorId, existing.id);
    return { id: existing.id, name: secretName, created: false };
  }

  const id = uid('sec');
  db.prepare(`
    INSERT INTO secrets (id, scope, scope_id, name, ciphertext, value_sha256, value_bytes, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, scope, scopeId, secretName, ciphertext, digest, bytes, actorId, actorId);
  return { id, name: secretName, created: true };
}

/**
 * Lists secret names and metadata. Never returns a value or its ciphertext.
 *
 * `digest` is the first 12 characters of the value's SHA-256 — enough to compare
 * two entries or confirm a rotation happened, far too little to recover from.
 */
export function listSecrets(db, { scope, scopeId }) {
  return db.prepare(`
    SELECT name, value_bytes AS bytes, value_sha256 AS digest,
      created_at AS createdAt, updated_at AS updatedAt, last_used_at AS lastUsedAt
    FROM secrets WHERE scope = ? AND scope_id = ? ORDER BY name
  `).all(scope, scopeId).map((row) => ({ ...row, digest: row.digest.slice(0, 12) }));
}

export function deleteSecret(db, { scope, scopeId, name }) {
  const secretName = normalizeSecretName(name);
  const result = db.prepare('DELETE FROM secrets WHERE scope = ? AND scope_id = ? AND name = ?')
    .run(scope, scopeId, secretName);
  if (!result.changes) throw httpError(404, 'Secret not found.', 'SECRET_NOT_FOUND');
  return { name: secretName };
}

/**
 * Resolves the secrets a job may use, decrypted.
 *
 * Deliberately not reachable over HTTP. The runner calls this directly; there is
 * no route that returns a plaintext value, so no authorization mistake on a route
 * can expose one.
 *
 * A repository secret shadows an organization secret of the same name, so a team
 * can override an inherited value without the organization losing its default.
 */
export function resolveSecrets(db, config, { organizationId, repositoryId = null, names = null }) {
  const wanted = names === null ? null : new Set(names.map((name) => String(name)));
  const resolved = new Map();

  const scopes = [
    { scope: 'organization', scopeId: organizationId },
    ...(repositoryId ? [{ scope: 'repository', scopeId: repositoryId }] : []),
  ];

  for (const { scope, scopeId } of scopes) {
    if (!scopeId) continue;
    for (const row of db.prepare('SELECT id, name, ciphertext FROM secrets WHERE scope = ? AND scope_id = ?').all(scope, scopeId)) {
      if (wanted && !wanted.has(row.name)) continue;
      resolved.set(row.name, {
        name: row.name,
        value: decryptSecretValue(config, row.ciphertext, { scope, scopeId, name: row.name }),
        scope,
        id: row.id,
      });
    }
  }

  const used = [...resolved.values()];
  if (used.length) {
    const statement = db.prepare('UPDATE secrets SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?');
    for (const entry of used) statement.run(entry.id);
  }
  return used.map(({ name, value, scope }) => ({ name, value, scope }));
}

/**
 * Replaces secret values wherever they appear in text.
 *
 * Log masking is a backstop, not the protection — the format already refuses to
 * interpolate a secret into a command, and values reach a job through the
 * environment. This exists because a build can still echo one by accident.
 *
 * Values shorter than five characters are not masked: they would match ordinary
 * text everywhere and turn a log into a wall of asterisks, which hides more than
 * it protects.
 */
export function maskSecrets(text, values) {
  let output = String(text ?? '');
  const candidates = [...new Set(values.filter((value) => typeof value === 'string' && value.length >= SECRET_LIMITS.minMaskLength))]
    .sort((a, b) => b.length - a.length);
  for (const value of candidates) output = output.split(value).join('***');
  return output;
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'SECRET_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

function routeMatch(pathname, pattern) {
  const parts = pattern.split('/');
  const actual = pathname.split('/');
  if (parts.length !== actual.length) return null;
  const params = {};
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].startsWith(':')) {
      if (!actual[index]) return null;
      params[parts[index].slice(1)] = decodeURIComponent(actual[index]);
    } else if (parts[index] !== actual[index]) return null;
  }
  return params;
}

// Organization secret administration is checked directly against membership
// rather than through `orgAccess`, which has a repository-access fast path that
// returns before the role rank is compared. That path exists so a repository-only
// collaborator can read repository context; letting it satisfy an organization
// admin check would hand organization-wide secrets to someone invited to a single
// repository.
function requireOrganizationSecretAdmin(db, userId, orgSlug) {
  if (currentRepositoryAccess()?.allowed) {
    throw httpError(403, 'Organization Admin permission is required to manage organization secrets.', 'ORGANIZATION_ACCESS_DENIED');
  }
  const organization = db.prepare('SELECT id, slug, name FROM organizations WHERE slug = ?').get(orgSlug);
  if (!organization) throw httpError(404, 'Organization not found.', 'ORGANIZATION_NOT_FOUND');
  const membership = db.prepare('SELECT role FROM org_members WHERE organization_id = ? AND user_id = ?')
    .get(organization.id, userId);
  if (!membership || (ORG_ROLE_RANK[membership.role] ?? 0) < ORG_ROLE_RANK.admin) {
    throw httpError(403, 'Organization Admin permission is required to manage organization secrets.', 'ORGANIZATION_ACCESS_DENIED');
  }
  return organization;
}

export function createSecretsApiHandler({ config, db }) {
  return async function secretsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    if (!url.pathname.startsWith('/api/secrets/')) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);
      migrateSecrets(db);
      const method = String(req.method || 'GET').toUpperCase();

      let params = routeMatch(url.pathname, '/api/secrets/orgs/:org');
      if (params && method === 'GET') {
        const organization = requireOrganizationSecretAdmin(db, user.id, params.org);
        return sendJson(res, 200, { scope: 'organization', organization: organization.slug, secrets: listSecrets(db, { scope: 'organization', scopeId: organization.id }) });
      }

      params = routeMatch(url.pathname, '/api/secrets/orgs/:org/:name');
      if (params && (method === 'PUT' || method === 'DELETE')) {
        const organization = requireOrganizationSecretAdmin(db, user.id, params.org);
        return handleWrite(res, {
          db, config, user, method, requestId,
          scope: 'organization', scopeId: organization.id, name: params.name,
          body: method === 'PUT' ? await readJson(req) : {},
          auditTarget: { type: 'organization', id: organization.id },
        });
      }

      params = routeMatch(url.pathname, '/api/secrets/repos/:org/:repo');
      if (params && method === 'GET') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        return sendJson(res, 200, {
          scope: 'repository',
          repository: `${params.org}/${params.repo}`,
          secrets: listSecrets(db, { scope: 'repository', scopeId: access.repository.id }),
          // Inherited names only. An organization secret is usable here, and
          // hiding that would make an unexplained value in a build look like a bug.
          inherited: listSecrets(db, { scope: 'organization', scopeId: access.repository.organizationId })
            .map((secret) => secret.name),
        });
      }

      params = routeMatch(url.pathname, '/api/secrets/repos/:org/:repo/:name');
      if (params && (method === 'PUT' || method === 'DELETE')) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        return handleWrite(res, {
          db, config, user, method, requestId,
          scope: 'repository', scopeId: access.repository.id, name: params.name,
          body: method === 'PUT' ? await readJson(req) : {},
          auditTarget: { type: 'repository', id: access.repository.id },
        });
      }

      throw httpError(404, 'Unknown secrets route.', 'SECRET_ROUTE_NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'SECRET_REQUEST_FAILED',
          message: status >= 500 ? 'The secrets vault is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}

function handleWrite(res, { db, config, user, method, requestId, scope, scopeId, name, body, auditTarget }) {
  if (method === 'DELETE') {
    const removed = deleteSecret(db, { scope, scopeId, name });
    audit(db, {
      userId: user.id,
      action: 'secret.deleted',
      targetType: auditTarget.type,
      targetId: auditTarget.id,
      // The name, never the value, and never its digest.
      metadata: { scope, name: removed.name },
    });
    res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end();
    return true;
  }

  const result = putSecret(db, config, { scope, scopeId, name, value: body.value, actorId: user.id });
  audit(db, {
    userId: user.id,
    action: result.created ? 'secret.created' : 'secret.updated',
    targetType: auditTarget.type,
    targetId: auditTarget.id,
    metadata: { scope, name: result.name },
  });
  // The value is not echoed back. There is no read path for a stored secret.
  return sendJson(res, result.created ? 201 : 200, { scope, name: result.name, created: result.created, requestId });
}
