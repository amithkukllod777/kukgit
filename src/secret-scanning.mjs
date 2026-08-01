import crypto from 'node:crypto';
import { audit, uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';
import { requireUser } from './auth.mjs';
import { requireRepositoryAccess } from './repository-access.mjs';

export const SCAN_LIMITS = {
  // A file larger than this is almost certainly not hand-written source, and
  // scanning it costs more than the finding is worth. Recorded as skipped rather
  // than silently ignored, so "we scanned everything" is never claimed falsely.
  maxFileBytes: 1024 * 1024,
  maxFilesPerPush: 3000,
  maxLineLength: 4000,
  maxFindingsPerPush: 500,
};

/**
 * A detector describes one credential format.
 *
 * `verify` exists because a regular expression alone produces false positives,
 * and a scanner that cries wolf is one an author learns to ignore — at which
 * point it protects nobody. Where a format carries a checksum, the checksum is
 * what decides.
 */
const DETECTORS = [
  {
    id: 'aws-access-key-id',
    name: 'AWS access key ID',
    severity: 'high',
    pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/g,
  },
  {
    id: 'github-token',
    name: 'GitHub token',
    severity: 'critical',
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,255})\b/g,
    verify: (value) => githubChecksumValid(value),
  },
  {
    id: 'kukgit-personal-access-token',
    name: 'KukGit personal access token',
    severity: 'critical',
    // Our own format. A host that scans for everybody else's credentials and
    // not its own would be an odd thing to ship.
    pattern: /\b(kgp_[A-Za-z0-9]{32,})\b/g,
  },
  {
    id: 'kukgit-runner-token',
    name: 'KukGit runner registration token',
    severity: 'critical',
    pattern: /\b(kgr_[A-Za-z0-9]{32,})\b/g,
  },
  {
    id: 'slack-token',
    name: 'Slack token',
    severity: 'high',
    pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    id: 'stripe-secret-key',
    name: 'Stripe secret key',
    severity: 'critical',
    pattern: /\b(sk_(?:live|test)_[A-Za-z0-9]{24,})\b/g,
    // A test key is a real key in the sense that it is a credential, but it
    // cannot move money. Reported at a lower severity rather than not at all.
    severityFor: (value) => (value.startsWith('sk_test_') ? 'low' : 'critical'),
  },
  {
    id: 'google-api-key',
    name: 'Google API key',
    severity: 'high',
    // No trailing `\b`: the alphabet includes `-`, which is not a word
    // character, so a key ending in one would be missed.
    pattern: /\b(AIza[A-Za-z0-9_-]{35})/g,
  },
  {
    id: 'private-key',
    name: 'Private key material',
    severity: 'critical',
    pattern: /(-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----)/g,
  },
  {
    id: 'jwt',
    name: 'JSON Web Token',
    severity: 'medium',
    pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  },
  {
    id: 'postgres-connection-string',
    name: 'Database connection string with a password',
    severity: 'high',
    pattern: /\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+)/g,
  },
];

// GitHub tokens carry a CRC32 checksum in their last six characters, base62
// encoded. Checking it turns "looks like a token" into "is one", which is the
// difference between a scanner people keep on and one they switch off.
function githubChecksumValid(value) {
  const body = value.slice(value.indexOf('_') + 1);
  if (body.length < 7) return false;
  const payload = body.slice(0, -6);
  const checksum = body.slice(-6);
  const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let expected = crc32(payload);
  let encoded = '';
  for (let index = 0; index < 6; index += 1) {
    encoded = ALPHABET[expected % 62] + encoded;
    expected = Math.floor(expected / 62);
  }
  return encoded === checksum;
}

let crcTable = null;
function crc32(text) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xEDB88320 : value >>> 1;
      crcTable[index] = value;
    }
  }
  let crc = -1;
  for (let index = 0; index < text.length; index += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ text.charCodeAt(index)) & 0xFF];
  }
  return (crc ^ -1) >>> 0;
}

