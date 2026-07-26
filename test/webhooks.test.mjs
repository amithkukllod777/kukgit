import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { hashPassword } from '../src/auth.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import {
  createRepositoryWebhook,
  createWebhookEventCapture,
  createWebhooksApiHandler,
  enqueueWebhookEvent,
  migrateWebhooks,
  processWebhookDelivery,
  resetWebhookDelivery,
  resolveWebhookTarget,
} from '../src/webhooks.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-webhooks-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Repository Owner',
    webhookEncryptionKey: 'test-webhook-encryption-key-with-sufficient-entropy',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateWebhooks(db);
  const { userId: ownerId, orgId } = seedCore(db, config);
  const repository = db.prepare(`
    SELECT r.id, r.slug, r.name, r.organization_id AS organizationId,
      o.slug AS orgSlug, o.name AS orgName
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE o.id = ? ORDER BY r.created_at LIMIT 1
  `).get(orgId);
  assert.ok(repository);

  const viewerId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(viewerId, 'viewer@example.com', hashPassword('secure-viewer-password'), 'Read Only User');
  db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(orgId, viewerId, 'viewer');

  const owner = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(ownerId);
  return { config, db, repository, owner, viewerId };
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

test('delivers signed payloads and keeps webhook secrets encrypted at rest', async (t) => {
  const context = setup(t);
  const received = [];
  const receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(202, { 'Content-Type': 'application/json', 'X-Request-Id': 'receiver-1' });
      res.end(JSON.stringify({ accepted: true }));
    });
  });
  const receiverOrigin = await listen(receiver);
  t.after(() => new Promise((resolve) => receiver.close(resolve)));

  const created = await createRepositoryWebhook(context.db, context.config, {
    repositoryId: context.repository.id,
    userId: context.owner.id,
    url: `${receiverOrigin}/events`,
    events: ['push', 'status'],
  });
  assert.match(created.secret, /^kgwhsec_/);
  const stored = context.db.prepare(`
    SELECT secret_ciphertext AS ciphertext, secret_iv AS iv, secret_tag AS tag
    FROM repository_webhooks WHERE id = ?
  `).get(created.webhook.id);
  assert.ok(stored.ciphertext && stored.iv && stored.tag);
  assert.equal(JSON.stringify(stored).includes(created.secret), false);

  const [deliveryId] = enqueueWebhookEvent(context.db, context.repository.id, 'push', {
    ref: 'refs/heads/main',
    after: 'a'.repeat(40),
  });
  const delivery = await processWebhookDelivery(context.db, context.config, deliveryId);
  assert.equal(delivery.status, 'success');
  assert.equal(delivery.responseStatus, 202);
  assert.equal(received.length, 1);
  assert.equal(received[0].headers['x-kukgit-event'], 'push');
  assert.equal(received[0].headers['x-kukgit-delivery'], deliveryId);
  const expectedSignature = `sha256=${crypto.createHmac('sha256', created.secret).update(received[0].body).digest('hex')}`;
  assert.equal(received[0].headers['x-kukgit-signature-256'], expectedSignature);
  const envelope = JSON.parse(received[0].body);
  assert.equal(envelope.repository.slug, context.repository.slug);
  assert.equal(envelope.data.ref, 'refs/heads/main');
});

test('retries failed deliveries, stops after five attempts and supports redelivery', async (t) => {
  const context = setup(t);
  let healthy = false;
  const receiver = http.createServer((_req, res) => {
    res.writeHead(healthy ? 204 : 500, { 'Content-Type': 'text/plain' });
    res.end(healthy ? '' : 'temporary receiver failure');
  });
  const receiverOrigin = await listen(receiver);
  t.after(() => new Promise((resolve) => receiver.close(resolve)));

  await createRepositoryWebhook(context.db, context.config, {
    repositoryId: context.repository.id,
    userId: context.owner.id,
    url: `${receiverOrigin}/retry`,
    events: ['issues'],
    secret: 'retry-secret-with-strong-length',
  });
  const [deliveryId] = enqueueWebhookEvent(context.db, context.repository.id, 'issues', { action: 'opened' });
  let delivery;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    context.db.prepare("UPDATE webhook_deliveries SET next_attempt_at = CURRENT_TIMESTAMP WHERE id = ?").run(deliveryId);
    delivery = await processWebhookDelivery(context.db, context.config, deliveryId);
    assert.equal(delivery.attemptCount, attempt);
    if (attempt < 5) assert.equal(delivery.status, 'pending');
  }
  assert.equal(delivery.status, 'failure');
  assert.equal(delivery.responseStatus, 500);
  assert.match(delivery.lastError, /HTTP 500/);

  healthy = true;
  resetWebhookDelivery(context.db, context.repository.id, deliveryId);
  delivery = await processWebhookDelivery(context.db, context.config, deliveryId);
  assert.equal(delivery.status, 'success');
  assert.equal(delivery.attemptCount, 1);
  assert.equal(delivery.responseStatus, 204);
});

