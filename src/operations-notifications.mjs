import { createNotification, migrateNotifications } from './notifications.mjs';
import { leaseGate } from './job-leases.mjs';

function adminUser(db, config) {
  return db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE email = ?')
    .get(String(config.adminEmail || '').toLowerCase());
}

function redact(value) {
  return String(value ?? '')
    .replace(/(password|token|secret)=([^\s&]+)/gi, '$1=[REDACTED]')
    .replace(/kg(?:p|i|whsec|lfs)_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .slice(0, 1800);
}

export function scheduleWebhookFailureAlerts(db, config) {
  migrateNotifications(db);
  const admin = adminUser(db, config);
  if (!admin) return { candidates: 0, created: 0 };
  let rows;
  try {
    rows = db.prepare(`
      SELECT d.id, d.event, d.attempt_count AS attemptCount, d.response_status AS responseStatus,
        d.last_error AS lastError, d.created_at AS createdAt,
        w.id AS webhookId, w.url, r.id AS repositoryId, r.slug AS repoSlug,
        o.slug AS orgSlug
      FROM webhook_deliveries d
      JOIN repository_webhooks w ON w.id = d.webhook_id
      JOIN repositories r ON r.id = w.repository_id
      JOIN organizations o ON o.id = r.organization_id
      WHERE d.status = 'failure' AND d.attempt_count >= 5
      ORDER BY d.updated_at DESC LIMIT 100
    `).all();
  } catch {
    return { candidates: 0, created: 0 };
  }
  let created = 0;
  for (const row of rows) {
    const result = createNotification(db, config, {
      userId: admin.id,
      category: 'operations',
      title: `Webhook delivery failed for ${row.repoSlug}`,
      body: `${row.event} delivery exhausted ${row.attemptCount} attempts${row.responseStatus ? ` with HTTP ${row.responseStatus}` : ''}. ${redact(row.lastError || 'Review the delivery history for details.')}`,
      link: `#/repo/${row.orgSlug}/${row.repoSlug}/settings`,
      dedupeKey: `webhook-terminal-failure:${row.id}`,
      metadata: { deliveryId: row.id, webhookId: row.webhookId, repositoryId: row.repositoryId, event: row.event, attemptCount: row.attemptCount, responseStatus: row.responseStatus },
      email: {
        subject: `[${row.repoSlug}] KukGit webhook delivery failed`,
        text: `A ${row.event} webhook delivery for ${row.orgSlug}/${row.repoSlug} exhausted ${row.attemptCount} attempts${row.responseStatus ? ` with HTTP ${row.responseStatus}` : ''}.\n\n${redact(row.lastError || 'Review the KukGit delivery history for details.')}\n\nOpen KukGit: ${config.baseUrl}/#/repo/${row.orgSlug}/${row.repoSlug}/settings`,
      },
    });
    if (result.notification || result.email) created += 1;
  }
  return { candidates: rows.length, created };
}

function captureResponse(res) {
  const chunks = [];
  let size = 0;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  res.write = (chunk, encoding, callback) => {
    if (chunk && size < 256 * 1024) {
      const value = Buffer.from(chunk);
      chunks.push(value);
      size += value.length;
    }
    return originalWrite(chunk, encoding, callback);
  };
  res.end = (chunk, encoding, callback) => {
    if (chunk && size < 256 * 1024) {
      const value = Buffer.from(chunk);
      chunks.push(value);
      size += value.length;
    }
    return originalEnd(chunk, encoding, callback);
  };
  return () => {
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return null; }
  };
}

function isOperationalRoute(pathname, method) {
  if (!['POST', 'PUT'].includes(method)) return false;
  if (pathname === '/api/backups' || /^\/api\/backups\/[^/]+\/verify$/.test(pathname)) return true;
  if (pathname === '/api/lfs/gc') return true;
  if (/^\/api\/lfs\/[^/]+\/[^/]+\/objects\/[0-9a-f]{64}\/verify$/i.test(pathname)) return true;
  return false;
}