/**
 * A stable, non-reversible identifier for a secret.
 *
 * Findings are stored, listed over an API and shown in a UI, so the value itself
 * must never leave the scanner. A digest lets the same credential be recognised
 * across files and pushes — which is what makes "this is the one you already
 * rotated" answerable — without the database ever holding the credential.
 *
 * Truncated deliberately: a full digest of a short or low-entropy secret is
 * brute-forceable, and sixteen hex characters is far more than enough to
 * distinguish findings within one repository.
 */
export function fingerprint(value) {
  return crypto.createHash('sha256').update(`kukgit-secret-scan:${value}`).digest('hex').slice(0, 16);
}

/**
 * The part of a match that is safe to show.
 *
 * Enough to recognise which credential it is, never enough to use it. Short
 * matches are redacted entirely rather than partly, because showing four of
 * eight characters is showing half the secret.
 */
export function redact(value) {
  const text = String(value);
  if (text.length <= 12) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}${'*'.repeat(Math.min(20, text.length - 8))}${text.slice(-4)}`;
}

// Paths where a credential-shaped string is expected and harmless. Kept narrow:
// a scanner that skips too much is a scanner that misses the real one.
const IGNORED_PATH = /(^|\/)(node_modules|\.git|dist|build|vendor)\//;
const EXAMPLE_PATH = /(^|\/)([^/]*\.(?:example|sample|template)(?:\.[a-z]+)?|.*fixtures?\/.*|.*testdata\/.*)$/i;

export function detectorsFor({ include = null } = {}) {
  return include ? DETECTORS.filter((detector) => include.includes(detector.id)) : DETECTORS;
}

/**
 * Scans one blob of text and returns findings.
 *
 * Line and column are recorded so an author can be told where to look. The value
 * never appears in the result — only its fingerprint and a redaction.
 */
export function scanText(text, { path: filePath = '', detectors = DETECTORS } = {}) {
  const findings = [];
  const content = String(text ?? '');
  if (!content) return findings;

  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // A minified bundle is one enormous line; scanning it produces noise rather
    // than findings, and the file that matters is the source it was built from.
    if (line.length > SCAN_LIMITS.maxLineLength) continue;

    for (const detector of detectors) {
      detector.pattern.lastIndex = 0;
      let match;
      while ((match = detector.pattern.exec(line)) !== null) {
        const value = match[1] ?? match[0];
        if (detector.verify && !detector.verify(value)) continue;
        findings.push({
          detectorId: detector.id,
          detectorName: detector.name,
          severity: detector.severityFor ? detector.severityFor(value) : detector.severity,
          path: filePath,
          line: index + 1,
          column: match.index + 1,
          fingerprint: fingerprint(value),
          preview: redact(value),
          // An example file is still reported, because a credential committed to
          // one is still committed. It is marked so a policy can choose to warn
          // rather than block, which is a decision for the repository and not
          // for the scanner.
          likelyExample: EXAMPLE_PATH.test(filePath),
        });
      }
    }
  }
  return findings;
}

/**
 * Scans a set of files.
 *
 * Returns what was skipped as well as what was found. A scanner that quietly
 * drops a file it could not read lets somebody believe a clean result means a
 * clean push.
 */
export function scanFiles(files, { detectors = DETECTORS } = {}) {
  const findings = [];
  const skipped = [];
  let scanned = 0;

  for (const file of files.slice(0, SCAN_LIMITS.maxFilesPerPush)) {
    if (IGNORED_PATH.test(file.path)) { skipped.push({ path: file.path, reason: 'vendored' }); continue; }
    const size = file.content?.length ?? 0;
    if (size > SCAN_LIMITS.maxFileBytes) { skipped.push({ path: file.path, reason: 'too_large' }); continue; }
    // A binary file cannot contain a credential a person typed, and a NUL byte
    // is the cheapest reliable way to tell.
    if (String(file.content ?? '').includes('\u0000')) { skipped.push({ path: file.path, reason: 'binary' }); continue; }

    scanned += 1;
    findings.push(...scanText(file.content, { path: file.path, detectors }));
    if (findings.length >= SCAN_LIMITS.maxFindingsPerPush) {
      skipped.push({ path: file.path, reason: 'finding_limit_reached' });
      break;
    }
  }
  if (files.length > SCAN_LIMITS.maxFilesPerPush) {
    skipped.push({ path: null, reason: 'file_limit_reached', count: files.length - SCAN_LIMITS.maxFilesPerPush });
  }
  return { findings: findings.slice(0, SCAN_LIMITS.maxFindingsPerPush), skipped, scanned };
}

export function migrateSecretScanning(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS secret_scan_findings (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      detector_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      preview TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line INTEGER NOT NULL,
      commit_sha TEXT NOT NULL,
      ref TEXT NOT NULL,
      likely_example INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','revoked','false_positive','accepted')),
      resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TEXT,
      resolution_note TEXT,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repository_id, fingerprint, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_secret_findings_repository
      ON secret_scan_findings(repository_id, status, severity);
  `);
}

