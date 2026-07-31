import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.mjs';
import { hashPassword } from '../src/auth.mjs';
import { BACKUP_ARCHIVE_MAGIC, packPortableArchive, unpackPortableArchive, validateArchivePath } from '../src/backup-archive.mjs';
import {
  createBackupsApiHandler,
  createMaintenanceGuard,
  createVerifiedBackup,
  getMaintenanceState,
  listBackupSnapshots,
  pruneBackupSnapshots,
  restoreBackupArchive,
  setMaintenanceState,
  verifyBackupArchive,
} from '../src/backups.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, createDemoCommit, repoDiskPath } from '../src/git.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { archiveRepository, migrateRepositoryLifecycle, trashRepository } from '../src/repository-lifecycle.mjs';
import { migrateWebhooks } from '../src/webhooks.mjs';

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-backup-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    backupsDir: path.join(dataDir, 'backups'),
    maintenancePath: path.join(dataDir, 'maintenance.json'),
    backupLockPath: path.join(dataDir, 'backup.lock'),
    backupRetentionCount: 2,
    backupRetentionDays: 30,
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Repository Owner',
    webhookEncryptionKey: 'backup-test-webhook-key-with-enough-entropy',
  });
  fs.mkdirSync(config.repositoriesDir, { recursive: true });
  fs.mkdirSync(config.tempDir, { recursive: true });
  fs.mkdirSync(config.backupsDir, { recursive: true });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateWebhooks(db);
  migrateRepositoryLifecycle(db);
  const { userId: ownerId, orgId } = seedCore(db, config);
  const owner = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(ownerId);

  const repositories = [];
  for (const slug of ['active-repo', 'trashed-repo', 'empty-repo']) {
    const id = uid('repo');
    createBareRepository(config, 'kuklabs', slug);
    db.prepare(`
      INSERT INTO repositories
        (id, organization_id, slug, name, description, visibility, default_branch, created_by)
      VALUES (?, ?, ?, ?, '', 'private', 'main', ?)
    `).run(id, orgId, slug, slug, ownerId);
    if (slug !== 'empty-repo') await createDemoCommit(config, 'kuklabs', slug);
    repositories.push({ id, slug });
  }

  const trashedRow = () => db.prepare(`
    SELECT r.id, r.slug, r.name, r.description, r.visibility,
      r.default_branch AS defaultBranch, r.organization_id AS organizationId,
      r.archived_at AS archivedAt, o.slug AS orgSlug, o.name AS orgName
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE r.id = ? AND r.deleted_at IS NULL
  `).get(repositories[1].id);
  archiveRepository(db, trashedRow(), owner);
  trashRepository(db, trashedRow(), owner, 'kuklabs/trashed-repo');

  return { config, db, owner, ownerId, orgId, repositories, dataDir };
}

