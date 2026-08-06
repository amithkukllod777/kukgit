import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { permissionAtLeast, requireRepositoryAccess } from './repository-access.mjs';
import { httpError, originAllowed } from './security.mjs';
import { labelsForIssue, migrateIssueTaxonomy } from './issue-taxonomy.mjs';

/**
 * The conversation on an issue.
 *
 * KukGit has had issues since the beginning and has never had a way to reply to
 * one. A tracker where nobody can answer is a list of complaints, and it is the
 * first thing anybody notices — it is also the reason importing issues from
 * another host would have thrown away the part people actually wanted to keep,
 * because there was nowhere to put it.
 *
 * Two decisions worth stating.
 *
 * **An imported comment says who wrote it, in a field, not in the prose.** When
 * a conversation comes from GitHub most of its authors have no account here, and
 * inventing one for them would be inventing a person who can be @-mentioned,
 * assigned work, and granted access. So the row records the KukGit user who ran
 * the import *and* the original author's name as text. The display shows the
 * original name and marks it as imported.
 *
 * **Editing keeps the original.** An edited comment shows that it was edited and
 * when. A thread where a reply can be silently rewritten after somebody has
 * acted on it is a thread nobody can rely on.
 */

const MAX_BODY_BYTES = 64 * 1024;
const MAX_COMMENT_LENGTH = 20000;

