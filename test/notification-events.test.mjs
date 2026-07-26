import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, createBranch, createDemoCommit, resolveRef } from '../src/git.mjs';
import { notifyFailedCommitStatus } from '../src/notification-events.mjs';
import {
  listNotifications,
  migrateNotifications,
  notifyPullRequestCreated,
  notifyPullRequestMerged,
  notifyPullRequestReview,
} from '../src/notifications.mjs';
import { scheduleWebhookFailureAlerts } from '../src/operations-notifications.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateWebhooks } from '../src/webhooks.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-notification-events-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    baseUrl: 'http://kukgit.test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Repository Owner',
    smtpHost: 'smtp.test',
    smtpPort: 2525,
    smtpSecure: false,
    smtpStartTls: false,
    emailFrom: 'noreply@kukgit.test',
    emailMaxAttempts: 3,
    emailBatchSize: 20,
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateWebhooks(db);
  const { userId: ownerId, orgId } = seedCore(db, config);
  const developerId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(developerId, 'developer@example.com', 'test-password-hash', 'Developer Reviewer');
  db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'developer')")
    .run(orgId, developerId);
  migrateNotifications(db);

  const repositoryId = uid('repo');
  createBareRepository(config, 'kuklabs', 'notification-demo');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'notification-demo', 'Notification Demo', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, ownerId);
  createDemoCommit(config, 'kuklabs', 'notification-demo');
  createBranch(config, 'kuklabs', 'notification-demo', 'feature/alerts', 'main');
  const pullId = uid('pr');
  db.prepare(`
    INSERT INTO pull_requests
      (id, repository_id, number, title, body, base_branch, head_branch, status, author_id)
    VALUES (?, ?, 1, 'Add notification alerts', '', 'main', 'feature/alerts', 'open', ?)
  `).run(pullId, repositoryId, ownerId);
  return { config, db, ownerId, developerId, orgId, repositoryId, pullId };
}

test('pull request creation, review, merge and failed status reach intended recipients', (t) => {
  const context = setup(t);
  const created = notifyPullRequestCreated(context.db, context.config, {
    orgSlug: 'kuklabs', repoSlug: 'notification-demo', number: 1, actorId: context.ownerId,
  });
  assert.equal(created, 1);
  let developerInbox = listNotifications(context.db, context.developerId);
  assert.equal(developerInbox.unreadCount, 1);
  assert.match(developerInbox.notifications[0].title, /Pull request #1 opened/);
  assert.equal(listNotifications(context.db, context.ownerId).notifications.length, 0);

  const reviewed = notifyPullRequestReview(context.db, context.config, {
    orgSlug: 'kuklabs', repoSlug: 'notification-demo', number: 1,
    actorId: context.developerId, state: 'changes_requested',
  });
  assert.equal(reviewed, 1);
  let ownerInbox = listNotifications(context.db, context.ownerId);
  assert.ok(ownerInbox.notifications.some((item) => /requested changes/.test(item.title)));

  const headSha = resolveRef(context.config, 'kuklabs', 'notification-demo', 'feature/alerts');
  const failed = notifyFailedCommitStatus(context.db, context.config, {
    orgSlug: 'kuklabs', repoSlug: 'notification-demo', sha: headSha,
    context: 'test', state: 'failure',
  });
  assert.equal(failed, 1);
  ownerInbox = listNotifications(context.db, context.ownerId);
  assert.ok(ownerInbox.notifications.some((item) => item.title === 'test reported failure'));

  context.db.prepare("UPDATE pull_requests SET status = 'merged' WHERE id = ?").run(context.pullId);
  const merged = notifyPullRequestMerged(context.db, context.config, {
    orgSlug: 'kuklabs', repoSlug: 'notification-demo', number: 1, actorId: context.developerId,
  });
  assert.equal(merged, 1);
  ownerInbox = listNotifications(context.db, context.ownerId);
  assert.ok(ownerInbox.notifications.some((item) => /Pull request #1 merged/.test(item.title)));
});

test('terminal webhook failures create one deduplicated Admin operations alert', (t) => {
  const context = setup(t);
  const webhookId = uid('whk');
  const deliveryId = uid('whd');
  context.db.prepare(`
    INSERT INTO repository_webhooks
      (id, repository_id, url, events_json, secret_ciphertext, secret_iv, secret_tag, active, created_by, updated_by)
    VALUES (?, ?, 'https://example.com/webhook', '["push"]', 'cipher', 'iv', 'tag', 1, ?, ?)
  `).run(webhookId, context.repositoryId, context.ownerId, context.ownerId);
  context.db.prepare(`
    INSERT INTO webhook_deliveries
      (id, webhook_id, event, payload_json, status, attempt_count, response_status, last_error)
    VALUES (?, ?, 'push', '{}', 'failure', 5, 503, 'upstream unavailable token=secret-value')
  `).run(deliveryId, webhookId);

  const first = scheduleWebhookFailureAlerts(context.db, context.config);
  const second = scheduleWebhookFailureAlerts(context.db, context.config);
  assert.equal(first.candidates, 1);
  assert.equal(first.created, 1);
  assert.equal(second.created, 1);
  const inbox = listNotifications(context.db, context.ownerId);
  const alerts = inbox.notifications.filter((item) => item.title.includes('Webhook delivery failed'));
  assert.equal(alerts.length, 1);
  assert.doesNotMatch(alerts[0].body, /secret-value/);
  assert.match(alerts[0].body, /REDACTED/);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE dedupe_key = ?").get(`email:webhook-terminal-failure:${deliveryId}`).count, 1);
});
