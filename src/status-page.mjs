import fs from 'node:fs';
import path from 'node:path';
import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { getMaintenanceState } from './backups.mjs';
import { listMaintenanceWindows } from './maintenance-windows.mjs';
import { httpError, originAllowed } from './security.mjs';

export const STATUS = {
  severities: ['sev1', 'sev2', 'sev3'],
  states: ['investigating', 'identified', 'monitoring', 'resolved'],
  minimumTitleLength: 8,
  minimumBodyLength: 20,
  maximumBodyLength: 4000,
};

export function migrateStatusPage(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS status_incidents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      severity TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'investigating',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS status_incident_updates (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES status_incidents(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      body TEXT NOT NULL,
      posted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_status_incidents_started
      ON status_incidents(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_status_updates_incident
      ON status_incident_updates(incident_id, created_at);
  `);
}

function text(value, { min, max = STATUS.maximumBodyLength, label }) {
  const written = String(value ?? '').trim();
  if (written.length < min) throw httpError(422, `${label} must be at least ${min} characters.`, 'STATUS_TEXT_REQUIRED');
  return written.slice(0, max);
}

/**
 * Opens an incident.
 *
 * Everything that reaches the public page is typed by a person for the public.
 * Nothing is generated from internal state — no tenant names, no repository
 * names, no request ids, no error strings copied out of a log. A status page
 * that assembles itself from the database is one bad template away from telling
 * the internet which customer was affected.
 */
export function publishIncident(db, { title, severity = 'sev2', body, userId }) {
  if (!STATUS.severities.includes(severity)) {
    throw httpError(422, `Severity must be one of ${STATUS.severities.join(', ')}.`, 'STATUS_SEVERITY_INVALID');
  }
  // Both validated before either is written, and written together. An incident
  // whose first update was refused is still an incident — published, on the
  // public page, with an empty timeline and nothing saying what is wrong. There
  // is no state in which one exists without the other.
  const headline = text(title, { min: STATUS.minimumTitleLength, max: 200, label: 'Title' });
  text(body, { min: STATUS.minimumBodyLength, label: 'Update' });

  const id = uid('inc');
  db.transaction(() => {
    db.prepare('INSERT INTO status_incidents (id, title, severity, created_by) VALUES (?, ?, ?, ?)')
      .run(id, headline, severity, userId);
    addIncidentUpdate(db, { incidentId: id, state: 'investigating', body, userId });
  })();
  audit(db, { userId, action: 'status.incident_opened', targetType: 'instance', targetId: id, metadata: { severity } });
  return getIncident(db, id);
}

/**
 * Adds an update, and nothing ever edits one.
 *
 * A timeline that can be rewritten is not a timeline. Correcting something means
 * posting the correction, which is what anybody reading it later needs: the
 * sequence of what was believed and when, including the part that was wrong.
 */
export function addIncidentUpdate(db, { incidentId, state = 'monitoring', body, userId }) {
  if (!STATUS.states.includes(state)) {
    throw httpError(422, `State must be one of ${STATUS.states.join(', ')}.`, 'STATUS_STATE_INVALID');
  }
  const incident = db.prepare('SELECT * FROM status_incidents WHERE id = ?').get(incidentId);
  if (!incident) throw httpError(404, 'No such incident.', 'STATUS_INCIDENT_NOT_FOUND');

  db.prepare('INSERT INTO status_incident_updates (id, incident_id, state, body, posted_by) VALUES (?, ?, ?, ?, ?)')
    .run(uid('inu'), incidentId, state, text(body, { min: STATUS.minimumBodyLength, label: 'Update' }), userId);
  db.prepare(`
    UPDATE status_incidents SET state = ?, resolved_at = CASE WHEN ? = 'resolved' THEN datetime('now') ELSE NULL END
    WHERE id = ?
  `).run(state, state, incidentId);
  if (state === 'resolved') {
    audit(db, { userId, action: 'status.incident_resolved', targetType: 'instance', targetId: incidentId, metadata: {} });
  }
  return getIncident(db, incidentId);
}

function shapeIncident(db, row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    severity: row.severity,
    state: row.state,
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    updates: db.prepare(`
      SELECT state, body, created_at AS at FROM status_incident_updates
      WHERE incident_id = ? ORDER BY created_at, rowid
    `).all(row.id),
  };
}

export function getIncident(db, id) {
  return shapeIncident(db, db.prepare('SELECT * FROM status_incidents WHERE id = ?').get(id));
}

export function listIncidents(db, { openOnly = false, limit = 25 } = {}) {
  const rows = openOnly
    ? db.prepare("SELECT * FROM status_incidents WHERE state != 'resolved' ORDER BY started_at DESC LIMIT ?").all(limit)
    : db.prepare('SELECT * FROM status_incidents ORDER BY started_at DESC LIMIT ?').all(limit);
  return rows.map((row) => shapeIncident(db, row));
}

/**
 * The whole public page as data.
 *
 * The overall state is derived from what is open rather than set by hand,
 * because a page that says "all systems operational" above an open SEV1 is worse
 * than no page — and that is what happens when the banner is a separate thing
 * somebody has to remember to change.
 */
export function statusSnapshot(config, db, { now = new Date() } = {}) {
  const incidents = listIncidents(db, { openOnly: true });
  const windows = listMaintenanceWindows(db, { upcomingOnly: true, now });
  const active = windows.find((window) => window.status === 'in_progress') ?? null;
  const maintenanceOn = getMaintenanceState(config).enabled;

  const state = incidents.some((incident) => incident.severity === 'sev1') ? 'outage'
    : incidents.length ? 'degraded'
      : (active || maintenanceOn) ? 'maintenance' : 'operational';

  return {
    format: 'kukgit-status-v1',
    generatedAt: now.toISOString(),
    state,
    // Titles and prose only. Everything here was written by an operator for the
    // public; nothing is lifted out of the database.
    incidents,
    maintenance: windows.map(({ id, summary, kind, status, startsAt, endsAt }) => ({ id, summary, kind, status, startsAt, endsAt })),
    recent: listIncidents(db, { limit: 10 }).filter((incident) => incident.state === 'resolved').slice(0, 5),
  };
}

const STATE_LABEL = {
  operational: 'All systems operational',
  degraded: 'Degraded performance',
  maintenance: 'Scheduled maintenance',
  outage: 'Major outage',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

/**
 * Renders the page as one self-contained HTML document.
 *
 * No stylesheet, no script, no font, no image. A status page that needs the
 * asset pipeline of the thing it is reporting on is a page that goes down with
 * it — and it is read at exactly the moment when the least should have to work.
 */
export function renderStatusPage(snapshot, { instanceName = 'KukGit' } = {}) {
  const rows = snapshot.incidents.map((incident) => `
      <article>
        <h3>${escapeHtml(incident.title)} <small>${escapeHtml(incident.severity)}</small></h3>
        <ol>${incident.updates.map((update) => `
          <li><time>${escapeHtml(update.at)}</time> <strong>${escapeHtml(update.state)}</strong><p>${escapeHtml(update.body)}</p></li>`).join('')}
        </ol>
      </article>`).join('');

  const maintenance = snapshot.maintenance.map((window) => `
      <li><time>${escapeHtml(window.startsAt)}</time> — <time>${escapeHtml(window.endsAt)}</time>
        <strong>${escapeHtml(window.summary)}</strong> <small>${escapeHtml(window.status)}</small></li>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(instanceName)} status</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 44rem; padding: 2rem 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1.5rem; }
  .state { border-radius: .5rem; padding: 1rem; font-weight: 600; border: 1px solid currentColor; }
  .operational { color: #0a6b3d; } .degraded { color: #8a5a00; }
  .maintenance { color: #17558a; } .outage { color: #96201a; }
  article { border-top: 1px solid #8884; margin-top: 1.5rem; padding-top: 1rem; }
  h3 small, li small { font-weight: 400; opacity: .7; text-transform: uppercase; font-size: .75rem; }
  ol { padding-left: 1.1rem; } li { margin-bottom: .75rem; }
  time { font-variant-numeric: tabular-nums; opacity: .75; font-size: .875rem; }
  p { margin: .25rem 0 0; }
  footer { margin-top: 3rem; font-size: .875rem; opacity: .7; }
</style></head><body>
<h1>${escapeHtml(instanceName)} status</h1>
<p class="state ${escapeHtml(snapshot.state)}">${escapeHtml(STATE_LABEL[snapshot.state] ?? snapshot.state)}</p>
${snapshot.incidents.length ? `<h2>Open incidents</h2>${rows}` : ''}
${snapshot.maintenance.length ? `<h2>Maintenance</h2><ul>${maintenance}</ul>` : ''}
<footer>
  <p>Updated ${escapeHtml(snapshot.generatedAt)}. Machine-readable at <a href="/api/status">/api/status</a>.</p>
  <p>This page is served by the instance it describes, so it cannot report a total
  outage. Ask your operator where the off-instance copy is published.</p>
</footer>
</body></html>
`;
}

/**
 * Writes a static copy for hosting somewhere else.
 *
 * The limitation this exists for is the obvious one and worth saying plainly: a
 * status page served by the instance it reports on cannot report that the
 * instance is down. The snapshot is two ordinary files that can be pushed to
 * object storage or a CDN on a schedule, which is where a status page belongs.
 */
export function writeStatusSnapshot(config, db, directory) {
  const snapshot = statusSnapshot(config, db);
  const target = path.resolve(directory);
  fs.mkdirSync(target, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(target, 'status.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(target, 'index.html'), renderStatusPage(snapshot, { instanceName: config.instanceName ?? 'KukGit' }), 'utf8');
  return { directory: target, state: snapshot.state, incidents: snapshot.incidents.length, files: ['status.json', 'index.html'] };
}

function send(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    // Short rather than none: a status page is read by many people at once
    // during exactly the moment the instance is least able to serve them.
    'Cache-Control': 'public, max-age=15',
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
    if (size > 32 * 1024) throw httpError(413, 'Request body is too large.', 'STATUS_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

export function createStatusPageApiHandler({ config, db, isInstanceAdmin }) {
  return async function statusPageApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const publicPage = url.pathname === '/status' || url.pathname === '/api/status';
    const operatorRoute = url.pathname === '/api/instance-admin/status/incidents';
    const updateRoute = /^\/api\/instance-admin\/status\/incidents\/([^/]+)\/updates$/.exec(url.pathname);
    if (!publicPage && !operatorRoute && !updateRoute) return false;

    const method = String(req.method || 'GET').toUpperCase();
    try {
      // Unauthenticated, deliberately. A status page that needs a login is
      // useless in the case it exists for: somebody who cannot sign in.
      if (publicPage) {
        if (method !== 'GET' && method !== 'HEAD') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
        const snapshot = statusSnapshot(config, db);
        if (url.pathname === '/api/status') return send(res, 200, JSON.stringify(snapshot), 'application/json; charset=utf-8');
        return send(res, 200, renderStatusPage(snapshot, { instanceName: config.instanceName ?? 'KukGit' }), 'text/html; charset=utf-8');
      }

      const user = requireUser(db, req);
      if (!isInstanceAdmin(config, user)) throw httpError(403, 'KukGit instance administrator access is required.', 'INSTANCE_ADMIN_REQUIRED');

      if (operatorRoute && method === 'GET') {
        return send(res, 200, JSON.stringify({ incidents: listIncidents(db) }), 'application/json; charset=utf-8');
      }
      if (method !== 'POST') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');

      const body = await readJson(req);
      const incident = updateRoute
        ? addIncidentUpdate(db, { incidentId: decodeURIComponent(updateRoute[1]), state: body.state, body: body.body, userId: user.id })
        : publishIncident(db, { title: body.title, severity: body.severity, body: body.body, userId: user.id });
      return send(res, updateRoute ? 200 : 201, JSON.stringify({ incident }), 'application/json; charset=utf-8');
    } catch (error) {
      const status = Number(error.status) || 500;
      const payload = JSON.stringify({
        error: { code: error.code || 'STATUS_FAILED', message: status >= 500 ? 'Status is temporarily unavailable.' : error.message },
      });
      return send(res, status, payload, 'application/json; charset=utf-8');
    }
  };
}
