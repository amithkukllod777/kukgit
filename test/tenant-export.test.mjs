import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { unpackPortableArchive } from '../src/backup-archive.mjs';
import { createBareRepository, createDemoCommit } from '../src/git.mjs';
import { lfsObjectPath } from '../src/git-lfs.mjs';
import { putSecret } from '../src/secrets-vault.mjs';
import { executeTenantDeletion, requestTenantDeletion, tenantSelectors } from '../src/tenant-lifecycle.mjs';
import {
  createTenantExport,
  listTenantExports,
  tenantExportColumnPolicy,
  verifyRecordedExport,
  verifyTenantExport,
} from '../src/tenant-export.mjs';

/**
 * The production schema, not a subset of it. Same reasoning as the deletion
 * tests: the column policy and the table graph are both derived from whatever
 * tables exist, so a partial schema would assert that a smaller problem is
 * solved.
 */
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

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-export-'));
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
    secretsEncryptionKey: 'kukgit-export-test-key-long-enough-here',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  await migrateEverything(db);
  const { userId } = seedCore(db, config);
  fs.mkdirSync(config.tempDir, { recursive: true });
  return { config, db, userId };
}

async function organization(context, slug, { withCommit = true } = {}) {
  const id = uid('org');
  context.db.prepare('INSERT INTO organizations (id, slug, name, created_by) VALUES (?, ?, ?, ?)')
    .run(id, slug, slug, context.userId);
  context.db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'owner')")
    .run(id, context.userId);
  const repositoryId = uid('repo');
  context.db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(repositoryId, id, context.userId);
  createBareRepository(context.config, slug, 'app');
  if (withCommit) await createDemoCommit(context.config, slug, 'app');
  return { id, slug, repositoryId };
}

test('an export covers exactly the tables a deletion removes', async (t) => {
  const context = await setup(t);
  const org = await organization(context, 'acme');
  const result = await createTenantExport(context.config, context.db, { slug: 'acme', userId: context.userId });

  // The symmetry is the reason both are derived from the schema. If a table is
  // exported it is deleted, and if it is deleted it was exported — by
  // construction, not because two lists happen to agree today.
  const { selectors } = tenantSelectors(context.db);
  const deletable = new Set([...selectors.map((selector) => selector.table), 'organizations']);
  const exported = new Set(result.manifest.tables.map((table) => table.table));
  for (const table of exported) assert.ok(deletable.has(table), `${table} is exported but never deleted`);

  assert.equal(result.manifest.organization.id, org.id);
  assert.ok(exported.has('repositories'));
  assert.ok(exported.has('organizations'));
});

test('every credential-shaped column is either withheld or explained', async (t) => {
  const context = await setup(t);
  const { selectors } = tenantSelectors(context.db);
  const policy = tenantExportColumnPolicy(context.db, [...selectors.map((entry) => entry.table), 'organizations']);

  // The same rule as the deletion's unclassified tables, with a worse failure:
  // an unclassified table leaves a row behind, an unclassified column puts a
  // credential in a file somebody else keeps forever.
  assert.deepEqual(policy.unexplained, [], 'every credential-shaped column needs a decision');
  assert.ok(policy.redacted.includes('secrets.ciphertext'));
  assert.ok(policy.redacted.includes('repository_webhooks.secret_ciphertext'));
  assert.ok(policy.redacted.includes('runners.token_hash'));
  // Found by exporting a real instance and reading the file that came out. A
  // digest of a credential is a credential: unsalted SHA-256 of a short secret
  // is brute-forceable, and of any secret it answers "is the value X?" for
  // somebody holding a guess. A digest of *content* is not, and is exempted by
  // name — which is why both kinds have to be classified rather than matched.
  assert.ok(policy.redacted.includes('secrets.value_sha256'));
  assert.ok(policy.explained.some((entry) => entry.column === 'workflow_artifacts.digest'));
});

