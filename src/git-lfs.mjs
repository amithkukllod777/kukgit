import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { currentUser, requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { authorizeGitCredential } from './git-http.mjs';
import { permissionAtLeast, requireRepositoryAccess } from './repository-access.mjs';
import { httpError, originAllowed } from './security.mjs';

const LFS_MEDIA_TYPE = 'application/vnd.git-lfs+json';
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_OBJECTS = 1000;
const OID_PATTERN = /^[0-9a-f]{64}$/;
const SIGNED_TOKEN_TTL_SECONDS = 300;

export function migrateGitLfs(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lfs_objects (
      oid TEXT PRIMARY KEY,
      size INTEGER NOT NULL CHECK(size >= 0),
      storage_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_accessed_at TEXT,
      last_verified_at TEXT
    );
    CREATE TABLE IF NOT EXISTS repository_lfs_objects (
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      oid TEXT NOT NULL REFERENCES lfs_objects(oid) ON DELETE CASCADE,
      attached_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      attached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (repository_id, oid)
    );
    CREATE TABLE IF NOT EXISTS lfs_pending_uploads (
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      oid TEXT NOT NULL,
      expected_size INTEGER NOT NULL CHECK(expected_size >= 0),
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (repository_id, oid)
    );
    CREATE INDEX IF NOT EXISTS idx_lfs_repo_objects_oid
      ON repository_lfs_objects(oid, repository_id);
    CREATE INDEX IF NOT EXISTS idx_lfs_pending_expiry
      ON lfs_pending_uploads(expires_at);
  `);
}

function sendLfsJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': `${LFS_MEDIA_TYPE}; charset=utf-8`,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
  return true;
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

async function readJson(req, maxBytes = MAX_BATCH_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, 'Git LFS request body is too large.', 'LFS_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Git LFS request JSON is invalid.', 'LFS_INVALID_JSON'); }
}

function normalizeOid(value) {
  const oid = String(value ?? '').toLowerCase();
  if (!OID_PATTERN.test(oid)) throw httpError(422, 'Git LFS object OID must be a 64-character SHA-256 hex value.', 'LFS_OID_INVALID');
  return oid;
}

function normalizeSize(value, config) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw httpError(422, 'Git LFS object size must be a non-negative safe integer.', 'LFS_SIZE_INVALID');
  if (size > config.lfsMaxObjectBytes) throw httpError(413, `Git LFS object exceeds the ${config.lfsMaxObjectBytes}-byte object limit.`, 'LFS_OBJECT_TOO_LARGE');
  return size;
}

function objectRelativePath(oid) {
  return path.posix.join('objects', oid.slice(0, 2), oid.slice(2, 4), oid);
}

export function lfsObjectPath(config, oidValue) {
  const oid = normalizeOid(oidValue);
  return path.join(config.lfsDir, 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
}

function findRepository(db, orgSlug, repoSlug) {
  return db.prepare(`
    SELECT r.id, r.slug, r.name, r.visibility, r.organization_id AS organizationId,
      r.archived_at AS archivedAt, r.deleted_at AS deletedAt,
      o.slug AS orgSlug, o.name AS orgName
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ? AND r.deleted_at IS NULL
  `).get(orgSlug, repoSlug);
}

function parseBasicCredential(header = '') {
  if (!String(header).startsWith('Basic ')) return '';
  try {
    const decoded = Buffer.from(String(header).slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return decoded.startsWith('kgp_') ? decoded : '';
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return password || (username.startsWith('kgp_') ? username : '');
  } catch {
    return '';
  }
}

function lfsSigningKey(config) {
  const value = String(config.lfsAuthKey ?? '');
  if (!value) throw httpError(503, 'Git LFS SSH authentication is not configured.', 'LFS_AUTH_KEY_MISSING');
  return crypto.createHash('sha256').update(value).digest();
}

function signPayload(config, encoded) {
  return crypto.createHmac('sha256', lfsSigningKey(config)).update(encoded).digest('base64url');
}

export function createLfsAuthToken(config, payload, ttlSeconds = SIGNED_TOKEN_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    version: 1,
    repositoryId: payload.repositoryId,
    orgSlug: payload.orgSlug,
    repoSlug: payload.repoSlug,
    operation: payload.operation,
    userId: payload.userId ?? null,
    keyKind: payload.keyKind ?? null,
    keyId: payload.keyId ?? null,
    issuedAt: now,
    expiresAt: now + Math.max(30, Math.min(Number(ttlSeconds) || SIGNED_TOKEN_TTL_SECONDS, 3600)),
    nonce: crypto.randomBytes(12).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `lfs_${encoded}.${signPayload(config, encoded)}`;
}

export function verifyLfsAuthToken(config, tokenValue, repository, operation) {
  const token = String(tokenValue ?? '');
  const match = token.match(/^lfs_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const expected = signPayload(config, match[1]);
  const received = match[2];
  if (received.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); }
  catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (payload.version !== 1 || payload.expiresAt < now || payload.issuedAt > now + 60) return null;
  if (payload.repositoryId !== repository.id || payload.orgSlug !== repository.orgSlug || payload.repoSlug !== repository.slug) return null;
  if (payload.operation !== operation) return null;
  return { authType: 'lfs-ssh-token', userId: payload.userId, keyKind: payload.keyKind, keyId: payload.keyId, repositoryPermission: operation === 'upload' ? 'write' : 'read' };
}

export function createLfsSshAuthentication(config, authorization) {
  const operation = authorization.command.operation;
  const token = createLfsAuthToken(config, {
    repositoryId: authorization.repository.id,
    orgSlug: authorization.repository.orgSlug,
    repoSlug: authorization.repository.slug,
    operation,
    userId: authorization.actor.userId ?? null,
    keyKind: authorization.actor.kind,
    keyId: authorization.actor.keyId,
  });
  return {
    href: `${config.baseUrl}/git/${authorization.repository.orgSlug}/${authorization.repository.slug}.git/info/lfs`,
    header: { Authorization: `Bearer ${token}` },
    expires_at: new Date(Date.now() + SIGNED_TOKEN_TTL_SECONDS * 1000).toISOString(),
    expires_in: SIGNED_TOKEN_TTL_SECONDS,
  };
}

function authenticateLfsRequest(db, config, req, repository, operation, { allowPublic = false } = {}) {
  const authorization = String(req.headers.authorization ?? '');
  if (authorization.startsWith('Bearer ')) {
    const signed = verifyLfsAuthToken(config, authorization.slice(7), repository, operation);
    if (signed) return signed;
  }
  const credential = parseBasicCredential(authorization);
  if (credential) {
    const authenticated = authorizeGitCredential(db, config, {
      credential,
      orgSlug: repository.orgSlug,
      repoSlug: repository.slug,
      isPush: operation === 'upload',
    });
    if (authenticated) return authenticated;
  }
  if (allowPublic && repository.visibility === 'public' && operation === 'download') {
    return { authType: 'public', userId: null, repositoryPermission: 'read' };
  }
  return null;
}

function requireLfsAuthentication(db, config, req, repository, operation, options) {
  const auth = authenticateLfsRequest(db, config, req, repository, operation, options);
  if (!auth) throw httpError(401, 'Git LFS authentication is required.', 'LFS_AUTH_REQUIRED');
  return auth;
}

function cleanupExpiredUploads(db) {
  const result = db.prepare("DELETE FROM lfs_pending_uploads WHERE datetime(expires_at) <= datetime('now')").run();
  return result.changes;
}

function objectRecord(db, oid) {
  return db.prepare(`
    SELECT oid, size, storage_path AS storagePath, created_at AS createdAt,
      last_accessed_at AS lastAccessedAt, last_verified_at AS lastVerifiedAt
    FROM lfs_objects WHERE oid = ?
  `).get(oid);
}

function associationExists(db, repositoryId, oid) {
  return Boolean(db.prepare('SELECT 1 AS found FROM repository_lfs_objects WHERE repository_id = ? AND oid = ?').get(repositoryId, oid));
}

function repositoryUsage(db, repositoryId) {
  return Number(db.prepare(`
    SELECT COALESCE(SUM(o.size), 0) AS bytes
    FROM repository_lfs_objects ro JOIN lfs_objects o ON o.oid = ro.oid
    WHERE ro.repository_id = ?
  `).get(repositoryId).bytes);
}

function instanceUsage(db) {
  return Number(db.prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM lfs_objects').get().bytes);
}

function pendingRepositoryUsage(db, repositoryId, excludedOid = '') {
  return Number(db.prepare(`
    SELECT COALESCE(SUM(expected_size), 0) AS bytes
    FROM lfs_pending_uploads p
    WHERE p.repository_id = ? AND p.oid <> ?
      AND datetime(p.expires_at) > datetime('now')
      AND NOT EXISTS (
        SELECT 1 FROM repository_lfs_objects ro
        WHERE ro.repository_id = p.repository_id AND ro.oid = p.oid
      )
  `).get(repositoryId, excludedOid).bytes);
}

function pendingInstanceUsage(db, excludedOid = '') {
  return Number(db.prepare(`
    SELECT COALESCE(SUM(expected_size), 0) AS bytes
    FROM (
      SELECT p.oid, MAX(p.expected_size) AS expected_size
      FROM lfs_pending_uploads p
      WHERE p.oid <> ? AND datetime(p.expires_at) > datetime('now')
        AND NOT EXISTS (SELECT 1 FROM lfs_objects o WHERE o.oid = p.oid)
      GROUP BY p.oid
    )
  `).get(excludedOid).bytes);
}

function checkQuota(db, config, repository, oid, size) {
  const existing = objectRecord(db, oid);
  if (existing && Number(existing.size) !== size) throw httpError(422, 'Git LFS object size conflicts with an existing object.', 'LFS_OBJECT_SIZE_CONFLICT');
  const associated = associationExists(db, repository.id, oid);
  const repositoryProjected = repositoryUsage(db, repository.id) + pendingRepositoryUsage(db, repository.id, oid) + (associated ? 0 : size);
  if (repositoryProjected > config.lfsRepositoryQuotaBytes) {
    throw httpError(413, 'Repository Git LFS quota would be exceeded.', 'LFS_REPOSITORY_QUOTA_EXCEEDED');
  }
  const instanceProjected = instanceUsage(db) + pendingInstanceUsage(db, oid) + (existing ? 0 : size);
  if (instanceProjected > config.lfsInstanceQuotaBytes) {
    throw httpError(413, 'KukGit instance Git LFS quota would be exceeded.', 'LFS_INSTANCE_QUOTA_EXCEEDED');
  }
  return { existing, associated, repositoryProjected, instanceProjected };
}

function attachObject(db, repositoryId, oid, userId) {
  db.prepare(`
    INSERT INTO repository_lfs_objects (repository_id, oid, attached_by)
    VALUES (?, ?, ?)
    ON CONFLICT(repository_id, oid) DO NOTHING
  `).run(repositoryId, oid, userId ?? null);
}

function lfsObjectHref(config, repository, oid) {
  return `${config.baseUrl}/git/${repository.orgSlug}/${repository.slug}.git/info/lfs/objects/${oid}`;
}

function batchError(oid, size, error) {
  const status = Number(error.status) || 422;
  return { oid, size, error: { code: status, message: error.message || 'Git LFS object could not be processed.' } };
}

function registerPendingUpload(db, config, repository, oid, size, userId) {
  const expiresAt = new Date(Date.now() + config.lfsUploadExpirySeconds * 1000).toISOString();
  db.prepare(`
    INSERT INTO lfs_pending_uploads
      (repository_id, oid, expected_size, user_id, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repository_id, oid) DO UPDATE SET
      expected_size = excluded.expected_size,
      user_id = excluded.user_id,
      expires_at = excluded.expires_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(repository.id, oid, size, userId ?? null, expiresAt);
}

function processBatchObject(db, config, repository, operation, auth, object) {
  const oid = normalizeOid(object.oid);
  const size = normalizeSize(object.size, config);
  const existing = objectRecord(db, oid);
  const associated = associationExists(db, repository.id, oid);
  if (operation === 'download') {
    if (!existing || !associated || !fs.existsSync(lfsObjectPath(config, oid))) {
      throw httpError(404, 'Git LFS object is not available for this repository.', 'LFS_OBJECT_NOT_FOUND');
    }
    return { oid, size: Number(existing.size), authenticated: auth.authType !== 'public', actions: { download: { href: lfsObjectHref(config, repository, oid) } } };
  }

  checkQuota(db, config, repository, oid, size);
  if (existing) {
    attachObject(db, repository.id, oid, auth.userId);
    db.prepare('DELETE FROM lfs_pending_uploads WHERE repository_id = ? AND oid = ?').run(repository.id, oid);
    return { oid, size, authenticated: true };
  }
  registerPendingUpload(db, config, repository, oid, size, auth.userId);
  const href = lfsObjectHref(config, repository, oid);
  return {
    oid,
    size,
    authenticated: true,
    actions: {
      upload: { href },
      verify: { href: `${href}/verify` },
    },
  };
}

async function handleBatch(req, res, { config, db, repository }) {
  const body = await readJson(req);
  const operation = String(body.operation ?? '').toLowerCase();
  if (!['upload', 'download'].includes(operation)) throw httpError(422, 'Git LFS batch operation must be upload or download.', 'LFS_OPERATION_INVALID');
  if (Array.isArray(body.transfers) && body.transfers.length && !body.transfers.includes('basic')) {
    throw httpError(406, 'KukGit supports the Git LFS basic transfer adapter.', 'LFS_TRANSFER_UNSUPPORTED');
  }
  if (!Array.isArray(body.objects) || body.objects.length > MAX_BATCH_OBJECTS) {
    throw httpError(422, `Git LFS batch must contain at most ${MAX_BATCH_OBJECTS} objects.`, 'LFS_OBJECTS_INVALID');
  }
  if (operation === 'upload' && repository.archivedAt) throw httpError(409, 'Archived repositories reject Git LFS uploads.', 'REPOSITORY_ARCHIVED');
  const auth = requireLfsAuthentication(db, config, req, repository, operation, { allowPublic: operation === 'download' });
  cleanupExpiredUploads(db);
  const objects = body.objects.map((object) => {
    try { return processBatchObject(db, config, repository, operation, auth, object || {}); }
    catch (error) {
      let oid = String(object?.oid ?? '');
      let size = Number(object?.size ?? 0);
      try { oid = normalizeOid(oid); } catch {}
      if (!Number.isFinite(size)) size = 0;
      return batchError(oid, size, error);
    }
  });
  return sendLfsJson(res, 200, { transfer: 'basic', objects });
}

async function hashAndStoreUpload(req, config, expectedSize, oid) {
  fs.mkdirSync(path.join(config.lfsDir, 'tmp'), { recursive: true, mode: 0o700 });
  const temporary = path.join(config.lfsDir, 'tmp', `${oid}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.upload`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > expectedSize || size > config.lfsMaxObjectBytes) throw httpError(422, 'Git LFS upload exceeds its declared size.', 'LFS_UPLOAD_TOO_LARGE');
      hash.update(chunk);
      fs.writeSync(fd, chunk);
    }
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  if (size !== expectedSize) {
    fs.rmSync(temporary, { force: true });
    throw httpError(422, 'Git LFS upload size does not match the batch declaration.', 'LFS_UPLOAD_SIZE_MISMATCH');
  }
  const actualOid = hash.digest('hex');
  if (actualOid !== oid) {
    fs.rmSync(temporary, { force: true });
    throw httpError(422, 'Git LFS upload SHA-256 does not match its OID.', 'LFS_UPLOAD_HASH_MISMATCH');
  }
  const destination = lfsObjectPath(config, oid);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (fs.existsSync(destination)) fs.rmSync(temporary, { force: true });
  else fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o600);
  return { destination, size, oid };
}

