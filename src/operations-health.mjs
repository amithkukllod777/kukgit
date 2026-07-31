import fs from 'node:fs';
import path from 'node:path';
import { requireInstanceAdmin } from './instance-admin.mjs';
import { requireUser } from './auth.mjs';
import { listBackupSnapshots } from './backups.mjs';
import { uid } from './db.mjs';

import { KUKGIT_VERSION } from './version.mjs';

export const OPERATIONS_HEALTH_FORMAT = 'kukgit-operations-health-v1';

const STATE_RANK = { ok: 0, warning: 1, critical: 2 };

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

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

// A signal states the measurement, the two thresholds it was judged against and
// the verdict. Alerting rules live here rather than in the monitoring system so
// that every deployment alerts on the same numbers.
function signal(name, { value, warning, critical, unit = 'count', detail = null, higherIsWorse = true }) {
  let state = 'ok';
  if (higherIsWorse) {
    if (critical !== null && value >= critical) state = 'critical';
    else if (warning !== null && value >= warning) state = 'warning';
  } else {
    if (critical !== null && value <= critical) state = 'critical';
    else if (warning !== null && value <= warning) state = 'warning';
  }
  return { name, value, unit, warning, critical, state, ...(detail ? { detail } : {}) };
}

function ageSeconds(timestamp) {
  if (!timestamp) return 0;
  const parsed = Date.parse(String(timestamp).endsWith('Z') || String(timestamp).includes('T')
    ? timestamp
    : `${String(timestamp).replace(' ', 'T')}Z`);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round((Date.now() - parsed) / 1000));
}

// Backlog depth alone is a poor signal: a queue can be deep and draining fine, or
// shallow and completely stuck. Both the depth and the age of the oldest waiting
// item are reported so the difference is visible.
function queueSignals(db, { table, prefix, pendingStatuses, thresholds }) {
  if (!tableExists(db, table)) return [];
  const placeholders = pendingStatuses.map(() => '?').join(', ');
  const backlog = db.prepare(`
    SELECT COUNT(*) AS depth, MIN(created_at) AS oldest
    FROM ${table} WHERE status IN (${placeholders})
  `).get(...pendingStatuses);
  const stuck = db.prepare(`
    SELECT COUNT(*) AS count FROM ${table}
    WHERE status = 'processing' AND julianday('now') - julianday(updated_at) > ?
  `).get(thresholds.stuckMinutes / (24 * 60));

  return [
    signal(`${prefix}.backlog_depth`, {
      value: Number(backlog.depth || 0),
      warning: thresholds.depthWarning,
      critical: thresholds.depthCritical,
    }),
    signal(`${prefix}.oldest_waiting_age`, {
      value: Number(backlog.depth || 0) ? ageSeconds(backlog.oldest) : 0,
      warning: thresholds.ageWarningSeconds,
      critical: thresholds.ageCriticalSeconds,
      unit: 'seconds',
    }),
    // A row stuck in `processing` means a worker claimed it and died. Nothing
    // retries it, so any non-zero count is already a fault.
    signal(`${prefix}.stuck_processing`, {
      value: Number(stuck.count || 0),
      warning: 1,
      critical: 1,
      detail: `claimed but not completed for over ${thresholds.stuckMinutes} minutes`,
    }),
  ];
}

