import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { hashPassword } from '../src/auth.mjs';
import { migrateRepositoryAccess, getEffectiveRepositoryAccess, requireRepositoryAccess } from '../src/repository-access.mjs';
import {
  grantSupportAccess,
  listSupportGrants,
  migrateSupportAccess,
  registerSupportOperators,
  revokeSupportAccess,
} from '../src/support-access.mjs';

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
    try { migrate(db); } catch { /* not applicable */ }
  }
}

async function setup(t, { operators = ['support@kuklabs.com'] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-support-'));
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
    instanceAdminEmails: operators.join(','),
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  await migrateEverything(db);
  migrateRepositoryAccess(db);
  migrateSupportAccess(db);
  const { userId: ownerId } = seedCore(db, config);

  // The operator check the server registers. Kept as a mutable set so a test
  // can take somebody off the list the way an instance would.
  const allowed = new Set(operators.map((email) => email.toLowerCase()));
  const isOperator = (_settings, user) => allowed.has(String(user?.email ?? '').toLowerCase());
  registerSupportOperators(db, (user) => isOperator(config, user));

  const user = (email, name) => {
    const id = uid('usr');
    db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(id, email, hashPassword('a-sufficiently-long-password'), name);
    return id;
  };
  const operatorId = user('support@kuklabs.com', 'Support');
  const strangerId = user('stranger@example.com', 'Stranger');

  const orgId = uid('org');
  db.prepare('INSERT INTO organizations (id, slug, name, created_by) VALUES (?, ?, ?, ?)')
    .run(orgId, 'acme', 'Acme', ownerId);
  db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'owner')").run(orgId, ownerId);
  const repositoryId = uid('repo');
  db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, ownerId);

  return { config, db, ownerId, operatorId, strangerId, orgId, repositoryId, allowed, isOperator };
}

const reference = { orgSlug: 'acme', repoSlug: 'app' };

function grant(context, options = {}) {
  return grantSupportAccess(context.db, context.config, {
    orgSlug: 'acme',
    userId: context.ownerId,
    operatorEmail: 'support@kuklabs.com',
    reason: 'ticket 4821: pushes are rejected and we cannot reproduce it',
    isOperator: context.isOperator,
    ...options,
  });
}

test('a support operator has no access to a private repository by default', async (t) => {
  const context = await setup(t);
  const access = getEffectiveRepositoryAccess(context.db, { userId: context.operatorId, ...reference });
  assert.equal(access.permission, 'none');
  assert.deepEqual(access.sources, []);
  assert.throws(() => requireRepositoryAccess(context.db, context.operatorId, reference), /ACCESS_DENIED|permission is required/);
});

test('the customer grants access, and the grant is why the read is allowed', async (t) => {
  const context = await setup(t);
  const created = grant(context);
  assert.equal(created.scope, 'organization');
  assert.equal(created.active, true);

  const access = getEffectiveRepositoryAccess(context.db, { userId: context.operatorId, ...reference });
  assert.equal(access.permission, 'read');
  // A source, not a bypass. Anywhere access is explained, the customer can see
  // that support read this and under whose grant.
  assert.equal(access.supportAccess.type, 'support');
  assert.equal(access.supportAccess.id, created.id);
  assert.match(access.supportAccess.name, /support@kuklabs\.com/);
});

test('the grant is read-only, whatever the ticket says', async (t) => {
  const context = await setup(t);
  grant(context);

  assert.ok(requireRepositoryAccess(context.db, context.operatorId, reference, 'read'));
  // An escalation path that can also write is a way to change a customer's
  // repository with nobody in the organization having agreed to it.
  for (const permission of ['triage', 'write', 'maintain', 'admin']) {
    assert.throws(
      () => requireRepositoryAccess(context.db, context.operatorId, reference, permission),
      /permission is required/,
      `support must not get ${permission}`,
    );
  }
});

test('what support looked at is visible to the organization', async (t) => {
  const context = await setup(t);
  const created = grant(context);
  getEffectiveRepositoryAccess(context.db, { userId: context.operatorId, ...reference });
  getEffectiveRepositoryAccess(context.db, { userId: context.operatorId, ...reference });

  const [record] = listSupportGrants(context.db, { orgSlug: 'acme' });
  assert.equal(record.id, created.id);
  // Bucketed to the minute: one clone is many requests, and a log nobody can
  // read is not transparency.
  assert.equal(record.uses, 1);
  assert.equal(record.events[0].repoSlug, 'app');
  assert.equal(record.events[0].action, 'read');
});

