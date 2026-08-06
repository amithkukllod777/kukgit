import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { permissionAtLeast, requireRepositoryAccess } from './repository-access.mjs';
import { httpError, originAllowed } from './security.mjs';

/**
 * Labels, milestones and who an issue is on.
 *
 * Every tracker anybody is migrating from has these, and KukGit had none of
 * them — so an import either dropped them or had to say it dropped them, which
 * is what it has been doing. This is where they go.
 *
 * **A label belongs to a repository, not to the instance.** `bug` on one
 * repository and `bug` on another are two labels that happen to share a word;
 * merging them would let one team's rename change another team's tracker.
 *
 * **An assignee must be somebody who can see the repository.** Assigning work to
 * a person with no access produces an issue nobody can open and a name on a
 * screen that means nothing. An import from another host usually cannot satisfy
 * that — GitHub gives a login, not an email — so the original assignee's name is
 * recorded as text and shown, exactly as an imported comment's author is. Nobody
 * is invented and nothing is silently dropped.
 */

const MAX_BODY_BYTES = 64 * 1024;
const NAME = /^[\p{L}\p{N} ._:\/-]{1,50}$/u;
const COLOUR = /^[0-9a-f]{6}$/;

// Enough to start with, and the same set GitHub opens a repository with, so an
// import of a repository that never customised its labels matches by name.
export const DEFAULT_LABELS = Object.freeze([
  { name: 'bug', colour: 'd73a4a', description: "Something is not working" },
  { name: 'enhancement', colour: 'a2eeef', description: 'A new feature or request' },
  { name: 'documentation', colour: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', colour: 'd876e3', description: 'Further information is requested' },
]);

export function migrateIssueTaxonomy(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_labels (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      colour TEXT NOT NULL DEFAULT '888888',
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- Scoped to the repository. Two teams may both have a 'bug'.
      UNIQUE(repository_id, name)
    );
    CREATE TABLE IF NOT EXISTS issue_label_links (
      issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES issue_labels(id) ON DELETE CASCADE,
      PRIMARY KEY (issue_id, label_id)
    );
    CREATE TABLE IF NOT EXISTS issue_milestones (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      due_on TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repository_id, title)
    );
    CREATE INDEX IF NOT EXISTS idx_issue_label_links_label ON issue_label_links(label_id);
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(issues)').all().map((row) => row.name));
  // Every column added to `issues` after the fact lives here, in one place. The
  // thread screen reads all of them, and splitting them across two modules made
  // one of them depend on the other importing it first.
  if (!columns.has('imported_author')) db.exec('ALTER TABLE issues ADD COLUMN imported_author TEXT');
  if (!columns.has('imported_from')) db.exec('ALTER TABLE issues ADD COLUMN imported_from TEXT');
  if (!columns.has('milestone_id')) {
    db.exec('ALTER TABLE issues ADD COLUMN milestone_id TEXT REFERENCES issue_milestones(id) ON DELETE SET NULL');
  }
  // The assignee an import found, when it is somebody with no account here.
  // `issues.assignee_id` already exists and stays for real assignments.
  if (!columns.has('imported_assignee')) {
    db.exec('ALTER TABLE issues ADD COLUMN imported_assignee TEXT');
  }
}

export function normalizeLabelName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw httpError(400, 'A label needs a name.', 'LABEL_NAME_REQUIRED');
  if (!NAME.test(name)) throw httpError(400, 'A label name may contain letters, numbers, spaces and . _ : / -', 'LABEL_NAME_INVALID');
  return name;
}