test('no secret material reaches the archive', async (t) => {
  const context = await setup(t);
  const org = await organization(context, 'acme');
  putSecret(context.db, context.config, {
    scope: 'organization', scopeId: org.id, name: 'DEPLOY', value: 'the-actual-secret-value', userId: context.userId,
  });
  const runnerToken = 'the-actual-runner-token';
  context.db.prepare('INSERT INTO runners (id, organization_id, name, token_hash) VALUES (?, ?, ?, ?)')
    .run(uid('run'), org.id, 'builder', runnerToken);

  const result = await createTenantExport(context.config, context.db, { slug: 'acme', userId: context.userId });
  const target = fs.mkdtempSync(path.join(context.config.tempDir, 'read-'));
  const unpacked = await unpackPortableArchive(result.archivePath, path.join(target, 'out'));

  // Greps the bytes that actually left, not the object that was meant to leave.
  for (const entry of unpacked.entries) {
    const content = fs.readFileSync(entry.destination, 'latin1');
    assert.ok(!content.includes(runnerToken), `${entry.path} contains a runner token`);
  }
  const secrets = unpacked.entries.find((entry) => entry.path === 'metadata/secrets.jsonl');
  const rows = fs.readFileSync(secrets.destination, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  // The name is exported because the customer needs to know which credentials
  // to recreate. The ciphertext is not, because the key does not travel.
  assert.equal(rows[0].name, 'DEPLOY');
  assert.match(rows[0].ciphertext, /redacted/);
  assert.match(rows[0].value_sha256, /redacted/);
});

test('a repository is exported as a bundle Git can read on its own', async (t) => {
  const context = await setup(t);
  await organization(context, 'acme');
  const result = await createTenantExport(context.config, context.db, { slug: 'acme', userId: context.userId });

  const target = fs.mkdtempSync(path.join(context.config.tempDir, 'clone-'));
  const unpacked = await unpackPortableArchive(result.archivePath, path.join(target, 'out'));
  const bundle = unpacked.entries.find((entry) => entry.path === 'repositories/app.bundle');
  assert.ok(bundle, 'the repository is in the archive');

  // An export whose repositories can only be opened by KukGit is not an export.
  // This is a real clone, by the real git, from the file that was handed over.
  const clone = path.join(target, 'clone');
  const cloned = spawnSync('git', ['clone', '--quiet', bundle.destination, clone], { encoding: 'utf8' });
  assert.equal(cloned.status, 0, cloned.stderr);
  assert.match(fs.readFileSync(path.join(clone, 'src', 'hello.js'), 'utf8'), /Welcome to KukGit/);
});

test('an empty repository is recorded as empty, and a missing one as missing', async (t) => {
  const context = await setup(t);
  const org = await organization(context, 'acme', { withCommit: false });
  const goneId = uid('repo');
  context.db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'gone', 'Gone', '', 'private', 'main', ?)
  `).run(goneId, org.id, context.userId);

  const result = await createTenantExport(context.config, context.db, { slug: 'acme', userId: context.userId });
  const byslug = new Map(result.manifest.repositories.map((entry) => [entry.slug, entry]));
  assert.equal(byslug.get('app').empty, true);
  assert.equal(byslug.get('gone').missing, true);

  // An export that quietly omits a repository is worse than no export: somebody
  // deletes the original believing they have it.
  assert.equal(result.manifest.complete, false);
  const verified = await verifyTenantExport(context.config, result.archivePath);
  assert.equal(verified.complete, false);
  assert.ok(verified.problems.some((problem) => problem.includes('gone')));
});

test('Git LFS bytes travel with the export, not a pointer to them', async (t) => {
  const context = await setup(t);
  const org = await organization(context, 'acme');
  const content = Buffer.from('a large file, pretend it is 4 GiB\n');
  const oid = crypto.createHash('sha256').update(content).digest('hex');
  const objectPath = lfsObjectPath(context.config, oid);
  fs.mkdirSync(path.dirname(objectPath), { recursive: true });
  fs.writeFileSync(objectPath, content);
  context.db.prepare('INSERT INTO lfs_objects (oid, size, storage_path) VALUES (?, ?, ?)')
    .run(oid, content.length, `objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`);
  context.db.prepare('INSERT INTO repository_lfs_objects (repository_id, oid) VALUES (?, ?)')
    .run(org.repositoryId, oid);

  const result = await createTenantExport(context.config, context.db, { slug: 'acme', userId: context.userId });
  assert.equal(result.manifest.lfs.objects, 1);
  assert.deepEqual(result.manifest.lfs.missing, []);

  const target = fs.mkdtempSync(path.join(context.config.tempDir, 'lfs-'));
  const unpacked = await unpackPortableArchive(result.archivePath, path.join(target, 'out'));
  const object = unpacked.entries.find((entry) => entry.path.endsWith(oid));
  // A manifest telling somebody their large files are in an S3 account they do
  // not own is not a copy of their data. The bytes are here.
  assert.ok(object, 'the object is in the archive');
  assert.deepEqual(fs.readFileSync(object.destination), content);

  const verified = await verifyTenantExport(context.config, result.archivePath);
  assert.equal(verified.lfsObjects, 1);
  assert.equal(verified.complete, true);
});

test('verification opens the archive and reads every byte back', async (t) => {
  const context = await setup(t);
  await organization(context, 'acme');
  const result = await createTenantExport(context.config, context.db, { slug: 'acme', userId: context.userId });

  const verified = await verifyRecordedExport(context.config, context.db, { exportId: result.id });
  assert.equal(verified.complete, true);
  assert.deepEqual(verified.problems, []);
  assert.equal(verified.bundles, 1);
  assert.ok(verified.rows > 0);
  assert.equal(listTenantExports(context.db, { slug: 'acme' })[0].verifiedAt !== null, true);
});

test('a corrupt archive fails verification rather than passing quietly', async (t) => {
  const context = await setup(t);
  await organization(context, 'acme');
  const result = await createTenantExport(context.config, context.db, { slug: 'acme', userId: context.userId });

  const bytes = fs.readFileSync(result.archivePath);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(result.archivePath, bytes);

  await assert.rejects(() => verifyTenantExport(context.config, result.archivePath));
});

test('one tenant export contains nothing belonging to another', async (t) => {
  const context = await setup(t);
  await organization(context, 'acme');
  const other = await organization(context, 'other');
  putSecret(context.db, context.config, {
    scope: 'organization', scopeId: other.id, name: 'OTHER_TENANT_SECRET_NAME', value: 'x', userId: context.userId,
  });

  const result = await createTenantExport(context.config, context.db, { slug: 'acme', userId: context.userId });
  const target = fs.mkdtempSync(path.join(context.config.tempDir, 'cross-'));
  const unpacked = await unpackPortableArchive(result.archivePath, path.join(target, 'out'));
  for (const entry of unpacked.entries) {
    const content = fs.readFileSync(entry.destination, 'latin1');
    assert.ok(!content.includes(other.id), `${entry.path} names another tenant`);
    assert.ok(!content.includes('OTHER_TENANT_SECRET_NAME'), `${entry.path} holds another tenant's secret name`);
  }
});

