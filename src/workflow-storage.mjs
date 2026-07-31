import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';
import { requireUser } from './auth.mjs';
import { requireRepositoryAccess } from './repository-access.mjs';
import { authorizeJobToken, getRun } from './workflow-runs.mjs';

export const STORAGE_LIMITS = {
  // Uploads are buffered in memory before they are hashed, so the per-object
  // ceiling is a memory budget, not a storage one. It is deliberately far below
  // the quota: a handful of concurrent uploads at this size is survivable, and
  // raising it means moving to a streaming hash first.
  maxArtifactBytes: 64 * 1024 * 1024,
  maxCacheBytes: 64 * 1024 * 1024,
  artifactQuotaBytes: 5 * 1024 * 1024 * 1024,
  cacheQuotaBytes: 5 * 1024 * 1024 * 1024,
  defaultRetentionDays: 30,
  maxRetentionDays: 90,
  maxNameLength: 200,
  maxKeyLength: 512,
  maxRestoreKeys: 10,
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
// Cache keys are opaque labels a workflow composes, often from a lockfile hash.
// Slashes and colons are ordinary in them; path separators are not, because the
// key never becomes a path — content is addressed by digest.
const CACHE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function migrateWorkflowStorage(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_blobs (
      digest TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS workflow_artifacts (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      job_id TEXT REFERENCES workflow_jobs(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      digest TEXT NOT NULL REFERENCES workflow_blobs(digest),
      size_bytes INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, name)
    );
    CREATE TABLE IF NOT EXISTS workflow_caches (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      ref TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      digest TEXT NOT NULL REFERENCES workflow_blobs(digest),
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      UNIQUE(repository_id, ref, cache_key)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_repository
      ON workflow_artifacts(repository_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_caches_lookup
      ON workflow_caches(repository_id, ref, cache_key);
  `);
}

function storageRoot(config) {
  return path.join(config.dataDir, 'ci');
}

export function blobPath(config, digest) {
  if (!DIGEST.test(String(digest ?? ''))) throw httpError(400, 'Invalid content digest.', 'STORAGE_DIGEST_INVALID');
  return path.join(storageRoot(config), 'blobs', digest.slice(0, 2), digest.slice(2, 4), digest);
}

/**
 * Stores content addressed by its SHA-256.
 *
 * Two runs that produce identical bytes share one file. That matters more for CI
 * than anywhere else: the same dependency cache is written by every branch, and
 * storing it once per branch would multiply the quota by the number of branches
 * rather than by the amount of distinct content.
 */
export function putBlob(db, config, buffer) {
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  const target = blobPath(config, digest);
  const existing = db.prepare('SELECT digest FROM workflow_blobs WHERE digest = ?').get(digest);
  if (existing && fs.existsSync(target)) return { digest, size: buffer.length, deduplicated: true };

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // Written to a temporary name and renamed, so a reader never sees a partial
  // file under a digest that promises complete content.
  const staging = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(staging, buffer, { mode: 0o600 });
  fs.renameSync(staging, target);
  db.prepare('INSERT OR IGNORE INTO workflow_blobs (digest, size_bytes) VALUES (?, ?)').run(digest, buffer.length);
  return { digest, size: buffer.length, deduplicated: false };
}

export function readBlob(config, digest) {
  const target = blobPath(config, digest);
  if (!fs.existsSync(target)) throw httpError(404, 'Stored content is no longer available.', 'STORAGE_BLOB_MISSING');
  return fs.readFileSync(target);
}

/**
 * Removes blobs nothing references any more.
 *
 * Deletion is by reference count rather than by age: a blob shared between a
 * live artifact and an expired one must survive, and content-addressed storage
 * makes that sharing invisible to whoever deleted the expired row.
 */
export function collectUnreferencedBlobs(db, config) {
  const orphans = db.prepare(`
    SELECT b.digest FROM workflow_blobs b
    WHERE NOT EXISTS (SELECT 1 FROM workflow_artifacts a WHERE a.digest = b.digest)
      AND NOT EXISTS (SELECT 1 FROM workflow_caches c WHERE c.digest = b.digest)
  `).all();
  let reclaimed = 0;
  for (const orphan of orphans) {
    const target = blobPath(config, orphan.digest);
    try {
      if (fs.existsSync(target)) { reclaimed += fs.statSync(target).size; fs.rmSync(target); }
    } catch {
      // A file that cannot be removed stays referenced by nothing and will be
      // retried on the next sweep; failing here would abort the whole pass.
      continue;
    }
    db.prepare('DELETE FROM workflow_blobs WHERE digest = ?').run(orphan.digest);
  }
  return { removed: orphans.length, reclaimedBytes: reclaimed };
}

function normalizeName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw httpError(400, 'An artifact name is required.', 'ARTIFACT_NAME_REQUIRED');
  if (name.length > STORAGE_LIMITS.maxNameLength) throw httpError(400, 'Artifact name is too long.', 'ARTIFACT_NAME_INVALID');
  if (!NAME.test(name)) throw httpError(400, 'An artifact name may contain letters, numbers, spaces, dots, underscores and hyphens.', 'ARTIFACT_NAME_INVALID');
  return name;
}

function repositoryUsage(db, table, repositoryId) {
  return Number(db.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM ${table} WHERE repository_id = ?`)
    .get(repositoryId).bytes);
}

/**
 * Stores a build artifact.
 *
 * An artifact name is written once per run. A job that could overwrite one could
 * replace evidence after the fact — the second upload is refused rather than
 * silently winning, so the record of what a run produced cannot be rewritten.
 */
export function putArtifact(db, config, { repositoryId, runId, jobId = null, name, content, retentionDays = null }) {
  const artifactName = normalizeName(name);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''));
  if (!buffer.length) throw httpError(400, 'An artifact must contain data.', 'ARTIFACT_EMPTY');
  if (buffer.length > STORAGE_LIMITS.maxArtifactBytes) {
    throw httpError(413, 'Artifact is too large.', 'ARTIFACT_TOO_LARGE');
  }

  const existing = db.prepare('SELECT id FROM workflow_artifacts WHERE run_id = ? AND name = ?').get(runId, artifactName);
  if (existing) throw httpError(409, `An artifact named '${artifactName}' already exists for this run.`, 'ARTIFACT_NAME_TAKEN');

  const used = repositoryUsage(db, 'workflow_artifacts', repositoryId);
  if (used + buffer.length > STORAGE_LIMITS.artifactQuotaBytes) {
    // Refused rather than silently evicting: an artifact is evidence somebody
    // may be about to download, and deleting one to make room for another would
    // lose it without anyone asking.
    throw httpError(507, 'The repository artifact quota is exhausted. Delete artifacts or wait for retention to expire.', 'ARTIFACT_QUOTA_EXCEEDED');
  }

  const days = Math.max(1, Math.min(Number(retentionDays) || STORAGE_LIMITS.defaultRetentionDays, STORAGE_LIMITS.maxRetentionDays));
  const blob = putBlob(db, config, buffer);
  const id = uid('art');
  db.prepare(`
    INSERT INTO workflow_artifacts (id, repository_id, run_id, job_id, name, digest, size_bytes, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
  `).run(id, repositoryId, runId, jobId, artifactName, blob.digest, buffer.length, `+${days} days`);

  return { id, name: artifactName, size: buffer.length, digest: blob.digest, retentionDays: days, deduplicated: blob.deduplicated };
}

