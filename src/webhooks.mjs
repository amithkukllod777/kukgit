import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { currentUser, requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { requireRepositoryAccess } from './repository-access.mjs';
import { assertSlug, httpError, originAllowed } from './security.mjs';
import { leaseGate, requeueStranded } from './job-leases.mjs';

export const WEBHOOK_EVENTS = Object.freeze(['push', 'issues', 'pull_request', 'review', 'status', 'repository', 'ping']);
const EVENT_SET = new Set(WEBHOOK_EVENTS);
const DELIVERY_STATES = new Set(['pending', 'processing', 'success', 'failure']);
const MAX_BODY_BYTES = 96 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ATTEMPTS = 5;
const RETRY_SECONDS = [60, 300, 1800, 7200];
const DELIVERY_TIMEOUT_MS = 10000;

export function migrateWebhooks(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repository_webhooks (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      events_json TEXT NOT NULL,
      secret_ciphertext TEXT NOT NULL,
      secret_iv TEXT NOT NULL,
      secret_tag TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_by TEXT NOT NULL REFERENCES users(id),
      updated_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL REFERENCES repository_webhooks(id) ON DELETE CASCADE,
      event TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','success','failure')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      response_status INTEGER,
      response_headers_json TEXT,
      response_body TEXT,
      last_error TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_repository_webhooks_repo
      ON repository_webhooks(repository_id, active, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_queue
      ON webhook_deliveries(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook
      ON webhook_deliveries(webhook_id, created_at DESC);
  `);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'WEBHOOK_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

function routeMatch(pathname, pattern) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  }) + '$');
  const match = pathname.match(regex);
  if (!match) return null;
  try { return Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])); }
  catch { throw httpError(400, 'Invalid request path.', 'INVALID_PATH'); }
}

function encryptionKey(config) {
  const source = String(config.webhookEncryptionKey ?? '').trim();
  if (!source) throw httpError(503, 'Webhook secret encryption is not configured.', 'WEBHOOK_ENCRYPTION_NOT_CONFIGURED');
  return crypto.createHash('sha256').update(source).digest();
}

function encryptSecret(config, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(config), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptSecret(config, row) {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(config),
      Buffer.from(row.secretIv ?? row.secret_iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(row.secretTag ?? row.secret_tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(row.secretCiphertext ?? row.secret_ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw httpError(500, 'Webhook secret could not be decrypted.', 'WEBHOOK_SECRET_DECRYPTION_FAILED');
  }
}

function newWebhookSecret() {
  return `kgwhsec_${crypto.randomBytes(32).toString('base64url')}`;
}

function normalizeSecret(value) {
  const secret = String(value ?? '').trim() || newWebhookSecret();
  if (secret.length < 16 || secret.length > 256) {
    throw httpError(400, 'Webhook secret must be between 16 and 256 characters.', 'WEBHOOK_SECRET_INVALID');
  }
  return secret;
}

export function normalizeWebhookEvents(input) {
  const values = Array.isArray(input) ? input : String(input ?? '').split(',');
  const events = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  if (!events.length) throw httpError(400, 'Select at least one webhook event.', 'WEBHOOK_EVENTS_REQUIRED');
  const invalid = events.filter((event) => event !== '*' && !EVENT_SET.has(event));
  if (invalid.length) throw httpError(400, `Unsupported webhook event: ${invalid.join(', ')}.`, 'WEBHOOK_EVENT_INVALID');
  return events;
}

function isPrivateIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && octets[2] === 2) ||
    (a === 198 && b === 18) || (a === 198 && b === 19) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224;
}

function isPrivateAddress(address) {
  const normalized = String(address).toLowerCase();
  if (normalized.startsWith('::ffff:')) return isPrivateIpv4(normalized.slice(7));
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family !== 6) return true;
  return normalized === '::' || normalized === '::1' ||
    normalized.startsWith('fc') || normalized.startsWith('fd') ||
    normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
    normalized.startsWith('fea') || normalized.startsWith('feb') ||
    normalized.startsWith('ff') || normalized.startsWith('2001:db8');
}

function isDevelopmentLoopback(config, hostname, address) {
  if (config.isProduction) return false;
  return ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase()) ||
    address === '127.0.0.1' || address === '::1';
}

export async function resolveWebhookTarget(config, value) {
  let target;
  try { target = new URL(String(value ?? '').trim()); }
  catch { throw httpError(400, 'Enter a valid webhook URL.', 'WEBHOOK_URL_INVALID'); }
  if (target.username || target.password) throw httpError(400, 'Webhook URLs cannot include credentials.', 'WEBHOOK_URL_CREDENTIALS');
  if (target.hash) throw httpError(400, 'Webhook URLs cannot include fragments.', 'WEBHOOK_URL_FRAGMENT');
  if (!['https:', 'http:'].includes(target.protocol)) throw httpError(400, 'Webhook URL must use HTTPS.', 'WEBHOOK_URL_PROTOCOL');
  if (config.isProduction && target.protocol !== 'https:') throw httpError(400, 'Production webhooks require HTTPS.', 'WEBHOOK_HTTPS_REQUIRED');
  if (target.toString().length > 2048) throw httpError(400, 'Webhook URL is too long.', 'WEBHOOK_URL_TOO_LONG');

  let addresses;
  const literalFamily = net.isIP(target.hostname);
  if (literalFamily) addresses = [{ address: target.hostname, family: literalFamily }];
  else {
    try { addresses = await dns.lookup(target.hostname, { all: true, verbatim: true }); }
    catch { throw httpError(400, 'Webhook hostname could not be resolved.', 'WEBHOOK_DNS_FAILED'); }
  }
  const allowed = addresses.filter(({ address }) => !isPrivateAddress(address) || isDevelopmentLoopback(config, target.hostname, address));
  if (!allowed.length) throw httpError(400, 'Webhook targets cannot use private, loopback, link-local or reserved networks.', 'WEBHOOK_PRIVATE_TARGET');
  const selected = allowed[0];
  return { target, address: selected.address, family: selected.family };
}

function webhookEvents(row) {
  try { return normalizeWebhookEvents(JSON.parse(row.eventsJson ?? row.events_json)); }
  catch { return []; }
}

function webhookDto(row) {
  return {
    id: row.id,
    repositoryId: row.repositoryId ?? row.repository_id,
    url: row.url,
    events: webhookEvents(row),
    active: Boolean(row.active),
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  };
}

function deliveryDto(row) {
  let headers = null;
  try { headers = row.responseHeadersJson || row.response_headers_json ? JSON.parse(row.responseHeadersJson ?? row.response_headers_json) : null; }
  catch { headers = null; }
  return {
    id: row.id,
    webhookId: row.webhookId ?? row.webhook_id,
    event: row.event,
    status: row.status,
    attemptCount: Number(row.attemptCount ?? row.attempt_count ?? 0),
    nextAttemptAt: row.nextAttemptAt ?? row.next_attempt_at,
    responseStatus: row.responseStatus ?? row.response_status,
    responseHeaders: headers,
    responseBody: row.responseBody ?? row.response_body,
    lastError: row.lastError ?? row.last_error,
    deliveredAt: row.deliveredAt ?? row.delivered_at,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  };
}

function findRepository(db, orgSlug, repoSlug) {
  return db.prepare(`
    SELECT r.id, r.slug, r.name, r.visibility, r.default_branch AS defaultBranch,
      r.organization_id AS organizationId, o.slug AS orgSlug, o.name AS orgName
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ?
  `).get(orgSlug, repoSlug);
}

function repositoryForAccess(db, access) {
  const repository = findRepository(db, access.repository.orgSlug, access.repository.slug);
  if (!repository) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
  return repository;
}

export function listRepositoryWebhooks(db, repositoryId) {
  return db.prepare(`
    SELECT id, repository_id AS repositoryId, url, events_json AS eventsJson,
      active, created_at AS createdAt, updated_at AS updatedAt
    FROM repository_webhooks WHERE repository_id = ? ORDER BY created_at DESC
  `).all(repositoryId).map(webhookDto);
}

export function listWebhookDeliveries(db, repositoryId, limit = 100) {
  const count = Math.max(1, Math.min(Number(limit) || 100, 250));
  return db.prepare(`
    SELECT d.id, d.webhook_id AS webhookId, d.event, d.status,
      d.attempt_count AS attemptCount, d.next_attempt_at AS nextAttemptAt,
      d.response_status AS responseStatus, d.response_headers_json AS responseHeadersJson,
      d.response_body AS responseBody, d.last_error AS lastError,
      d.delivered_at AS deliveredAt, d.created_at AS createdAt, d.updated_at AS updatedAt
    FROM webhook_deliveries d JOIN repository_webhooks w ON w.id = d.webhook_id
    WHERE w.repository_id = ? ORDER BY d.created_at DESC LIMIT ?
  `).all(repositoryId, count).map(deliveryDto);
}

export async function createRepositoryWebhook(db, config, { repositoryId, userId, url, events, secret, active = true }) {
  const resolved = await resolveWebhookTarget(config, url);
  const normalizedEvents = normalizeWebhookEvents(events);
  const plaintextSecret = normalizeSecret(secret);
  const encrypted = encryptSecret(config, plaintextSecret);
  const id = uid('whk');
  db.prepare(`
    INSERT INTO repository_webhooks
      (id, repository_id, url, events_json, secret_ciphertext, secret_iv, secret_tag, active, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    repositoryId,
    resolved.target.toString(),
    JSON.stringify(normalizedEvents),
    encrypted.ciphertext,
    encrypted.iv,
    encrypted.tag,
    active ? 1 : 0,
    userId,
    userId,
  );
  const row = db.prepare(`
    SELECT id, repository_id AS repositoryId, url, events_json AS eventsJson, active,
      created_at AS createdAt, updated_at AS updatedAt
    FROM repository_webhooks WHERE id = ?
  `).get(id);
  return { webhook: webhookDto(row), secret: plaintextSecret };
}

function findWebhook(db, repositoryId, webhookId, includeSecret = false) {
  const secretFields = includeSecret ? ', secret_ciphertext AS secretCiphertext, secret_iv AS secretIv, secret_tag AS secretTag' : '';
  return db.prepare(`
    SELECT id, repository_id AS repositoryId, url, events_json AS eventsJson, active,
      created_at AS createdAt, updated_at AS updatedAt ${secretFields}
    FROM repository_webhooks WHERE id = ? AND repository_id = ?
  `).get(webhookId, repositoryId);
}

export async function updateRepositoryWebhook(db, config, { repositoryId, webhookId, userId, body }) {
  const existing = findWebhook(db, repositoryId, webhookId, true);
  if (!existing) throw httpError(404, 'Webhook not found.', 'WEBHOOK_NOT_FOUND');
  const url = body.url === undefined ? existing.url : (await resolveWebhookTarget(config, body.url)).target.toString();
  const events = body.events === undefined ? webhookEvents(existing) : normalizeWebhookEvents(body.events);
  const active = body.active === undefined ? Boolean(existing.active) : Boolean(body.active);
  let encrypted = {
    ciphertext: existing.secretCiphertext,
    iv: existing.secretIv,
    tag: existing.secretTag,
  };
  let rotatedSecret = null;
  if (body.rotateSecret || body.secret) {
    rotatedSecret = normalizeSecret(body.secret);
    encrypted = encryptSecret(config, rotatedSecret);
  }
  db.prepare(`
    UPDATE repository_webhooks SET url = ?, events_json = ?, active = ?,
      secret_ciphertext = ?, secret_iv = ?, secret_tag = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND repository_id = ?
  `).run(url, JSON.stringify(events), active ? 1 : 0, encrypted.ciphertext, encrypted.iv, encrypted.tag, userId, webhookId, repositoryId);
  return { webhook: webhookDto(findWebhook(db, repositoryId, webhookId)), secret: rotatedSecret };
}

function eventMatches(events, event) {
  return events.includes('*') || events.includes(event);
}

function repositoryPayload(db, repositoryId) {
  return db.prepare(`
    SELECT r.id, r.slug, r.name, r.visibility, r.default_branch AS defaultBranch,
      o.id AS organizationId, o.slug AS organizationSlug, o.name AS organizationName
    FROM repositories r JOIN organizations o ON o.id = r.organization_id WHERE r.id = ?
  `).get(repositoryId);
}

function insertDelivery(db, webhookId, event, payload) {
  const id = uid('whd');
  db.prepare(`
    INSERT INTO webhook_deliveries (id, webhook_id, event, payload_json)
    VALUES (?, ?, ?, ?)
  `).run(id, webhookId, event, JSON.stringify(payload ?? {}));
  return id;
}

export function enqueueWebhookEvent(db, repositoryId, event, payload = {}) {
  if (!EVENT_SET.has(event)) throw httpError(400, `Unsupported webhook event '${event}'.`, 'WEBHOOK_EVENT_INVALID');
  const hooks = db.prepare(`
    SELECT id, events_json AS eventsJson FROM repository_webhooks
    WHERE repository_id = ? AND active = 1
  `).all(repositoryId);
  const deliveryIds = [];
  for (const hook of hooks) {
    if (!eventMatches(webhookEvents(hook), event)) continue;
    deliveryIds.push(insertDelivery(db, hook.id, event, payload));
  }
  return deliveryIds;
}

function enqueueWebhookPing(db, webhookId, payload = {}) {
  return insertDelivery(db, webhookId, 'ping', payload);
}

function signPayload(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function safeResponseHeaders(headers) {
  const allowed = ['content-type', 'x-request-id', 'retry-after', 'server'];
  return Object.fromEntries(allowed.filter((name) => headers[name] !== undefined).map((name) => [name, String(headers[name]).slice(0, 1000)]));
}

function requestWebhook(targetInfo, { body, headers }) {
  const { target, address, family } = targetInfo;
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: 'POST',
      path: `${target.pathname}${target.search}`,
      servername: target.hostname,
      headers,
      timeout: DELIVERY_TIMEOUT_MS,
      lookup: (_hostname, _options, callback) => callback(null, address, family),
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        if (size >= MAX_RESPONSE_BYTES) return;
        const remaining = MAX_RESPONSE_BYTES - size;
        const value = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(value);
        size += value.length;
      });
      response.on('end', () => resolve({
        statusCode: Number(response.statusCode || 0),
        headers: safeResponseHeaders(response.headers),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('timeout', () => request.destroy(new Error('Webhook delivery timed out.')));
    request.on('error', reject);
    request.end(body);
  });
}

function deliveryRecord(db, deliveryId) {
  return db.prepare(`
    SELECT d.id, d.webhook_id AS webhookId, d.event, d.payload_json AS payloadJson,
      d.status, d.attempt_count AS attemptCount, d.next_attempt_at AS nextAttemptAt,
      d.response_status AS responseStatus, d.response_headers_json AS responseHeadersJson,
      d.response_body AS responseBody, d.last_error AS lastError,
      d.delivered_at AS deliveredAt, d.created_at AS createdAt, d.updated_at AS updatedAt,
      w.repository_id AS repositoryId, w.url, w.active,
      w.secret_ciphertext AS secretCiphertext, w.secret_iv AS secretIv, w.secret_tag AS secretTag
    FROM webhook_deliveries d JOIN repository_webhooks w ON w.id = d.webhook_id
    WHERE d.id = ?
  `).get(deliveryId);
}

export async function processWebhookDelivery(db, config, deliveryId) {
  const claimed = db.prepare(`
    UPDATE webhook_deliveries SET status = 'processing', attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending' AND datetime(next_attempt_at) <= datetime('now')
  `).run(deliveryId);
  if (!claimed.changes) return deliveryRecord(db, deliveryId) ? deliveryDto(deliveryRecord(db, deliveryId)) : null;

  const delivery = deliveryRecord(db, deliveryId);
  try {
    if (!delivery.active) throw new Error('Webhook is disabled.');
    const targetInfo = await resolveWebhookTarget(config, delivery.url);
    const repository = repositoryPayload(db, delivery.repositoryId);
    const data = JSON.parse(delivery.payloadJson || '{}');
    const envelope = {
      id: delivery.id,
      event: delivery.event,
      createdAt: delivery.createdAt,
      repository,
      data,
    };
    const body = JSON.stringify(envelope);
    const secret = decryptSecret(config, delivery);
    const response = await requestWebhook(targetInfo, {
      body,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'KukGit-Hookshot/0.1',
        'X-KukGit-Event': delivery.event,
        'X-KukGit-Delivery': delivery.id,
        'X-KukGit-Signature-256': signPayload(secret, body),
      },
    });
    const successful = response.statusCode >= 200 && response.statusCode < 300;
    if (!successful) throw Object.assign(new Error(`Webhook endpoint returned HTTP ${response.statusCode}.`), { webhookResponse: response });
    db.prepare(`
      UPDATE webhook_deliveries SET status = 'success', response_status = ?, response_headers_json = ?,
        response_body = ?, last_error = NULL, delivered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(response.statusCode, JSON.stringify(response.headers), response.body, delivery.id);
  } catch (error) {
    const response = error.webhookResponse;
    const exhausted = delivery.attemptCount >= MAX_ATTEMPTS;
    const delay = RETRY_SECONDS[Math.min(Math.max(delivery.attemptCount - 1, 0), RETRY_SECONDS.length - 1)];
    db.prepare(`
      UPDATE webhook_deliveries SET status = ?, next_attempt_at = datetime('now', ?),
        response_status = ?, response_headers_json = ?, response_body = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      exhausted ? 'failure' : 'pending',
      `+${delay} seconds`,
      response?.statusCode ?? null,
      response ? JSON.stringify(response.headers) : null,
      response?.body ?? null,
      String(error.message || 'Webhook delivery failed.').slice(0, 2000),
      delivery.id,
    );
  }
  return deliveryDto(deliveryRecord(db, delivery.id));
}

export function resetWebhookDelivery(db, repositoryId, deliveryId) {
  const result = db.prepare(`
    UPDATE webhook_deliveries SET status = 'pending', attempt_count = 0,
      next_attempt_at = CURRENT_TIMESTAMP, response_status = NULL, response_headers_json = NULL,
      response_body = NULL, last_error = NULL, delivered_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND webhook_id IN (SELECT id FROM repository_webhooks WHERE repository_id = ?)
  `).run(deliveryId, repositoryId);
  if (!result.changes) throw httpError(404, 'Webhook delivery not found.', 'WEBHOOK_DELIVERY_NOT_FOUND');
}

export async function processNextWebhookDelivery(db, config) {
  const row = db.prepare(`
    SELECT id FROM webhook_deliveries
    WHERE status = 'pending' AND datetime(next_attempt_at) <= datetime('now')
    ORDER BY created_at LIMIT 1
  `).get();
  if (!row) return null;
  return processWebhookDelivery(db, config, row.id);
}

/**
 * Delivers queued webhooks on whichever instance holds the `webhooks` lease.
 *
 * The gate is checked again between deliveries. A batch runs up to ten, and an
 * instance that loses the lease part-way through would otherwise keep sending
 * alongside the instance that took over — every remaining delivery in the batch
 * arriving twice at somebody's endpoint.
 */
export function startWebhookWorker(db, config, { intervalMs = 2000, gate = leaseGate(db, 'webhooks') } = {}) {
  let active = false;
  const run = async () => {
    if (active) return;
    if (!gate()) return;
    active = true;
    try {
      // Rows a worker claimed and never finished, reclaimed by age. Resetting
      // every `processing` row — which this did at startup — resurrects work
      // another instance is performing right now, and the visible result is a
      // delivery that arrives twice.
      requeueStranded(db, { table: 'webhook_deliveries', extraSet: "next_attempt_at = CURRENT_TIMESTAMP" });
      for (let index = 0; index < 10; index += 1) {
        if (!gate.holds()) break;
        const processed = await processNextWebhookDelivery(db, config);
        if (!processed) break;
      }
    } catch (error) {
      console.error('KukGit webhook worker', error);
    } finally {
      active = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  queueMicrotask(run);
  return () => { clearInterval(timer); gate.release?.(); };
}

function webhookPayload(db, repository) {
  return {
    repository,
    availableEvents: WEBHOOK_EVENTS,
    webhooks: listRepositoryWebhooks(db, repository.id),
    deliveries: listWebhookDeliveries(db, repository.id),
  };
}

export function createWebhooksApiHandler({ config, db }) {
  return async function handleWebhooksApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/webhooks/')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);

      let params = routeMatch(pathname, '/api/webhooks/:org/:repo');
      if (params && req.method === 'GET') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        return sendJson(res, 200, webhookPayload(db, repositoryForAccess(db, access)));
      }
      if (params && req.method === 'POST') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = repositoryForAccess(db, access);
        const body = await readJson(req);
        const created = await createRepositoryWebhook(db, config, {
          repositoryId: repository.id,
          userId: user.id,
          url: body.url,
          events: body.events,
          secret: body.secret,
          active: body.active !== false,
        });
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: 'webhook.created',
          targetType: 'repository_webhook',
          targetId: created.webhook.id,
          metadata: { repository: repository.slug, url: created.webhook.url, events: created.webhook.events },
        });
        return sendJson(res, 201, {
          ...created,
          warning: 'Copy this webhook secret now. KukGit will not reveal it again.',
        });
      }

      params = routeMatch(pathname, '/api/webhooks/:org/:repo/:webhookId/ping');
      if (params && req.method === 'POST') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = repositoryForAccess(db, access);
        const webhook = findWebhook(db, repository.id, params.webhookId);
        if (!webhook) throw httpError(404, 'Webhook not found.', 'WEBHOOK_NOT_FOUND');
        const deliveryId = enqueueWebhookPing(db, webhook.id, {
          zen: 'KukGit webhooks are ready.',
          sender: { id: user.id, displayName: user.displayName, email: user.email },
        });
        const delivery = await processWebhookDelivery(db, config, deliveryId);
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: 'webhook.pinged',
          targetType: 'repository_webhook',
          targetId: webhook.id,
          metadata: { repository: repository.slug, deliveryId },
        });
        return sendJson(res, 200, { delivery });
      }

      params = routeMatch(pathname, '/api/webhooks/:org/:repo/deliveries/:deliveryId/redeliver');
      if (params && req.method === 'POST') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = repositoryForAccess(db, access);
        resetWebhookDelivery(db, repository.id, params.deliveryId);
        const delivery = await processWebhookDelivery(db, config, params.deliveryId);
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: 'webhook_delivery.redelivered',
          targetType: 'webhook_delivery',
          targetId: params.deliveryId,
          metadata: { repository: repository.slug },
        });
        return sendJson(res, 200, { delivery });
      }

      params = routeMatch(pathname, '/api/webhooks/:org/:repo/:webhookId');
      if (params && req.method === 'PATCH') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = repositoryForAccess(db, access);
        const updated = await updateRepositoryWebhook(db, config, {
          repositoryId: repository.id,
          webhookId: params.webhookId,
          userId: user.id,
          body: await readJson(req),
        });
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: updated.secret ? 'webhook.secret_rotated' : 'webhook.updated',
          targetType: 'repository_webhook',
          targetId: params.webhookId,
          metadata: { repository: repository.slug, url: updated.webhook.url, events: updated.webhook.events, active: updated.webhook.active },
        });
        return sendJson(res, 200, {
          ...updated,
          warning: updated.secret ? 'Copy the rotated secret now. KukGit will not reveal it again.' : undefined,
        });
      }
      if (params && req.method === 'DELETE') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = repositoryForAccess(db, access);
        const result = db.prepare('DELETE FROM repository_webhooks WHERE id = ? AND repository_id = ?')
          .run(params.webhookId, repository.id);
        if (!result.changes) throw httpError(404, 'Webhook not found.', 'WEBHOOK_NOT_FOUND');
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: 'webhook.deleted',
          targetType: 'repository_webhook',
          targetId: params.webhookId,
          metadata: { repository: repository.slug },
        });
        return sendJson(res, 200, { deleted: true });
      }

      throw httpError(404, 'Webhook API endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] webhook API`, error);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: {
            code: error.code || 'INTERNAL_ERROR',
            message: status >= 500 ? 'An unexpected server error occurred.' : error.message,
            requestId,
          },
        });
      } else res.end();
    }
    return true;
  };
}

