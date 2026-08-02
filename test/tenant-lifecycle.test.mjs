import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { migrateSecrets, putSecret } from '../src/secrets-vault.mjs';
import {
  cancelTenantDeletion,
  executeTenantDeletion,
  listTenantDeletions,
  migrateTenantLifecycle,
  requestTenantDeletion,
  tenantRowCensus,
  tenantTableGraph,
} from '../src/tenant-lifecycle.mjs';

/**
 * Builds the production schema, not a subset of it.
 *
 * The graph is derived from whatever tables exist, so a test against a partial
 * schema would assert that a smaller problem is solved. Every `migrate*` export
 * in `src/` is called, which also means a module added later is covered without
 * anybody remembering to add it here — the same reason the graph is derived
 * rather than written down.
 */
async function migrateEverything(db) {
  const dir = new URL('../src/', import.meta.url);
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.mjs')).sort();
  const deferred = [];
  for (const file of files) {
    let module;
    try { module = await import(new URL(file, dir).href); } catch { continue; }
    for (const [name, value] of Object.entries(module)) {
      // Arity one, because a schema migration takes only the database.
      // `migrateLfsObjectsToBucket(config, db, options)` also starts with
      // "migrate" and is not one — calling it here tried to talk to a bucket.
      if (!/^migrate[A-Z]/.test(name) || typeof value !== 'function' || value.length !== 1) continue;
      try { value(db); } catch { deferred.push(value); }
    }
  }
  // A second pass for migrations that depend on a table an alphabetically later
  // module creates.
  for (const migrate of deferred) {
    try { migrate(db); } catch { /* genuinely not applicable to this database */ }
  }
}

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-tenant-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
    secretsEncryptionKey: 'kukgit-tenant-test-key-long-enough-here',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  await migrateEverything(db);
  const { userId, orgId } = seedCore(db, config);
  return { config, db, userId, orgId };
}

function organization(context, slug) {
  const id = uid('org');
  context.db.prepare("INSERT INTO organizations (id, slug, name, created_by) VALUES (?, ?, ?, ?)")
    .run(id, slug, slug, context.userId);
  const repositoryId = uid('repo');
  context.db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(repositoryId, id, context.userId);
  context.db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'owner')")
    .run(id, context.userId);
  return { id, slug, repositoryId };
}

test('every table is either reachable from a tenant or explains why not', async (t) => {
  const context = await setup(t);
  const graph = tenantTableGraph(context.db);

  // The whole design rests on this being empty. A table nobody classified is not
  // evidence of a clean deletion; it is evidence that nobody looked — and it is
  // how a deletion reports success while leaving rows behind.
  assert.deepEqual(graph.unclassified, [], 'every table must be classified');
  assert.ok(graph.deleteOrder.length > 20);

  // Children before parents, so foreign keys hold at every step rather than
  // being switched off for the duration.
  const order = graph.deleteOrder.filter((entry) => !entry.polymorphic).map((entry) => entry.depth);
  assert.deepEqual(order, [...order].sort((a, b) => b - a));
});

test('a polymorphic table is included even though no foreign key says so', async (t) => {
  const context = await setup(t);
  const org = organization(context, 'acme');
  putSecret(context.db, context.config, {
    scope: 'organization', scopeId: org.id, name: 'DEPLOY_TOKEN', value: 'a-value', userId: context.userId,
  });
  putSecret(context.db, context.config, {
    scope: 'repository', scopeId: org.repositoryId, name: 'REPO_TOKEN', value: 'another', userId: context.userId,
  });

  // `secrets` is scoped by (scope, scope_id) with no foreign key, so the graph
  // cannot see it. Unhandled, deleting an organization would leave its encrypted
  // credentials in the database forever.
  const census = tenantRowCensus(context.db, org.id);
  assert.equal(census.counts.secrets, 2, 'both scopes belong to this tenant');
});

test('a census counts what a deletion would destroy', async (t) => {
  const context = await setup(t);
  const org = organization(context, 'acme');
  const census = tenantRowCensus(context.db, org.id);

  assert.equal(census.counts.repositories, 1);
  assert.equal(census.counts.org_members, 1);
  assert.equal(census.organizationRows, 1);
  assert.ok(census.total >= 2);
});