test('revoking ends the access immediately, and the operator can end it too', async (t) => {
  const context = await setup(t);
  const created = grant(context);
  assert.equal(getEffectiveRepositoryAccess(context.db, { userId: context.operatorId, ...reference }).permission, 'read');

  revokeSupportAccess(context.db, { orgSlug: 'acme', grantId: created.id, userId: context.ownerId });
  assert.equal(getEffectiveRepositoryAccess(context.db, { userId: context.operatorId, ...reference }).permission, 'none');
  assert.equal(listSupportGrants(context.db, { orgSlug: 'acme' })[0].active, false);

  const second = grant(context);
  // Nobody should have to wait for a customer to take away access support has
  // finished with.
  const ended = revokeSupportAccess(context.db, { orgSlug: 'acme', grantId: second.id, userId: context.operatorId });
  assert.equal(ended.byOperator, true);
  assert.equal(getEffectiveRepositoryAccess(context.db, { userId: context.operatorId, ...reference }).permission, 'none');
});

test('an expired grant is not access', async (t) => {
  const context = await setup(t);
  const created = grant(context);
  context.db.prepare("UPDATE support_access_grants SET expires_at = datetime('now', '-1 hour') WHERE id = ?").run(created.id);

  assert.equal(getEffectiveRepositoryAccess(context.db, { userId: context.operatorId, ...reference }).permission, 'none');
  assert.equal(listSupportGrants(context.db, { orgSlug: 'acme' })[0].active, false);
});

test('an operator taken off the instance list loses live grants at once', async (t) => {
  const context = await setup(t);
  grant(context);
  assert.equal(getEffectiveRepositoryAccess(context.db, { userId: context.operatorId, ...reference }).permission, 'read');

  // Somebody leaving support should not keep reading customer repositories
  // until every grant they hold happens to expire.
  context.allowed.delete('support@kuklabs.com');
  assert.equal(getEffectiveRepositoryAccess(context.db, { userId: context.operatorId, ...reference }).permission, 'none');
});

test('only the customer can grant it, and only to a real operator', async (t) => {
  const context = await setup(t);

  // The whole difference between this and impersonation: the access exists
  // because somebody who owns the data said so.
  assert.throws(() => grant(context, { userId: context.strangerId }), /owner access is required/);
  assert.throws(() => grant(context, { userId: context.operatorId }), /owner access is required/);
  assert.throws(() => grant(context, { operatorEmail: 'stranger@example.com' }), /not a KukGit support operator/);
  assert.throws(() => grant(context, { operatorEmail: 'nobody@example.com' }), /no account on this instance/);
  assert.throws(() => grant(context, { reason: 'because' }), /at least 20 characters/);
  assert.throws(() => grant(context, { hours: 24 * 30 }), /between 1 and 72 hours/);
  assert.throws(() => grant(context, { hours: 0 }), /between 1 and 72 hours/);
});

test('a repository-scoped grant does not open the rest of the organization', async (t) => {
  const context = await setup(t);
  const otherId = uid('repo');
  context.db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'private-plans', 'Plans', '', 'private', 'main', ?)
  `).run(otherId, context.orgId, context.ownerId);

  grant(context, { repoSlug: 'app' });
  assert.equal(getEffectiveRepositoryAccess(context.db, { userId: context.operatorId, ...reference }).permission, 'read');
  assert.equal(
    getEffectiveRepositoryAccess(context.db, { userId: context.operatorId, orgSlug: 'acme', repoSlug: 'private-plans' }).permission,
    'none',
  );
});

test('an operator who is also a member reads as the member, and burns no grant', async (t) => {
  const context = await setup(t);
  grant(context);
  // The same person can be a KukGit operator and a member of a customer's
  // organization — a Kuklabs engineer working on Kuklabs' own repositories.
  context.db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'developer')")
    .run(context.orgId, context.operatorId);

  const access = getEffectiveRepositoryAccess(context.db, { userId: context.operatorId, ...reference });
  assert.equal(access.permission, 'write');
  // Their own membership is why they can read, and the record has to say so.
  // Logging it against the support grant would put "support read your
  // repository" in a customer's audit trail for somebody doing their day job,
  // and would spend a grant that was never needed.
  assert.equal(access.supportAccess, null);
  assert.deepEqual(access.sources.map((source) => source.type), ['organization']);
  assert.equal(listSupportGrants(context.db, { orgSlug: 'acme' })[0].uses, 0);
});
