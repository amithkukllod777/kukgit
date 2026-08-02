import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, createDemoCommit, listBranches } from '../src/git.mjs';
import { lfsObjectPath } from '../src/git-lfs.mjs';
import { putSecret } from '../src/secrets-vault.mjs';
import { createTenantExport } from '../src/tenant-export.mjs';
import { importTenantArchive, planTenantImport } from '../src/tenant-import.mjs';
import { executeTenantDeletion, requestTenantDeletion, tenantRowCensus } from '../src/tenant-lifecycle.mjs';

async function migrateEverything(db) {
  const dir = new URL('../src/', import.meta.url);
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.mjs')).sort();
  const deferred = [];
  for (const file of files) {
    let module;
    try { module = await import(new URL(file, dir).href); } catch { continue; }
    for (const [name, value] of Object.entries(module)) {
      if (!/^migrate[A-Z]/.test(name) || typeof value !== 'function' || value.length !== 1) continue;
      try { value(db); } catch { deferred.push(value); }
    }
  }
  for (const migrate of deferred) {
    try { migrate(db); } catch { /* genuinely not applicable to this database */ }
  }
}

/**
 * A whole instance, so an import can be tested the way it is used: an archive
 * made on one and loaded into another. Testing an import against the database it
 * was exported from would hide every assumption about identifiers that only
 * exist on the source.
 */
async function instance(t, name) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `kukgit-${name}-`));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    backupsDir: path.join(dataDir, 'backups'),
    lfsDir: path.join(dataDir, 'lfs'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
    secretsEncryptionKey: `kukgit-${name}-test-key-long-enough-here`,
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  await migrateEverything(db);
  const { userId } = seedCore(db, config);
  fs.mkdirSync(config.tempDir, { recursive: true });
  return { config, db, userId };
}