async function handleUpload(req, res, { config, db, repository, oid }) {
  if (repository.archivedAt) throw httpError(409, 'Archived repositories reject Git LFS uploads.', 'REPOSITORY_ARCHIVED');
  const auth = requireLfsAuthentication(db, config, req, repository, 'upload');
  cleanupExpiredUploads(db);
  const pending = db.prepare(`
    SELECT expected_size AS expectedSize FROM lfs_pending_uploads
    WHERE repository_id = ? AND oid = ? AND datetime(expires_at) > datetime('now')
  `).get(repository.id, oid);
  if (!pending) throw httpError(404, 'Git LFS upload was not registered or has expired.', 'LFS_UPLOAD_NOT_REGISTERED');
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined && Number(contentLength) !== Number(pending.expectedSize)) {
    throw httpError(422, 'Git LFS Content-Length does not match the batch declaration.', 'LFS_CONTENT_LENGTH_MISMATCH');
  }
  checkQuota(db, config, repository, oid, Number(pending.expectedSize));
  const stored = await hashAndStoreUpload(req, config, Number(pending.expectedSize), oid);
  db.exec('BEGIN IMMEDIATE');
  try {
    checkQuota(db, config, repository, oid, stored.size);
    db.prepare(`
      INSERT INTO lfs_objects (oid, size, storage_path, last_verified_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(oid) DO UPDATE SET
        last_verified_at = CURRENT_TIMESTAMP
    `).run(oid, stored.size, objectRelativePath(oid));
    attachObject(db, repository.id, oid, auth.userId);
    db.prepare('DELETE FROM lfs_pending_uploads WHERE repository_id = ? AND oid = ?').run(repository.id, oid);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    if (!objectRecord(db, oid)) fs.rmSync(stored.destination, { force: true });
    throw error;
  }
  audit(db, {
    organizationId: repository.organizationId,
    userId: auth.userId,
    action: 'lfs.object_uploaded',
    targetType: 'lfs_object',
    targetId: oid,
    metadata: { repository: repository.slug, size: stored.size, authType: auth.authType },
  });
  res.writeHead(200, { 'Content-Length': '0', 'Cache-Control': 'no-store' });
  res.end();
  return true;
}