test('a deletion waits, and can be cancelled while it does', async (t) => {
  const context = await setup(t);
  const org = organization(context, 'acme');

  const scheduled = requestTenantDeletion(context.db, {
    slug: 'acme', reason: 'the customer closed their account in writing', userId: context.userId,
  });
  assert.equal(scheduled.graceDays, 7);

  // Not due yet. Deletion is the one operation with no undo, and the most common
  // reason to want one reversed is that it was a mistake noticed within the hour.
  assert.throws(() => executeTenantDeletion(context.db, { requestId: scheduled.id }), /not due until/);
  assert.equal(tenantRowCensus(context.db, org.id).organizationRows, 1);

  cancelTenantDeletion(context.db, { requestId: scheduled.id, userId: context.userId });
  assert.equal(listTenantDeletions(context.db)[0].status, 'cancelled');
  assert.throws(() => executeTenantDeletion(context.db, { requestId: scheduled.id }), /No scheduled deletion/);
});

test('a deletion removes everything and proves it', async (t) => {
  const context = await setup(t);
  const org = organization(context, 'acme');
  putSecret(context.db, context.config, {
    scope: 'organization', scopeId: org.id, name: 'TOKEN', value: 'a-value', userId: context.userId,
  });
  const before = tenantRowCensus(context.db, org.id);
  assert.ok(before.total > 0);

  const scheduled = requestTenantDeletion(context.db, {
    slug: 'acme', reason: 'the customer closed their account in writing', userId: context.userId, graceDays: 0,
  });
  // `withoutExport` because this test is about the deletion. A deletion normally
  // refuses to run until a verified export has been taken — see
  // test/tenant-export.test.mjs, where that gate is the subject.
  const result = executeTenantDeletion(context.db, { requestId: scheduled.id, withoutExport: true });

  // "We deleted it" is a claim anybody can make. A census taken afterwards
  // against a schema-derived table list is a check that fails loudly.
  assert.equal(result.verification.complete, true);
  assert.equal(result.verification.remainingRows, 0);
  assert.deepEqual(result.verification.remaining, {});
  assert.deepEqual(result.verification.unclassifiedTables, []);
  assert.ok(result.deleted.repositories >= 1);
  assert.ok(result.deleted.secrets >= 1);

  assert.equal(listTenantDeletions(context.db)[0].status, 'executed');
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM organizations WHERE id = ?').get(org.id).count, 0);
});

test('another tenant is untouched', async (t) => {
  const context = await setup(t);
  const doomed = organization(context, 'acme');
  const kept = organization(context, 'other');
  putSecret(context.db, context.config, {
    scope: 'organization', scopeId: kept.id, name: 'KEEP', value: 'safe', userId: context.userId,
  });

  const scheduled = requestTenantDeletion(context.db, {
    slug: 'acme', reason: 'the customer closed their account in writing', userId: context.userId, graceDays: 0,
  });
  executeTenantDeletion(context.db, { requestId: scheduled.id, withoutExport: true });

  const survivor = tenantRowCensus(context.db, kept.id);
  assert.equal(survivor.organizationRows, 1);
  assert.equal(survivor.counts.repositories, 1);
  assert.equal(survivor.counts.secrets, 1);
  assert.equal(tenantRowCensus(context.db, doomed.id).total, 0);
});

test('a request needs a real reason and cannot be duplicated', async (t) => {
  const context = await setup(t);
  organization(context, 'acme');

  assert.throws(() => requestTenantDeletion(context.db, {
    slug: 'acme', reason: 'because', userId: context.userId,
  }), /at least 20 characters/);
  assert.throws(() => requestTenantDeletion(context.db, {
    slug: 'nope', reason: 'a perfectly adequate written reason', userId: context.userId,
  }), /not found/);

  requestTenantDeletion(context.db, { slug: 'acme', reason: 'a perfectly adequate written reason', userId: context.userId });
  // Two scheduled deletions for one tenant is two people believing different
  // things about when it happens.
  assert.throws(() => requestTenantDeletion(context.db, {
    slug: 'acme', reason: 'a perfectly adequate written reason', userId: context.userId,
  }), /already scheduled/);
});