function eventDescriptor(pathname, method) {
  const candidates = [
    { regex: /^\/api\/status-checks\/([^/]+)\/([^/]+)\/commits\/[^/]+\/statuses$/, methods: ['POST'], event: 'status' },
    { regex: /^\/api\/repos\/([^/]+)\/([^/]+)\/issues(?:\/[^/]+)?$/, methods: ['POST', 'PATCH'], event: 'issues' },
    { regex: /^\/api\/repos\/([^/]+)\/([^/]+)\/pulls(?:\/[^/]+\/merge)?$/, methods: ['POST'], event: 'pull_request' },
    { regex: /^\/api\/governance\/([^/]+)\/([^/]+)\/pulls\/[^/]+\/reviews$/, methods: ['POST'], event: 'review' },
    { regex: /^\/api\/review-threads\/([^/]+)\/([^/]+)\/pulls\/[^/]+\/threads(?:\/.*)?$/, methods: ['POST'], event: 'review' },
    { regex: /^\/api\/repos\/([^/]+)\/([^/]+)\/(?:branches|files)(?:\/.*)?$/, methods: ['POST', 'PUT', 'PATCH'], event: 'push' },
    { regex: /^\/git\/([^/]+)\/([^/]+)\.git\/git-receive-pack$/, methods: ['POST'], event: 'push' },
  ];
  for (const candidate of candidates) {
    if (!candidate.methods.includes(method)) continue;
    const match = pathname.match(candidate.regex);
    if (match) {
      try { return { event: candidate.event, org: decodeURIComponent(match[1]), repo: decodeURIComponent(match[2]) }; }
      catch { return null; }
    }
  }
  return null;
}

