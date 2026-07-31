import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVerifiedBackup } from '../src/backups-lfs.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, createDemoCommit } from '../src/git.mjs';
import { lfsObjectPath, migrateGitLfs } from '../src/git-lfs.mjs';
import { checkLfsObjects, checkRepositories, MANUAL_CHECKS, runRecoveryRehearsal } from '../src/recovery-rehearsal.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateRepositoryLifecycle } from '../src/repository-lifecycle.mjs';

// Builds an instance holding one repository of every lifecycle state the drill
// has to cover — active with history, empty, archived and trashed — plus a Git
// LFS object, so a rehearsal against it exercises every branch.
async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-rehearsal-test-'));
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
    lfsAuthKey: 'test-rehearsal-signing-key-long-enough',
  });
  for (const dir of [config.tempDir, config.backupsDir, config.lfsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateRepositoryLifecycle(db);
  migrateGitLfs(db);
  const { userId, orgId } = seedCore(db, config);

  const insert = db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, ?, ?, '', 'private', 'main', ?)
  `);

  const active = uid('repo');
  createBareRepository(config, 'kuklabs', 'active-repo');
  insert.run(active, orgId, 'active-repo', 'Active', userId);
  await createDemoCommit(config, 'kuklabs', 'active-repo');

  const empty = uid('repo');
  createBareRepository(config, 'kuklabs', 'empty-repo');
  insert.run(empty, orgId, 'empty-repo', 'Empty', userId);

  const archived = uid('repo');
  createBareRepository(config, 'kuklabs', 'archived-repo');
  insert.run(archived, orgId, 'archived-repo', 'Archived', userId);
  await createDemoCommit(config, 'kuklabs', 'archived-repo');
  db.prepare('UPDATE repositories SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(archived);

  // A trashed repository keeps its bytes under the slug it had when deleted.
  const trashed = uid('repo');
  createBareRepository(config, 'kuklabs', 'trashed-repo');
  insert.run(trashed, orgId, 'trashed-repo', 'Trashed', userId);
  await createDemoCommit(config, 'kuklabs', 'trashed-repo');
  db.prepare(`
    UPDATE repositories
    SET deleted_at = CURRENT_TIMESTAMP, deleted_from_org_id = ?, deleted_original_slug = 'trashed-repo'
    WHERE id = ?
  `).run(orgId, trashed);

  const content = Buffer.from('KukGit recovery rehearsal payload\n');
  const oid = crypto.createHash('sha256').update(content).digest('hex');
  const objectPath = lfsObjectPath(config, oid);
  fs.mkdirSync(path.dirname(objectPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(objectPath, content, { mode: 0o600 });
  db.prepare(`
    INSERT INTO lfs_objects (oid, size, storage_path, last_verified_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).run(oid, content.length, `objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`);
  db.prepare('INSERT INTO repository_lfs_objects (repository_id, oid, attached_by) VALUES (?, ?, ?)')
    .run(active, oid, userId);

  return { config, db, userId, orgId, oid, content, repositories: { active, empty, archived, trashed } };
}

function restoreTarget(t, context) {
  const target = path.join(context.config.dataDir, `rehearsal-${uid('t')}`);
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  return target;
}

test('a rehearsal restores every lifecycle state, verifies it and records recovery evidence', async (t) => {
  const context = await setup(t);
  const backup = await createVerifiedBackup(context.config, context.db);

  const { record } = await runRecoveryRehearsal(context.config, {
    archivePath: backup.path,
    targetDir: restoreTarget(t, context),
    operator: 'rehearsal-test',
  });

  assert.equal(record.automatedResult, 'passed');
  assert.deepEqual(record.failures, []);
  assert.equal(record.checks.archiveVerified, true);

  // Every lifecycle state the drill is required to cover was actually present.
  assert.deepEqual(record.checks.repositories.coverage, { active: 1, archived: 1, empty: 1, trashed: 1 });
  assert.equal(record.checks.repositories.checked, 4);
  assert.equal(record.checks.repositories.passed, 4);
  for (const repository of record.checks.repositories.detail) {
    assert.equal(repository.fsck, 'passed', `${repository.storage} must pass fsck`);
    assert.equal(repository.restoredRefs, repository.expectedRefs);
  }

  assert.equal(record.checks.lfs.checked, 1);
  assert.equal(record.checks.lfs.verified, 1);
  assert.equal(record.checks.lfs.verifiedBytes, context.content.length);
  assert.equal(record.checks.credentialsAtRest, true);

  // Nothing changed between the snapshot and the drill, so nothing would be lost.
  assert.equal(record.checks.dataLoss.identical, true);
  assert.equal(record.checks.dataLoss.rowsLost, 0);
  assert.deepEqual(record.checks.dataLoss.missingTables, []);

  assert.ok(record.recovery.recoveryTimeMs > 0, 'recovery time must be measured');
  assert.ok(record.recovery.timings.restoreMs >= 0);
  assert.equal(record.archive.backupId, backup.backupId);
  assert.equal(record.operator, 'rehearsal-test');

  // An automated pass is not a completed drill.
  assert.equal(record.complete, false);
  assert.equal(record.manualChecks.length, MANUAL_CHECKS.length);
  assert.ok(record.manualChecks.every((check) => check.status === 'outstanding'));
});

