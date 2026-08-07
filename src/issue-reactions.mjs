import { requireUser } from './auth.mjs';
import { uid } from './db.mjs';
import { getEffectiveRepositoryAccess } from './repository-access.mjs';
import { httpError, originAllowed } from './security.mjs';

/**
 * Reactions on an issue and on the replies to it.
 *
 * The point of them is that "I agree", "this happened to me too" and "thank
 * you" stop being comments. A tracker without reactions grows a layer of
 * one-word replies that push the actual discussion off the screen, and nobody
 * can tell from a thread of forty comments whether it is forty people or one
 * argument.
 *
 * Three decisions.
 *
 * **The set is fixed and stored by name, not by character.** Free text would
 * make this an unmoderated message channel on somebody else's issue — a
 * "reaction" can be a sentence, and a slur is a sentence. Names rather than
 * emoji because `❤️` is two code points and `❤` is one: storing the characters
 * means the same reaction from two keyboards is two rows, and one person can
 * appear to react twice with the same thing.
 *
 * **Reacting needs read access, and support access is not enough.** A reader
 * who cannot react writes "+1" instead, which is worse for everybody. But a
 * KukGit support operator looking at a customer's repository has `read` through
 * a temporary grant, and the promise attached to that grant is that support
 * looks without touching. A reaction is a mark left in the customer's
 * repository with an operator's name on it.
 *
 * **Reacting is a toggle.** The same reaction twice is the person taking it
 * back, because that is the only gesture the interface offers and an interface
 * where the undo is somewhere else is an interface where nobody undoes.
 */

export const REACTIONS = Object.freeze([
  { name: '+1', emoji: '👍', label: 'Agree' },
  { name: '-1', emoji: '👎', label: 'Disagree' },
  { name: 'laugh', emoji: '😄', label: 'Funny' },
  { name: 'hooray', emoji: '🎉', label: 'Celebrate' },
  { name: 'confused', emoji: '😕', label: 'Confused' },
  { name: 'heart', emoji: '❤️', label: 'Love' },
  { name: 'rocket', emoji: '🚀', label: 'Shipped' },
  { name: 'eyes', emoji: '👀', label: 'Looking' },
]);

const REACTION_NAMES = new Set(REACTIONS.map((reaction) => reaction.name));
const MAX_BODY_BYTES = 16 * 1024;
// How many names are sent for the tooltip. The count is exact; the list is not,
// because an issue with four hundred thumbs does not need four hundred names in
// every response.
const MAX_NAMES = 8;

export function migrateIssueReactions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_reactions (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      -- Null when the reaction is on the issue itself. Both columns are real
      -- foreign keys so that deleting a comment or an issue takes its
      -- reactions with it rather than leaving rows pointing at nothing.
      comment_id TEXT REFERENCES issue_comments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reaction TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    -- Two partial indexes rather than one UNIQUE over four columns, because
    -- SQLite treats every NULL as distinct: a single constraint including
    -- \`comment_id\` would not stop the same person reacting to the same issue
    -- with the same thing twice.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_reactions_on_comment
      ON issue_reactions(comment_id, user_id, reaction) WHERE comment_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_reactions_on_issue
      ON issue_reactions(issue_id, user_id, reaction) WHERE comment_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_issue_reactions_issue
      ON issue_reactions(issue_id);
  `);
}

export function normalizeReaction(value) {
  const name = String(value ?? '').trim();
  if (!REACTION_NAMES.has(name)) {
    throw httpError(400, 'That is not one of the reactions.', 'REACTION_UNKNOWN');
  }
  return name;
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'REACTION_REQUEST_TOO_LARGE');
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

function group(rows, viewerId) {
  const byReaction = new Map();
  for (const row of rows) {
    if (!byReaction.has(row.reaction)) byReaction.set(row.reaction, { reaction: row.reaction, count: 0, mine: false, names: [] });
    const entry = byReaction.get(row.reaction);
    entry.count += 1;
    if (row.userId === viewerId) entry.mine = true;
    if (entry.names.length < MAX_NAMES) entry.names.push(row.userName);
  }
  // In the order the set is declared, so the row of reactions does not
  // rearrange itself under somebody's cursor as counts change.
  return REACTIONS
    .map((reaction) => byReaction.get(reaction.name))
    .filter(Boolean);
}

/**
 * Every reaction on an issue and on all of its comments, in one read.
 *
 * The thread renders in one go, so asking per comment would be one request per
 * reply on every render — which is the shape of every request storm this
 * front end has had.
 */