function safeJsonResponse(chunks) {
  if (!chunks.length) return null;
  const body = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(body); }
  catch { return null; }
}

export function createWebhookEventCapture({ config, db, next }) {
  return async function webhookEventCapture(req, res) {
    const url = new URL(req.url, config.baseUrl);
    if (url.pathname.startsWith('/api/webhooks/')) return next(req, res);
    const descriptor = eventDescriptor(url.pathname, req.method || 'GET');
    if (!descriptor) return next(req, res);
    const repository = findRepository(db, descriptor.org, descriptor.repo);
    if (!repository) return next(req, res);
    const actor = currentUser(db, req);
    const chunks = [];
    let capturedBytes = 0;
    let ended = false;
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    res.write = (chunk, encoding, callback) => {
      if (chunk && capturedBytes < MAX_BODY_BYTES) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        const remaining = MAX_BODY_BYTES - capturedBytes;
        chunks.push(value.length > remaining ? value.subarray(0, remaining) : value);
        capturedBytes += Math.min(value.length, remaining);
      }
      return originalWrite(chunk, encoding, callback);
    };
    res.end = (chunk, encoding, callback) => {
      if (chunk && capturedBytes < MAX_BODY_BYTES) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        const remaining = MAX_BODY_BYTES - capturedBytes;
        chunks.push(value.length > remaining ? value.subarray(0, remaining) : value);
      }
      const result = originalEnd(chunk, encoding, callback);
      if (!ended) {
        ended = true;
        queueMicrotask(() => {
          if (res.statusCode < 200 || res.statusCode >= 300) return;
          try {
            enqueueWebhookEvent(db, repository.id, descriptor.event, {
              action: `${String(req.method || 'GET').toLowerCase()}:${url.pathname}`,
              sender: actor ? { id: actor.id, displayName: actor.displayName, email: actor.email } : null,
              response: safeJsonResponse(chunks),
              occurredAt: new Date().toISOString(),
            });
          } catch (error) {
            console.error('KukGit webhook event capture', error);
          }
        });
      }
      return result;
    };
    return next(req, res);
  };
}