export function listArtifacts(db, { repositoryId, runId = null }) {
  const rows = runId
    ? db.prepare(`
        SELECT id, run_id AS runId, job_id AS jobId, name, size_bytes AS sizeBytes,
          expires_at AS expiresAt, created_at AS createdAt
        FROM workflow_artifacts WHERE repository_id = ? AND run_id = ? ORDER BY name
      `).all(repositoryId, runId)
    : db.prepare(`
        SELECT id, run_id AS runId, job_id AS jobId, name, size_bytes AS sizeBytes,
          expires_at AS expiresAt, created_at AS createdAt
        FROM workflow_artifacts WHERE repository_id = ? ORDER BY created_at DESC LIMIT 200
      `).all(repositoryId);
  return rows;
}

export function readArtifact(db, config, { repositoryId, artifactId }) {
  const artifact = db.prepare(`
    SELECT id, name, digest, size_bytes AS sizeBytes, expires_at AS expiresAt
    FROM workflow_artifacts WHERE repository_id = ? AND id = ?
  `).get(repositoryId, artifactId);
  if (!artifact) throw httpError(404, 'Artifact not found.', 'ARTIFACT_NOT_FOUND');
  return { ...artifact, content: readBlob(config, artifact.digest) };
}

/**
 * Deletes artifacts past their retention.
 *
 * The blob sweep is separate and reference-counted, so expiring one artifact
 * never removes content another still points at.
 */
