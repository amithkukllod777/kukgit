import { currentUser, requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { sendSmtpMessage, smtpConfigured } from './email-transport.mjs';
import { recordSmtpRejection } from './email-provider-events.mjs';
import { httpError, normalizeEmail, originAllowed } from './security.mjs';

export const NOTIFICATION_CATEGORIES = Object.freeze([
  'organization',
  'security',
  'pull_request',
  'status',
  'operations',
]);

const CATEGORY_SET = new Set(NOTIFICATION_CATEGORIES);
const DEFAULT_EMAIL = Object.freeze({
  organization: true,
  security: true,
  pull_request: false,
  status: false,
  operations: true,
});
const MAX_BODY_BYTES = 64 * 1024;
const MAX_EMAIL_BODY = 2 * 1024 * 1024;

export function migrateNotifications(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK(category IN ('organization','security','pull_request','status','operations')),
      in_app_enabled INTEGER NOT NULL DEFAULT 1 CHECK(in_app_enabled IN (0,1)),
      email_enabled INTEGER NOT NULL DEFAULT 0 CHECK(email_enabled IN (0,1)),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, category)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK(category IN ('organization','security','pull_request','status','operations')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      link TEXT,
      dedupe_key TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, dedupe_key)
    );
    CREATE TABLE IF NOT EXISTS email_outbox (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      to_email TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('organization','security','pull_request','status','operations')),
      subject TEXT NOT NULL,
      text_body TEXT NOT NULL,
      html_body TEXT,
      dedupe_key TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed','cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 8,
      next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_attempt_at TEXT,
      sent_at TEXT,
      last_error TEXT,
      provider_response TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS email_delivery_attempts (
      id TEXT PRIMARY KEY,
      outbox_id TEXT NOT NULL REFERENCES email_outbox(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success','failure')),
      response_code INTEGER,
      response_text TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created
      ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
      ON notifications(user_id, read_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_outbox_due
      ON email_outbox(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_email_attempts_outbox
      ON email_delivery_attempts(outbox_id, attempt_number DESC);
  `);
  const users = db.prepare('SELECT id FROM users').all();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO notification_preferences
      (user_id, category, in_app_enabled, email_enabled)
    VALUES (?, ?, 1, ?)
  `);
  for (const user of users) {
    for (const category of NOTIFICATION_CATEGORIES) insert.run(user.id, category, DEFAULT_EMAIL[category] ? 1 : 0);
  }
}

function normalizeCategory(value) {
  const category = String(value ?? '').trim().toLowerCase();
  if (!CATEGORY_SET.has(category)) throw httpError(400, 'Notification category is invalid.', 'NOTIFICATION_CATEGORY_INVALID');
  return category;
}

function safeText(value, name, max) {
  const text = String(value ?? '').trim();
  if (!text) throw httpError(400, `${name} is required.`, 'NOTIFICATION_TEXT_REQUIRED');
  if (text.length > max) throw httpError(400, `${name} is too long.`, 'NOTIFICATION_TEXT_TOO_LONG');
  return text;
}

function safeLink(value) {
  const link = String(value ?? '').trim();
  if (!link) return null;
  if (link.length > 1000 || !link.startsWith('#/')) throw httpError(400, 'Notification link must be an internal KukGit route.', 'NOTIFICATION_LINK_INVALID');
  return link;
}

function safeDedupeKey(value, max = 240) {
  const key = String(value ?? '').trim();
  if (!key) return null;
  if (key.length > max || !/^[A-Za-z0-9:_./-]+$/.test(key)) throw httpError(400, 'Notification deduplication key is invalid.', 'NOTIFICATION_DEDUPE_KEY_INVALID');
  return key;
}

function metadataJson(value) {
  if (!value) return '{}';
  let text;
  try { text = JSON.stringify(value); }
  catch { throw httpError(400, 'Notification metadata must be JSON serializable.', 'NOTIFICATION_METADATA_INVALID'); }
  if (text.length > 10000) throw httpError(400, 'Notification metadata is too large.', 'NOTIFICATION_METADATA_TOO_LARGE');
  return text;
}

function preference(db, userId, category) {
  migrateNotifications(db);
  const row = db.prepare(`
    SELECT in_app_enabled AS inAppEnabled, email_enabled AS emailEnabled
    FROM notification_preferences WHERE user_id = ? AND category = ?
  `).get(userId, category);
  return row
    ? { inAppEnabled: Boolean(row.inAppEnabled), emailEnabled: Boolean(row.emailEnabled) }
    : { inAppEnabled: true, emailEnabled: Boolean(DEFAULT_EMAIL[category]) };
}

export function listNotificationPreferences(db, userId) {
  migrateNotifications(db);
  const rows = db.prepare(`
    SELECT category, in_app_enabled AS inAppEnabled, email_enabled AS emailEnabled,
      updated_at AS updatedAt
    FROM notification_preferences WHERE user_id = ? ORDER BY category
  `).all(userId);
  const map = new Map(rows.map((row) => [row.category, row]));
  return NOTIFICATION_CATEGORIES.map((category) => {
    const row = map.get(category);
    return row
      ? { ...row, inAppEnabled: Boolean(row.inAppEnabled), emailEnabled: Boolean(row.emailEnabled) }
      : { category, inAppEnabled: true, emailEnabled: Boolean(DEFAULT_EMAIL[category]), updatedAt: null };
  });
}

export function updateNotificationPreferences(db, userId, input) {
  migrateNotifications(db);
  if (!Array.isArray(input)) throw httpError(400, 'Notification preferences must be an array.', 'NOTIFICATION_PREFERENCES_INVALID');
  const byCategory = new Map(input.map((item) => [normalizeCategory(item.category), item]));
  const upsert = db.prepare(`
    INSERT INTO notification_preferences (user_id, category, in_app_enabled, email_enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, category) DO UPDATE SET
      in_app_enabled = excluded.in_app_enabled,
      email_enabled = excluded.email_enabled,
      updated_at = CURRENT_TIMESTAMP
  `);
  for (const category of NOTIFICATION_CATEGORIES) {
    const current = preference(db, userId, category);
    const item = byCategory.get(category);
    const inApp = item ? Boolean(item.inAppEnabled) : current.inAppEnabled;
    const email = item ? Boolean(item.emailEnabled) : current.emailEnabled;
    upsert.run(userId, category, inApp ? 1 : 0, email ? 1 : 0);
  }
  return listNotificationPreferences(db, userId);
}

export function queueTransactionalEmail(db, config, {
  userId = null,
  to,
  category,
  subject,
  text,
  html = null,
  dedupeKey = null,
  maxAttempts = config.emailMaxAttempts,
}) {
  migrateNotifications(db);
  const normalizedCategory = normalizeCategory(category);
  const recipient = normalizeEmail(to);
  const normalizedSubject = safeText(subject, 'Email subject', 500);
  if (/\r|\n/.test(normalizedSubject)) throw httpError(400, 'Email subject contains an invalid line break.', 'EMAIL_HEADER_INJECTION');
  const textBody = String(text ?? '').trim();
  const htmlBody = html === null || html === undefined ? null : String(html).trim();
  if (!textBody || Buffer.byteLength(textBody) > MAX_EMAIL_BODY) throw httpError(400, 'Email text body is required and must be within the size limit.', 'EMAIL_BODY_INVALID');
  if (htmlBody && Buffer.byteLength(htmlBody) > MAX_EMAIL_BODY) throw httpError(400, 'Email HTML body exceeds the size limit.', 'EMAIL_BODY_INVALID');
  const normalizedDedupe = safeDedupeKey(dedupeKey, 300);
  const attempts = Math.max(1, Math.min(Number(maxAttempts) || 8, 20));
  const id = uid('eml');
  try {
    db.prepare(`
      INSERT INTO email_outbox
        (id, user_id, to_email, category, subject, text_body, html_body, dedupe_key, max_attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, recipient, normalizedCategory, normalizedSubject, textBody, htmlBody, normalizedDedupe, attempts);
  } catch (error) {
    if (normalizedDedupe && String(error.message).includes('UNIQUE')) {
      return db.prepare(`
        SELECT id, status, created_at AS createdAt FROM email_outbox WHERE dedupe_key = ?
      `).get(normalizedDedupe);
    }
    throw error;
  }
  return { id, status: 'pending', createdAt: new Date().toISOString() };
}

export function createNotification(db, config, {
  userId,
  category,
  title,
  body,
  link = null,
  dedupeKey = null,
  metadata = null,
  email = null,
}) {
  migrateNotifications(db);
  const user = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(userId);
  if (!user) throw httpError(404, 'Notification recipient was not found.', 'NOTIFICATION_USER_NOT_FOUND');
  const normalizedCategory = normalizeCategory(category);
  const normalizedTitle = safeText(title, 'Notification title', 180);
  const normalizedBody = safeText(body, 'Notification body', 4000);
  const normalizedLink = safeLink(link);
  const normalizedDedupe = safeDedupeKey(dedupeKey);
  const prefs = preference(db, userId, normalizedCategory);
  let notification = null;
  if (prefs.inAppEnabled) {
    const id = uid('ntf');
    try {
      db.prepare(`
        INSERT INTO notifications
          (id, user_id, category, title, body, link, dedupe_key, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, userId, normalizedCategory, normalizedTitle, normalizedBody, normalizedLink, normalizedDedupe, metadataJson(metadata));
      notification = { id, userId, category: normalizedCategory, title: normalizedTitle, body: normalizedBody, link: normalizedLink };
    } catch (error) {
      if (normalizedDedupe && String(error.message).includes('UNIQUE')) {
        notification = db.prepare(`
          SELECT id, user_id AS userId, category, title, body, link
          FROM notifications WHERE user_id = ? AND dedupe_key = ?
        `).get(userId, normalizedDedupe);
      } else throw error;
    }
  }
  let emailRecord = null;
  if (email && prefs.emailEnabled) {
    emailRecord = queueTransactionalEmail(db, config, {
      userId,
      to: user.email,
      category: normalizedCategory,
      subject: email.subject ?? normalizedTitle,
      text: email.text ?? normalizedBody,
      html: email.html ?? null,
      dedupeKey: email.dedupeKey ?? (normalizedDedupe ? `email:${normalizedDedupe}` : null),
    });
  }
  return { notification, email: emailRecord };
}

export function notifyEmailAddress(db, config, {
  to,
  category,
  subject,
  text,
  html = null,
  dedupeKey = null,
}) {
  migrateNotifications(db);
  const email = normalizeEmail(to);
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (user) {
    const prefs = preference(db, user.id, normalizeCategory(category));
    if (!prefs.emailEnabled) return null;
  }
  return queueTransactionalEmail(db, config, { userId: user?.id ?? null, to: email, category, subject, text, html, dedupeKey });
}

function notificationRow(row) {
  let metadata = {};
  try { metadata = JSON.parse(row.metadataJson || '{}'); } catch {}
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    body: row.body,
    link: row.link,
    readAt: row.readAt,
    createdAt: row.createdAt,
    metadata,
  };
}

export function listNotifications(db, userId, { unreadOnly = false, limit = 100 } = {}) {
  migrateNotifications(db);
  const count = Math.max(1, Math.min(Number(limit) || 100, 250));
  const rows = unreadOnly
    ? db.prepare(`
        SELECT id, category, title, body, link, metadata_json AS metadataJson,
          read_at AS readAt, created_at AS createdAt
        FROM notifications WHERE user_id = ? AND read_at IS NULL
        ORDER BY created_at DESC LIMIT ?
      `).all(userId, count)
    : db.prepare(`
        SELECT id, category, title, body, link, metadata_json AS metadataJson,
          read_at AS readAt, created_at AS createdAt
        FROM notifications WHERE user_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(userId, count);
  const unreadCount = Number(db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).count);
  return { notifications: rows.map(notificationRow), unreadCount };
}

export function setNotificationRead(db, userId, notificationId, read) {
  migrateNotifications(db);
  const result = read
    ? db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE id = ? AND user_id = ?').run(notificationId, userId)
    : db.prepare('UPDATE notifications SET read_at = NULL WHERE id = ? AND user_id = ?').run(notificationId, userId);
  if (!result.changes) throw httpError(404, 'Notification not found.', 'NOTIFICATION_NOT_FOUND');
  return db.prepare(`
    SELECT id, category, title, body, link, metadata_json AS metadataJson,
      read_at AS readAt, created_at AS createdAt
    FROM notifications WHERE id = ?
  `).get(notificationId);
}

export function markAllNotificationsRead(db, userId) {
  migrateNotifications(db);
  const result = db.prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL').run(userId);
  return { updated: result.changes, unreadCount: 0 };
}

function redactError(error) {
  return String(error?.message || error || 'Email delivery failed.')
    .replace(/(AUTH\s+(?:PLAIN|LOGIN)\s+)[A-Za-z0-9+/=]+/gi, '$1[REDACTED]')
    .replace(/(password|token|secret)=([^\s&]+)/gi, '$1=[REDACTED]')
    .slice(0, 2000);
}

function retryDelaySeconds(attempt) {
  return Math.min(6 * 60 * 60, 60 * (2 ** Math.max(0, attempt - 1)));
}

function claimEmail(db, id) {
  const result = db.prepare(`
    UPDATE email_outbox
    SET status = 'processing', attempt_count = attempt_count + 1,
      last_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('pending','failed') AND next_attempt_at <= CURRENT_TIMESTAMP
      AND attempt_count < max_attempts
  `).run(id);
  if (!result.changes) return null;
  return db.prepare(`
    SELECT id, user_id AS userId, to_email AS toEmail, category, subject,
      text_body AS textBody, html_body AS htmlBody, attempt_count AS attemptCount,
      max_attempts AS maxAttempts
    FROM email_outbox WHERE id = ?
  `).get(id);
}

export async function processEmailOutbox(db, config, {
  sendEmail = sendSmtpMessage,
  limit = config.emailBatchSize,
} = {}) {
  migrateNotifications(db);
  if (!smtpConfigured(config)) return { configured: false, processed: 0, sent: 0, failed: 0 };
  const batch = Math.max(1, Math.min(Number(limit) || 20, 100));
  db.prepare(`
    UPDATE email_outbox SET status = 'failed', last_error = 'Delivery worker recovered an interrupted attempt.',
      next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE status = 'processing' AND last_attempt_at < datetime('now', '-15 minutes')
  `).run();
  const candidates = db.prepare(`
    SELECT id FROM email_outbox
    WHERE status IN ('pending','failed') AND next_attempt_at <= CURRENT_TIMESTAMP
      AND attempt_count < max_attempts
    ORDER BY next_attempt_at, created_at LIMIT ?
  `).all(batch);
  let sent = 0;
  let failed = 0;
  let suppressed = 0;
  for (const candidate of candidates) {
    const email = claimEmail(db, candidate.id);
    if (!email) continue;
    const startedAt = new Date().toISOString();
    try {
      const result = await sendEmail(config, {
        to: email.toEmail,
        subject: email.subject,
        text: email.textBody,
        html: email.htmlBody,
      });
      db.prepare(`
        UPDATE email_outbox SET status = 'sent', sent_at = CURRENT_TIMESTAMP,
          last_error = NULL, provider_response = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(String(result?.response || 'Accepted').slice(0, 2000), email.id);
      db.prepare(`
        INSERT INTO email_delivery_attempts
          (id, outbox_id, attempt_number, status, response_code, response_text, started_at, completed_at)
        VALUES (?, ?, ?, 'success', ?, ?, ?, ?)
      `).run(uid('eda'), email.id, email.attemptCount, result?.responseCode ?? null, String(result?.response || '').slice(0, 2000), startedAt, new Date().toISOString());
      sent += 1;
    } catch (error) {
      const message = redactError(error);
      // Record the attempt before suppression, so the failure that caused the
      // suppression stays visible in delivery history.
      db.prepare(`
        INSERT INTO email_delivery_attempts
          (id, outbox_id, attempt_number, status, response_code, error_message, started_at, completed_at)
        VALUES (?, ?, ?, 'failure', ?, ?, ?, ?)
      `).run(uid('eda'), email.id, email.attemptCount, Number(error?.smtpCode) || null, message, startedAt, new Date().toISOString());

      // A permanent rejection at RCPT TO proves the mailbox does not exist.
      // Suppressing here cancels this message and every queued one for the
      // address; the outbox triggers then block any further claim.
      const rejection = recordSmtpRejection(db, { email: email.toEmail, outboxId: email.id, error });
      if (rejection.suppressed) {
        // This message is mid-flight in 'processing', which the suppression's own
        // cancel sweep skips (it targets 'pending' and 'failed'). Cancel it
        // explicitly: once the address is suppressed the outbox trigger refuses
        // any move back to pending/failed/processing, so leaving it claimed would
        // strand the row permanently.
        db.prepare(`
          UPDATE email_outbox SET status = 'cancelled', last_error = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(`Recipient suppressed after a permanent SMTP rejection: ${message}`.slice(0, 2000), email.id);
        suppressed += 1;
        continue;
      }

      const terminal = email.attemptCount >= email.maxAttempts;
      const delay = retryDelaySeconds(email.attemptCount);
      db.prepare(`
        UPDATE email_outbox SET status = 'failed', last_error = ?,
          next_attempt_at = CASE WHEN ? THEN next_attempt_at ELSE datetime('now', '+' || ? || ' seconds') END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(message, terminal ? 1 : 0, delay, email.id);
      failed += 1;
    }
  }
  return { configured: true, processed: sent + failed + suppressed, sent, failed, suppressed };
}

export function retryOutboxEmail(db, id) {
  migrateNotifications(db);
  const result = db.prepare(`
    UPDATE email_outbox SET status = 'pending', next_attempt_at = CURRENT_TIMESTAMP,
      last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('failed','cancelled')
  `).run(id);
  if (!result.changes) throw httpError(404, 'Retryable email was not found.', 'EMAIL_OUTBOX_NOT_RETRYABLE');
  return { id, queued: true };
}

export function listEmailOutbox(db, { status = null, limit = 100 } = {}) {
  migrateNotifications(db);
  const count = Math.max(1, Math.min(Number(limit) || 100, 250));
  const validStatus = ['pending', 'processing', 'sent', 'failed', 'cancelled'].includes(status) ? status : null;
  const rows = validStatus
    ? db.prepare(`
        SELECT id, user_id AS userId, to_email AS toEmail, category, subject, status,
          attempt_count AS attemptCount, max_attempts AS maxAttempts,
          next_attempt_at AS nextAttemptAt, last_attempt_at AS lastAttemptAt,
          sent_at AS sentAt, last_error AS lastError, provider_response AS providerResponse,
          created_at AS createdAt, updated_at AS updatedAt
        FROM email_outbox WHERE status = ? ORDER BY created_at DESC LIMIT ?
      `).all(validStatus, count)
    : db.prepare(`
        SELECT id, user_id AS userId, to_email AS toEmail, category, subject, status,
          attempt_count AS attemptCount, max_attempts AS maxAttempts,
          next_attempt_at AS nextAttemptAt, last_attempt_at AS lastAttemptAt,
          sent_at AS sentAt, last_error AS lastError, provider_response AS providerResponse,
          created_at AS createdAt, updated_at AS updatedAt
        FROM email_outbox ORDER BY created_at DESC LIMIT ?
      `).all(count);
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS count FROM email_outbox GROUP BY status').all().map((row) => [row.status, Number(row.count)]));
  return { emails: rows, counts };
}

export function scheduleTokenExpiryNotifications(db, config, now = new Date()) {
  migrateNotifications(db);
  const rows = db.prepare(`
    SELECT p.id, p.user_id AS userId, p.name, p.token_prefix AS tokenPrefix,
      p.expires_at AS expiresAt
    FROM personal_access_tokens p
    WHERE p.revoked_at IS NULL AND p.expires_at IS NOT NULL
      AND p.expires_at > ? AND p.expires_at <= ?
  `).all(now.toISOString(), new Date(now.getTime() + 7 * 86400000).toISOString());
  let created = 0;
  for (const token of rows) {
    const milliseconds = new Date(token.expiresAt).getTime() - now.getTime();
    const days = Math.max(1, Math.ceil(milliseconds / 86400000));
    const bucket = days <= 1 ? 1 : days <= 3 ? 3 : 7;
    const result = createNotification(db, config, {
      userId: token.userId,
      category: 'security',
      title: `Personal access token expires in ${days} day${days === 1 ? '' : 's'}`,
      body: `The token “${token.name}” (${token.tokenPrefix}…) expires on ${new Date(token.expiresAt).toLocaleDateString('en-IN')}. Rotate it before expiry to avoid interrupted Git or integration access.`,
      link: '#/settings',
      dedupeKey: `pat-expiry:${token.id}:${bucket}`,
      metadata: { tokenId: token.id, expiresAt: token.expiresAt, daysRemaining: days },
      email: {
        subject: `KukGit token expires in ${days} day${days === 1 ? '' : 's'}`,
        text: `Your KukGit personal access token “${token.name}” (${token.tokenPrefix}…) expires on ${new Date(token.expiresAt).toLocaleString('en-IN')}. Create a replacement token and update every client before expiry. KukGit never includes the token secret in reminders.`,
      },
    });
    if (result.notification || result.email) created += 1;
  }
  return { candidates: rows.length, created };
}

export function startNotificationWorker(db, config, { sendEmail = sendSmtpMessage } = {}) {
  let stopped = false;
  let running = false;
  let lastTokenSweep = 0;
  const intervalMs = Math.max(5000, Math.min(Number(config.emailWorkerIntervalMs) || 30000, 60 * 60 * 1000));
  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      if (Date.now() - lastTokenSweep > 6 * 60 * 60 * 1000) {
        scheduleTokenExpiryNotifications(db, config);
        lastTokenSweep = Date.now();
      }
      await processEmailOutbox(db, config, { sendEmail });
    } catch (error) {
      console.error(`[notifications] worker: ${redactError(error)}`);
    } finally {
      running = false;
    }
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  setTimeout(tick, 100).unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function requireInstanceAdmin(config, user) {
  if (String(user.email || '').toLowerCase() !== String(config.adminEmail || '').toLowerCase()) {
    throw httpError(403, 'KukGit instance administrator access is required.', 'INSTANCE_ADMIN_REQUIRED');
  }
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'NOTIFICATION_REQUEST_TOO_LARGE');
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

export function createNotificationsApiHandler({ config, db }) {
  return async function handleNotificationsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/notifications')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);
      if (pathname === '/api/notifications' && req.method === 'GET') {
        const data = listNotifications(db, user.id, {
          unreadOnly: url.searchParams.get('unread') === 'true',
          limit: url.searchParams.get('limit'),
        });
        return sendJson(res, 200, { ...data, preferences: listNotificationPreferences(db, user.id) });
      }
      if (pathname === '/api/notifications/preferences' && req.method === 'GET') {
        return sendJson(res, 200, { preferences: listNotificationPreferences(db, user.id) });
      }
      if (pathname === '/api/notifications/preferences' && req.method === 'PUT') {
        const body = await readJson(req);
        const preferences = updateNotificationPreferences(db, user.id, body.preferences);
        audit(db, { userId: user.id, action: 'notification_preferences.updated', targetType: 'user', targetId: user.id });
        return sendJson(res, 200, { preferences });
      }
      if (pathname === '/api/notifications/read-all' && req.method === 'POST') {
        return sendJson(res, 200, markAllNotificationsRead(db, user.id));
      }
      let params = routeMatch(pathname, '/api/notifications/:id/read');
      if (params && req.method === 'POST') {
        return sendJson(res, 200, { notification: setNotificationRead(db, user.id, params.id, true) });
      }
      params = routeMatch(pathname, '/api/notifications/:id/unread');
      if (params && req.method === 'POST') {
        return sendJson(res, 200, { notification: setNotificationRead(db, user.id, params.id, false) });
      }
      if (pathname === '/api/notifications/admin/outbox' && req.method === 'GET') {
        requireInstanceAdmin(config, user);
        return sendJson(res, 200, {
          ...listEmailOutbox(db, { status: url.searchParams.get('status'), limit: url.searchParams.get('limit') }),
          configured: smtpConfigured(config),
        });
      }
      if (pathname === '/api/notifications/admin/process' && req.method === 'POST') {
        requireInstanceAdmin(config, user);
        const result = await processEmailOutbox(db, config);
        audit(db, { userId: user.id, action: 'email_outbox.processed', targetType: 'email_outbox', metadata: result });
        return sendJson(res, 200, { result });
      }
      params = routeMatch(pathname, '/api/notifications/admin/outbox/:id/retry');
      if (params && req.method === 'POST') {
        requireInstanceAdmin(config, user);
        const result = retryOutboxEmail(db, params.id);
        audit(db, { userId: user.id, action: 'email_outbox.retried', targetType: 'email_outbox', targetId: params.id });
        return sendJson(res, 200, { result });
      }
      throw httpError(404, 'Notification API endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] notifications API`, error);
      if (!res.headersSent) sendJson(res, status, { error: { code: error.code || 'INTERNAL_ERROR', message: status >= 500 ? 'An unexpected server error occurred.' : error.message, requestId } });
      else res.end();
    }
    return true;
  };
}

function repositoryRecipients(db, repositoryId, minimum = 'write') {
  const ranks = { read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };
  const minimumRank = ranks[minimum] ?? 3;
  const ids = new Set();
  const organizationMembers = db.prepare(`
    SELECT om.user_id AS userId, om.role
    FROM org_members om JOIN repositories r ON r.organization_id = om.organization_id
    WHERE r.id = ?
  `).all(repositoryId);
  const orgPermission = { owner: 5, admin: 5, maintainer: 4, developer: 3, viewer: 1 };
  for (const member of organizationMembers) if ((orgPermission[member.role] ?? 0) >= minimumRank) ids.add(member.userId);
  const direct = db.prepare('SELECT user_id AS userId, permission FROM repository_collaborators WHERE repository_id = ?').all(repositoryId);
  for (const member of direct) if ((ranks[member.permission] ?? 0) >= minimumRank) ids.add(member.userId);
  const teams = db.prepare(`
    SELECT tm.user_id AS userId, rta.permission
    FROM repository_team_access rta JOIN team_members tm ON tm.team_id = rta.team_id
    WHERE rta.repository_id = ?
  `).all(repositoryId);
  for (const member of teams) if ((ranks[member.permission] ?? 0) >= minimumRank) ids.add(member.userId);
  return [...ids];
}

export function notifyPullRequestCreated(db, config, { orgSlug, repoSlug, number, actorId }) {
  migrateNotifications(db);
  const pull = db.prepare(`
    SELECT p.id, p.number, p.title, p.author_id AS authorId, r.id AS repositoryId,
      r.name AS repositoryName, r.slug AS repoSlug, o.slug AS orgSlug
    FROM pull_requests p JOIN repositories r ON r.id = p.repository_id
    JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ? AND p.number = ?
  `).get(orgSlug, repoSlug, Number(number));
  if (!pull) return 0;
  let created = 0;
  for (const userId of repositoryRecipients(db, pull.repositoryId, 'write')) {
    if (userId === actorId) continue;
    const result = createNotification(db, config, {
      userId,
      category: 'pull_request',
      title: `Pull request #${pull.number} opened in ${pull.repoSlug}`,
      body: pull.title,
      link: `#/repo/${pull.orgSlug}/${pull.repoSlug}/pulls`,
      dedupeKey: `pr-opened:${pull.id}:${userId}`,
      metadata: { pullRequestId: pull.id, repositoryId: pull.repositoryId, number: pull.number },
      email: {
        subject: `[${pull.repoSlug}] Pull request #${pull.number}: ${pull.title}`,
        text: `A new pull request was opened in ${pull.orgSlug}/${pull.repoSlug}.\n\n#${pull.number} ${pull.title}\n\nOpen KukGit: ${config.baseUrl}/#/repo/${pull.orgSlug}/${pull.repoSlug}/pulls`,
      },
    });
    if (result.notification || result.email) created += 1;
  }
  return created;
}

export function notifyPullRequestMerged(db, config, { orgSlug, repoSlug, number, actorId }) {
  migrateNotifications(db);
  const pull = db.prepare(`
    SELECT p.id, p.number, p.title, p.author_id AS authorId, r.id AS repositoryId,
      r.slug AS repoSlug, o.slug AS orgSlug
    FROM pull_requests p JOIN repositories r ON r.id = p.repository_id
    JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ? AND p.number = ?
  `).get(orgSlug, repoSlug, Number(number));
  if (!pull || pull.authorId === actorId) return 0;
  const result = createNotification(db, config, {
    userId: pull.authorId,
    category: 'pull_request',
    title: `Pull request #${pull.number} merged`,
    body: `${pull.title} was merged into its base branch.`,
    link: `#/repo/${pull.orgSlug}/${pull.repoSlug}/pulls`,
    dedupeKey: `pr-merged:${pull.id}`,
    metadata: { pullRequestId: pull.id, repositoryId: pull.repositoryId, number: pull.number },
    email: {
      subject: `[${pull.repoSlug}] Pull request #${pull.number} merged`,
      text: `Your pull request was merged in ${pull.orgSlug}/${pull.repoSlug}.\n\n#${pull.number} ${pull.title}\n\nOpen KukGit: ${config.baseUrl}/#/repo/${pull.orgSlug}/${pull.repoSlug}/pulls`,
    },
  });
  return result.notification || result.email ? 1 : 0;
}

export function notifyPullRequestReview(db, config, { orgSlug, repoSlug, number, actorId, state }) {
  migrateNotifications(db);
  const pull = db.prepare(`
    SELECT p.id, p.number, p.title, p.author_id AS authorId, r.id AS repositoryId,
      r.slug AS repoSlug, o.slug AS orgSlug
    FROM pull_requests p JOIN repositories r ON r.id = p.repository_id
    JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ? AND p.number = ?
  `).get(orgSlug, repoSlug, Number(number));
  if (!pull || pull.authorId === actorId) return 0;
  const label = state === 'approved' ? 'approved' : state === 'changes_requested' ? 'requested changes on' : 'commented on';
  const result = createNotification(db, config, {
    userId: pull.authorId,
    category: 'pull_request',
    title: `Review ${label} pull request #${pull.number}`,
    body: pull.title,
    link: `#/repo/${pull.orgSlug}/${pull.repoSlug}/pulls`,
    dedupeKey: `pr-review:${pull.id}:${actorId}:${state}:${Date.now()}`,
    metadata: { pullRequestId: pull.id, repositoryId: pull.repositoryId, number: pull.number, reviewState: state },
    email: {
      subject: `[${pull.repoSlug}] Review update on pull request #${pull.number}`,
      text: `A reviewer ${label} your pull request in ${pull.orgSlug}/${pull.repoSlug}.\n\n#${pull.number} ${pull.title}\n\nOpen KukGit: ${config.baseUrl}/#/repo/${pull.orgSlug}/${pull.repoSlug}/pulls`,
    },
  });
  return result.notification || result.email ? 1 : 0;
}

export function notifyStatusFailure(db, config, { orgSlug, repoSlug, sha, context, state }) {
  migrateNotifications(db);
  if (!['failure', 'error'].includes(state)) return 0;
  const pulls = db.prepare(`
    SELECT p.id, p.number, p.title, p.author_id AS authorId, r.id AS repositoryId,
      r.slug AS repoSlug, o.slug AS orgSlug
    FROM pull_requests p JOIN repositories r ON r.id = p.repository_id
    JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ? AND p.status = 'open'
  `).all(orgSlug, repoSlug).filter((pull) => {
    try {
      const row = db.prepare(`SELECT head_sha AS headSha FROM pull_request_status_snapshots WHERE pull_request_id = ? ORDER BY created_at DESC LIMIT 1`).get(pull.id);
      return row?.headSha === sha;
    } catch { return false; }
  });
  let created = 0;
  for (const pull of pulls) {
    const result = createNotification(db, config, {
      userId: pull.authorId,
      category: 'status',
      title: `${context} reported ${state}`,
      body: `Required or reported status check failed for pull request #${pull.number}: ${pull.title}`,
      link: `#/repo/${pull.orgSlug}/${pull.repoSlug}/pulls`,
      dedupeKey: `status:${pull.id}:${sha}:${context}:${state}`,
      metadata: { pullRequestId: pull.id, repositoryId: pull.repositoryId, sha, context, state },
      email: {
        subject: `[${pull.repoSlug}] ${context} ${state} on PR #${pull.number}`,
        text: `The ${context} status check reported ${state} for pull request #${pull.number} in ${pull.orgSlug}/${pull.repoSlug}.\n\nOpen KukGit: ${config.baseUrl}/#/repo/${pull.orgSlug}/${pull.repoSlug}/pulls`,
      },
    });
    if (result.notification || result.email) created += 1;
  }
  return created;
}

function captureJsonResponse(res) {
  const chunks = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  res.write = (chunk, encoding, callback) => {
    if (chunk && chunks.reduce((sum, item) => sum + item.length, 0) < 512 * 1024) chunks.push(Buffer.from(chunk));
    return originalWrite(chunk, encoding, callback);
  };
  res.end = (chunk, encoding, callback) => {
    if (chunk && chunks.reduce((sum, item) => sum + item.length, 0) < 512 * 1024) chunks.push(Buffer.from(chunk));
    return originalEnd(chunk, encoding, callback);
  };
  return () => {
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return null; }
  };
}