export function normalizeColour(value, fallback = '888888') {
  const colour = String(value ?? '').trim().toLowerCase().replace(/^#/, '');
  if (!colour) return fallback;
  if (!COLOUR.test(colour)) throw httpError(400, 'A label colour must be six hexadecimal digits.', 'LABEL_COLOUR_INVALID');
  return colour;
}

export function listLabels(db, repositoryId) {
  return db.prepare(`
    SELECT l.id, l.name, l.colour, l.description,
           (SELECT COUNT(*) FROM issue_label_links k WHERE k.label_id = l.id) AS issues
    FROM issue_labels l WHERE l.repository_id = ? ORDER BY l.name
  `).all(repositoryId).map((row) => ({ id: row.id, name: row.name, colour: row.colour, description: row.description, issues: row.issues }));
}

export function listMilestones(db, repositoryId) {
  return db.prepare(`
    SELECT m.id, m.title, m.description, m.due_on AS dueOn, m.status,
           (SELECT COUNT(*) FROM issues i WHERE i.milestone_id = m.id) AS issues,
           (SELECT COUNT(*) FROM issues i WHERE i.milestone_id = m.id AND i.status = 'open') AS openIssues
    FROM issue_milestones m WHERE m.repository_id = ? ORDER BY m.due_on IS NULL, m.due_on, m.title
  `).all(repositoryId).map((row) => ({ ...row }));
}

export function labelsForIssue(db, issueId) {
  return db.prepare(`
    SELECT l.id, l.name, l.colour FROM issue_label_links k
    JOIN issue_labels l ON l.id = k.label_id
    WHERE k.issue_id = ? ORDER BY l.name
  `).all(issueId).map((row) => ({ id: row.id, name: row.name, colour: row.colour }));
}

/**
 * Finds a label by name in a repository, creating it if it is not there.
 *
 * The import needs this: a repository's labels arrive attached to issues rather
 * than as a list, and creating one per issue would be one row per use.
 */
export function ensureLabel(db, repositoryId, { name, colour, description = '' }) {
  const labelName = normalizeLabelName(name);
  const existing = db.prepare('SELECT id FROM issue_labels WHERE repository_id = ? AND name = ?').get(repositoryId, labelName);
  if (existing) return existing.id;
  const id = uid('lbl');
  db.prepare('INSERT INTO issue_labels (id, repository_id, name, colour, description) VALUES (?, ?, ?, ?, ?)')
    .run(id, repositoryId, labelName, normalizeColour(colour), String(description ?? '').slice(0, 300));
  return id;
}

export function ensureMilestone(db, repositoryId, { title, description = '', dueOn = null, status = 'open' }) {
  const value = String(title ?? '').trim();
  if (!value) throw httpError(400, 'A milestone needs a title.', 'MILESTONE_TITLE_REQUIRED');
  const existing = db.prepare('SELECT id FROM issue_milestones WHERE repository_id = ? AND title = ?').get(repositoryId, value.slice(0, 120));
  if (existing) return existing.id;
  const id = uid('mst');
  db.prepare('INSERT INTO issue_milestones (id, repository_id, title, description, due_on, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, repositoryId, value.slice(0, 120), String(description ?? '').slice(0, 1000), dueOn, status === 'closed' ? 'closed' : 'open');
  return id;
}

export function setIssueLabels(db, { issueId, repositoryId, labelIds }) {
  const valid = new Set(db.prepare('SELECT id FROM issue_labels WHERE repository_id = ?').all(repositoryId).map((row) => row.id));
  for (const id of labelIds) {
    // A label id from another repository would attach one team's taxonomy to
    // another team's issue, and the id is supplied by the caller.
    if (!valid.has(id)) throw httpError(400, 'That label does not belong to this repository.', 'LABEL_NOT_IN_REPOSITORY');
  }
  const write = db.transaction(() => {
    db.prepare('DELETE FROM issue_label_links WHERE issue_id = ?').run(issueId);
    const link = db.prepare('INSERT INTO issue_label_links (issue_id, label_id) VALUES (?, ?) ON CONFLICT DO NOTHING');
    for (const id of labelIds) link.run(issueId, id);
  });
  write();
  return labelsForIssue(db, issueId);
}

/**
 * Assigns an issue to somebody who can actually open it.
 *
 * An assignee without access is a name on a screen that means nothing and an
 * issue whose owner cannot read it.
 */
export function assignIssue(db, { issueId, repositoryId, orgSlug, repoSlug, userId }) {
  if (!userId) {
    db.prepare('UPDATE issues SET assignee_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(issueId);
    return null;
  }
  let access = null;
  try { access = requireRepositoryAccess(db, userId, { orgSlug, repoSlug }, 'read'); }
  catch { access = null; }
  if (!access) throw httpError(400, 'That person cannot see this repository, so they cannot be assigned to its issues.', 'ASSIGNEE_NO_ACCESS');
  db.prepare('UPDATE issues SET assignee_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId, issueId);
  void repositoryId;
  return userId;
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'TAXONOMY_REQUEST_TOO_LARGE');
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

export function createIssueTaxonomyApiHandler({ config, db }) {
  return async function handleIssueTaxonomyApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/issue-taxonomy/')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);

      let params = routeMatch(pathname, '/api/issue-taxonomy/:org/:repo');
      if (req.method === 'GET' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'read');
        return sendJson(res, 200, {
          labels: listLabels(db, access.repository.id),
          milestones: listMilestones(db, access.repository.id),
          // Only people who can already read it. Offering anybody else is
          // offering an assignment the server will refuse.
          assignable: db.prepare(`
            SELECT u.id, u.display_name AS name FROM org_members m
            JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? ORDER BY u.display_name
          `).all(access.repository.organizationId),
          canManage: permissionAtLeast(access.permission, 'write'),
        });
      }

      params = routeMatch(pathname, '/api/issue-taxonomy/:org/:repo/labels');
      if (req.method === 'POST' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'write');
        const body = await readJson(req);
        const id = ensureLabel(db, access.repository.id, { name: body.name, colour: body.colour, description: body.description });
        audit(db, {
          organizationId: access.repository.organizationId, userId: user.id, action: 'issue.label.created',
          targetType: 'repository', targetId: access.repository.id, metadata: { name: body.name },
        });
        return sendJson(res, 201, { labels: listLabels(db, access.repository.id), id });
      }

      params = routeMatch(pathname, '/api/issue-taxonomy/:org/:repo/labels/:labelId');
      if (req.method === 'DELETE' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'maintain');
        // Scoped to this repository, so a label id cannot be used to delete
        // another repository's label.
        const removed = db.prepare('DELETE FROM issue_labels WHERE id = ? AND repository_id = ?').run(params.labelId, access.repository.id);
        if (!removed.changes) throw httpError(404, 'Label not found.', 'LABEL_NOT_FOUND');
        return sendJson(res, 200, { labels: listLabels(db, access.repository.id) });
      }

      params = routeMatch(pathname, '/api/issue-taxonomy/:org/:repo/milestones');
      if (req.method === 'POST' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'write');
        const body = await readJson(req);
        ensureMilestone(db, access.repository.id, { title: body.title, description: body.description, dueOn: body.dueOn ?? null });
        return sendJson(res, 201, { milestones: listMilestones(db, access.repository.id) });
      }

      params = routeMatch(pathname, '/api/issue-taxonomy/:org/:repo/issues/:number');
      if (req.method === 'PATCH' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'write');
        const issue = db.prepare('SELECT id FROM issues WHERE repository_id = ? AND number = ?').get(access.repository.id, Number(params.number));
        if (!issue) throw httpError(404, 'Issue not found.', 'ISSUE_NOT_FOUND');
        const body = await readJson(req);

        if (Array.isArray(body.labelIds)) {
          setIssueLabels(db, { issueId: issue.id, repositoryId: access.repository.id, labelIds: body.labelIds.map(String) });
        }
        if ('milestoneId' in body) {
          const milestoneId = body.milestoneId ? String(body.milestoneId) : null;
          if (milestoneId) {
            const owned = db.prepare('SELECT id FROM issue_milestones WHERE id = ? AND repository_id = ?').get(milestoneId, access.repository.id);
            if (!owned) throw httpError(400, 'That milestone does not belong to this repository.', 'MILESTONE_NOT_IN_REPOSITORY');
          }
          db.prepare('UPDATE issues SET milestone_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(milestoneId, issue.id);
        }
        if ('assigneeId' in body) {
          assignIssue(db, {
            issueId: issue.id,
            repositoryId: access.repository.id,
            orgSlug: params.org,
            repoSlug: params.repo,
            userId: body.assigneeId ? String(body.assigneeId) : null,
          });
        }
        return sendJson(res, 200, { labels: labelsForIssue(db, issue.id) });
      }

      throw httpError(404, 'Issue taxonomy endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] issue taxonomy API`, error);
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