/**
 * Records findings, merging repeats of the same credential in the same file.
 *
 * A credential that appears in ten pushes is one problem, not ten. Merging on
 * fingerprint and path means the count an operator sees is the number of
 * credentials to rotate rather than the number of times somebody pushed.
 *
 * A finding already marked resolved stays resolved. Re-opening it on every push
 * would mean a repository whose history contains a rotated credential could
 * never be clean, and a list that can never be cleared is a list nobody reads.
 */
export function recordFindings(db, { repositoryId, ref, commitSha, findings }) {
  const insert = db.prepare(`
    INSERT INTO secret_scan_findings
      (id, repository_id, detector_id, severity, fingerprint, preview, file_path, line, commit_sha, ref, likely_example)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repository_id, fingerprint, file_path) DO UPDATE SET
      last_seen_at = CURRENT_TIMESTAMP,
      commit_sha = excluded.commit_sha,
      ref = excluded.ref,
      line = excluded.line
  `);
  const recorded = [];
  const write = db.transaction(() => {
    for (const finding of findings) {
      const id = uid('sec');
      insert.run(
        id, repositoryId, finding.detectorId, finding.severity, finding.fingerprint, finding.preview,
        finding.path, finding.line, commitSha, ref, finding.likelyExample ? 1 : 0,
      );
      recorded.push(finding.fingerprint);
    }
  });
  write();
  return { recorded: recorded.length };
}

export function listFindings(db, repositoryId, { status = 'open', limit = 200 } = {}) {
  const rows = status === 'all'
    ? db.prepare(`
        SELECT * FROM secret_scan_findings WHERE repository_id = ?
        ORDER BY last_seen_at DESC LIMIT ?
      `).all(repositoryId, limit)
    : db.prepare(`
        SELECT * FROM secret_scan_findings WHERE repository_id = ? AND status = ?
        ORDER BY last_seen_at DESC LIMIT ?
      `).all(repositoryId, status, limit);
  return rows.map((row) => ({
    id: row.id,
    detectorId: row.detector_id,
    severity: row.severity,
    fingerprint: row.fingerprint,
    // The preview is a redaction, and the value is nowhere in this table at all.
    preview: row.preview,
    path: row.file_path,
    line: row.line,
    commitSha: row.commit_sha,
    ref: row.ref,
    likelyExample: Boolean(row.likely_example),
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolutionNote: row.resolution_note,
  }));
}

export function resolveFinding(db, { repositoryId, findingId, status, userId, note = null }) {
  if (!['revoked', 'false_positive', 'accepted'].includes(status)) {
    throw new Error('A finding is resolved as revoked, false_positive or accepted.');
  }
  const result = db.prepare(`
    UPDATE secret_scan_findings
    SET status = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, resolution_note = ?
    WHERE repository_id = ? AND id = ?
  `).run(status, userId, note, repositoryId, findingId);
  return result.changes > 0;
}

