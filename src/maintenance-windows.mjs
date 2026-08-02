import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { setMaintenanceState } from './backups.mjs';
import { httpError, originAllowed } from './security.mjs';

export const MAINTENANCE = {
  // A planned window announced with less than this much notice is not planned.
  // Somebody has a deploy running, a build queued, a release going out — and the
  // point of a window is that they could have known.
  plannedNoticeMinutes: 24 * 60,
  // How far ahead of its planned start a window may actually begin. Without it,
  // an approved window scheduled for next month is a standing licence to take
  // the instance down today.
  earlyStartMinutes: 30,
  maximumHours: 12,
  minimumReasonLength: 20,
  kinds: ['planned', 'expedited', 'emergency'],
};

export function migrateMaintenanceWindows(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_windows (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'planned',
      reason TEXT NOT NULL DEFAULT '',
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      notice_minutes INTEGER NOT NULL DEFAULT 0,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      approved_at TEXT,
      started_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      started_at TEXT,
      ended_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      ended_at TEXT,
      cancelled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      cancelled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_maintenance_windows_schedule
      ON maintenance_windows(starts_at DESC);
  `);
}

function isoOrThrow(value, label) {
  const at = new Date(String(value ?? ''));
  if (Number.isNaN(at.getTime())) throw httpError(422, `${label} must be a valid timestamp.`, 'MAINTENANCE_TIME_INVALID');
  return at;
}

function shape(row, now = new Date()) {
  if (!row) return null;
  const startsAt = new Date(row.starts_at);
  const endsAt = new Date(row.ends_at);
  const status = row.cancelled_at ? 'cancelled'
    : row.ended_at ? 'completed'
      : row.started_at ? 'in_progress'
        : row.approved_at ? 'approved' : 'scheduled';
  return {
    id: row.id,
    summary: row.summary,
    detail: row.detail,
    kind: row.kind,
    reason: row.reason,
    status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    noticeMinutes: Number(row.notice_minutes),
    // Planned against actual, because "we were down for twenty minutes" should
    // be something anybody can check rather than something somebody remembers.
    startedAt: row.started_at,
    endedAt: row.ended_at,
    plannedMinutes: Math.round((endsAt - startsAt) / 60000),
    actualMinutes: row.started_at && row.ended_at
      ? Math.round((new Date(row.ended_at) - new Date(row.started_at)) / 60000)
      : null,
    approvedAt: row.approved_at,
    cancelledAt: row.cancelled_at,
    upcoming: status === 'scheduled' || status === 'approved' ? endsAt > now : false,
  };
}

/**
 * Schedules a window.
 *
 * The notice period is recorded rather than enforced, and the window is labelled
 * by how much of it there was. A rule that refused anything under 24 hours would
 * be worked around by whoever needs to fix something tonight, and the honest
 * record would be the first casualty. So: schedule it, and let the label say
 * what kind of window this really was.
 */
export function scheduleMaintenanceWindow(db, {
  summary, detail = '', startsAt, endsAt, kind = 'planned', reason = '', userId, now = new Date(),
}) {
  const title = String(summary ?? '').trim();
  if (title.length < 8) throw httpError(422, 'A window needs a summary of at least 8 characters.', 'MAINTENANCE_SUMMARY_REQUIRED');
  if (!MAINTENANCE.kinds.includes(kind)) throw httpError(422, `Kind must be one of ${MAINTENANCE.kinds.join(', ')}.`, 'MAINTENANCE_KIND_INVALID');

  const start = isoOrThrow(startsAt, 'Start');
  const end = isoOrThrow(endsAt, 'End');
  if (end <= start) throw httpError(422, 'A window must end after it starts.', 'MAINTENANCE_RANGE_INVALID');
  if (end - start > MAINTENANCE.maximumHours * 3600_000) {
    throw httpError(422, `A window may not be longer than ${MAINTENANCE.maximumHours} hours.`, 'MAINTENANCE_TOO_LONG');
  }

  const noticeMinutes = Math.round((start - now) / 60000);
  // Anything short-notice has to say why. "Planned" is a claim about how much
  // warning people had, and a window with two hours' notice is not planned
  // however it was labelled.
  const shortNotice = noticeMinutes < MAINTENANCE.plannedNoticeMinutes;
  const written = String(reason ?? '').trim();
  const resolvedKind = kind === 'planned' && shortNotice ? 'expedited' : kind;
  if (resolvedKind !== 'planned' && written.length < MAINTENANCE.minimumReasonLength) {
    throw httpError(422, `An ${resolvedKind} window needs a reason of at least ${MAINTENANCE.minimumReasonLength} characters.`, 'MAINTENANCE_REASON_REQUIRED');
  }

  const overlapping = db.prepare(`
    SELECT id FROM maintenance_windows
    WHERE cancelled_at IS NULL AND ended_at IS NULL AND starts_at < ? AND ends_at > ?
  `).get(end.toISOString(), start.toISOString());
  // Two overlapping windows means two people believe different things about
  // when the instance is down.
  if (overlapping) throw httpError(409, `That overlaps window ${overlapping.id}.`, 'MAINTENANCE_OVERLAPS');

  const id = uid('mw');
  db.prepare(`
    INSERT INTO maintenance_windows (id, summary, detail, kind, reason, starts_at, ends_at, notice_minutes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, String(detail ?? '').slice(0, 4000), resolvedKind, written, start.toISOString(), end.toISOString(), noticeMinutes, userId);

  audit(db, {
    userId,
    action: 'maintenance.scheduled',
    targetType: 'instance',
    targetId: id,
    metadata: { summary: title, kind: resolvedKind, startsAt: start.toISOString(), endsAt: end.toISOString(), noticeMinutes },
  });
  return getMaintenanceWindow(db, id);
}

export function getMaintenanceWindow(db, id) {
  return shape(db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id));
}