export function reactionsForIssue(db, issueId, viewerId) {
  migrateIssueReactions(db);
  const rows = db.prepare(`
    SELECT r.comment_id AS commentId, r.reaction, r.user_id AS userId, u.display_name AS userName
    FROM issue_reactions r JOIN users u ON u.id = r.user_id
    WHERE r.issue_id = ? ORDER BY r.created_at, r.id
  `).all(issueId);

  const comments = {};
  for (const row of rows) {
    if (!row.commentId) continue;
    (comments[row.commentId] ??= []).push(row);
  }
  return {
    available: REACTIONS,
    issue: group(rows.filter((row) => !row.commentId), viewerId),
    comments: Object.fromEntries(Object.entries(comments).map(([id, list]) => [id, group(list, viewerId)])),
  };
}

/**
 * Adds the reaction, or takes it away if it is already there.
 *
 * @returns {'added'|'removed'}
 */
export function toggleReaction(db, { issueId, commentId = null, userId, reaction }) {
  migrateIssueReactions(db);
  const name = normalizeReaction(reaction);
  const existing = commentId
    ? db.prepare('SELECT id FROM issue_reactions WHERE comment_id = ? AND user_id = ? AND reaction = ?').get(commentId, userId, name)
    : db.prepare('SELECT id FROM issue_reactions WHERE issue_id = ? AND comment_id IS NULL AND user_id = ? AND reaction = ?').get(issueId, userId, name);

  if (existing) {
    db.prepare('DELETE FROM issue_reactions WHERE id = ?').run(existing.id);
    return 'removed';
  }
  db.prepare('INSERT INTO issue_reactions (id, issue_id, comment_id, user_id, reaction) VALUES (?, ?, ?, ?, ?)')
    .run(uid('rxn'), issueId, commentId, userId, name);
  return 'added';
}

export function createIssueReactionsApiHandler({ config, db }) {
  return async function handleIssueReactionsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/issue-reactions/')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);

      const params = routeMatch(pathname, '/api/issue-reactions/:org/:repo/:number');
      if (!params || !['GET', 'POST'].includes(req.method)) {
        throw httpError(404, 'Issue reaction endpoint not found.', 'NOT_FOUND');
      }

      const access = getEffectiveRepositoryAccess(db, { userId: user.id, orgSlug: params.org, repoSlug: params.repo });
      if (!access?.repository) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
      if (access.permission === 'none') {
        // Same rule as everywhere else: a private repository does not confirm
        // its own existence to somebody with no access to it.
        if (access.repository.visibility !== 'public') throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
        throw httpError(403, 'Repository read permission is required.', 'REPOSITORY_ACCESS_DENIED');
      }

      const issue = db.prepare('SELECT id, number FROM issues WHERE repository_id = ? AND number = ?')
        .get(access.repository.id, Number(params.number));
      if (!issue) throw httpError(404, 'Issue not found.', 'ISSUE_NOT_FOUND');

      if (req.method === 'GET') {
        return sendJson(res, 200, {
          ...reactionsForIssue(db, issue.id, user.id),
          // The screen needs to know whether to draw the buttons at all. A row
          // of reaction buttons that answers 403 is a worse answer than no row.
          canReact: canReact(access),
        });
      }

      if (!canReact(access)) {
        // Support access is read, and the grant it comes from says support
        // looks without touching. A reaction is a mark left in a customer's
        // repository with an operator's name on it.
        throw httpError(403, 'A support grant is read-only. Reacting would leave a mark in the customer\'s repository.', 'REACTION_SUPPORT_READ_ONLY');
      }

      const body = await readJson(req);
      const reaction = normalizeReaction(body.reaction);
      let commentId = null;
      if (body.commentId) {
        // Checked against this issue, not just against the comments table: a
        // comment id from another repository's issue would otherwise attach a
        // reaction across a tenancy boundary.
        const comment = db.prepare('SELECT id FROM issue_comments WHERE id = ? AND issue_id = ?').get(String(body.commentId), issue.id);
        if (!comment) throw httpError(404, 'Comment not found.', 'COMMENT_NOT_FOUND');
        commentId = comment.id;
      }

      const outcome = toggleReaction(db, { issueId: issue.id, commentId, userId: user.id, reaction });
      return sendJson(res, 200, { outcome, ...reactionsForIssue(db, issue.id, user.id), canReact: true });
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] issue reactions API`, error);
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

/**
 * Whether this access is somebody's own, rather than a support grant standing
 * in for them.
 *
 * `sources` explains where the permission came from, so this is asking whether
 * *anything* other than support granted it — a Kuklabs operator who is also a
 * member of the organization is a member, and reacts as one.
 */
export function canReact(access) {
  if (!access || access.permission === 'none') return false;
  return access.sources.some((source) => source.type !== 'support');
}
