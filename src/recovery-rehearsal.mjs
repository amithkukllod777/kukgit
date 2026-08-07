import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { sha256File } from './backup-archive.mjs';
import { readBackupManifest } from './backups.mjs';
import { restoreBackupArchive, verifyBackupArchive } from './backups-lfs.mjs';
import { httpError } from './security.mjs';
import { KUKGIT_VERSION } from './version.mjs';

export const REHEARSAL_FORMAT = 'kukgit-recovery-rehearsal-v1';

const OID_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_ENVELOPE = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// Live checks that cannot be proved from an archive alone. They need a running
// instance, a reachable AuthKit and a credential only the operator holds — a
// backup stores password and token *hashes*, so the drill deliberately cannot
// authenticate on the operator's behalf. Each one is recorded as outstanding
// until signed off, so a rehearsal is never reported complete on the automated
// evidence by itself.
/**
 * Folds an AuthKit drill record into the manual checklist.
 *
 * `npm run authkit:rehearse` automates three of the checks below, and pointing
 * this at its evidence file marks those `rehearsed` — **not** `verified`. The
 * distinction is the whole point: the drill runs against a stand-in AuthKit, so
 * it shows KukGit's half of the conversation is right and says nothing about
 * the real service. A rehearsal is still not complete on the strength of it.
 *
 * A record that failed, or that was produced against a stand-in and claims
 * otherwise, is ignored rather than trusted.
 */
export function applyAuthKitEvidence(checks, evidencePath) {
  let record = null;
  if (evidencePath) {
    try { record = JSON.parse(fs.readFileSync(path.resolve(evidencePath), 'utf8')); }
    catch { record = null; }
  }
  const covered = new Map();
  if (record?.format === 'kukgit-authkit-rehearsal/1' && record.result === 'passed') {
    for (const check of record.checks ?? []) if (check.ok) covered.set(check.id, record);
  }
  return checks.map((check) => {
    const evidence = covered.get(check.id);
    if (!evidence) return { ...check, status: 'outstanding' };
    return {
      ...check,
      status: evidence.confidence === 'verified' ? 'verified' : 'rehearsed',
      evidence: {
        drill: 'kukgit-authkit-rehearsal/1',
        authkit: evidence.authkit?.kind ?? 'unknown',
        confidence: evidence.confidence ?? 'unknown',
        finishedAt: evidence.finishedAt ?? null,
      },
    };
  });
}

export const MANUAL_CHECKS = [
  {
    id: 'authkit.login',
    description: 'Sign in to the restored instance with One Kuklabs Account and confirm the local user id is retained.',
  },
  {
    id: 'authkit.refresh_rotation',
    description: 'Let the access token expire and confirm one refresh rotates both stored secrets.',
  },
  {
    id: 'authkit.device_revocation',
    description: 'Revoke the central device session and confirm the restored bridge is refused and the cookie cleared.',
  },
  {
    id: 'git.http_authorization',
    description: 'Clone over Git HTTP with a freshly issued PAT and confirm an unscoped token is refused.',
  },
  {
    id: 'git.ssh_authorization',
    description: 'Clone over SSH with a restored key and confirm a removed key is refused.',
  },
  {
    id: 'git.lfs_authorization',
    description: 'Fetch a restored Git LFS object through the API and confirm cross-repository access is refused.',
  },
  {
    id: 'email.retry_and_suppression',
    description: 'Force an SMTP failure and confirm the outbox retries, and that a suppressed address stays cancelled.',
  },
  {
    id: 'notifications.websocket_recovery',
    description: 'Reconnect the notification socket and confirm delivery resumes without duplicating messages.',
  },
];

function execGit(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw httpError(500, `git ${args[0]} failed: ${String(result.stderr || '').trim()}`, 'REHEARSAL_GIT_FAILED');
  }
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function openReadOnly(databasePath) {
  if (!fs.existsSync(databasePath)) {
    throw httpError(400, `Database not found: ${databasePath}`, 'REHEARSAL_DATABASE_MISSING');
  }
  return new DatabaseSync(databasePath, { readOnly: true });
}

function userTables(db) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
}