export function expireArtifacts(db, config) {
  const expired = db.prepare("DELETE FROM workflow_artifacts WHERE expires_at <= datetime('now')").run();
  const collected = collectUnreferencedBlobs(db, config);
  return { expired: expired.changes, ...collected };
}

function normalizeCacheKey(value, label = 'A cache key') {
  const key = String(value ?? '').trim();
  if (!key) throw httpError(400, `${label} is required.`, 'CACHE_KEY_REQUIRED');
  if (key.length > STORAGE_LIMITS.maxKeyLength) throw httpError(400, `${label} is too long.`, 'CACHE_KEY_INVALID');
  if (!CACHE_KEY.test(key)) throw httpError(400, `${label} may contain letters, numbers, dots, underscores, hyphens, colons and slashes.`, 'CACHE_KEY_INVALID');
  return key;
}

/**
 * Saves a cache entry for the ref that produced it.
 *
 * **A run may only write a cache for its own ref.** This is the control that
 * stops cache poisoning: without it, anyone who can open a pull request could
 * write a cache the default branch's build would later restore and execute. The
 * ref is taken from the run record, never from the request, so there is nothing
 * for a job to name incorrectly.
 */
export function saveCache(db, config, { repositoryId, ref, key, content }) {
  const cacheKey = normalizeCacheKey(key);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''));
  if (!buffer.length) throw httpError(400, 'A cache entry must contain data.', 'CACHE_EMPTY');
  if (buffer.length > STORAGE_LIMITS.maxCacheBytes) throw httpError(413, 'Cache entry is too large.', 'CACHE_TOO_LARGE');

  const existing = db.prepare('SELECT id FROM workflow_caches WHERE repository_id = ? AND ref = ? AND cache_key = ?')
    .get(repositoryId, ref, cacheKey);
  // An existing key is kept, not replaced. A cache key is supposed to describe
  // its own contents — a lockfile hash, a version — so a second write under the
  // same key means the key is wrong, and overwriting would hide that while
  // handing later runs something they did not ask for.
  if (existing) return { id: existing.id, key: cacheKey, stored: false, reason: 'a cache already exists for this key' };

  const blob = putBlob(db, config, buffer);
  const id = uid('cch');
  db.prepare(`
    INSERT INTO workflow_caches (id, repository_id, ref, cache_key, digest, size_bytes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, repositoryId, ref, cacheKey, blob.digest, buffer.length);

  evictCacheToQuota(db, config, repositoryId);
  return { id, key: cacheKey, size: buffer.length, stored: true, deduplicated: blob.deduplicated };
}

/**
 * Evicts least-recently-used cache entries until the repository is under quota.
 *
 * A cache may be evicted because losing one costs a slower build and nothing
 * else — unlike an artifact, which is evidence. Least-recently-*used* rather
 * than oldest: an old cache that every build still restores is the most valuable
 * one there is.
 */
export function evictCacheToQuota(db, config, repositoryId) {
  const evicted = [];
  let used = repositoryUsage(db, 'workflow_caches', repositoryId);
  while (used > STORAGE_LIMITS.cacheQuotaBytes) {
    const victim = db.prepare(`
      SELECT id, size_bytes AS sizeBytes FROM workflow_caches
      WHERE repository_id = ?
      ORDER BY COALESCE(last_used_at, created_at), rowid LIMIT 1
    `).get(repositoryId);
    if (!victim) break;
    db.prepare('DELETE FROM workflow_caches WHERE id = ?').run(victim.id);
    evicted.push(victim.id);
    used -= Number(victim.sizeBytes);
  }
  if (evicted.length) collectUnreferencedBlobs(db, config);
  return evicted;
}

/**
 * Restores a cache entry for a run.
 *
 * Lookup order: the exact key on this ref, then each restore key as a prefix on
 * this ref, then the same on the default branch.
 *
 * Reading the default branch is what makes a cache useful on a new branch, and
 * it is safe in the direction that matters: a branch may *read* the default
 * branch's cache but can never *write* it. The dangerous direction is the one
 * that is closed.
 */
export function restoreCache(db, config, { repositoryId, ref, key, restoreKeys = [], defaultRef = null }) {
  const exact = normalizeCacheKey(key);
  const prefixes = (Array.isArray(restoreKeys) ? restoreKeys : [restoreKeys])
    .filter(Boolean)
    .slice(0, STORAGE_LIMITS.maxRestoreKeys)
    .map((value) => normalizeCacheKey(value, 'A restore key'));

  const refs = defaultRef && defaultRef !== ref ? [ref, defaultRef] : [ref];
  for (const candidateRef of refs) {
    const hit = db.prepare('SELECT id, cache_key AS cacheKey, digest, size_bytes AS sizeBytes FROM workflow_caches WHERE repository_id = ? AND ref = ? AND cache_key = ?')
      .get(repositoryId, candidateRef, exact);
    if (hit) return completeRestore(db, config, hit, candidateRef, true);

    for (const prefix of prefixes) {
      // The newest match wins: a restore key names a family, and the most recent
      // member of that family is the closest thing to what was asked for.
      //
      // `rowid` breaks the tie. Timestamps here have one-second granularity, so
      // two caches saved in the same second would otherwise order arbitrarily
      // and "newest" would mean whichever the planner happened to return.
      const partial = db.prepare(`
        SELECT id, cache_key AS cacheKey, digest, size_bytes AS sizeBytes FROM workflow_caches
        WHERE repository_id = ? AND ref = ? AND cache_key LIKE ? ESCAPE '\\'
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(repositoryId, candidateRef, `${prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
      if (partial) return completeRestore(db, config, partial, candidateRef, false);
    }
  }
  return null;
}

function completeRestore(db, config, row, ref, exact) {
  db.prepare("UPDATE workflow_caches SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
  let content;
  try { content = readBlob(config, row.digest); }
  catch {
    // The row outlived its bytes. Removing it turns a broken restore into a
    // clean miss, which a build already knows how to handle.
    db.prepare('DELETE FROM workflow_caches WHERE id = ?').run(row.id);
    return null;
  }
  return { id: row.id, key: row.cacheKey, ref, exact, size: Number(row.sizeBytes), content };
}

/**
 * Deletes one artifact.
 *
 * The artifact quota refuses rather than evicting, so somebody has to be able to
 * free the space deliberately. This is that lever, and it is a repository write
 * because it destroys evidence a run produced.
 */
export function deleteArtifact(db, config, { repositoryId, artifactId }) {
  const removed = db.prepare('DELETE FROM workflow_artifacts WHERE repository_id = ? AND id = ?')
    .run(repositoryId, artifactId);
  if (!removed.changes) throw httpError(404, 'Artifact not found.', 'ARTIFACT_NOT_FOUND');
  collectUnreferencedBlobs(db, config);
  return { id: artifactId, deleted: true };
}

export function storageUsage(db, repositoryId) {
  return {
    artifacts: {
      bytes: repositoryUsage(db, 'workflow_artifacts', repositoryId),
      quotaBytes: STORAGE_LIMITS.artifactQuotaBytes,
      count: db.prepare('SELECT COUNT(*) AS count FROM workflow_artifacts WHERE repository_id = ?').get(repositoryId).count,
    },
    caches: {
      bytes: repositoryUsage(db, 'workflow_caches', repositoryId),
      quotaBytes: STORAGE_LIMITS.cacheQuotaBytes,
      count: db.prepare('SELECT COUNT(*) AS count FROM workflow_caches WHERE repository_id = ?').get(repositoryId).count,
    },
  };
}

/**
 * Periodically expires artifacts and reclaims unreferenced content.
 *
 * Hourly: retention is measured in days, so a sweep that runs more often only
 * adds load to the instance the runners are already reporting to.
 */
export function startStorageRetentionWorker(db, config, { intervalMs = 3600_000 } = {}) {
  const tick = () => {
    try { expireArtifacts(db, config); }
    catch (error) { console.error('KukGit storage retention worker', error.message); }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
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

function sendBytes(res, status, buffer, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(buffer);
  return true;
}

async function readBody(req, limit, code) {
  // The declared length is checked before a single byte is read, so an oversized
  // upload is refused rather than streamed into memory and then rejected.
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw httpError(413, 'Upload is too large.', code);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // Re-checked while reading: `Content-Length` is a claim by the client, and a
    // chunked upload does not declare one at all.
    if (size > limit) throw httpError(413, 'Upload is too large.', code);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) throw httpError(401, 'A job credential is required.', 'JOB_TOKEN_REQUIRED');
  return header.slice(7).trim();
}

function defaultRefFor(db, repositoryId) {
  const branch = db.prepare('SELECT default_branch AS defaultBranch FROM repositories WHERE id = ?')
    .get(repositoryId)?.defaultBranch;
  return branch ? `refs/heads/${branch}` : null;
}

/**
 * Artifact and cache HTTP surface.
 *
 * Two credentials reach it and they are not interchangeable. A job token writes,
 * and it can only ever write for its own run and its own ref — there is no
 * parameter naming a repository, a run or a ref, so there is nothing for a job to
 * name incorrectly. A user session reads, and only through a repository it has
 * permission on.
 *
 * Registered ahead of the workflow logs handler, which claims the same two path
 * prefixes and answers unknown routes under them with a 404.
 */
export function createWorkflowStorageApiHandler({ config, db }) {
  function authorizeRunAccess(req, params, permission) {
    const user = requireUser(db, req);
    const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, permission);
    const run = getRun(db, params.runId);
    // A run is addressed through its repository and must actually belong to it,
    // or a caller with access to one repository could read another's artifacts
    // by naming its own path with a foreign run id.
    if (run.repositoryId !== access.repository.id) {
      throw httpError(404, 'Workflow run not found.', 'WORKFLOW_RUN_NOT_FOUND');
    }
    return { user, access, run };
  }

  return async function workflowStorageApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const storageRoute = url.pathname.startsWith('/api/workflow-jobs/self/artifacts')
      || url.pathname.startsWith('/api/workflow-jobs/self/cache')
      || /^\/api\/workflow-runs\/[^/]+\/[^/]+\/[^/]+\/artifacts/.test(url.pathname)
      || /^\/api\/repositories\/[^/]+\/[^/]+\/ci-storage$/.test(url.pathname);
    if (!storageRoute) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    const method = String(req.method || 'GET').toUpperCase();

    try {
      let params = routeMatch(url.pathname, '/api/workflow-jobs/self/artifacts');
      if (params && method === 'POST') {
        const job = authorizeJobToken(db, bearerToken(req));
        const content = await readBody(req, STORAGE_LIMITS.maxArtifactBytes, 'ARTIFACT_TOO_LARGE');
        const stored = putArtifact(db, config, {
          repositoryId: job.repositoryId,
          runId: job.runId,
          jobId: job.jobId,
          name: req.headers['x-artifact-name'],
          retentionDays: req.headers['x-artifact-retention-days'] ?? null,
          content,
        });
        return sendJson(res, 201, { ...stored, requestId });
      }

      params = routeMatch(url.pathname, '/api/workflow-jobs/self/cache');
      if (params && method === 'POST') {
        const job = authorizeJobToken(db, bearerToken(req));
        // A fork pull request may not write a cache at all. Its ref is a branch
        // name in somebody else's repository, and two forks can choose the same
        // one — so a fork write would let one contributor hand another's build
        // content it never produced. Reading stays open; that direction is safe.
        if (job.fork) {
          throw httpError(403, 'A fork pull request may restore caches but may not save them.', 'CACHE_FORK_WRITE_DENIED');
        }
        const content = await readBody(req, STORAGE_LIMITS.maxCacheBytes, 'CACHE_TOO_LARGE');
        const saved = saveCache(db, config, {
          repositoryId: job.repositoryId,
          ref: job.ref,
          key: req.headers['x-cache-key'],
          content,
        });
        return sendJson(res, saved.stored ? 201 : 200, { ...saved, requestId });
      }

      if (params && method === 'GET') {
        const job = authorizeJobToken(db, bearerToken(req));
        const hit = restoreCache(db, config, {
          repositoryId: job.repositoryId,
          ref: job.ref,
          key: url.searchParams.get('key'),
          restoreKeys: url.searchParams.getAll('restoreKey'),
          defaultRef: defaultRefFor(db, job.repositoryId),
        });
        if (!hit) return sendJson(res, 404, { error: { code: 'CACHE_MISS', message: 'No cache matched.', requestId } });
        return sendBytes(res, 200, hit.content, {
          'X-Cache-Key': hit.key,
          'X-Cache-Ref': hit.ref,
          'X-Cache-Exact': String(hit.exact),
        });
      }

      params = routeMatch(url.pathname, '/api/workflow-runs/:org/:repo/:runId/artifacts');
      if (params && method === 'GET') {
        const { run, access } = authorizeRunAccess(req, params, 'read');
        return sendJson(res, 200, {
          artifacts: listArtifacts(db, { repositoryId: access.repository.id, runId: run.id }),
          limits: { maxArtifactBytes: STORAGE_LIMITS.maxArtifactBytes, maxRetentionDays: STORAGE_LIMITS.maxRetentionDays },
        });
      }

      params = routeMatch(url.pathname, '/api/workflow-runs/:org/:repo/:runId/artifacts/:artifactId');
      if (params && method === 'GET') {
        const { access } = authorizeRunAccess(req, params, 'read');
        const artifact = readArtifact(db, config, { repositoryId: access.repository.id, artifactId: params.artifactId });
        return sendBytes(res, 200, artifact.content, {
          // The name charset excludes quotes and control characters, so it cannot
          // break out of the quoted filename or inject a second header.
          'Content-Disposition': `attachment; filename="${artifact.name}"`,
        });
      }

      if (params && method === 'DELETE') {
        const { access } = authorizeRunAccess(req, params, 'write');
        if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
        return sendJson(res, 200, {
          ...deleteArtifact(db, config, { repositoryId: access.repository.id, artifactId: params.artifactId }),
          requestId,
        });
      }

      params = routeMatch(url.pathname, '/api/repositories/:org/:repo/ci-storage');
      if (params && method === 'GET') {
        const user = requireUser(db, req);
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'read');
        return sendJson(res, 200, storageUsage(db, access.repository.id));
      }

      throw httpError(404, 'Unknown workflow storage route.', 'WORKFLOW_STORAGE_ROUTE_NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'WORKFLOW_STORAGE_REQUEST_FAILED',
          message: status >= 500 ? 'Workflow storage is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}
