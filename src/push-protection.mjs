import { audit, uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';
import { requireUser } from './auth.mjs';
import { requireRepositoryAccess } from './repository-access.mjs';

export const PUSH_PROTECTION_DEFAULTS = {
  // Off unless an administrator turns it on. A control that starts rejecting
  // pushes the moment it ships is one that gets switched off before anybody
  // reads what it does.
  enabled: false,
  // Critical and high. A medium-severity JWT is worth showing and not worth
  // stopping somebody's work for.
  blockSeverities: ['critical', 'high'],
  allowExampleFiles: true,
  bypassMinutes: 30,
};

const SEVERITIES = ['critical', 'high', 'medium', 'low'];

export function migratePushProtection(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS secret_push_protection (
      repository_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      block_severities TEXT NOT NULL DEFAULT 'critical,high',
      allow_example_files INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS secret_push_bypasses (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      reason TEXT NOT NULL,
      requested_by TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_secret_bypasses_lookup
      ON secret_push_bypasses(repository_id, fingerprint, expires_at);
  `);
}

export function getPushProtectionPolicy(db, repositoryId) {
  const row = db.prepare('SELECT * FROM secret_push_protection WHERE repository_id = ?').get(repositoryId);
  if (!row) return { ...PUSH_PROTECTION_DEFAULTS, repositoryId, configured: false };
  return {
    repositoryId,
    configured: true,
    enabled: Boolean(row.enabled),
    blockSeverities: String(row.block_severities).split(',').filter(Boolean),
    allowExampleFiles: Boolean(row.allow_example_files),
    bypassMinutes: PUSH_PROTECTION_DEFAULTS.bypassMinutes,
    updatedAt: row.updated_at,
  };
}

export function setPushProtectionPolicy(db, { repositoryId, userId, enabled, blockSeverities, allowExampleFiles }) {
  const severities = (Array.isArray(blockSeverities) ? blockSeverities : PUSH_PROTECTION_DEFAULTS.blockSeverities)
    .map((value) => String(value).toLowerCase());
  for (const severity of severities) {
    if (!SEVERITIES.includes(severity)) {
      throw httpError(400, `Unknown severity '${severity}'. Use ${SEVERITIES.join(', ')}.`, 'SEVERITY_INVALID');
    }
  }
  db.prepare(`
    INSERT INTO secret_push_protection (repository_id, enabled, block_severities, allow_example_files, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(repository_id) DO UPDATE SET
      enabled = excluded.enabled,
      block_severities = excluded.block_severities,
      allow_example_files = excluded.allow_example_files,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(repositoryId, enabled ? 1 : 0, severities.join(','), allowExampleFiles === false ? 0 : 1, userId);
  return getPushProtectionPolicy(db, repositoryId);
}

/**
 * Records permission to push one specific credential.
 *
 * Keyed by **fingerprint**, not by "the next push". A bypass that waved through
 * whatever came next would let an unrelated credential ride along with the one
 * somebody actually reviewed.
 *
 * It expires, because a standing bypass is the control being off. And it is a
 * row with a person, a time and a reason on it — a bypass that is not recorded
 * is a control that is not enforced.
 */
export function createBypass(db, { repositoryId, fingerprint, reason, userId, minutes = PUSH_PROTECTION_DEFAULTS.bypassMinutes }) {
  const trimmed = String(reason ?? '').trim();
  if (trimmed.length < 10) {
    // A reason nobody has to write is a reason nobody writes. Ten characters is
    // not a high bar; it is enough that "asdf" stands out in an audit review.
    throw httpError(400, 'A bypass needs a reason of at least 10 characters.', 'BYPASS_REASON_REQUIRED');
  }
  if (!/^[a-f0-9]{16}$/.test(String(fingerprint ?? ''))) {
    throw httpError(400, 'A bypass names the finding fingerprint it covers.', 'BYPASS_FINGERPRINT_INVALID');
  }
  const id = uid('byp');
  db.prepare(`
    INSERT INTO secret_push_bypasses (id, repository_id, fingerprint, reason, requested_by, expires_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', ?))
  `).run(id, repositoryId, fingerprint, trimmed, userId, `+${Math.max(1, Math.round(minutes))} minutes`);
  return { id, fingerprint, expiresInMinutes: minutes };
}

export function activeBypassFingerprints(db, repositoryId) {
  return new Set(db.prepare(`
    SELECT fingerprint FROM secret_push_bypasses
    WHERE repository_id = ? AND expires_at > datetime('now')
  `).all(repositoryId).map((row) => row.fingerprint));
}

export function markBypassesUsed(db, repositoryId, fingerprints) {
  if (!fingerprints.length) return 0;
  const placeholders = fingerprints.map(() => '?').join(', ');
  return db.prepare(`
    UPDATE secret_push_bypasses SET used_at = CURRENT_TIMESTAMP
    WHERE repository_id = ? AND used_at IS NULL AND fingerprint IN (${placeholders})
  `).run(repositoryId, ...fingerprints).changes;
}

/**
 * Decides whether a push may proceed.
 *
 * Pure: it takes findings and a policy and returns a decision, so the rule can
 * be tested without a repository, a hook or a network. The hook does the
 * scanning and the rejecting; this decides.
 */
export function evaluatePush({ findings, policy, bypassed = new Set() }) {
  if (!policy.enabled) return { allowed: true, reason: 'push protection is not enabled', blocked: [], bypassed: [] };

  const blocking = [];
  const waved = [];
  for (const finding of findings) {
    if (!policy.blockSeverities.includes(finding.severity)) continue;
    if (policy.allowExampleFiles && finding.likelyExample) continue;
    if (bypassed.has(finding.fingerprint)) { waved.push(finding); continue; }
    blocking.push(finding);
  }
  return {
    allowed: blocking.length === 0,
    reason: blocking.length ? 'the push introduces credentials' : 'no blocking findings',
    blocked: blocking,
    bypassed: waved,
  };
}

/**
 * The message a pusher sees in their terminal.
 *
 * It has to be actionable in the place it appears, because that is the only
 * place the author is looking. So: what was found, where, and the exact command
 * to get past it if the finding is wrong. A rejection that only says "blocked"
 * gets worked around with `--no-verify` or a disabled feature.
 *
 * The preview is redacted here as everywhere. A rejection message is written to
 * the pusher's terminal and quite often into a CI log.
 */
export function rejectionMessage(decision, { orgSlug, repoSlug, baseUrl }) {
  const lines = [
    'KukGit push protection: this push introduces credentials.',
    '',
  ];
  for (const finding of decision.blocked) {
    lines.push(`  ${finding.severity.padEnd(8)} ${finding.detectorName}`);
    lines.push(`           ${finding.path}:${finding.line}  ${finding.preview}`);
    lines.push(`           fingerprint ${finding.fingerprint}`);
  }
  lines.push('');
  lines.push('Remove the credential and rewrite the commit that introduced it, then');
  lines.push('rotate it at the provider — a credential that reached a push should be');
  lines.push('treated as exposed even if the push was refused.');
  lines.push('');
  lines.push('If this is not a credential, a repository administrator can allow it:');
  lines.push(`  POST ${baseUrl}/api/repos/${orgSlug}/${repoSlug}/push-protection/bypasses`);
  lines.push('  {"fingerprint": "…", "reason": "why this is not a credential"}');
  return lines.join('\n');
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
    if (size > 32 * 1024) throw httpError(413, 'Request body is too large.', 'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

export function createPushProtectionApiHandler({ config, db }) {
  return async function pushProtectionApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const match = /^\/api\/repos\/([^/]+)\/([^/]+)\/push-protection(\/bypasses)?$/.exec(url.pathname);
    if (!match) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    const method = String(req.method || 'GET').toUpperCase();
    const [, orgSlug, repoSlug, bypasses] = match;

    try {
      const user = requireUser(db, req);

      if (!bypasses && method === 'GET') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug, repoSlug }, 'write');
        return sendJson(res, 200, { policy: getPushProtectionPolicy(db, access.repository.id) });
      }

      if (!bypasses && method === 'PUT') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug, repoSlug }, 'admin');
        if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
        const body = await readJson(req);
        const policy = setPushProtectionPolicy(db, {
          repositoryId: access.repository.id,
          userId: user.id,
          enabled: body.enabled === true,
          blockSeverities: body.blockSeverities,
          allowExampleFiles: body.allowExampleFiles,
        });
        audit(db, {
          userId: user.id,
          organizationId: access.repository.organizationId ?? null,
          action: 'push_protection.policy_changed',
          targetType: 'repository',
          targetId: access.repository.id,
          metadata: { enabled: policy.enabled, blockSeverities: policy.blockSeverities, allowExampleFiles: policy.allowExampleFiles },
        });
        return sendJson(res, 200, { policy, requestId });
      }

      if (bypasses && method === 'POST') {
        // Admin, because a bypass lets a credential into the repository. The
        // person blocked is often not the person who should decide it is safe.
        const access = requireRepositoryAccess(db, user.id, { orgSlug, repoSlug }, 'admin');
        if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
        const body = await readJson(req);
        const bypass = createBypass(db, {
          repositoryId: access.repository.id,
          fingerprint: body.fingerprint,
          reason: body.reason,
          userId: user.id,
        });
        audit(db, {
          userId: user.id,
          organizationId: access.repository.organizationId ?? null,
          action: 'push_protection.bypass_granted',
          targetType: 'repository',
          targetId: access.repository.id,
          // The reason is the point of the record. The fingerprint identifies
          // which finding without naming the credential.
          metadata: { fingerprint: bypass.fingerprint, reason: String(body.reason).slice(0, 500), expiresInMinutes: bypass.expiresInMinutes },
        });
        return sendJson(res, 201, { ...bypass, requestId });
      }

      if (bypasses && method === 'GET') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug, repoSlug }, 'write');
        return sendJson(res, 200, {
          bypasses: db.prepare(`
            SELECT id, fingerprint, reason, requested_by AS requestedBy, expires_at AS expiresAt,
              used_at AS usedAt, created_at AS createdAt
            FROM secret_push_bypasses WHERE repository_id = ? ORDER BY created_at DESC LIMIT 100
          `).all(access.repository.id),
        });
      }

      throw httpError(405, 'Method not allowed for this route.', 'METHOD_NOT_ALLOWED');
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'PUSH_PROTECTION_FAILED',
          message: status >= 500 ? 'Push protection is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}