function frame(header, content = Buffer.alloc(0)) {
  const payload = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  return Buffer.concat([length, payload, content]);
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function login(origin, email, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('portable archive round-trips files and rejects unsafe paths', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-archive-format-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.txt');
  fs.writeFileSync(source, 'portable backup payload\n');
  const archive = path.join(root, 'snapshot.kgbak');
  const packed = await packPortableArchive([{ path: 'metadata/source.txt', sourcePath: source }], archive);
  assert.match(packed.archiveSha256, /^[0-9a-f]{64}$/);
  const extracted = path.join(root, 'extract');
  const unpacked = await unpackPortableArchive(archive, extracted);
  assert.equal(unpacked.entries.length, 1);
  assert.equal(fs.readFileSync(path.join(extracted, 'metadata', 'source.txt'), 'utf8'), 'portable backup payload\n');
  assert.throws(() => validateArchivePath('../outside.txt'), (error) => error.code === 'BACKUP_PATH_TRAVERSAL');

  const maliciousContent = Buffer.from('owned');
  const malicious = Buffer.concat([
    BACKUP_ARCHIVE_MAGIC,
    frame({ path: '../outside.txt', size: maliciousContent.length, sha256: crypto.createHash('sha256').update(maliciousContent).digest('hex') }, maliciousContent),
    frame({ end: true, entries: 1, totalBytes: maliciousContent.length }),
  ]);
  const maliciousArchive = path.join(root, 'malicious.kgbak');
  fs.writeFileSync(maliciousArchive, gzipSync(malicious));
  await assert.rejects(unpackPortableArchive(maliciousArchive, path.join(root, 'malicious-extract')), (error) => error.code === 'BACKUP_PATH_TRAVERSAL');
  assert.equal(fs.existsSync(path.join(root, 'outside.txt')), false);
});

test('creates, verifies and restores SQLite metadata plus active, trashed and empty repositories', async (t) => {
  const context = await setup(t);
  const backup = await createVerifiedBackup(context.config, context.db);
  assert.equal(backup.verification.valid, true);
  assert.equal(backup.totals.repositories, 3);
  assert.equal(backup.totals.trashedRepositories, 1);
  assert.ok(fs.existsSync(backup.path));
  assert.equal(listBackupSnapshots(context.config).length, 1);

  const verified = await verifyBackupArchive(context.config, backup.path);
  assert.equal(verified.backupId, backup.backupId);
  assert.ok(verified.verifiedRefs >= 2);

  const dryRunTarget = path.join(context.dataDir, 'dry-run-target');
  const dryRun = await restoreBackupArchive(context.config, backup.path, dryRunTarget, { dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(fs.existsSync(dryRunTarget), false);

  const target = path.join(context.dataDir, 'restored-data');
  const restored = await restoreBackupArchive(context.config, backup.path, target);
  assert.equal(restored.restored, true);
  assert.ok(fs.existsSync(path.join(target, 'kukgit.db')));
  assert.ok(fs.existsSync(path.join(target, 'repos', 'kuklabs', 'active-repo.git')));
  assert.ok(fs.existsSync(path.join(target, 'repos', 'kuklabs', 'trashed-repo.git')));
  assert.ok(fs.existsSync(path.join(target, 'repos', 'kuklabs', 'empty-repo.git')));

  const restoredDb = new DatabaseSync(path.join(target, 'kukgit.db'));
  try {
    assert.equal(restoredDb.prepare('SELECT COUNT(*) AS count FROM repositories').get().count, 3);
    assert.equal(restoredDb.prepare('SELECT COUNT(*) AS count FROM repositories WHERE deleted_at IS NOT NULL').get().count, 1);
  } finally {
    restoredDb.close();
  }
  for (const slug of ['active-repo', 'trashed-repo', 'empty-repo']) {
    const result = fs.existsSync(repoDiskPath({ repositoriesDir: path.join(target, 'repos') }, 'kuklabs', slug));
    assert.equal(result, true);
  }
  assert.ok(fs.existsSync(path.join(target, 'RESTORE.json')));
});

test('detects archive corruption and refuses non-empty restore targets without partial writes', async (t) => {
  const context = await setup(t);
  const backup = await createVerifiedBackup(context.config, context.db);
  const corrupt = path.join(context.config.backupsDir, 'corrupt-copy.kgbak');
  const bytes = fs.readFileSync(backup.path);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(corrupt, bytes);
  await assert.rejects(verifyBackupArchive(context.config, corrupt));

  const target = path.join(context.dataDir, 'occupied-target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'do not replace');
  await assert.rejects(restoreBackupArchive(context.config, backup.path, target), (error) => error.code === 'RESTORE_TARGET_NOT_EMPTY');
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'do not replace');
});

test('prunes only snapshots outside both minimum-count and age policy', async (t) => {
  const context = await setup(t);
  const records = [
    ['20260101T000000Z', '111111111111', '2026-01-01T00:00:00.000Z'],
    ['20260102T000000Z', '222222222222', '2026-01-02T00:00:00.000Z'],
    ['20260103T000000Z', '333333333333', new Date().toISOString()],
  ];
  for (const [stamp, id, createdAt] of records) {
    const filename = `kukgit-${stamp}-${id}.kgbak`;
    const archive = path.join(context.config.backupsDir, filename);
    fs.writeFileSync(archive, 'placeholder');
    fs.writeFileSync(`${archive}.json`, JSON.stringify({
      format: 'kukgit-backup-index-v1', filename, archiveSha256: 'a'.repeat(64), archiveSize: 11,
      createdAt, backupId: `${id}${id}`, totals: { repositories: 0, refs: 0 }, verifiedAt: createdAt,
    }));
  }
  const result = pruneBackupSnapshots(context.config, { keep: 1, days: 30 });
  assert.equal(result.removed.length, 2);
  assert.equal(result.remaining, 1);
});

test('maintenance mode allows reads and backup creation path but blocks writes and Git pushes', async (t) => {
  const context = await setup(t);
  const next = (_req, res) => { res.writeHead(204); res.end(); };
  const guard = createMaintenanceGuard({ config: context.config, next });
  const server = http.createServer(guard);
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  assert.equal(getMaintenanceState(context.config).enabled, false);
  setMaintenanceState(context.config, true, { reason: 'Restore rehearsal', actor: 'test' });
  assert.equal(getMaintenanceState(context.config).enabled, true);
  assert.equal((await fetch(`${origin}/api/dashboard`)).status, 204);
  assert.equal((await fetch(`${origin}/api/backups`, { method: 'POST' })).status, 204);
  const blocked = await fetch(`${origin}/api/repos/kuklabs/active-repo/issues`, { method: 'POST' });
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).error.code, 'MAINTENANCE_MODE');
  assert.equal((await fetch(`${origin}/git/kuklabs/active-repo.git/git-receive-pack`, { method: 'POST' })).status, 503);
  setMaintenanceState(context.config, false);
  assert.equal((await fetch(`${origin}/api/repos/kuklabs/active-repo/issues`, { method: 'POST' })).status, 204);
});

test('backup API is restricted to the configured instance administrator and blocks CSRF', async (t) => {
  const context = await setup(t);
  const viewerId = uid('usr');
  context.db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(viewerId, 'viewer@example.com', hashPassword('secure-viewer-password'), 'Viewer');
  context.db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'viewer')")
    .run(context.orgId, viewerId);
  const app = createApp({ config: context.config, db: context.db });
  const backupsApi = createBackupsApiHandler({ config: context.config, db: context.db });
  const server = http.createServer(async (req, res) => {
    if (await backupsApi(req, res)) return;
    return app(req, res);
  });
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');
  const viewerCookie = await login(origin, 'viewer@example.com', 'secure-viewer-password');

  assert.equal((await fetch(`${origin}/api/backups`, { headers: { Cookie: viewerCookie } })).status, 403);
  assert.equal((await fetch(`${origin}/api/backups`, { headers: { Cookie: ownerCookie } })).status, 200);
  const crossOrigin = await fetch(`${origin}/api/backups/prune`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie, Origin: 'https://attacker.example' },
    body: JSON.stringify({ keep: 1, days: 1 }),
  });
  assert.equal(crossOrigin.status, 403);
});