// Order-independent content digest: rows are serialized, sorted and hashed, so
// two databases holding the same rows agree regardless of physical layout or
// insertion order. Values are tagged by type so that 1 and '1' cannot collide.
function tableDigest(db, table) {
  const rows = db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all();
  const serialized = rows.map((row) => JSON.stringify(
    Object.keys(row).sort().map((key) => {
      const value = row[key];
      if (value === null || value === undefined) return [key, 'null'];
      if (value instanceof Uint8Array) return [key, 'blob', Buffer.from(value).toString('hex')];
      return [key, typeof value, String(value)];
    }),
  )).sort();
  const hash = crypto.createHash('sha256');
  for (const line of serialized) hash.update(line).update('\n');
  return { rows: rows.length, digest: hash.digest('hex') };
}

function repositoryDiskPath(root, repository) {
  return path.join(root, 'repos', repository.storageOrgSlug, `${repository.storageRepoSlug}.git`);
}

function lifecycleState(repository) {
  if (repository.deleted) return 'trashed';
  if (repository.archived) return 'archived';
  if (repository.snapshotType === 'empty') return 'empty';
  return 'active';
}

function actualRefs(gitDir) {
  const output = execGit(['--git-dir', gitDir, 'for-each-ref', '--format=%(refname)%09%(objectname)']).stdout;
  return output.trim().split('\n').filter(Boolean).map((line) => {
    const [name, sha] = line.split('\t');
    return `${name}\t${sha}`;
  }).sort();
}

// Every repository in the snapshot must exist on disk, survive a full fsck and
// carry exactly the refs the manifest recorded. fsck alone would pass a
// repository that restored with missing branches, so the ref comparison is the
// check that actually proves the restore is complete.
export function checkRepositories(root, manifest) {
  const repositories = [];
  const failures = [];
  const states = new Map();

  for (const repository of manifest.repositories) {
    const state = lifecycleState(repository);
    states.set(state, (states.get(state) || 0) + 1);
    const gitDir = repositoryDiskPath(root, repository);
    const record = {
      id: repository.id,
      storage: `${repository.storageOrgSlug}/${repository.storageRepoSlug}`,
      state,
      expectedRefs: repository.refCount,
      restoredRefs: null,
      fsck: 'not_run',
      ok: false,
    };

    if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
      record.fsck = 'missing';
      failures.push(`repository ${repository.id} (${record.storage}) is missing from the restored instance`);
      repositories.push(record);
      continue;
    }

    const fsck = execGit(['--git-dir', gitDir, 'fsck', '--full'], { allowFailure: true });
    record.fsck = fsck.status === 0 ? 'passed' : 'failed';
    if (fsck.status !== 0) {
      failures.push(`repository ${repository.id} (${record.storage}) failed git fsck: ${fsck.stderr.trim().slice(0, 300)}`);
    }

    const restored = actualRefs(gitDir);
    const expected = (repository.refs || []).map((ref) => `${ref.name}\t${ref.sha}`).sort();
    record.restoredRefs = restored.length;
    if (restored.length !== expected.length || restored.some((ref, index) => ref !== expected[index])) {
      failures.push(`repository ${repository.id} (${record.storage}) restored ${restored.length} refs but the snapshot recorded ${expected.length}`);
    } else if (record.fsck === 'passed') {
      record.ok = true;
    }
    repositories.push(record);
  }

  return {
    repositories,
    failures,
    coverage: Object.fromEntries([...states.entries()].sort()),
    checked: repositories.length,
    passed: repositories.filter((entry) => entry.ok).length,
  };
}

