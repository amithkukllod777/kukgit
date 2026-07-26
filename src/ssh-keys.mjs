import crypto from 'node:crypto';
import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { repoDiskPath } from './git.mjs';
import { permissionAtLeast, requireRepositoryAccess } from './repository-access.mjs';
import { httpError, originAllowed } from './security.mjs';

const MAX_BODY_BYTES = 96 * 1024;
const ALLOWED_KEY_TYPES = new Set([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
]);
const ECDSA_CURVES = Object.freeze({
  'ecdsa-sha2-nistp256': { curve: 'nistp256', pointBytes: 65 },
  'ecdsa-sha2-nistp384': { curve: 'nistp384', pointBytes: 97 },
  'ecdsa-sha2-nistp521': { curve: 'nistp521', pointBytes: 133 },
});

export function migrateSshKeys(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_ssh_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      key_type TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS repository_deploy_keys (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      key_type TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      can_write INTEGER NOT NULL DEFAULT 0 CHECK(can_write IN (0,1)),
      created_by TEXT NOT NULL REFERENCES users(id),
      last_used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_user_ssh_keys_user
      ON user_ssh_keys(user_id, revoked_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_ssh_keys_fingerprint
      ON user_ssh_keys(fingerprint, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_deploy_keys_repository
      ON repository_deploy_keys(repository_id, revoked_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deploy_keys_fingerprint
      ON repository_deploy_keys(fingerprint, revoked_at);
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'SSH_KEY_REQUEST_TOO_LARGE');
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

function readSshString(buffer, offset) {
  if (offset + 4 > buffer.length) throw httpError(400, 'SSH public key blob is truncated.', 'SSH_KEY_BLOB_INVALID');
  const length = buffer.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (length > 16384 || end > buffer.length) throw httpError(400, 'SSH public key blob is invalid.', 'SSH_KEY_BLOB_INVALID');
  return { value: buffer.subarray(start, end), offset: end };
}

function mpintBits(value) {
  let index = 0;
  while (index < value.length && value[index] === 0) index += 1;
  if (index === value.length) return 0;
  const first = value[index];
  return (value.length - index - 1) * 8 + (32 - Math.clz32(first));
}

function decodeBase64(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) {
    throw httpError(400, 'SSH public key base64 is invalid.', 'SSH_KEY_BASE64_INVALID');
  }
  const blob = Buffer.from(value, 'base64');
  if (blob.length < 16 || blob.length > 16384) throw httpError(400, 'SSH public key size is invalid.', 'SSH_KEY_SIZE_INVALID');
  const normalizedInput = value.replace(/=+$/, '');
  const normalizedOutput = blob.toString('base64').replace(/=+$/, '');
  if (normalizedInput !== normalizedOutput) throw httpError(400, 'SSH public key base64 is invalid.', 'SSH_KEY_BASE64_INVALID');
  return blob;
}

export function parseSshPublicKey(input) {
  const value = String(input ?? '').trim();
  if (!value || value.includes('\n') || value.includes('\r') || value.length > 20000) {
    throw httpError(400, 'Enter one valid SSH public key.', 'SSH_KEY_INVALID');
  }
  const parts = value.split(/\s+/);
  if (parts.length < 2) throw httpError(400, 'SSH public key must include a key type and base64 value.', 'SSH_KEY_INVALID');
  const [keyType, encoded] = parts;
  if (!ALLOWED_KEY_TYPES.has(keyType)) {
    throw httpError(400, 'Supported SSH key types are Ed25519, ECDSA and RSA.', 'SSH_KEY_TYPE_UNSUPPORTED');
  }
  const blob = decodeBase64(encoded);
  let cursor = readSshString(blob, 0);
  if (cursor.value.toString('utf8') !== keyType) throw httpError(400, 'SSH key type does not match its encoded blob.', 'SSH_KEY_TYPE_MISMATCH');

  if (keyType === 'ssh-ed25519') {
    cursor = readSshString(blob, cursor.offset);
    if (cursor.value.length !== 32 || cursor.offset !== blob.length) {
      throw httpError(400, 'Ed25519 public keys must contain exactly 32 key bytes.', 'SSH_ED25519_INVALID');
    }
  } else if (keyType.startsWith('ecdsa-')) {
    const expected = ECDSA_CURVES[keyType];
    const curve = readSshString(blob, cursor.offset);
    const point = readSshString(blob, curve.offset);
    if (curve.value.toString('utf8') !== expected.curve || point.value.length !== expected.pointBytes || point.value[0] !== 4 || point.offset !== blob.length) {
      throw httpError(400, 'ECDSA public key curve or point is invalid.', 'SSH_ECDSA_INVALID');
    }
  } else {
    const exponent = readSshString(blob, cursor.offset);
    const modulus = readSshString(blob, exponent.offset);
    if (exponent.value.length < 1 || modulus.offset !== blob.length || mpintBits(modulus.value) < 2048) {
      throw httpError(400, 'RSA SSH keys must use a modulus of at least 2048 bits.', 'SSH_RSA_TOO_SMALL');
    }
  }

  return {
    keyType,
    publicKey: `${keyType} ${encoded}`,
    fingerprint: `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
  };
}

function normalizeTitle(value) {
  const title = String(value ?? '').trim();
  if (!title || title.length > 100) throw httpError(400, 'Key title is required and must be 100 characters or fewer.', 'SSH_KEY_TITLE_INVALID');
  return title;
}

function assertFingerprintAvailable(db, fingerprint) {
  const userKey = db.prepare(`SELECT id FROM user_ssh_keys WHERE fingerprint = ? AND revoked_at IS NULL`).get(fingerprint);
  const deployKey = db.prepare(`SELECT id FROM repository_deploy_keys WHERE fingerprint = ? AND revoked_at IS NULL`).get(fingerprint);
  if (userKey || deployKey) throw httpError(409, 'This SSH public key is already registered.', 'SSH_KEY_DUPLICATE');
}

function keyDto(row) {
  return {
    id: row.id,
    title: row.title,
    keyType: row.keyType ?? row.key_type,
    publicKey: row.publicKey ?? row.public_key,
    fingerprint: row.fingerprint,
    lastUsedAt: row.lastUsedAt ?? row.last_used_at,
    revokedAt: row.revokedAt ?? row.revoked_at,
    createdAt: row.createdAt ?? row.created_at,
  };
}

function deployKeyDto(row) {
  return { ...keyDto(row), canWrite: Boolean(row.canWrite ?? row.can_write) };
}

export function createUserSshKey(db, userId, { title, publicKey }) {
  const parsed = parseSshPublicKey(publicKey);
  assertFingerprintAvailable(db, parsed.fingerprint);
  const id = uid('usk');
  db.prepare(`
    INSERT INTO user_ssh_keys (id, user_id, title, key_type, public_key, fingerprint)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, normalizeTitle(title), parsed.keyType, parsed.publicKey, parsed.fingerprint);
  return keyDto(db.prepare(`
    SELECT id, title, key_type AS keyType, public_key AS publicKey, fingerprint,
      last_used_at AS lastUsedAt, revoked_at AS revokedAt, created_at AS createdAt
    FROM user_ssh_keys WHERE id = ?
  `).get(id));
}

export function listUserSshKeys(db, userId) {
  return db.prepare(`
    SELECT id, title, key_type AS keyType, public_key AS publicKey, fingerprint,
      last_used_at AS lastUsedAt, revoked_at AS revokedAt, created_at AS createdAt
    FROM user_ssh_keys WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId).map(keyDto);
}

export function revokeUserSshKey(db, userId, keyId) {
  const result = db.prepare(`
    UPDATE user_ssh_keys SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
    WHERE id = ? AND user_id = ?
  `).run(keyId, userId);
  if (!result.changes) throw httpError(404, 'SSH key not found.', 'SSH_KEY_NOT_FOUND');
  return listUserSshKeys(db, userId).find((key) => key.id === keyId);
}

function activeRepository(db, orgSlug, repoSlug) {
  return db.prepare(`
    SELECT r.id, r.slug, r.name, r.organization_id AS organizationId,
      r.archived_at AS archivedAt, o.slug AS orgSlug, o.name AS orgName
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ? AND r.deleted_at IS NULL
  `).get(orgSlug, repoSlug);
}

export function createDeployKey(db, repositoryId, userId, { title, publicKey, canWrite = false }) {
  const parsed = parseSshPublicKey(publicKey);
  assertFingerprintAvailable(db, parsed.fingerprint);
  const id = uid('dpk');
  db.prepare(`
    INSERT INTO repository_deploy_keys
      (id, repository_id, title, key_type, public_key, fingerprint, can_write, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, repositoryId, normalizeTitle(title), parsed.keyType, parsed.publicKey, parsed.fingerprint, canWrite ? 1 : 0, userId);
  return deployKeyDto(db.prepare(`
    SELECT id, title, key_type AS keyType, public_key AS publicKey, fingerprint,
      can_write AS canWrite, last_used_at AS lastUsedAt,
      revoked_at AS revokedAt, created_at AS createdAt
    FROM repository_deploy_keys WHERE id = ?
  `).get(id));
}

export function listDeployKeys(db, repositoryId) {
  return db.prepare(`
    SELECT id, title, key_type AS keyType, public_key AS publicKey, fingerprint,
      can_write AS canWrite, last_used_at AS lastUsedAt,
      revoked_at AS revokedAt, created_at AS createdAt
    FROM repository_deploy_keys WHERE repository_id = ? ORDER BY created_at DESC
  `).all(repositoryId).map(deployKeyDto);
}

export function revokeDeployKey(db, repositoryId, keyId) {
  const result = db.prepare(`
    UPDATE repository_deploy_keys SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
    WHERE id = ? AND repository_id = ?
  `).run(keyId, repositoryId);
  if (!result.changes) throw httpError(404, 'Deploy key not found.', 'DEPLOY_KEY_NOT_FOUND');
  return listDeployKeys(db, repositoryId).find((key) => key.id === keyId);
}

export function sshCloneUrl(config, orgSlug, repoSlug) {
  const user = config.sshUser || 'git';
  const host = config.sshHost || new URL(config.baseUrl).hostname;
  const port = Number(config.sshPort || 22);
  return port === 22
    ? `${user}@${host}:${orgSlug}/${repoSlug}.git`
    : `ssh://${user}@${host}:${port}/${orgSlug}/${repoSlug}.git`;
}

function commandPath(config) {
  const node = String(config.nodeBinary || process.execPath).replaceAll('"', '\\"');
  const script = String(config.sshCommandScript || `${config.root}/scripts/ssh-command.mjs`).replaceAll('"', '\\"');
  return { node, script };
}

function forcedCommand(config, kind, id) {
  const { node, script } = commandPath(config);
  return `${node} ${script} --key-kind ${kind} --key-id ${id}`;
}

function authorizedLine(config, kind, row) {
  const restrictions = [
    'restrict',
    'no-port-forwarding',
    'no-agent-forwarding',
    'no-X11-forwarding',
    'no-pty',
    `command="${forcedCommand(config, kind, row.id)}"`,
  ].join(',');
  return `${restrictions} ${row.publicKey ?? row.public_key} kukgit:${row.id}`;
}

export function generateAuthorizedKeys(db, config) {
  const userKeys = db.prepare(`
    SELECT id, public_key AS publicKey FROM user_ssh_keys WHERE revoked_at IS NULL ORDER BY created_at
  `).all().map((row) => authorizedLine(config, 'user', row));
  const deployKeys = db.prepare(`
    SELECT id, public_key AS publicKey FROM repository_deploy_keys WHERE revoked_at IS NULL ORDER BY created_at
  `).all().map((row) => authorizedLine(config, 'deploy', row));
  return [...userKeys, ...deployKeys].join('\n') + (userKeys.length || deployKeys.length ? '\n' : '');
}

export function parseSshOriginalCommand(value) {
  const command = String(value ?? '').trim();
  const match = command.match(/^(git-upload-pack|git-receive-pack) '([a-z0-9][a-z0-9-]{1,62})\/([a-z0-9][a-z0-9-]{1,62})\.git'$/);
  if (!match) throw httpError(400, 'Only Git upload-pack and receive-pack SSH commands are allowed.', 'SSH_COMMAND_REJECTED');
  return {
    service: match[1],
    orgSlug: match[2],
    repoSlug: match[3],
    write: match[1] === 'git-receive-pack',
  };
}

export function authorizeSshCommand(db, config, { keyKind, keyId, originalCommand }) {
  if (!['user', 'deploy'].includes(keyKind) || !/^(usk|dpk)_[a-f0-9]{32}$/i.test(String(keyId ?? ''))) {
    throw httpError(403, 'SSH key identity is invalid.', 'SSH_KEY_IDENTITY_INVALID');
  }
  const command = parseSshOriginalCommand(originalCommand);
  const repository = activeRepository(db, command.orgSlug, command.repoSlug);
  if (!repository) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
  if (repository.archivedAt && command.write) throw httpError(409, 'Archived repositories reject SSH pushes.', 'REPOSITORY_ARCHIVED');

  let actor;
  if (keyKind === 'user') {
    const key = db.prepare(`
      SELECT k.id, k.user_id AS userId, u.email, u.display_name AS displayName
      FROM user_ssh_keys k JOIN users u ON u.id = k.user_id
      WHERE k.id = ? AND k.revoked_at IS NULL
    `).get(keyId);
    if (!key) throw httpError(403, 'SSH key is revoked or unknown.', 'SSH_KEY_UNAUTHORIZED');
    const access = requireRepositoryAccess(db, key.userId, { repositoryId: repository.id }, command.write ? 'write' : 'read');
    actor = { kind: 'user', keyId: key.id, userId: key.userId, email: key.email, displayName: key.displayName, permission: access.permission };
    db.prepare('UPDATE user_ssh_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(key.id);
  } else {
    const key = db.prepare(`
      SELECT id, repository_id AS repositoryId, title, can_write AS canWrite
      FROM repository_deploy_keys WHERE id = ? AND revoked_at IS NULL
    `).get(keyId);
    if (!key || key.repositoryId !== repository.id) throw httpError(403, 'Deploy key does not authorize this repository.', 'DEPLOY_KEY_REPOSITORY_MISMATCH');
    if (command.write && !key.canWrite) throw httpError(403, 'This deploy key is read-only.', 'DEPLOY_KEY_READ_ONLY');
    actor = { kind: 'deploy', keyId: key.id, title: key.title, canWrite: Boolean(key.canWrite) };
    db.prepare('UPDATE repository_deploy_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(key.id);
  }

  audit(db, {
    organizationId: repository.organizationId,
    userId: actor.userId ?? null,
    action: command.write ? 'git.ssh.push' : 'git.ssh.fetch',
    targetType: 'repository',
    targetId: repository.id,
    metadata: { repository: repository.slug, keyKind, keyId, service: command.service },
  });
  return {
    command,
    repository,
    actor,
    gitDirectory: repoDiskPath(config, repository.orgSlug, repository.slug),
  };
}

export function createSshKeysApiHandler({ config, db }) {
  return async function handleSshKeysApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/ssh-keys')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);

      if (pathname === '/api/ssh-keys' && req.method === 'GET') {
        return sendJson(res, 200, { keys: listUserSshKeys(db, user.id), supportedKeyTypes: [...ALLOWED_KEY_TYPES] });
      }
      if (pathname === '/api/ssh-keys' && req.method === 'POST') {
        const key = createUserSshKey(db, user.id, await readJson(req));
        audit(db, { userId: user.id, action: 'ssh_key.created', targetType: 'ssh_key', targetId: key.id, metadata: { title: key.title, fingerprint: key.fingerprint, keyType: key.keyType } });
        return sendJson(res, 201, { key });
      }

      let params = routeMatch(pathname, '/api/ssh-keys/:keyId');
      if (params && req.method === 'DELETE') {
        const key = revokeUserSshKey(db, user.id, params.keyId);
        audit(db, { userId: user.id, action: 'ssh_key.revoked', targetType: 'ssh_key', targetId: key.id, metadata: { title: key.title, fingerprint: key.fingerprint } });
        return sendJson(res, 200, { key });
      }

      params = routeMatch(pathname, '/api/ssh-keys/:org/:repo/deploy-keys');
      if (params && req.method === 'GET') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = activeRepository(db, params.org, params.repo);
        return sendJson(res, 200, {
          repository,
          keys: listDeployKeys(db, access.repository.id),
          sshCloneUrl: sshCloneUrl(config, params.org, params.repo),
          supportedKeyTypes: [...ALLOWED_KEY_TYPES],
        });
      }
      if (params && req.method === 'POST') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const key = createDeployKey(db, access.repository.id, user.id, await readJson(req));
        audit(db, { organizationId: access.repository.organizationId, userId: user.id, action: 'deploy_key.created', targetType: 'deploy_key', targetId: key.id, metadata: { repository: access.repository.slug, title: key.title, fingerprint: key.fingerprint, canWrite: key.canWrite } });
        return sendJson(res, 201, { key });
      }

      params = routeMatch(pathname, '/api/ssh-keys/:org/:repo/deploy-keys/:keyId');
      if (params && req.method === 'DELETE') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const key = revokeDeployKey(db, access.repository.id, params.keyId);
        audit(db, { organizationId: access.repository.organizationId, userId: user.id, action: 'deploy_key.revoked', targetType: 'deploy_key', targetId: key.id, metadata: { repository: access.repository.slug, title: key.title, fingerprint: key.fingerprint } });
        return sendJson(res, 200, { key });
      }

      throw httpError(404, 'SSH keys endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] SSH keys API`, error);
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