export function createNotificationEventCapture({ config, db, next }) {
  return async function notificationEventCapture(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const method = String(req.method || 'GET').toUpperCase();
    const actor = currentUser(db, req);
    const readPayload = captureJsonResponse(res);
    res.once('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300 || method !== 'POST') return;
      const payload = readPayload();
      try {
        let match = url.pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/pulls$/);
        if (match && payload?.pullRequest?.number) {
          notifyPullRequestCreated(db, config, { orgSlug: decodeURIComponent(match[1]), repoSlug: decodeURIComponent(match[2]), number: payload.pullRequest.number, actorId: actor?.id });
          return;
        }
        match = url.pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/);
        if (match) {
          notifyPullRequestMerged(db, config, { orgSlug: decodeURIComponent(match[1]), repoSlug: decodeURIComponent(match[2]), number: Number(match[3]), actorId: actor?.id });
          return;
        }
        match = url.pathname.match(/^\/api\/governance\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/);
        if (match && payload?.review?.state) {
          notifyPullRequestReview(db, config, { orgSlug: decodeURIComponent(match[1]), repoSlug: decodeURIComponent(match[2]), number: Number(match[3]), actorId: actor?.id, state: payload.review.state });
          return;
        }
        match = url.pathname.match(/^\/api\/status-checks\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]{40})\/statuses$/);
        if (match && payload?.status) {
          notifyStatusFailure(db, config, { orgSlug: decodeURIComponent(match[1]), repoSlug: decodeURIComponent(match[2]), sha: match[3], context: payload.status.context, state: payload.status.state });
        }
      } catch (error) {
        console.error(`[notifications] event capture: ${redactError(error)}`);
      }
    });
    return next(req, res);
  };
}