export function findingSummary(db, repositoryId) {
  const rows = db.prepare(`
    SELECT severity, COUNT(*) AS count FROM secret_scan_findings
    WHERE repository_id = ? AND status = 'open' GROUP BY severity
  `).all(repositoryId);
  const bySeverity = Object.fromEntries(rows.map((row) => [row.severity, Number(row.count)]));
  return {
    open: rows.reduce((sum, row) => sum + Number(row.count), 0),
    bySeverity,
    // What a branch rule or a UI badge actually keys off. A medium-severity JWT
    // is worth showing; it is not worth stopping a release for.
    blocking: Number(bySeverity.critical ?? 0) + Number(bySeverity.high ?? 0),
  };
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

/**
 * The findings surface.
 *
 * Reading needs repository **write**, not read. A finding names a file and a
 * line where a credential is, which is a map to it for anyone who can also read
 * the repository — and a private repository's read list is usually wider than
 * the set of people who should be handed that map. Resolving one is an
 * administrative act on the repository's security posture, so it needs
 * **admin**.
 */
export function createSecretScanningApiHandler({ config, db }) {
  return async function secretScanningApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const match = /^\/api\/repos\/([^/]+)\/([^/]+)\/secret-scanning(?:\/findings\/([^/]+))?$/.exec(url.pathname);
    if (!match) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    const method = String(req.method || 'GET').toUpperCase();
    const [, orgSlug, repoSlug, findingId] = match;

    try {
      const user = requireUser(db, req);

      if (!findingId && method === 'GET') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug, repoSlug }, 'write');
        return sendJson(res, 200, {
          summary: findingSummary(db, access.repository.id),
          findings: listFindings(db, access.repository.id, {
            status: url.searchParams.get('status') || 'open',
          }),
        });
      }

      if (findingId && method === 'PATCH') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug, repoSlug }, 'admin');
        if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
        const body = await readJson(req);
        const status = String(body.status || '');
        if (!resolveFinding(db, {
          repositoryId: access.repository.id, findingId, status, userId: user.id, note: body.note ?? null,
        })) {
          throw httpError(404, 'Secret scanning finding not found.', 'SECRET_FINDING_NOT_FOUND');
        }
        audit(db, {
          userId: user.id,
          organizationId: access.repository.organizationId ?? null,
          action: 'secret_scanning.resolved',
          targetType: 'repository',
          targetId: access.repository.id,
          // The finding id and the outcome. Never the preview, and certainly
          // never anything derived from the value.
          metadata: { findingId, status },
        });
        return sendJson(res, 200, { findingId, status, requestId });
      }

      throw httpError(405, 'Method not allowed for this route.', 'METHOD_NOT_ALLOWED');
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'SECRET_SCANNING_FAILED',
          message: status >= 500 ? 'Secret scanning is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}

/**
 * Scans the content a push introduced.
 *
 * Only the new content, never the whole repository. Rescanning history on every
 * push is work proportional to the repository rather than to the change, and it
 * re-reports the same credentials the author has already been told about.
 *
 * A failure here never affects the push. The push has already been accepted and
 * acknowledged by the time this runs; turning a scanner problem into a rejected
 * push would make the scanner the least reliable part of pushing code.
 */
export function scanPushedContent(config, db, { repository, changes, spawnGit }) {
  const results = [];
  for (const change of changes) {
    if (change.type === 'tag' || !change.sha) continue;
    try {
      const paths = spawnGit(['diff', '--name-only', '--diff-filter=ACMR',
        change.previousSha && !/^0+$/.test(change.previousSha) ? `${change.previousSha}..${change.sha}` : change.sha]);
      const files = [];
      for (const filePath of paths.slice(0, SCAN_LIMITS.maxFilesPerPush)) {
        try { files.push({ path: filePath, content: spawnGit(['show', `${change.sha}:${filePath}`], { raw: true }) }); }
        catch { /* deleted between listing and reading, or unreadable */ }
      }
      const scan = scanFiles(files);
      if (scan.findings.length) {
        recordFindings(db, {
          repositoryId: repository.id, ref: change.ref, commitSha: change.sha, findings: scan.findings,
        });
      }
      results.push({ ref: change.ref, ...scan, findings: scan.findings.length });
    } catch (error) {
      console.error(`KukGit secret scanning ${repository.orgSlug}/${repository.repoSlug}`, error.message);
      results.push({ ref: change.ref, error: error.message });
    }
  }
  return results;
}