async function verifyStoredObject(config, record) {
  const filePath = lfsObjectPath(config, record.oid);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return { valid: false, reason: 'missing' };
  const stat = fs.statSync(filePath);
  if (stat.size !== Number(record.size)) return { valid: false, reason: 'size' };
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  const actual = hash.digest('hex');
  return { valid: actual === record.oid, reason: actual === record.oid ? null : 'hash', actualOid: actual, size: stat.size };
}

async function handleVerify(req, res, { config, db, repository, oid }) {
  requireLfsAuthentication(db, config, req, repository, 'upload');
  const body = await readJson(req, 64 * 1024);
  if (normalizeOid(body.oid) !== oid) throw httpError(422, 'Git LFS verify OID does not match the request path.', 'LFS_VERIFY_OID_MISMATCH');
  const size = normalizeSize(body.size, config);
  const record = objectRecord(db, oid);
  if (!record || Number(record.size) !== size || !associationExists(db, repository.id, oid)) {
    throw httpError(404, 'Git LFS object is not attached to this repository.', 'LFS_OBJECT_NOT_FOUND');
  }
  const verification = await verifyStoredObject(config, record);
  if (!verification.valid) throw httpError(422, 'Stored Git LFS object failed integrity verification.', 'LFS_OBJECT_CORRUPT');
  db.prepare('UPDATE lfs_objects SET last_verified_at = CURRENT_TIMESTAMP WHERE oid = ?').run(oid);
  return sendLfsJson(res, 200, { oid, size, valid: true });
}