/**
 * A second operator agrees.
 *
 * Never the person who scheduled it. Maintenance mode makes the instance
 * read-only for every customer at once, which is the largest blast radius any
 * single operator action has here — and the failure it guards against is not
 * malice, it is one tired person at 2am with the wrong window open.
 */
export function approveMaintenanceWindow(db, { id, userId }) {
  const row = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'No such maintenance window.', 'MAINTENANCE_NOT_FOUND');
  if (row.cancelled_at) throw httpError(409, 'That window was cancelled.', 'MAINTENANCE_CANCELLED');
  if (row.approved_at) throw httpError(409, 'That window is already approved.', 'MAINTENANCE_ALREADY_APPROVED');
  if (row.created_by === userId) {
    throw httpError(403, 'A maintenance window must be approved by a different operator.', 'MAINTENANCE_SELF_APPROVAL');
  }

  db.prepare("UPDATE maintenance_windows SET approved_by = ?, approved_at = datetime('now') WHERE id = ?").run(userId, id);
  audit(db, { userId, action: 'maintenance.approved', targetType: 'instance', targetId: id, metadata: { summary: row.summary } });
  return getMaintenanceWindow(db, id);
}

/**
 * Turns maintenance mode on, for a window that was scheduled and approved.
 *
 * This is the only way in. The switch itself has existed all along, and that was
 * the gap: an instance could be taken down with nothing recorded about who
 * decided it, when it was supposed to end, or whether anybody was told.
 */
export function startMaintenanceWindow(config, db, { id, userId, now = new Date() }) {
  const row = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'No such maintenance window.', 'MAINTENANCE_NOT_FOUND');
  if (row.cancelled_at) throw httpError(409, 'That window was cancelled.', 'MAINTENANCE_CANCELLED');
  if (row.started_at) throw httpError(409, 'That window has already started.', 'MAINTENANCE_ALREADY_STARTED');
  if (!row.approved_at) throw httpError(409, 'That window has not been approved by a second operator.', 'MAINTENANCE_NOT_APPROVED');

  const earliest = new Date(new Date(row.starts_at).getTime() - MAINTENANCE.earlyStartMinutes * 60000);
  if (now < earliest) {
    throw httpError(409, `That window cannot start before ${earliest.toISOString()}.`, 'MAINTENANCE_TOO_EARLY');
  }
  if (now > new Date(row.ends_at)) throw httpError(409, 'That window has already passed.', 'MAINTENANCE_EXPIRED');

  db.prepare("UPDATE maintenance_windows SET started_by = ?, started_at = datetime('now') WHERE id = ?").run(userId, id);
  setMaintenanceState(config, true, { reason: row.summary, actor: userId });
  audit(db, {
    userId,
    action: 'maintenance.started',
    targetType: 'instance',
    targetId: id,
    metadata: { summary: row.summary, kind: row.kind, endsAt: row.ends_at },
  });
  return getMaintenanceWindow(db, id);
}