function storageSignals(config, db) {
  const signals = [];

  const databasePath = config.databasePath;
  if (fs.existsSync(databasePath)) {
    signals.push(signal('storage.database_bytes', {
      value: fs.statSync(databasePath).size,
      warning: config.saturation.databaseWarningBytes,
      critical: config.saturation.databaseCriticalBytes,
      unit: 'bytes',
      detail: 'SQLite metadata file; migrate to PostgreSQL before this becomes the constraint',
    }));
  }

  if (tableExists(db, 'lfs_objects')) {
    const lfs = db.prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM lfs_objects').get();
    const used = Number(lfs.bytes || 0);
    const quota = Number(config.lfsInstanceQuotaBytes || 0);
    signals.push(signal('storage.lfs_quota_used', {
      value: quota ? Math.round((used / quota) * 100) : 0,
      warning: config.saturation.quotaWarningPercent,
      critical: config.saturation.quotaCriticalPercent,
      unit: 'percent',
      detail: `${used} of ${quota} bytes`,
    }));
  }

  // Free space is the signal that turns every other queue red at once when it
  // runs out, so it is measured on the volume that actually holds the data.
  try {
    const stats = fs.statfsSync(config.dataDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    signals.push(signal('storage.volume_free', {
      value: totalBytes ? Math.round((freeBytes / totalBytes) * 100) : 100,
      warning: config.saturation.diskFreeWarningPercent,
      critical: config.saturation.diskFreeCriticalPercent,
      unit: 'percent',
      higherIsWorse: false,
      detail: `${freeBytes} of ${totalBytes} bytes free on the data volume`,
    }));
  } catch {
    // statfs is unavailable on some platforms; the absent signal is preferable
    // to a fabricated one.
  }

  return signals;
}

function backupSignals(config) {
  let snapshots = [];
  try { snapshots = listBackupSnapshots(config); } catch { snapshots = []; }
  const newest = snapshots[0];
  return [
    signal('backups.newest_age', {
      // No backup at all is reported as the maximum age rather than zero, so an
      // instance that has never taken one does not read as freshly backed up.
      value: newest ? ageSeconds(newest.createdAt) : Number.MAX_SAFE_INTEGER,
      warning: config.saturation.backupAgeWarningSeconds,
      critical: config.saturation.backupAgeCriticalSeconds,
      unit: 'seconds',
      detail: newest ? `snapshot ${newest.filename}` : 'no snapshot has ever been taken',
    }),
    signal('backups.retained', {
      value: snapshots.length,
      warning: 2,
      critical: 1,
      higherIsWorse: false,
    }),
  ];
}

function realtimeSignals(config, realtime) {
  // The WebSocket server is constructed after the dispatch chain, so callers may
  // pass a getter instead of the server itself.
  const server = typeof realtime === 'function' ? realtime() : realtime;
  if (!server || typeof server.stats !== 'function') return [];
  const connections = Number(server.stats()?.activeConnections || 0);
  const cap = Number(config.realtimeMaxConnections || 0);
  return [signal('realtime.connection_capacity', {
    value: cap ? Math.round((connections / cap) * 100) : 0,
    warning: config.saturation.quotaWarningPercent,
    critical: config.saturation.quotaCriticalPercent,
    unit: 'percent',
    detail: `${connections} of ${cap} sockets on this instance`,
  })];
}

/**
 * Collects every saturation signal with its verdict.
 *
 * Deliberately contains no user data: counts, ages, sizes and percentages only.
 * The result is safe to forward to a monitoring system.
 */
export function collectOperationalHealth(config, db, { realtime = null } = {}) {
  const signals = [
    ...queueSignals(db, {
      table: 'email_outbox',
      prefix: 'email',
      pendingStatuses: ['pending', 'failed'],
      thresholds: {
        depthWarning: config.saturation.queueDepthWarning,
        depthCritical: config.saturation.queueDepthCritical,
        ageWarningSeconds: config.saturation.queueAgeWarningSeconds,
        ageCriticalSeconds: config.saturation.queueAgeCriticalSeconds,
        stuckMinutes: config.saturation.stuckProcessingMinutes,
      },
    }),
    ...queueSignals(db, {
      table: 'webhook_deliveries',
      prefix: 'webhooks',
      pendingStatuses: ['pending'],
      thresholds: {
        depthWarning: config.saturation.queueDepthWarning,
        depthCritical: config.saturation.queueDepthCritical,
        ageWarningSeconds: config.saturation.queueAgeWarningSeconds,
        ageCriticalSeconds: config.saturation.queueAgeCriticalSeconds,
        stuckMinutes: config.saturation.stuckProcessingMinutes,
      },
    }),
    ...storageSignals(config, db),
    ...backupSignals(config),
    ...realtimeSignals(config, realtime),
  ];

  const status = signals.reduce(
    (worst, entry) => (STATE_RANK[entry.state] > STATE_RANK[worst] ? entry.state : worst),
    'ok',
  );

  return {
    format: OPERATIONS_HEALTH_FORMAT,
    status,
    service: 'kukgit',
    version: KUKGIT_VERSION,
    uptimeSeconds: Math.floor(process.uptime()),
    // Every worker is an in-process interval on this node. Until that changes,
    // a second instance against the same volume double-fires all of them, so the
    // instance identity belongs in the health output.
    instance: { pid: process.pid, singleNode: true },
    signals,
    degraded: signals.filter((entry) => entry.state !== 'ok').map((entry) => entry.name),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Readiness, as distinct from liveness: can this instance actually serve?
 *
 * Returns no detail to unauthenticated callers — a load balancer needs the
 * status code, and an attacker should not learn which subsystem is failing.
 */
export function readinessProbe(config, db) {
  const checks = [];
  try {
    db.prepare('SELECT 1').get();
    checks.push({ name: 'database', ready: true });
  } catch {
    checks.push({ name: 'database', ready: false });
  }
  try {
    fs.accessSync(config.repositoriesDir, fs.constants.W_OK);
    checks.push({ name: 'repository_storage', ready: true });
  } catch {
    checks.push({ name: 'repository_storage', ready: false });
  }
  try {
    fs.accessSync(path.dirname(config.databasePath), fs.constants.W_OK);
    checks.push({ name: 'data_volume_writable', ready: true });
  } catch {
    checks.push({ name: 'data_volume_writable', ready: false });
  }
  return { ready: checks.every((check) => check.ready), checks };
}

export function createOperationsHealthApiHandler({ config, db, realtime = null }) {
  return async function operationsHealthApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    if (req.method !== 'GET') return false;

    if (url.pathname === '/api/health/ready') {
      const probe = readinessProbe(config, db);
      return sendJson(res, probe.ready ? 200 : 503, { status: probe.ready ? 'ready' : 'not_ready' });
    }

    if (url.pathname !== '/api/instance-admin/health') return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      // Saturation detail is operational intelligence about the whole instance.
      // It stays behind the same operator allowlist as the rest of the console.
      requireInstanceAdmin(config, requireUser(db, req));
      const health = collectOperationalHealth(config, db, { realtime });
      const probe = readinessProbe(config, db);
      return sendJson(res, 200, { ...health, readiness: probe, requestId });
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'OPERATIONS_HEALTH_FAILED',
          message: status >= 500 ? 'Operational health is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}