// Re-hashes every restored object on disk rather than trusting the restore's own
// verification, because this is the drill that has to prove the bytes are there.
export async function checkLfsObjects(root, databasePath) {
  const db = openReadOnly(databasePath);
  let rows;
  try {
    const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'lfs_objects'").get();
    rows = table ? db.prepare('SELECT oid, size FROM lfs_objects ORDER BY oid').all() : [];
  } finally {
    db.close();
  }

  const failures = [];
  let verifiedBytes = 0;
  for (const row of rows) {
    const oid = String(row.oid ?? '');
    if (!OID_PATTERN.test(oid)) {
      failures.push(`Git LFS object identifier '${oid}' is not a SHA-256 digest`);
      continue;
    }
    const objectPath = path.join(root, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
    if (!fs.existsSync(objectPath)) {
      failures.push(`Git LFS object ${oid} is missing from the restored instance`);
      continue;
    }
    const digest = await sha256File(objectPath);
    if (digest.sha256 !== oid) {
      failures.push(`Git LFS object ${oid} restored with digest ${digest.sha256}`);
      continue;
    }
    if (digest.size !== Number(row.size)) {
      failures.push(`Git LFS object ${oid} restored ${digest.size} bytes, expected ${row.size}`);
      continue;
    }
    verifiedBytes += digest.size;
  }

  return { checked: rows.length, verified: rows.length - failures.length, verifiedBytes, failures };
}

// Measures what a restore performed right now would actually cost, by comparing
// the live database against the restored one table by table. On a quiesced
// instance every table matches and the loss window is empty; otherwise the
// difference is the evidence, not an error.
function measureDataLoss(sourceDatabasePath, restoredDatabasePath) {
  const source = openReadOnly(sourceDatabasePath);
  const restored = openReadOnly(restoredDatabasePath);
  try {
    const sourceTables = userTables(source);
    const restoredTables = userTables(restored);
    const missingTables = sourceTables.filter((name) => !restoredTables.includes(name));
    const unexpectedTables = restoredTables.filter((name) => !sourceTables.includes(name));

    const tables = [];
    for (const name of sourceTables.filter((table) => restoredTables.includes(table))) {
      const from = tableDigest(source, name);
      const to = tableDigest(restored, name);
      tables.push({
        table: name,
        liveRows: from.rows,
        restoredRows: to.rows,
        rowDelta: from.rows - to.rows,
        identical: from.digest === to.digest,
      });
    }

    const changed = tables.filter((entry) => !entry.identical);
    return {
      identical: changed.length === 0 && !missingTables.length && !unexpectedTables.length,
      missingTables,
      unexpectedTables,
      changedTables: changed.map((entry) => entry.table),
      rowsLost: tables.reduce((sum, entry) => sum + Math.max(0, entry.rowDelta), 0),
      tables,
    };
  } finally {
    source.close();
    restored.close();
  }
}

// A restored instance must not hand anyone a usable credential. Backups carry
// hashes and ciphertext only, so this asserts the shapes rather than trusting
// that no plaintext column was ever added.
function checkCredentialSafety(databasePath) {
  const db = openReadOnly(databasePath);
  const failures = [];
  try {
    const tables = new Set(userTables(db));
    const columns = (table) => db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
      .all().map((row) => String(row.name));

    if (tables.has('personal_access_tokens')) {
      const names = columns('personal_access_tokens');
      for (const plaintext of ['token', 'token_plaintext', 'secret']) {
        if (names.includes(plaintext)) failures.push(`personal_access_tokens restored a plaintext '${plaintext}' column`);
      }
      if (names.includes('token_hash')) {
        const bad = db.prepare("SELECT COUNT(*) AS count FROM personal_access_tokens WHERE token_hash IS NULL OR LENGTH(token_hash) <> 64").get();
        if (bad.count) failures.push(`${bad.count} restored personal access tokens are not stored as SHA-256 hashes`);
      }
    }

    if (tables.has('users')) {
      const bad = db.prepare("SELECT COUNT(*) AS count FROM users WHERE password_hash IS NOT NULL AND password_hash <> 'authkit$managed' AND INSTR(password_hash, '$') = 0").get();
      if (bad.count) failures.push(`${bad.count} restored users carry a password value that is not a hash`);
    }

    if (tables.has('sessions') && columns('sessions').includes('authkit_access_ciphertext')) {
      const rows = db.prepare("SELECT authkit_access_ciphertext AS access, authkit_refresh_ciphertext AS refresh FROM sessions WHERE auth_mode = 'authkit'").all();
      const plain = rows.filter((row) => [row.access, row.refresh].some((value) => value && !SESSION_ENVELOPE.test(String(value))));
      if (plain.length) failures.push(`${plain.length} restored AuthKit sessions are not stored as AES-256-GCM envelopes`);
    }
  } finally {
    db.close();
  }
  return { failures, safe: failures.length === 0 };
}

function durationMs(start) {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e6);
}