test('an archived repository is restored and reported under its own lifecycle state', async (t) => {
  const context = await setup(t);
  const backup = await createVerifiedBackup(context.config, context.db);
  const { record } = await runRecoveryRehearsal(context.config, {
    archivePath: backup.path,
    targetDir: restoreTarget(t, context),
  });

  // `archived` is reported for a live-but-archived repository; the trashed one
  // is classified by its deletion instead, and an empty repository by having no
  // refs at all. The manifest carries archived state per repository.
  const byStorage = new Map(record.checks.repositories.detail.map((entry) => [entry.storage, entry]));
  assert.equal(byStorage.get('kuklabs/archived-repo').state, 'archived');
  assert.equal(byStorage.get('kuklabs/archived-repo').ok, true);
  assert.equal(byStorage.get('kuklabs/trashed-repo').state, 'trashed');
  assert.equal(byStorage.get('kuklabs/empty-repo').state, 'empty');
  assert.equal(byStorage.get('kuklabs/empty-repo').expectedRefs, 0);
  assert.equal(byStorage.get('kuklabs/empty-repo').fsck, 'passed');
});

test('writes after the snapshot are reported as the data-loss window, not as a pass', async (t) => {
  const context = await setup(t);
  const backup = await createVerifiedBackup(context.config, context.db);

  // Work that lands after the backup is exactly what a restore would lose.
  context.db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'post-backup', 'Post Backup', '', 'private', 'main', ?)
  `).run(uid('repo'), context.orgId, context.userId);

  const { record } = await runRecoveryRehearsal(context.config, {
    archivePath: backup.path,
    targetDir: restoreTarget(t, context),
  });

  assert.equal(record.checks.dataLoss.identical, false);
  assert.ok(record.checks.dataLoss.changedTables.includes('repositories'));
  assert.equal(record.checks.dataLoss.rowsLost, 1);
  const repositories = record.checks.dataLoss.tables.find((entry) => entry.table === 'repositories');
  assert.equal(repositories.liveRows - repositories.restoredRows, 1);

  // Drift is evidence about the window, not a broken restore: the archive still
  // restored everything it contained.
  assert.equal(record.automatedResult, 'passed');
  assert.deepEqual(record.checks.dataLoss.missingTables, []);
});

test('a missing or damaged restored repository fails the drill instead of passing quietly', async (t) => {
  const context = await setup(t);
  const backup = await createVerifiedBackup(context.config, context.db);
  const target = restoreTarget(t, context);
  await runRecoveryRehearsal(context.config, { archivePath: backup.path, targetDir: target });

  const manifest = {
    repositories: [
      { id: 'repo_gone', storageOrgSlug: 'kuklabs', storageRepoSlug: 'not-restored', refCount: 1, refs: [{ name: 'refs/heads/main', sha: 'a'.repeat(40) }], snapshotType: 'bundle', archived: false, deleted: false },
    ],
  };
  const missing = checkRepositories(target, manifest);
  assert.equal(missing.passed, 0);
  assert.equal(missing.repositories[0].fsck, 'missing');
  assert.match(missing.failures[0], /is missing from the restored instance/);

  // A repository that restored with fewer refs than the snapshot recorded passes
  // fsck but is not a complete restore, so it must still fail.
  const truncated = {
    repositories: [{
      id: 'repo_truncated',
      storageOrgSlug: 'kuklabs',
      storageRepoSlug: 'active-repo',
      refCount: 99,
      refs: [
        { name: 'refs/heads/main', sha: 'b'.repeat(40) },
        { name: 'refs/heads/missing-branch', sha: 'c'.repeat(40) },
      ],
      snapshotType: 'bundle',
      archived: false,
      deleted: false,
    }],
  };
  const short = checkRepositories(target, truncated);
  assert.equal(short.passed, 0);
  assert.equal(short.repositories[0].fsck, 'passed', 'fsck alone would have accepted this');
  assert.match(short.failures[0], /refs but the snapshot recorded/);
});

test('a Git LFS object that did not survive the restore is reported by digest', async (t) => {
  const context = await setup(t);
  const backup = await createVerifiedBackup(context.config, context.db);
  const target = restoreTarget(t, context);
  await runRecoveryRehearsal(context.config, { archivePath: backup.path, targetDir: target });

  const databasePath = path.join(target, 'kukgit.db');
  const objectPath = path.join(target, 'lfs', 'objects', context.oid.slice(0, 2), context.oid.slice(2, 4), context.oid);

  // Silent corruption: right size, wrong bytes. Only re-hashing catches it.
  fs.writeFileSync(objectPath, Buffer.alloc(context.content.length, 0x41));
  const corrupted = await checkLfsObjects(target, databasePath);
  assert.equal(corrupted.checked, 1);
  assert.equal(corrupted.verified, 0);
  assert.match(corrupted.failures[0], /restored with digest/);

  fs.rmSync(objectPath);
  const absent = await checkLfsObjects(target, databasePath);
  assert.match(absent.failures[0], /is missing from the restored instance/);
});

test('the drill refuses a target that is not empty and never touches the live instance', async (t) => {
  const context = await setup(t);
  const backup = await createVerifiedBackup(context.config, context.db);
  const target = restoreTarget(t, context);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'occupied'), 'not empty');

  await assert.rejects(
    runRecoveryRehearsal(context.config, { archivePath: backup.path, targetDir: target }),
    (error) => error.code === 'RESTORE_TARGET_NOT_EMPTY',
  );

  await assert.rejects(
    runRecoveryRehearsal(context.config, { archivePath: path.join(context.config.backupsDir, 'absent.kgbak'), targetDir: restoreTarget(t, context) }),
    (error) => error.code === 'REHEARSAL_ARCHIVE_MISSING',
  );

  // The live repositories are still exactly where they were.
  assert.ok(fs.existsSync(path.join(context.config.repositoriesDir, 'kuklabs', 'active-repo.git')));
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count, 4);
});