test('a deletion will not execute without an export taken since it was requested', async (t) => {
  const context = await setup(t);
  await organization(context, 'acme');

  const stale = await createTenantExport(context.config, context.db, { slug: 'acme', userId: context.userId });
  await verifyRecordedExport(context.config, context.db, { exportId: stale.id });

  const scheduled = requestTenantDeletion(context.db, {
    slug: 'acme', reason: 'the customer closed their account in writing', userId: context.userId, graceDays: 0,
  });

  // An export from before the request describes a tenant that has changed since.
  // Existing is not the bar; taken during this deletion's window is.
  context.db.prepare("UPDATE tenant_exports SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(stale.id);
  assert.throws(() => executeTenantDeletion(context.db, { requestId: scheduled.id }), /No verified export/);

  const fresh = await createTenantExport(context.config, context.db, { slug: 'acme', userId: context.userId });
  // Created but never opened. An archive nobody has read back is a belief.
  assert.throws(() => executeTenantDeletion(context.db, { requestId: scheduled.id }), /No verified export/);

  await verifyRecordedExport(context.config, context.db, { exportId: fresh.id });
  const executed = executeTenantDeletion(context.db, { requestId: scheduled.id });
  assert.equal(executed.verification.complete, true);
  assert.equal(executed.verification.exportWaived, false);
  assert.equal(executed.verification.export.id, fresh.id);
});

test('waiving the export is possible and is written down', async (t) => {
  const context = await setup(t);
  await organization(context, 'acme');
  const scheduled = requestTenantDeletion(context.db, {
    slug: 'acme', reason: 'the customer closed their account in writing', userId: context.userId, graceDays: 0,
  });

  const executed = executeTenantDeletion(context.db, { requestId: scheduled.id, withoutExport: true });
  // The single most consequential decision anybody makes here, so it lives in
  // the evidence rather than only in whoever typed the flag.
  assert.equal(executed.verification.exportWaived, true);
  assert.equal(executed.verification.export, null);
  assert.equal(executed.verification.complete, true);
});