test('production webhook targets require HTTPS and reject private networks', async () => {
  const config = loadConfig({ nodeEnv: 'production', webhookEncryptionKey: 'production-test-key' });
  await assert.rejects(
    resolveWebhookTarget(config, 'http://example.com/hook'),
    (error) => error.code === 'WEBHOOK_HTTPS_REQUIRED',
  );
  await assert.rejects(
    resolveWebhookTarget(config, 'https://127.0.0.1/hook'),
    (error) => error.code === 'WEBHOOK_PRIVATE_TARGET',
  );
  await assert.rejects(
    resolveWebhookTarget(config, 'https://user:pass@example.com/hook'),
    (error) => error.code === 'WEBHOOK_URL_CREDENTIALS',
  );
});

test('webhook API requires repository Admin permission and blocks cross-origin writes', async (t) => {
  const context = setup(t);
  const app = createApp({ config: context.config, db: context.db });
  const webhooksApi = createWebhooksApiHandler({ config: context.config, db: context.db });
  const server = http.createServer(async (req, res) => {
    if (await webhooksApi(req, res)) return;
    return app(req, res);
  });
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');
  const viewerCookie = await login(origin, 'viewer@example.com', 'secure-viewer-password');
  const base = `/api/webhooks/${encodeURIComponent(context.repository.orgSlug)}/${encodeURIComponent(context.repository.slug)}`;

  const ownerRead = await fetch(`${origin}${base}`, { headers: { Cookie: ownerCookie } });
  assert.equal(ownerRead.status, 200);

  const viewerCreate = await fetch(`${origin}${base}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
    body: JSON.stringify({ url: 'http://127.0.0.1:9999/hook', events: ['push'] }),
  });
  assert.equal(viewerCreate.status, 403);

  const crossOrigin = await fetch(`${origin}${base}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie, Origin: 'https://attacker.example' },
    body: JSON.stringify({ url: 'http://127.0.0.1:9999/hook', events: ['push'] }),
  });
  assert.equal(crossOrigin.status, 403);
});

test('automatic event capture queues successful repository activity only', async (t) => {
  const context = setup(t);
  await createRepositoryWebhook(context.db, context.config, {
    repositoryId: context.repository.id,
    userId: context.owner.id,
    url: 'http://127.0.0.1:9999/events',
    events: ['issues'],
    secret: 'automatic-event-secret-value',
  });

  const next = (_req, res) => {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ issue: { number: 7, title: 'Captured event' } }));
  };
  const capture = createWebhookEventCapture({ config: context.config, db: context.db, next });
  const server = http.createServer(capture);
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`${origin}/api/repos/${encodeURIComponent(context.repository.orgSlug)}/${encodeURIComponent(context.repository.slug)}/issues`, { method: 'POST' });
  assert.equal(response.status, 201);
  await new Promise((resolve) => setImmediate(resolve));
  const queued = context.db.prepare(`
    SELECT event, status, payload_json AS payloadJson FROM webhook_deliveries ORDER BY created_at DESC LIMIT 1
  `).get();
  assert.equal(queued.event, 'issues');
  assert.equal(queued.status, 'pending');
  assert.equal(JSON.parse(queued.payloadJson).response.issue.number, 7);

  const failedNext = (_req, res) => {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'validation failed' }));
  };
  const failedCapture = createWebhookEventCapture({ config: context.config, db: context.db, next: failedNext });
  const failedServer = http.createServer(failedCapture);
  const failedOrigin = await listen(failedServer);
  t.after(() => new Promise((resolve) => failedServer.close(resolve)));
  const before = context.db.prepare('SELECT COUNT(*) AS count FROM webhook_deliveries').get().count;
  await fetch(`${failedOrigin}/api/repos/${encodeURIComponent(context.repository.orgSlug)}/${encodeURIComponent(context.repository.slug)}/issues`, { method: 'POST' });
  await new Promise((resolve) => setImmediate(resolve));
  const after = context.db.prepare('SELECT COUNT(*) AS count FROM webhook_deliveries').get().count;
  assert.equal(after, before);
});