async function tenant(context, slug) {
  const id = uid('org');
  context.db.prepare('INSERT INTO organizations (id, slug, name, created_by) VALUES (?, ?, ?, ?)')
    .run(id, slug, slug, context.userId);
  context.db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'owner')")
    .run(id, context.userId);
  const repositoryId = uid('repo');
  context.db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', 'the app', 'private', 'main', ?)
  `).run(repositoryId, id, context.userId);
  createBareRepository(context.config, slug, 'app');
  await createDemoCommit(context.config, slug, 'app');
  return { id, slug, repositoryId };
}

test('a tenant exported from one instance loads into another', async (t) => {
  const source = await instance(t, 'source');
  const target = await instance(t, 'target');
  const org = await tenant(source, 'acme');

  const content = Buffer.from('an LFS payload that has to survive the move\n');
  const oid = crypto.createHash('sha256').update(content).digest('hex');
  fs.mkdirSync(path.dirname(lfsObjectPath(source.config, oid)), { recursive: true });
  fs.writeFileSync(lfsObjectPath(source.config, oid), content);
  source.db.prepare('INSERT INTO lfs_objects (oid, size, storage_path) VALUES (?, ?, ?)')
    .run(oid, content.length, `objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`);
  source.db.prepare('INSERT INTO repository_lfs_objects (repository_id, oid) VALUES (?, ?)')
    .run(org.repositoryId, oid);

  const exported = await createTenantExport(source.config, source.db, { slug: 'acme', userId: source.userId });
  const report = await importTenantArchive(target.config, target.db, {
    archivePath: exported.archivePath, userId: target.userId,
  });

  assert.equal(report.complete, true);
  assert.equal(report.organization.slug, 'acme');
  assert.equal(report.loaded.repositories, 1);
  assert.equal(report.lfsObjects, 1);

  // The repository is a repository on the target, not a file sitting in a
  // directory. Reading its branches goes through the same code the web UI uses.
  const branches = listBranches(target.config, 'acme', 'app');
  assert.equal(branches.length, 1);
  assert.equal(branches[0].name, 'main');
  assert.deepEqual(fs.readFileSync(lfsObjectPath(target.config, oid)), content);

  // A cloned bare repository points `origin` at the bundle it came from, which
  // is in a temporary directory that no longer exists.
  const remotes = spawnSync('git', ['--git-dir', path.join(target.config.repositoriesDir, 'acme', 'app.git'), 'remote'], { encoding: 'utf8' });
  assert.equal(remotes.stdout.trim(), '');
});

test('the member who owned the tenant is re-linked by email, not by id', async (t) => {
  const source = await instance(t, 'source');
  const target = await instance(t, 'target');
  await tenant(source, 'acme');

  // Same person, different account row — which is what happens on any two
  // instances. An import that kept the id would point at nobody.
  assert.notEqual(source.userId, target.userId);

  const exported = await createTenantExport(source.config, source.db, { slug: 'acme', userId: source.userId });
  const report = await importTenantArchive(target.config, target.db, { archivePath: exported.archivePath });

  assert.deepEqual(report.unresolvedMembers, []);
  const member = target.db.prepare('SELECT user_id AS userId, role FROM org_members WHERE organization_id = ?').get(report.organization.id);
  assert.equal(member.userId, target.userId);
  assert.equal(member.role, 'owner');
});

test('a member with no account here is reported, never invented', async (t) => {
  const source = await instance(t, 'source');
  const target = await instance(t, 'target');
  const org = await tenant(source, 'acme');
  const strangerId = uid('usr');
  source.db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(strangerId, 'stranger@example.com', 'x', 'Stranger');
  source.db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'developer')")
    .run(org.id, strangerId);

  const exported = await createTenantExport(source.config, source.db, { slug: 'acme', userId: source.userId });
  const plan = await planTenantImport(target.config, target.db, { archivePath: exported.archivePath });
  assert.deepEqual(plan.unresolvedMembers, ['stranger@example.com']);

  const report = await importTenantArchive(target.config, target.db, { archivePath: exported.archivePath });
  assert.deepEqual(report.unresolvedMembers, ['stranger@example.com']);
  assert.equal(report.droppedRows.org_members, 1);
  assert.ok(report.warnings.some((warning) => warning.includes('stranger@example.com')));
  // Dropped, not pointed at somebody else. An access list that invents a member
  // is worse than one that is short.
  assert.equal(target.db.prepare('SELECT COUNT(*) AS count FROM org_members WHERE organization_id = ?').get(report.organization.id).count, 1);
});

test('a withheld credential is not loaded as if it worked', async (t) => {
  const source = await instance(t, 'source');
  const target = await instance(t, 'target');
  const org = await tenant(source, 'acme');
  putSecret(source.db, source.config, {
    scope: 'organization', scopeId: org.id, name: 'DEPLOY', value: 'a-real-value', userId: source.userId,
  });

  const exported = await createTenantExport(source.config, source.db, { slug: 'acme', userId: source.userId });
  const plan = await planTenantImport(target.config, target.db, { archivePath: exported.archivePath });
  assert.equal(plan.tables.find((table) => table.table === 'secrets').withheld, 1);

  const report = await importTenantArchive(target.config, target.db, { archivePath: exported.archivePath });
  // A secret whose ciphertext is a sentinel would decrypt to nothing and sit in
  // the interface looking real. An absent one is honest.
  assert.equal(report.withheldRows.secrets, 1);
  assert.equal(target.db.prepare('SELECT COUNT(*) AS count FROM secrets').get().count, 0);
  assert.ok(report.warnings.some((warning) => warning.includes('must be recreated')));
});

test('an import refuses to write over a tenant that is already here', async (t) => {
  const source = await instance(t, 'source');
  const target = await instance(t, 'target');
  await tenant(source, 'acme');
  await tenant(target, 'acme');

  const exported = await createTenantExport(source.config, source.db, { slug: 'acme', userId: source.userId });
  const plan = await planTenantImport(target.config, target.db, { archivePath: exported.archivePath });
  assert.ok(plan.conflicts.length);
  await assert.rejects(
    () => importTenantArchive(target.config, target.db, { archivePath: exported.archivePath }),
    /already exists/,
  );

  // Under another slug there is nothing to collide with: the identifier is the
  // tenant's own and was generated on the source, so two instances that both
  // have an `acme` can still hold each other's.
  const report = await importTenantArchive(target.config, target.db, {
    archivePath: exported.archivePath, slug: 'acme-restored',
  });
  assert.equal(report.organization.slug, 'acme-restored');
  assert.deepEqual(
    target.db.prepare('SELECT slug FROM organizations ORDER BY slug').all().map((row) => row.slug),
    // `kukgit-trash` is the instance's own holding organization, created by the
    // repository lifecycle migration, not something either import touched.
    ['acme', 'acme-restored', 'kukgit-trash', 'kuklabs'],
  );
  assert.equal(target.db.prepare('SELECT slug FROM repositories WHERE organization_id = ?').get(report.organization.id).slug, 'app');
});

test('a plan writes nothing', async (t) => {
  const source = await instance(t, 'source');
  const target = await instance(t, 'target');
  await tenant(source, 'acme');
  const exported = await createTenantExport(source.config, source.db, { slug: 'acme', userId: source.userId });

  const before = target.db.prepare('SELECT COUNT(*) AS count FROM organizations').get().count;
  const plan = await planTenantImport(target.config, target.db, { archivePath: exported.archivePath });
  assert.ok(plan.tables.length > 0);
  assert.equal(target.db.prepare('SELECT COUNT(*) AS count FROM organizations').get().count, before);
  assert.equal(fs.existsSync(path.join(target.config.repositoriesDir, 'acme')), false);
});

test('an unverified archive is refused before anything is written', async (t) => {
  const source = await instance(t, 'source');
  const target = await instance(t, 'target');
  await tenant(source, 'acme');
  const exported = await createTenantExport(source.config, source.db, { slug: 'acme', userId: source.userId });

  const bytes = fs.readFileSync(exported.archivePath);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(exported.archivePath, bytes);

  await assert.rejects(() => importTenantArchive(target.config, target.db, { archivePath: exported.archivePath }));
  assert.equal(target.db.prepare('SELECT COUNT(*) AS count FROM organizations WHERE slug = ?').get('acme').count, 0);
});

test('a deleted tenant can be restored from the export that preceded the deletion', async (t) => {
  const context = await instance(t, 'roundtrip');
  const org = await tenant(context, 'acme');
  const before = tenantRowCensus(context.db, org.id);

  const scheduled = requestTenantDeletion(context.db, {
    slug: 'acme', reason: 'the customer asked to close their account', userId: context.userId, graceDays: 0,
  });
  const exported = await createTenantExport(context.config, context.db, { slug: 'acme', userId: context.userId });
  const { verifyRecordedExport } = await import('../src/tenant-export.mjs');
  await verifyRecordedExport(context.config, context.db, { exportId: exported.id });
  const deleted = executeTenantDeletion(context.db, { requestId: scheduled.id });
  assert.equal(deleted.verification.complete, true);
  fs.rmSync(path.join(context.config.repositoriesDir, 'acme'), { recursive: true, force: true });

  // This is the whole promise: the gate on deletion is only worth having if the
  // archive it insists on can actually bring the tenant back.
  const report = await importTenantArchive(context.config, context.db, {
    archivePath: exported.archivePath, userId: context.userId,
  });
  assert.equal(report.complete, true);
  assert.equal(report.organization.id, org.id);
  assert.equal(report.census.counts.repositories, before.counts.repositories);
  assert.equal(report.census.counts.org_members, before.counts.org_members);
  assert.equal(listBranches(context.config, 'acme', 'app')[0].name, 'main');
});