export function migrateIssueComments(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_comments (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      -- Set only for a comment that came from another host. The account that
      -- ran the import owns the row; this is who actually wrote it.
      imported_author TEXT,
      imported_from TEXT,
      edited_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_issue_comments_issue
      ON issue_comments(issue_id, created_at);
  `);
  // The thread shows an issue's labels, milestone and assignee, so it makes
  // sure they exist rather than depending on the order migrations are called
  // in.
  migrateIssueTaxonomy(db);
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'COMMENT_REQUEST_TOO_LARGE');
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

export function normalizeCommentBody(value) {
  const body = String(value ?? '').trim();
  if (!body) throw httpError(400, 'A comment cannot be empty.', 'COMMENT_EMPTY');
  if (body.length > MAX_COMMENT_LENGTH) {
    throw httpError(400, `A comment may be at most ${MAX_COMMENT_LENGTH} characters.`, 'COMMENT_TOO_LONG');
  }
  return body;
}

function commentDto(row) {
  return {
    id: row.id,
    body: row.body,
    // The original author when there is one, and the account that carried the
    // comment across otherwise. Never a fabricated user.
    authorName: row.importedAuthor || row.authorName,
    authorId: row.importedAuthor ? null : row.authorId,
    imported: Boolean(row.importedAuthor),
    importedFrom: row.importedFrom ?? null,
    editedAt: row.editedAt ?? null,
    createdAt: row.createdAt,
  };
}

export function listIssueComments(db, issueId) {
  return db.prepare(`
    SELECT c.id, c.body, c.author_id AS authorId, u.display_name AS authorName,
           c.imported_author AS importedAuthor, c.imported_from AS importedFrom,
           c.edited_at AS editedAt, c.created_at AS createdAt
    FROM issue_comments c JOIN users u ON u.id = c.author_id
    WHERE c.issue_id = ? ORDER BY c.created_at, c.rowid
  `).all(issueId).map(commentDto);
}

export function addIssueComment(db, { issueId, authorId, body, importedAuthor = null, importedFrom = null, createdAt = null }) {
  const id = uid('icom');
  const text = normalizeCommentBody(body);
  if (createdAt) {
    // An imported comment keeps the time it was written. A thread where every
    // reply is dated today is a thread whose order means nothing.
    db.prepare(`
      INSERT INTO issue_comments (id, issue_id, author_id, body, imported_author, imported_from, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, issueId, authorId, text, importedAuthor, importedFrom, createdAt, createdAt);
  } else {
    db.prepare(`
      INSERT INTO issue_comments (id, issue_id, author_id, body, imported_author, imported_from)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, issueId, authorId, text, importedAuthor, importedFrom);
  }
  return id;
}

function issueFor(db, repositoryId, number) {
  const issue = db.prepare(`
    SELECT i.id, i.number, i.title, i.body, i.status, i.priority, i.created_at AS createdAt,
           i.updated_at AS updatedAt, i.author_id AS authorId, u.display_name AS authorName,
           i.imported_author AS importedAuthor, i.imported_assignee AS importedAssignee,
           i.milestone_id AS milestoneId, m.title AS milestoneTitle,
           i.assignee_id AS assigneeId, a.display_name AS assigneeName
    FROM issues i
    JOIN users u ON u.id = i.author_id
    LEFT JOIN issue_milestones m ON m.id = i.milestone_id
    LEFT JOIN users a ON a.id = i.assignee_id
    WHERE i.repository_id = ? AND i.number = ?
  `).get(repositoryId, Number(number));
  if (!issue) throw httpError(404, 'Issue not found.', 'ISSUE_NOT_FOUND');
  // Same rule as a comment: the name shown is whoever opened it, and an
  // imported issue names somebody with no account here.
  return { ...issue, authorName: issue.importedAuthor || issue.authorName, labels: labelsForIssue(db, issue.id) };
}

export function createIssueCommentsApiHandler({ config, db }) {
  return async function handleIssueCommentsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/issue-comments/')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);

      let params = routeMatch(pathname, '/api/issue-comments/:org/:repo/:number');
      if (params) {
        // Reading a conversation needs read; adding to it needs the same
        // permission as opening an issue in the first place.
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, req.method === 'GET' ? 'read' : 'write');
        const issue = issueFor(db, access.repository.id, params.number);

        if (req.method === 'GET') {
          return sendJson(res, 200, {
            issue: { ...issue, authorId: undefined },
            comments: listIssueComments(db, issue.id),
            canComment: permissionAtLeast(access.permission, 'write'),
          });
        }

        if (req.method === 'POST') {
          const body = await readJson(req);
          const id = addIssueComment(db, { issueId: issue.id, authorId: user.id, body: body.body });
          db.prepare('UPDATE issues SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(issue.id);
          audit(db, {
            organizationId: access.repository.organizationId,
            userId: user.id,
            action: 'issue.commented',
            targetType: 'issue',
            targetId: issue.id,
            metadata: { repository: params.repo, number: issue.number, commentId: id },
          });
          return sendJson(res, 201, { comments: listIssueComments(db, issue.id) });
        }
      }

      params = routeMatch(pathname, '/api/issue-comments/:org/:repo/:number/:commentId');
      if (params && ['PATCH', 'DELETE'].includes(req.method)) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'write');
        const issue = issueFor(db, access.repository.id, params.number);
        const comment = db.prepare('SELECT id, author_id AS authorId, imported_author AS importedAuthor FROM issue_comments WHERE id = ? AND issue_id = ?')
          .get(params.commentId, issue.id);
        if (!comment) throw httpError(404, 'Comment not found.', 'COMMENT_NOT_FOUND');

        const isAuthor = comment.authorId === user.id;
        const isMaintainer = permissionAtLeast(access.permission, 'maintain');
        if (req.method === 'PATCH') {
          // Only the author rewrites their own words. A maintainer may remove a
          // comment; putting different words in somebody's mouth is not a
          // moderation power any role should have.
          if (!isAuthor) throw httpError(403, 'Only the author can edit a comment.', 'COMMENT_NOT_AUTHOR');
          const body = await readJson(req);
          db.prepare("UPDATE issue_comments SET body = ?, edited_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(normalizeCommentBody(body.body), comment.id);
          return sendJson(res, 200, { comments: listIssueComments(db, issue.id) });
        }

        if (!isAuthor && !isMaintainer) throw httpError(403, 'Only the author or a maintainer can delete a comment.', 'COMMENT_NOT_PERMITTED');
        db.prepare('DELETE FROM issue_comments WHERE id = ?').run(comment.id);
        audit(db, {
          organizationId: access.repository.organizationId,
          userId: user.id,
          action: 'issue.comment.deleted',
          targetType: 'issue',
          targetId: issue.id,
          metadata: { repository: params.repo, number: issue.number, commentId: comment.id, byAuthor: isAuthor },
        });
        return sendJson(res, 200, { comments: listIssueComments(db, issue.id) });
      }

      throw httpError(404, 'Issue comment endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] issue comments API`, error);
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
