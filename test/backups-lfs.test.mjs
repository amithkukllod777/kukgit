import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVerifiedBackup, restoreBackupArchive, verifyBackupArchive } from '../src/backups-lfs.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, createDemoCommit } from '../src/git.mjs';
import { lfsObjectPath, migrateGitLfs } from '../src/git-lfs.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateRepositoryLifecycle } from '../src/repository-lifecycle.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-lfs-backup-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    lfsDir: path.join(dataDir, 'lfs'),
    tempDir: path.join(dataDir, 'tmp'),
    backupsDir: path.join(dataDir, 'backups'),
    maintenancePath: path.join(dataDir, 'maintenance.json'),
    backupLockPath: path.join(dataDir, 'backup.lock'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Repository Owner',
    lfsAuthKey: 'test-lfs-backup-signing-key-long-enough',
  });
  fs.mkdirSync(config.tempDir, { recursive: true });
  fs.mkdirSync(config.backupsDir, { recursive: true });
  fs.mkdirSync(config.lfsDir, { recursive: true });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateRepositoryLifecycle(db);
  migrateGitLfs(db);
  const { userId, orgId } = seedCore(db, config);
  const repositoryId = uid('repo');
  createBareRepository(config, 'kuklabs', 'lfs-backup');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'lfs-backup', 'LFS Backup', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, userId);
  createDemoCommit(config, 'kuklabs', 'lfs-backup');
  return { config, db, userId, repositoryId };
}

function attachObject(context, content) {
  const oid = crypto.createHash('sha256').update(content).digest('hex');
  const destination = lfsObjectPath(context.config, oid);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, content, { mode: 0o600 });
  const storagePath = `objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;
  context.db.prepare(`
    INSERT INTO lfs_objects (oid, size, storage_path, last_verified_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).run(oid, content.length, storagePath);
  context.db.prepare(`
    INSERT INTO repository_lfs_objects (repository_id, oid, attached_by)
    VALUES (?, ?, ?)
  `).run(context.repositoryId, oid, context.userId);
  return { oid, destination };
}

test('verified backup archives and restores Git LFS objects with metadata', async (t) => {
  const context = setup(t);
  const content = Buffer.from('KukGit LFS disaster recovery payload\n');
  const object = attachObject(context, content);

  const backup = await createVerifiedBackup(context.config, context.db);
  assert.equal(backup.totals.lfsObjects, 1);
  assert.equal(backup.totals.lfsBytes, content.length);
  assert.ok(fs.existsSync(backup.path));

  const verification = await verifyBackupArchive(context.config, backup.path);
  assert.equal(verification.valid, true);
  assert.equal(verification.lfs.objectCount, 1);
  assert.equal(verification.lfs.totalBytes, content.length);

  const target = path.join(context.config.dataDir, 'restored-lfs-data');
  const restored = await restoreBackupArchive(context.config, backup.path, target);
  assert.equal(restored.restored, true);
  assert.equal(restored.lfs.objectCount, 1);
  const restoredPath = path.join(target, 'lfs', 'objects', object.oid.slice(0, 2), object.oid.slice(2, 4), object.oid);
  assert.equal(fs.readFileSync(restoredPath).equals(content), true);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(restoredPath)).digest('hex'), object.oid);

  const restoredDb = openDatabase({ ...context.config, dataDir: target, databasePath: path.join(target, 'kukgit.db') });
  try {
    const row = restoredDb.prepare('SELECT size, storage_path AS storagePath FROM lfs_objects WHERE oid = ?').get(object.oid);
    assert.equal(Number(row.size), content.length);
    assert.equal(row.storagePath.endsWith(object.oid), true);
  } finally {
    restoredDb.close();
  }
});

test('backup creation rejects missing or corrupt Git LFS object data', async (t) => {
  const context = setup(t);
  const content = Buffer.from('object that will be corrupted');
  const object = attachObject(context, content);
  fs.writeFileSync(object.destination, Buffer.from('different bytes'), { mode: 0o600 });

  await assert.rejects(
    createVerifiedBackup(context.config, context.db),
    (error) => ['BACKUP_LFS_SIZE_MISMATCH', 'BACKUP_LFS_HASH_MISMATCH'].includes(error.code),
  );
});
