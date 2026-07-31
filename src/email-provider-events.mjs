import crypto from 'node:crypto';
import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { requireInstanceAdmin } from './instance-admin.mjs';
import { httpError, normalizeEmail, originAllowed } from './security.mjs';

const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_ADMIN_BYTES = 64 * 1024;
const EVENT_TYPES = new Set(['delivered', 'deferred', 'bounce', 'complaint']);

// Enhanced status codes (RFC 3463) that identify the mailbox itself as invalid.
const SMTP_HARD_ENHANCED = /^5\.(?:1\.(?:1|2|3|6|10)|2\.1|4\.4)$/;
// Capacity and size failures. The address is real and the mailbox is only
// temporarily unusable, so these must stay retryable.
const SMTP_SOFT_ENHANCED = /^5\.(?:2\.2|2\.3|3\.1|3\.4)$/;
// Basic codes that conventionally mean "no such mailbox" at RCPT TO. 552 is a
// quota failure and 554 is widely used for policy blocks, so both are excluded.
const SMTP_HARD_BASIC = new Set([550, 551, 553]);

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

export function migrateEmailProviderEvents(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_provider_events (
      id TEXT PRIMARY KEY,
      provider_event_id TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('delivered','deferred','bounce','complaint')),
      recipient TEXT NOT NULL,
      outbox_id TEXT REFERENCES email_outbox(id) ON DELETE SET NULL,
      severity TEXT,
      reason_code TEXT,
      occurred_at TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS email_recipient_health (
      email TEXT PRIMARY KEY,
      soft_bounce_count INTEGER NOT NULL DEFAULT 0,
      window_started_at TEXT,
      last_soft_bounce_at TEXT,
      last_delivered_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS email_suppressions (
      email TEXT PRIMARY KEY,
      reason TEXT NOT NULL CHECK(reason IN ('hard_bounce','complaint','soft_bounce_threshold','manual')),
      source_event_id TEXT REFERENCES email_provider_events(id) ON DELETE SET NULL,
      soft_bounce_count INTEGER NOT NULL DEFAULT 0,
      suppressed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT,
      reviewed_at TEXT,
      reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      review_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_email_provider_events_created
      ON email_provider_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_provider_events_recipient
      ON email_provider_events(recipient, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_suppressions_active
      ON email_suppressions(expires_at, suppressed_at DESC);
  `);
  if (tableExists(db, 'email_outbox')) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_email_outbox_cancel_suppressed_insert
      AFTER INSERT ON email_outbox
      WHEN EXISTS (
        SELECT 1 FROM email_suppressions s
        WHERE s.email = NEW.to_email
          AND (s.expires_at IS NULL OR julianday(s.expires_at) > julianday('now'))
      )
      BEGIN
        UPDATE email_outbox
        SET status = 'cancelled',
            last_error = 'Recipient is suppressed by email-delivery policy.',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_email_outbox_block_suppressed_claim
      BEFORE UPDATE OF status ON email_outbox
      WHEN NEW.status IN ('pending','failed','processing')
        AND EXISTS (
          SELECT 1 FROM email_suppressions s
          WHERE s.email = NEW.to_email
            AND (s.expires_at IS NULL OR julianday(s.expires_at) > julianday('now'))
        )
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
  }
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
  return true;
}

async function readRaw(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, 'Request body is too large.', 'EMAIL_PROVIDER_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(buffer) {
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

function signatureBuffer(value) {
  const raw = String(value || '').trim().replace(/^sha256=/i, '');
  if (!/^[a-f0-9]{64}$/i.test(raw)) return null;
  return Buffer.from(raw, 'hex');
}

export function verifyEmailProviderSignature(config, headers, rawBody, now = Date.now()) {
  const secret = String(config.emailProviderWebhookSecret || '');
  if (secret.length < 32) throw httpError(503, 'Email provider webhook secret is not configured.', 'EMAIL_PROVIDER_SECRET_MISSING');
  const timestampRaw = String(headers['x-kukgit-email-timestamp'] || '').trim();
  const timestamp = Number(timestampRaw);
  const tolerance = Number(config.emailProviderWebhookToleranceSeconds || 300);
  if (!Number.isInteger(timestamp) || timestamp <= 0) throw httpError(401, 'Email provider timestamp is invalid.', 'EMAIL_PROVIDER_TIMESTAMP_INVALID');
  if (Math.abs(Math.floor(now / 1000) - timestamp) > tolerance) throw httpError(401, 'Email provider request timestamp is stale.', 'EMAIL_PROVIDER_TIMESTAMP_STALE');
  const supplied = signatureBuffer(headers['x-kukgit-email-signature-256']);
  const expected = crypto.createHmac('sha256', secret).update(`${timestampRaw}.`).update(rawBody).digest();
  if (!supplied || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw httpError(401, 'Email provider signature is invalid.', 'EMAIL_PROVIDER_SIGNATURE_INVALID');
  }
}

function text(value, label, max = 200) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f]/.test(result)) throw httpError(400, `${label} is invalid.`, 'EMAIL_PROVIDER_EVENT_INVALID');
  return result;
}

function optionalText(value, max = 200) {
  if (value === null || value === undefined || value === '') return null;
  const result = String(value).trim();
  if (!result || result.length > max || /[\u0000-\u001f]/.test(result)) throw httpError(400, 'Email provider metadata is invalid.', 'EMAIL_PROVIDER_EVENT_INVALID');
  return result;
}

function normalizeEventType(payload) {
  const raw = String(payload.type ?? payload.event_type ?? payload.event ?? '').trim().toLowerCase().replaceAll('-', '_');
  if (['delivery', 'delivered', 'success'].includes(raw)) return 'delivered';
  if (['deferred', 'soft_bounce', 'temporary_failure'].includes(raw)) return 'deferred';
  if (['bounce', 'bounced', 'hard_bounce', 'permanent_failure'].includes(raw)) {
    return String(payload.severity || '').toLowerCase() === 'soft' ? 'deferred' : 'bounce';
  }
  if (['complaint', 'spam_complaint', 'complained'].includes(raw)) return 'complaint';
  throw httpError(400, 'Email provider event type is unsupported.', 'EMAIL_PROVIDER_EVENT_TYPE_UNSUPPORTED');
}

function occurredAt(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw httpError(400, 'Email provider event time is invalid.', 'EMAIL_PROVIDER_EVENT_TIME_INVALID');
  if (date.getTime() > Date.now() + 10 * 60 * 1000) throw httpError(400, 'Email provider event time is in the future.', 'EMAIL_PROVIDER_EVENT_TIME_INVALID');
  return date.toISOString();
}

export function activeEmailSuppression(db, email, now = new Date()) {
  migrateEmailProviderEvents(db);
  const recipient = normalizeEmail(email);
  const row = db.prepare(`
    SELECT email, reason, source_event_id AS sourceEventId, soft_bounce_count AS softBounceCount,
      suppressed_at AS suppressedAt, expires_at AS expiresAt, reviewed_at AS reviewedAt,
      reviewed_by AS reviewedBy, review_note AS reviewNote
    FROM email_suppressions
    WHERE email = ? AND (expires_at IS NULL OR expires_at > ?)
  `).get(recipient, now.toISOString());
  return row || null;
}

function cancelQueuedEmail(db, email) {
  if (!tableExists(db, 'email_outbox')) return 0;
  return db.prepare(`
    UPDATE email_outbox
    SET status = 'cancelled', last_error = 'Recipient is suppressed by email-delivery policy.',
      updated_at = CURRENT_TIMESTAMP
    WHERE to_email = ? AND status IN ('pending','failed')
  `).run(email).changes;
}

function suppress(db, { email, reason, eventId, softBounceCount = 0, expiresAt = null }) {
  db.prepare(`
    INSERT INTO email_suppressions
      (email, reason, source_event_id, soft_bounce_count, suppressed_at, expires_at, reviewed_at, reviewed_by, review_note)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, NULL, NULL, NULL)
    ON CONFLICT(email) DO UPDATE SET
      reason = excluded.reason,
      source_event_id = excluded.source_event_id,
      soft_bounce_count = excluded.soft_bounce_count,
      suppressed_at = CURRENT_TIMESTAMP,
      expires_at = excluded.expires_at,
      reviewed_at = NULL,
      reviewed_by = NULL,
      review_note = NULL
  `).run(email, reason, eventId, softBounceCount, expiresAt);
  return cancelQueuedEmail(db, email);
}

function recordSoftBounce(db, config, email, eventId, eventTime) {
  const windowDays = Number(config.emailSoftBounceWindowDays || 7);
  const threshold = Number(config.emailSoftBounceThreshold || 3);
  const prior = db.prepare(`
    SELECT soft_bounce_count AS count, window_started_at AS windowStartedAt
    FROM email_recipient_health WHERE email = ?
  `).get(email);
  const start = prior?.windowStartedAt ? new Date(prior.windowStartedAt) : null;
  const expired = !start || eventTime.getTime() - start.getTime() > windowDays * 86400000;
  const count = expired ? 1 : Number(prior.count || 0) + 1;
  const windowStartedAt = expired ? eventTime.toISOString() : prior.windowStartedAt;
  db.prepare(`
    INSERT INTO email_recipient_health
      (email, soft_bounce_count, window_started_at, last_soft_bounce_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(email) DO UPDATE SET
      soft_bounce_count = excluded.soft_bounce_count,
      window_started_at = excluded.window_started_at,
      last_soft_bounce_at = excluded.last_soft_bounce_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(email, count, windowStartedAt, eventTime.toISOString());
  if (count < threshold) return { count, suppressed: false, cancelled: 0 };
  const expiresAt = new Date(eventTime.getTime() + Number(config.emailSoftBounceSuppressionDays || 30) * 86400000).toISOString();
  const cancelled = suppress(db, { email, reason: 'soft_bounce_threshold', eventId, softBounceCount: count, expiresAt });
  return { count, suppressed: true, cancelled, expiresAt };
}

export function ingestEmailProviderEvent(db, config, payload, rawBody = Buffer.from(JSON.stringify(payload))) {
  migrateEmailProviderEvents(db);
  const providerEventId = text(payload.id ?? payload.provider_event_id ?? payload.event_id, 'Provider event ID', 240);
  const existing = db.prepare('SELECT id, event_type AS eventType FROM email_provider_events WHERE provider_event_id = ?').get(providerEventId);
  if (existing) return { duplicate: true, eventId: existing.id, eventType: existing.eventType };
  const provider = text(payload.provider ?? 'generic', 'Provider', 80).toLowerCase();
  const eventType = normalizeEventType(payload);
  const recipient = normalizeEmail(payload.recipient ?? payload.email ?? payload.to);
  const outboxId = optionalText(payload.outbox_id ?? payload.message_id, 160);
  const severity = optionalText(payload.severity, 40);
  const reasonCode = optionalText(payload.reason_code ?? payload.code, 120);
  const occurred = occurredAt(payload.occurred_at ?? payload.timestamp);
  const eventId = uid('epe');
  const digest = crypto.createHash('sha256').update(rawBody).digest('hex');
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO email_provider_events
        (id, provider_event_id, provider, event_type, recipient, outbox_id, severity,
         reason_code, occurred_at, payload_sha256, payload_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, providerEventId, provider, eventType, recipient, outboxId, severity, reasonCode, occurred, digest, rawBody.length);
    let result = { suppressed: false, cancelled: 0 };
    if (eventType === 'bounce') {
      result = { suppressed: true, cancelled: suppress(db, { email: recipient, reason: 'hard_bounce', eventId }) };
    } else if (eventType === 'complaint') {
      result = { suppressed: true, cancelled: suppress(db, { email: recipient, reason: 'complaint', eventId }) };
    } else if (eventType === 'deferred') {
      result = recordSoftBounce(db, config, recipient, eventId, new Date(occurred));
    } else {
      db.prepare(`
        INSERT INTO email_recipient_health
          (email, soft_bounce_count, window_started_at, last_delivered_at, updated_at)
        VALUES (?, 0, NULL, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(email) DO UPDATE SET
          soft_bounce_count = 0, window_started_at = NULL,
          last_delivered_at = excluded.last_delivered_at, updated_at = CURRENT_TIMESTAMP
      `).run(recipient, occurred);
    }
    audit(db, {
      action: 'email.provider_event_received',
      targetType: 'email_provider_event',
      targetId: eventId,
      metadata: {
        provider,
        eventType,
        recipientHash: crypto.createHash('sha256').update(recipient).digest('hex').slice(0, 16),
        suppressed: Boolean(result.suppressed),
      },
    });
    return result;
  });
  return { duplicate: false, eventId, eventType, recipient, ...transaction() };
}

export function listEmailSuppressions(db, { q = '', activeOnly = true, limit = 100 } = {}) {
  migrateEmailProviderEvents(db);
  const count = Math.max(1, Math.min(Number(limit) || 100, 250));
  const query = String(q || '').trim().toLowerCase();
  const where = [];
  const params = [];
  if (query) { where.push('s.email LIKE ?'); params.push(`%${query.replace(/[\\%_]/g, '\\$&')}%`); }
  if (activeOnly) where.push('(s.expires_at IS NULL OR s.expires_at > CURRENT_TIMESTAMP)');
  const rows = db.prepare(`
    SELECT s.email, s.reason, s.soft_bounce_count AS softBounceCount,
      s.suppressed_at AS suppressedAt, s.expires_at AS expiresAt,
      s.reviewed_at AS reviewedAt, s.review_note AS reviewNote,
      e.provider, e.event_type AS sourceEventType, e.provider_event_id AS providerEventId
    FROM email_suppressions s
    LEFT JOIN email_provider_events e ON e.id = s.source_event_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY s.suppressed_at DESC LIMIT ?
  `).all(...params, count);
  const stats = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN reason = 'hard_bounce' THEN 1 ELSE 0 END) AS hardBounces,
      SUM(CASE WHEN reason = 'complaint' THEN 1 ELSE 0 END) AS complaints,
      SUM(CASE WHEN reason = 'soft_bounce_threshold' THEN 1 ELSE 0 END) AS softBounceSuppressions
    FROM email_suppressions
  `).get();
  return { suppressions: rows, stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value || 0)])) };
}

export function listEmailProviderEvents(db, { limit = 100 } = {}) {
  migrateEmailProviderEvents(db);
  const count = Math.max(1, Math.min(Number(limit) || 100, 250));
  return db.prepare(`
    SELECT id, provider_event_id AS providerEventId, provider, event_type AS eventType,
      recipient, outbox_id AS outboxId, severity, reason_code AS reasonCode,
      occurred_at AS occurredAt, payload_sha256 AS payloadSha256,
      payload_bytes AS payloadBytes, created_at AS createdAt
    FROM email_provider_events ORDER BY created_at DESC LIMIT ?
  `).all(count);
}

export function unsuppressEmail(db, config, user, email, { confirmEmail, note = '' } = {}) {
  requireInstanceAdmin(config, user);
  const recipient = normalizeEmail(email);
  if (normalizeEmail(confirmEmail) !== recipient) throw httpError(400, 'Type the exact email address to confirm.', 'EMAIL_UNSUPPRESS_CONFIRMATION_INVALID');
  const reviewNote = String(note || '').trim();
  if (reviewNote.length < 3 || reviewNote.length > 1000) throw httpError(400, 'A review note of 3 to 1000 characters is required.', 'EMAIL_UNSUPPRESS_NOTE_INVALID');
  const existing = db.prepare('SELECT email, reason FROM email_suppressions WHERE email = ?').get(recipient);
  if (!existing) throw httpError(404, 'Email suppression was not found.', 'EMAIL_SUPPRESSION_NOT_FOUND');
  db.prepare('DELETE FROM email_suppressions WHERE email = ?').run(recipient);
  db.prepare(`
    UPDATE email_recipient_health SET soft_bounce_count = 0, window_started_at = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE email = ?
  `).run(recipient);
  audit(db, {
    userId: user.id,
    action: 'instance_support.email_unsuppressed',
    targetType: 'email_recipient',
    targetId: crypto.createHash('sha256').update(recipient).digest('hex').slice(0, 24),
    metadata: { previousReason: existing.reason, note: reviewNote.slice(0, 300) },
  });
  return { email: recipient, unsuppressed: true };
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

export function createEmailProviderEventsApiHandler({ config, db }) {
  return async function emailProviderEventsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (pathname === '/api/email-provider/events' && req.method === 'POST') {
      try {
        const raw = await readRaw(req, MAX_WEBHOOK_BYTES);
        verifyEmailProviderSignature(config, req.headers, raw);
        const result = ingestEmailProviderEvent(db, config, parseJson(raw), raw);
        return sendJson(res, result.duplicate ? 200 : 202, result);
      } catch (error) {
        const status = Number(error.status) || 500;
        return sendJson(res, status, { error: { code: error.code || 'EMAIL_PROVIDER_EVENT_FAILED', message: status >= 500 ? 'Email provider event processing failed.' : error.message } });
      }
    }

    const isAdminRoute = pathname.startsWith('/api/email-provider/admin/');
    const retryMatch = req.method === 'POST' && (routeMatch(pathname, '/api/instance-admin/email/:id/retry') || routeMatch(pathname, '/api/notifications/admin/email/:id/retry'));
    if (!isAdminRoute && !retryMatch) return false;
    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);
      requireInstanceAdmin(config, user);
      if (retryMatch) {
        const id = retryMatch.id;
        const outbox = db.prepare('SELECT to_email AS toEmail FROM email_outbox WHERE id = ?').get(id);
        if (outbox && activeEmailSuppression(db, outbox.toEmail)) throw httpError(409, 'Recipient is actively suppressed. Review and unsuppress the address before retrying.', 'EMAIL_RECIPIENT_SUPPRESSED');
        return false;
      }
      if (pathname === '/api/email-provider/admin/suppressions' && req.method === 'GET') {
        return sendJson(res, 200, listEmailSuppressions(db, {
          q: url.searchParams.get('q') || '',
          activeOnly: url.searchParams.get('active') !== 'false',
          limit: url.searchParams.get('limit'),
        }));
      }
      if (pathname === '/api/email-provider/admin/events' && req.method === 'GET') {
        return sendJson(res, 200, { events: listEmailProviderEvents(db, { limit: url.searchParams.get('limit') }) });
      }
      const unsuppress = routeMatch(pathname, '/api/email-provider/admin/suppressions/:email/unsuppress');
      if (unsuppress && req.method === 'POST') {
        const body = parseJson(await readRaw(req, MAX_ADMIN_BYTES));
        return sendJson(res, 200, unsuppressEmail(db, config, user, unsuppress.email, body));
      }
      return false;
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, { error: { code: error.code || 'EMAIL_PROVIDER_ADMIN_FAILED', message: status >= 500 ? 'Email delivery administration failed.' : error.message } });
    }
  };
}

// Synchronous SMTP rejections, as a second suppression signal alongside provider
// webhooks.
//
// The webhook path above covers providers that accept a message and report the
// failure later. This path covers the failure we observe ourselves, during the
// SMTP conversation. Both converge on the same `email_suppressions` table and the
// same admin review workflow.

function smtpEnhancedStatus(text) {
  const match = String(text ?? '').match(/\b([245]\.\d{1,3}\.\d{1,3})\b/);
  return match ? match[1] : null;
}

// Decides whether a delivery failure proves the recipient address is dead.
//
// Deliberately narrow. Mis-suppressing a valid address silently blackholes a real
// user, which is far worse than retrying a dead one, so anything ambiguous
// retries.
export function classifySmtpRejection(error) {
  const stage = error?.smtpStage ?? null;
  const code = Number(error?.smtpCode) || null;
  const enhanced = smtpEnhancedStatus(error?.message);
  const undecided = { suppress: false, reason: null, code, enhanced, stage };

  // Only the recipient handshake speaks about the recipient. A 5xx at MAIL FROM,
  // AUTH or DATA describes our sender, our credentials or the message body.
  if (stage !== 'recipient') return undecided;
  if (!code || code < 500) return undecided;
  if (enhanced && SMTP_SOFT_ENHANCED.test(enhanced)) return undecided;
  if (enhanced && SMTP_HARD_ENHANCED.test(enhanced)) {
    return { suppress: true, reason: 'hard_bounce', code, enhanced, stage };
  }
  // An enhanced code that is neither clearly hard nor soft — 5.7.x policy and
  // reputation blocks, for example — is ambiguous. Leave the address alone.
  if (enhanced) return undecided;
  if (SMTP_HARD_BASIC.has(code)) {
    return { suppress: true, reason: 'hard_bounce', code, enhanced, stage };
  }
  return undecided;
}

// Records a permanent SMTP rejection and suppresses the recipient.
//
// A synthetic `email_provider_events` row with provider `smtp` keeps one audit
// trail for both signals and satisfies the `source_event_id` foreign key, so the
// admin console shows SMTP-observed and provider-reported suppressions the same
// way. The provider event ID is derived from the outbox ID, which makes the write
// idempotent for a given message.
export function recordSmtpRejection(db, { email, outboxId = null, error, occurredAt = new Date() }) {
  migrateEmailProviderEvents(db);
  const verdict = classifySmtpRejection(error);
  if (!verdict.suppress) return { ...verdict, suppressed: false, cancelled: 0 };

  const recipient = normalizeEmail(email);
  const detail = String(error?.message ?? '').slice(0, 2000);
  const eventId = uid('epe');
  const providerEventId = `smtp:${outboxId ?? recipient}`;
  try {
    db.prepare(`
      INSERT INTO email_provider_events
        (id, provider_event_id, provider, event_type, recipient, outbox_id,
         severity, reason_code, occurred_at, payload_sha256, payload_bytes)
      VALUES (?, ?, 'smtp', 'bounce', ?, ?, 'permanent', ?, ?, ?, ?)
    `).run(
      eventId,
      providerEventId,
      recipient,
      outboxId,
      verdict.enhanced ?? (verdict.code === null ? null : String(verdict.code)),
      occurredAt.toISOString(),
      crypto.createHash('sha256').update(detail).digest('hex'),
      Buffer.byteLength(detail),
    );
  } catch (insertError) {
    // Already recorded for this message. Suppression below is idempotent, so fall
    // through rather than losing the suppression.
    if (!String(insertError.message).includes('UNIQUE')) throw insertError;
  }

  const existing = db.prepare('SELECT id FROM email_provider_events WHERE provider_event_id = ?').get(providerEventId);
  const cancelled = suppress(db, {
    email: recipient,
    reason: verdict.reason,
    eventId: existing?.id ?? eventId,
    expiresAt: null,
  });
  audit(db, {
    action: 'email.suppressed',
    targetType: 'email_suppression',
    targetId: recipient,
    metadata: { reason: verdict.reason, source: 'smtp', responseCode: verdict.code, enhancedCode: verdict.enhanced },
  });
  return { ...verdict, suppressed: true, cancelled };
}
