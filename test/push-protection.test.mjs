import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import {
  activeBypassFingerprints,
  createBypass,
  evaluatePush,
  getPushProtectionPolicy,
  markBypassesUsed,
  migratePushProtection,
  rejectionMessage,
  setPushProtectionPolicy,
} from '../src/push-protection.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-push-protection-'));
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
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migratePushProtection(db);
  const { userId, orgId } = seedCore(db, config);
  const repositoryId = uid('repo');
  db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, userId);
  return { config, db, userId, repositoryId };
}

const finding = (overrides = {}) => ({
  detectorId: 'github-token',
  detectorName: 'GitHub token',
  severity: 'critical',
  path: 'deploy.sh',
  line: 1,
  fingerprint: 'a'.repeat(16),
  preview: 'ghp_****cpLR',
  likelyExample: false,
  ...overrides,
});

test('a repository with no policy is not protected', (t) => {
  const context = setup(t);
  const policy = getPushProtectionPolicy(context.db, context.repositoryId);
  // A control that starts rejecting pushes the moment it ships is one that gets
  // switched off before anybody reads what it does.
  assert.equal(policy.enabled, false);
  assert.equal(policy.configured, false);
  assert.equal(evaluatePush({ findings: [finding()], policy }).allowed, true);
});

test('only the severities in the policy block a push', (t) => {
  const context = setup(t);
  const policy = setPushProtectionPolicy(context.db, {
    repositoryId: context.repositoryId, userId: context.userId, enabled: true,
  });
  assert.deepEqual(policy.blockSeverities, ['critical', 'high']);

  const findings = [finding(), finding({ severity: 'medium', fingerprint: 'b'.repeat(16) })];
  const decision = evaluatePush({ findings, policy });
  assert.equal(decision.allowed, false);
  // A medium-severity JWT is worth showing and not worth stopping work for.
  assert.deepEqual(decision.blocked.map((entry) => entry.severity), ['critical']);
});

test('an example file is waved through only while the policy says so', (t) => {
  const context = setup(t);
  const findings = [finding({ likelyExample: true })];

  const lenient = setPushProtectionPolicy(context.db, {
    repositoryId: context.repositoryId, userId: context.userId, enabled: true, allowExampleFiles: true,
  });
  assert.equal(evaluatePush({ findings, policy: lenient }).allowed, true);

  const strict = setPushProtectionPolicy(context.db, {
    repositoryId: context.repositoryId, userId: context.userId, enabled: true, allowExampleFiles: false,
  });
  assert.equal(evaluatePush({ findings, policy: strict }).allowed, false);
});

test('a bypass covers the credential it names and nothing else', (t) => {
  const context = setup(t);
  const policy = setPushProtectionPolicy(context.db, {
    repositoryId: context.repositoryId, userId: context.userId, enabled: true,
  });
  createBypass(context.db, {
    repositoryId: context.repositoryId, fingerprint: 'a'.repeat(16),
    reason: 'a sample value in documentation', userId: context.userId,
  });
  const bypassed = activeBypassFingerprints(context.db, context.repositoryId);

  assert.equal(evaluatePush({ findings: [finding()], policy, bypassed }).allowed, true);
  // A bypass that waved through whatever came next would let an unrelated
  // credential ride along with the one somebody actually reviewed.
  const other = finding({ fingerprint: 'b'.repeat(16) });
  assert.equal(evaluatePush({ findings: [other], policy, bypassed }).allowed, false);
});

test('a bypass expires, because a standing one is the control being off', (t) => {
  const context = setup(t);
  createBypass(context.db, {
    repositoryId: context.repositoryId, fingerprint: 'a'.repeat(16),
    reason: 'temporary allowance for a release', userId: context.userId, minutes: 30,
  });
  assert.equal(activeBypassFingerprints(context.db, context.repositoryId).size, 1);

  context.db.prepare("UPDATE secret_push_bypasses SET expires_at = datetime('now', '-1 minute')").run();
  assert.equal(activeBypassFingerprints(context.db, context.repositoryId).size, 0);
});

test('a bypass needs a reason and a real fingerprint', (t) => {
  const context = setup(t);
  const attempt = (overrides) => createBypass(context.db, {
    repositoryId: context.repositoryId, fingerprint: 'a'.repeat(16),
    reason: 'a properly written reason', userId: context.userId, ...overrides,
  });
  // A reason nobody has to write is a reason nobody writes.
  assert.throws(() => attempt({ reason: 'nope' }), /at least 10 characters/);
  assert.throws(() => attempt({ reason: '            ' }), /at least 10 characters/);
  assert.throws(() => attempt({ fingerprint: 'not-a-fingerprint' }), /fingerprint/);
});

test('a used bypass is recorded as used', (t) => {
  const context = setup(t);
  createBypass(context.db, {
    repositoryId: context.repositoryId, fingerprint: 'a'.repeat(16),
    reason: 'reviewed and allowed', userId: context.userId,
  });
  assert.equal(markBypassesUsed(context.db, context.repositoryId, ['a'.repeat(16)]), 1);
  // Marking twice must not rewrite the first use: the record is when it was
  // used, not when it was last seen.
  assert.equal(markBypassesUsed(context.db, context.repositoryId, ['a'.repeat(16)]), 0);
  assert.ok(context.db.prepare('SELECT used_at FROM secret_push_bypasses').get().used_at);
});

test('the rejection message is actionable and carries no secret', () => {
  const decision = evaluatePush({
    findings: [finding()],
    policy: { enabled: true, blockSeverities: ['critical'], allowExampleFiles: false },
  });
  const message = rejectionMessage(decision, {
    orgSlug: 'kuklabs', repoSlug: 'app', baseUrl: 'https://git.kuklabs.test',
  });

  // The author only sees their terminal, so the way past this has to be in it.
  assert.match(message, /deploy\.sh:1/);
  assert.match(message, /rotate it at the provider/);
  assert.match(message, /push-protection\/bypasses/);
  assert.match(message, /ghp_\*+cpLR/);
  // A rejection message is written to a terminal and quite often into a CI log.
  assert.doesNotMatch(message, /ghp_[A-Za-z0-9]{20}/);
});

test('an unknown severity in a policy is refused', (t) => {
  const context = setup(t);
  assert.throws(() => setPushProtectionPolicy(context.db, {
    repositoryId: context.repositoryId, userId: context.userId, enabled: true,
    blockSeverities: ['critical', 'catastrophic'],
  }), /Unknown severity/);
});