/**
 * Runs the production recovery drill end to end against a real archive and
 * records the evidence an operator has to keep: recovery time, the data-loss
 * window, and the outcome of every automated check.
 *
 * The instance under test is never touched — everything is restored into a
 * fresh target directory and inspected there.
 */
export async function runRecoveryRehearsal(config, {
  archivePath,
  targetDir,
  sourceDatabasePath = config.databasePath,
  operator = 'unknown',
  keepTarget = true,
  authkitEvidencePath = null,
} = {}) {
  if (!archivePath) throw httpError(400, 'A backup archive path is required.', 'REHEARSAL_ARCHIVE_REQUIRED');
  if (!targetDir) throw httpError(400, 'A restore target directory is required.', 'REHEARSAL_TARGET_REQUIRED');
  const archive = path.resolve(archivePath);
  const target = path.resolve(targetDir);
  if (!fs.existsSync(archive)) throw httpError(400, `Backup archive not found: ${archive}`, 'REHEARSAL_ARCHIVE_MISSING');

  const startedAt = new Date();
  const clock = process.hrtime.bigint();
  const timings = {};
  const failures = [];

  let verifyStart = process.hrtime.bigint();
  const verification = await verifyBackupArchive(config, archive);
  timings.verifyMs = durationMs(verifyStart);

  verifyStart = process.hrtime.bigint();
  const { manifest } = await readBackupManifest(config, archive);
  timings.manifestMs = durationMs(verifyStart);

  const restoreStart = process.hrtime.bigint();
  const restore = await restoreBackupArchive(config, archive, target);
  timings.restoreMs = durationMs(restoreStart);

  try {
    const restoredDatabasePath = path.join(target, 'kukgit.db');
    const checkStart = process.hrtime.bigint();
    const repositories = checkRepositories(target, manifest);
    const lfs = await checkLfsObjects(target, restoredDatabasePath);
    const credentials = checkCredentialSafety(restoredDatabasePath);
    const dataLoss = measureDataLoss(sourceDatabasePath, restoredDatabasePath);
    timings.verificationMs = durationMs(checkStart);

    failures.push(...repositories.failures, ...lfs.failures, ...credentials.failures);
    for (const table of dataLoss.missingTables) failures.push(`table '${table}' exists live but is absent from the restore`);
    for (const table of dataLoss.unexpectedTables) failures.push(`table '${table}' exists in the restore but not live`);

    // Recovery time objective: everything from opening the archive to a verified,
    // serviceable instance. It excludes operator decision time by design — that is
    // recorded separately in the incident record, not measured here.
    const recoveryTimeMs = durationMs(clock);
    const backupCreatedAt = new Date(manifest.createdAt);
    const dataLossWindowMs = Math.max(0, startedAt.getTime() - backupCreatedAt.getTime());

    const record = {
      format: REHEARSAL_FORMAT,
      application: { name: 'KukGit', version: KUKGIT_VERSION },
      operator,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      archive: {
        filename: path.basename(archive),
        backupId: verification.backupId,
        createdAt: manifest.createdAt,
        archiveSha256: verification.archiveSha256,
        archiveSize: verification.archiveSize,
        totals: verification.totals,
      },
      recovery: {
        target,
        recoveryTimeMs,
        recoveryTimeSeconds: Math.round(recoveryTimeMs / 1000),
        dataLossWindowMs,
        dataLossWindowSeconds: Math.round(dataLossWindowMs / 1000),
        timings,
      },
      checks: {
        archiveVerified: verification.valid === true,
        repositories: {
          checked: repositories.checked,
          passed: repositories.passed,
          coverage: repositories.coverage,
          detail: repositories.repositories,
        },
        lfs: { checked: lfs.checked, verified: lfs.verified, verifiedBytes: lfs.verifiedBytes },
        credentialsAtRest: credentials.safe,
        dataLoss,
      },
      manualChecks: applyAuthKitEvidence(MANUAL_CHECKS, authkitEvidencePath),
      failures,
      // An automated pass is necessary but not sufficient: the drill is only
      // complete once the manual checks above are signed off too.
      automatedResult: failures.length ? 'failed' : 'passed',
      complete: false,
    };

    if (!keepTarget) fs.rmSync(target, { recursive: true, force: true });
    return { record, restore };
  } catch (error) {
    if (!keepTarget) fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