function parseRange(header, size) {
  if (!header) return null;
  const match = String(header).match(/^bytes=(\d*)-(\d*)$/);
  if (!match) throw httpError(416, 'Only a single byte range is supported.', 'LFS_RANGE_INVALID');
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw httpError(416, 'Git LFS suffix range is invalid.', 'LFS_RANGE_INVALID');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    throw httpError(416, 'Git LFS range is outside the object.', 'LFS_RANGE_NOT_SATISFIABLE');
  }
  end = Math.min(end, size - 1);
  return { start, end };
}

function handleDownload(req, res, { config, db, repository, oid }) {
  requireLfsAuthentication(db, config, req, repository, 'download', { allowPublic: true });
  const record = objectRecord(db, oid);
  if (!record || !associationExists(db, repository.id, oid)) throw httpError(404, 'Git LFS object is not available for this repository.', 'LFS_OBJECT_NOT_FOUND');
  const filePath = lfsObjectPath(config, oid);
  if (!fs.existsSync(filePath)) throw httpError(404, 'Git LFS object data is missing.', 'LFS_OBJECT_MISSING');
  const stat = fs.statSync(filePath);
  if (stat.size !== Number(record.size)) throw httpError(422, 'Git LFS object size is corrupt.', 'LFS_OBJECT_CORRUPT');
  const range = parseRange(req.headers.range, stat.size);
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  const length = stat.size === 0 ? 0 : end - start + 1;
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    'Cache-Control': repository.visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private, max-age=3600',
    ETag: `"${oid}"`,
    'X-Content-Type-Options': 'nosniff',
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(range ? 206 : 200, headers);
  db.prepare('UPDATE lfs_objects SET last_accessed_at = CURRENT_TIMESTAMP WHERE oid = ?').run(oid);
  if (req.method === 'HEAD' || stat.size === 0) return void res.end();
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function matchLfsPath(pathname) {
  const match = pathname.match(/^\/git\/([a-z0-9][a-z0-9-]{1,62})\/([a-z0-9][a-z0-9-]{1,62})\.git\/info\/lfs(?:\/(.*))?$/);
  if (!match) return null;
  return { orgSlug: match[1], repoSlug: match[2], suffix: match[3] || '' };
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

export function repositoryLfsStatus(db, config, repositoryId) {
  const usage = repositoryUsage(db, repositoryId);
  const objects = db.prepare(`
    SELECT o.oid, o.size, o.created_at AS createdAt, o.last_accessed_at AS lastAccessedAt,
      o.last_verified_at AS lastVerifiedAt, ro.attached_at AS attachedAt
    FROM repository_lfs_objects ro JOIN lfs_objects o ON o.oid = ro.oid
    WHERE ro.repository_id = ? ORDER BY ro.attached_at DESC LIMIT 250
  `).all(repositoryId).map((object) => ({
    ...object,
    available: fs.existsSync(lfsObjectPath(config, object.oid)),
  }));
  return {
    usageBytes: usage,
    quotaBytes: config.lfsRepositoryQuotaBytes,
    remainingBytes: Math.max(0, config.lfsRepositoryQuotaBytes - usage),
    objectCount: Number(db.prepare('SELECT COUNT(*) AS count FROM repository_lfs_objects WHERE repository_id = ?').get(repositoryId).count),
    objects,
  };
}

export function garbageCollectLfs(db, config) {
  const expiredUploads = cleanupExpiredUploads(db);
  const orphans = db.prepare(`
    SELECT o.oid, o.size FROM lfs_objects o
    LEFT JOIN repository_lfs_objects ro ON ro.oid = o.oid
    WHERE ro.oid IS NULL
    ORDER BY o.created_at LIMIT 10000
  `).all();
  let bytes = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const object of orphans) {
      fs.rmSync(lfsObjectPath(config, object.oid), { force: true });
      db.prepare('DELETE FROM lfs_objects WHERE oid = ?').run(object.oid);
      bytes += Number(object.size);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return { expiredUploads, objectsRemoved: orphans.length, bytesRemoved: bytes };
}

function requireInstanceAdmin(config, user) {
  if (String(user.email || '').toLowerCase() !== String(config.adminEmail || '').toLowerCase()) {
    throw httpError(403, 'KukGit instance administrator access is required.', 'INSTANCE_ADMIN_REQUIRED');
  }
}

export function createGitLfsHandler({ config, db }) {
  return async function handleGitLfs(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const lfsRoute = matchLfsPath(url.pathname);
    if (!lfsRoute && !url.pathname.startsWith('/api/lfs')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    try {
      if (lfsRoute) {
        const repository = findRepository(db, lfsRoute.orgSlug, lfsRoute.repoSlug);
        if (!repository) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
        if (lfsRoute.suffix === 'objects/batch' && req.method === 'POST') return await handleBatch(req, res, { config, db, repository });
        const objectMatch = lfsRoute.suffix.match(/^objects\/([0-9a-f]{64})(?:\/(verify))?$/);
        if (objectMatch) {
          const oid = normalizeOid(objectMatch[1]);
          if (objectMatch[2] === 'verify' && req.method === 'POST') return await handleVerify(req, res, { config, db, repository, oid });
          if (!objectMatch[2] && req.method === 'PUT') return await handleUpload(req, res, { config, db, repository, oid });
          if (!objectMatch[2] && ['GET', 'HEAD'].includes(req.method)) return handleDownload(req, res, { config, db, repository, oid });
        }
        throw httpError(404, 'Git LFS endpoint not found.', 'LFS_NOT_FOUND');
      }

      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);
      if (url.pathname === '/api/lfs/gc' && req.method === 'POST') {
        requireInstanceAdmin(config, user);
        const result = garbageCollectLfs(db, config);
        audit(db, { userId: user.id, action: 'lfs.garbage_collected', targetType: 'lfs', metadata: result });
        return sendJson(res, 200, { result, instanceUsageBytes: instanceUsage(db), instanceQuotaBytes: config.lfsInstanceQuotaBytes });
      }
      let params = routeMatch(url.pathname, '/api/lfs/:org/:repo');
      if (params && req.method === 'GET') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = findRepository(db, params.org, params.repo);
        return sendJson(res, 200, {
          repository,
          ...repositoryLfsStatus(db, config, access.repository.id),
          instanceUsageBytes: instanceUsage(db),
          instanceQuotaBytes: config.lfsInstanceQuotaBytes,
          maxObjectBytes: config.lfsMaxObjectBytes,
        });
      }
      params = routeMatch(url.pathname, '/api/lfs/:org/:repo/objects/:oid/verify');
      if (params && req.method === 'POST') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const oid = normalizeOid(params.oid);
        const record = objectRecord(db, oid);
        if (!record || !associationExists(db, access.repository.id, oid)) throw httpError(404, 'Git LFS object not found.', 'LFS_OBJECT_NOT_FOUND');
        const verification = await verifyStoredObject(config, record);
        if (verification.valid) db.prepare('UPDATE lfs_objects SET last_verified_at = CURRENT_TIMESTAMP WHERE oid = ?').run(oid);
        return sendJson(res, verification.valid ? 200 : 422, { oid, ...verification });
      }
      throw httpError(404, 'Git LFS API endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] Git LFS`, error);
      if (!res.headersSent) {
        const payload = { message: status >= 500 ? 'An unexpected Git LFS server error occurred.' : error.message, code: error.code || 'INTERNAL_ERROR', requestId };
        if (lfsRoute) sendLfsJson(res, status, payload, status === 401 ? { 'WWW-Authenticate': 'Basic realm="KukGit LFS"' } : {});
        else sendJson(res, status, { error: payload });
      } else res.end();
    }
    return true;
  };
}