function operationalNotification(db, config, { title, body, link = '#/settings', dedupeKey, metadata, emailSubject }) {
  const admin = adminUser(db, config);
  if (!admin) return null;
  return createNotification(db, config, {
    userId: admin.id,
    category: 'operations',
    title,
    body: redact(body),
    link,
    dedupeKey,
    metadata,
    email: { subject: emailSubject || title, text: `${redact(body)}\n\nOpen KukGit: ${config.baseUrl}/${link}` },
  });
}

export function createOperationsNotificationCapture({ config, db, next }) {
  return async function operationsNotificationCapture(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const method = String(req.method || 'GET').toUpperCase();
    if (!isOperationalRoute(url.pathname, method)) return next(req, res);
    const readPayload = captureResponse(res);
    res.once('finish', () => {
      const payload = readPayload();
      try {
        const requestId = res.getHeader('X-Request-Id') || `${Date.now()}`;
        if (res.statusCode >= 400) {
          const error = payload?.error || payload || {};
          operationalNotification(db, config, {
            title: url.pathname.startsWith('/api/backups') ? 'KukGit backup operation failed' : 'Git LFS integrity operation failed',
            body: `${method} ${url.pathname} returned HTTP ${res.statusCode}. ${error.code ? `${error.code}: ` : ''}${error.message || 'Review server logs using the request ID.'}`,
            dedupeKey: `operation-failure:${requestId}`,
            metadata: { path: url.pathname, method, status: res.statusCode, code: error.code || null, requestId: String(requestId) },
          });
          return;
        }
        if (url.pathname === '/api/backups' && res.statusCode === 201 && payload?.backup) {
          operationalNotification(db, config, {
            title: 'Verified KukGit backup created',
            body: `${payload.backup.filename} was created and verified. Archive size: ${payload.backup.archiveSize || 0} bytes.`,
            dedupeKey: `backup-created:${payload.backup.backupId}`,
            metadata: { backupId: payload.backup.backupId, filename: payload.backup.filename, archiveSize: payload.backup.archiveSize, archiveSha256: payload.backup.archiveSha256 },
          });
        } else if (/^\/api\/backups\/[^/]+\/verify$/.test(url.pathname) && payload?.verification) {
          operationalNotification(db, config, {
            title: 'KukGit backup verification passed',
            body: `${url.pathname.split('/')[3]} passed metadata, Git and LFS verification.`,
            dedupeKey: `backup-verified:${payload.verification.backupId}:${payload.verification.archiveSha256}`,
            metadata: { backupId: payload.verification.backupId, archiveSha256: payload.verification.archiveSha256 },
          });
        } else if (url.pathname === '/api/lfs/gc' && payload?.result) {
          operationalNotification(db, config, {
            title: 'Git LFS garbage collection completed',
            body: `${payload.result.objectsRemoved || 0} orphan object(s) removed and ${payload.result.bytesRemoved || 0} bytes reclaimed.`,
            dedupeKey: `lfs-gc:${requestId}`,
            metadata: payload.result,
          });
        }
      } catch (error) {
        console.error(`[notifications] operational capture: ${redact(error?.message || error)}`);
      }
    });
    return next(req, res);
  };
}

export function startOperationalNotificationWorker(db, config, { gate = leaseGate(db, 'operational-alerts') } = {}) {
  let stopped = false;
  let running = false;
  async function tick() {
    if (stopped || running) return;
    // Alerts become email. One instance owns them, or an operator is paged once
    // per instance for the same condition.
    if (!gate()) return;
    running = true;
    try { scheduleWebhookFailureAlerts(db, config); }
    catch (error) { console.error(`[notifications] operational worker: ${redact(error?.message || error)}`); }
    finally { running = false; }
  }
  const timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref();
  setTimeout(tick, 500).unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
