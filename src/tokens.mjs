import { uid } from './db.mjs';
import { hashToken, httpError, randomToken } from './security.mjs';

export const PERSONAL_ACCESS_TOKEN_PREFIX = 'kgp_';
export const PERSONAL_ACCESS_TOKEN_SCOPES = Object.freeze(['repo:read', 'repo:write']);
const ALLOWED_SCOPES = new Set(PERSONAL_ACCESS_TOKEN_SCOPES);
const DEFAULT_LIFETIME_DAYS = 90;

export function normalizeTokenScopes(input) {
  const values = Array.isArray(input) ? input : String(input ?? '').split(',');
  const scopes = [...new Set(values.map((scope) => String(scope).trim()).filter(Boolean))];
  if (!scopes.length) throw httpError(400, 'Select at least one personal access token scope.', 'TOKEN_SCOPE_REQUIRED');
  const invalid = scopes.filter((scope) => !ALLOWED_SCOPES.has(scope));
  if (invalid.length) throw httpError(400, `Unsupported personal access token scope: ${invalid.join(', ')}.`, 'TOKEN_SCOPE_INVALID');
  return scopes;
}

function normalizeExpiry(value) {
  if (value === null) return null;
  if (value === undefined || value === '') return new Date(Date.now() + DEFAULT_LIFETIME_DAYS * 86400000).toISOString();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw httpError(400, 'Enter a valid token expiry date.', 'TOKEN_EXPIRY_INVALID');
  if (date.getTime() <= Date.now()) throw httpError(400, 'Token expiry must be in the future.', 'TOKEN_EXPIRY_INVALID');
  return date.toISOString();
}

function parseScopes(json) {
  try { return normalizeTokenScopes(JSON.parse(json)); }
  catch { return []; }
}

export function tokenHasScope(scopes, requiredScope) {
  if (!requiredScope) return true;
  if (scopes.includes(requiredScope)) return true;
  return requiredScope === 'repo:read' && scopes.includes('repo:write');
}

export function createPersonalAccessToken(db, userId, { name, scopes = ['repo:read'], expiresAt } = {}) {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) throw httpError(404, 'User not found.', 'USER_NOT_FOUND');
  const normalizedName = String(name ?? '').trim();
  if (!normalizedName) throw httpError(400, 'Token name is required.', 'TOKEN_NAME_REQUIRED');
  if (normalizedName.length > 80) throw httpError(400, 'Token name must be 80 characters or fewer.', 'TOKEN_NAME_INVALID');

  const normalizedScopes = normalizeTokenScopes(scopes);
  const normalizedExpiry = normalizeExpiry(expiresAt);
  const token = `${PERSONAL_ACCESS_TOKEN_PREFIX}${randomToken(32)}`;
  const id = uid('pat');
  const prefix = token.slice(0, 12);

  db.prepare(`
    INSERT INTO personal_access_tokens (id, user_id, name, token_hash, token_prefix, scopes_json, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, normalizedName, hashToken(token), prefix, JSON.stringify(normalizedScopes), normalizedExpiry);

  return { id, name: normalizedName, token, tokenPrefix: prefix, scopes: normalizedScopes, expiresAt: normalizedExpiry };
}

export function verifyPersonalAccessToken(db, token, requiredScope = null) {
  const value = String(token ?? '').trim();
  if (!value.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX) || value.length < 24) return null;
  const row = db.prepare(`
    SELECT p.id, p.user_id AS userId, p.name, p.scopes_json AS scopesJson,
      p.expires_at AS expiresAt, p.revoked_at AS revokedAt,
      u.email, u.display_name AS displayName
    FROM personal_access_tokens p JOIN users u ON u.id = p.user_id
    WHERE p.token_hash = ?
  `).get(hashToken(value));
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return null;
  const scopes = parseScopes(row.scopesJson);
  if (!tokenHasScope(scopes, requiredScope)) return null;
  db.prepare('UPDATE personal_access_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    name: row.name,
    scopes,
    expiresAt: row.expiresAt,
  };
}

export function listPersonalAccessTokens(db, userId) {
  return db.prepare(`
    SELECT id, name, token_prefix AS tokenPrefix, scopes_json AS scopesJson,
      expires_at AS expiresAt, last_used_at AS lastUsedAt,
      revoked_at AS revokedAt, created_at AS createdAt
    FROM personal_access_tokens
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId).map(({ scopesJson, ...row }) => ({ ...row, scopes: parseScopes(scopesJson) }));
}

export function revokePersonalAccessToken(db, userId, tokenId) {
  const result = db.prepare(`
    UPDATE personal_access_tokens
    SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
    WHERE id = ? AND user_id = ?
  `).run(tokenId, userId);
  if (!result.changes) throw httpError(404, 'Personal access token not found.', 'TOKEN_NOT_FOUND');
  return listPersonalAccessTokens(db, userId).find((token) => token.id === tokenId);
}