export function endMaintenanceWindow(config, db, { id, userId }) {
  const row = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'No such maintenance window.', 'MAINTENANCE_NOT_FOUND');
  if (!row.started_at) throw httpError(409, 'That window has not started.', 'MAINTENANCE_NOT_STARTED');
  if (row.ended_at) throw httpError(409, 'That window has already ended.', 'MAINTENANCE_ALREADY_ENDED');

  db.prepare("UPDATE maintenance_windows SET ended_by = ?, ended_at = datetime('now') WHERE id = ?").run(userId, id);
  setMaintenanceState(config, false);
  const window = getMaintenanceWindow(db, id);
  audit(db, {
    userId,
    action: 'maintenance.ended',
    targetType: 'instance',
    targetId: id,
    // The overrun is the number worth having. A window that was meant to take
    // twenty minutes and took three hours is the one to go back and read.
    metadata: { summary: row.summary, plannedMinutes: window.plannedMinutes, actualMinutes: window.actualMinutes },
  });
  return window;
}

export function cancelMaintenanceWindow(db, { id, userId }) {
  const row = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'No such maintenance window.', 'MAINTENANCE_NOT_FOUND');
  if (row.started_at && !row.ended_at) throw httpError(409, 'End the window rather than cancelling it once it has started.', 'MAINTENANCE_IN_PROGRESS');
  if (row.cancelled_at) return getMaintenanceWindow(db, id);

  db.prepare("UPDATE maintenance_windows SET cancelled_by = ?, cancelled_at = datetime('now') WHERE id = ?").run(userId, id);
  audit(db, { userId, action: 'maintenance.cancelled', targetType: 'instance', targetId: id, metadata: { summary: row.summary } });
  return getMaintenanceWindow(db, id);
}

export function listMaintenanceWindows(db, { upcomingOnly = false, limit = 50, now = new Date() } = {}) {
  const rows = db.prepare('SELECT * FROM maintenance_windows ORDER BY starts_at DESC LIMIT ?').all(limit);
  const windows = rows.map((row) => shape(row, now));
  if (!upcomingOnly) return windows;
  return windows.filter((window) => window.upcoming || window.status === 'in_progress');
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
    if (size > 32 * 1024) throw httpError(413, 'Request body is too large.', 'MAINTENANCE_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

export function createMaintenanceWindowsApiHandler({ config, db, isInstanceAdmin }) {
  return async function maintenanceWindowsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const announced = url.pathname === '/api/maintenance/windows';
    const operatorList = url.pathname === '/api/instance-admin/maintenance/windows';
    const action = /^\/api\/instance-admin\/maintenance\/windows\/([^/]+)\/(approve|start|end|cancel)$/.exec(url.pathname);
    if (!announced && !operatorList && !action) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    const method = String(req.method || 'GET').toUpperCase();

    try {
      const user = requireUser(db, req);

      // What every signed-in customer is entitled to: when the instance is
      // going to be unavailable. A window nobody was told about is an outage
      // with paperwork.
      if (announced) {
        if (method !== 'GET') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
        return sendJson(res, 200, { windows: listMaintenanceWindows(db, { upcomingOnly: true }) });
      }

      if (!isInstanceAdmin(config, user)) throw httpError(403, 'KukGit instance administrator access is required.', 'INSTANCE_ADMIN_REQUIRED');

      if (operatorList && method === 'GET') {
        return sendJson(res, 200, { windows: listMaintenanceWindows(db), policy: MAINTENANCE });
      }
      if (method !== 'POST') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');

      if (operatorList) {
        const body = await readJson(req);
        const window = scheduleMaintenanceWindow(db, { ...body, userId: user.id });
        return sendJson(res, 201, { window, requestId });
      }

      const id = decodeURIComponent(action[1]);
      const step = action[2];
      const window = step === 'approve' ? approveMaintenanceWindow(db, { id, userId: user.id })
        : step === 'start' ? startMaintenanceWindow(config, db, { id, userId: user.id })
          : step === 'end' ? endMaintenanceWindow(config, db, { id, userId: user.id })
            : cancelMaintenanceWindow(db, { id, userId: user.id });
      return sendJson(res, 200, { window, requestId });
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'MAINTENANCE_FAILED',
          message: status >= 500 ? 'Maintenance scheduling is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}
