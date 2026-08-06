import { httpError } from './security.mjs';
import { uid } from './db.mjs';
import { normalizeForge, DISCOVERY_LIMITS } from './forge-discovery.mjs';
import { normalizeImportToken } from './repository-import.mjs';
import { addIssueComment } from './issue-comments.mjs';

/**
 * Bringing an issue tracker across, not just the code.
 *
 * A mirror clone moves every commit and none of the argument about why. For most
 * repositories the conversation is the part that cannot be reconstructed — the
 * reason a decision was made lives in a thread, not in a diff.
 *
 * Three decisions.
 *
 * **Comments are fetched in one list, not one request per issue.** GitHub
 * exposes `/repos/{owner}/{repo}/issues/comments`, every comment in the
 * repository with the issue it belongs to. A repository with two hundred issues
 * costs three requests instead of two hundred, which is the difference between
 * fitting inside an hourly rate limit and not.
 *
 * **Pull requests are left behind, deliberately.** GitHub's issues endpoint
 * returns pull requests too — they share a number space — and a pull request
 * whose branches were deleted years ago cannot become a KukGit pull request,
 * which needs live refs. Importing them as issues would put closed code review
 * in the bug tracker forever. They are counted and reported, not imported.
 *
 * **Nobody is invented.** An issue opened by somebody with no account here is
 * owned by the account that ran the import and displays the original author's
 * name. Creating a user for a GitHub login would create a person who can be
 * assigned work and granted access, and who cannot sign in to object.
 */

export const ISSUE_IMPORT_LIMITS = Object.freeze({
  maxIssues: 1000,
  maxComments: 5000,
  perPage: 100,
  maxPages: 30,
});

function ensureColumn(db, table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrateImportedIssues(db) {
  // `issues` predates any of this, so the two columns are added rather than
  // declared. An issue carried in from elsewhere needs to say so for the same
  // reason a comment does.
  ensureColumn(db, 'issues', 'imported_author', 'TEXT');
  ensureColumn(db, 'issues', 'imported_from', 'TEXT');
}

function normalizeName(value) {
  const name = String(value ?? '').trim();
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,98}$/.test(name)) {
    throw httpError(400, 'That repository name is not valid.', 'FORGE_REPOSITORY_INVALID');
  }
  return name;
}

/**
 * GitHub's timestamps are ISO 8601; SQLite's defaults are `YYYY-MM-DD HH:MM:SS`.
 * Storing one format in a column that holds the other makes every comparison
 * and sort silently wrong, so it is converted once, here.
 */
export function sqliteTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function githubIssue(entry) {
  return {
    number: Number(entry.number),
    title: String(entry.title ?? '').slice(0, 220),
    body: String(entry.body ?? '').slice(0, 20000),
    status: entry.state === 'closed' ? 'closed' : 'open',
    authorLogin: entry.user?.login ? String(entry.user.login) : 'unknown',
    createdAt: sqliteTime(entry.created_at),
    updatedAt: sqliteTime(entry.updated_at),
    // Read, not imported: KukGit has no labels. Kept so the count can be
    // reported rather than the loss being silent.
    labels: Array.isArray(entry.labels) ? entry.labels.map((label) => String(label?.name ?? label)).filter(Boolean) : [],
    comments: [],
  };
}

function githubComment(entry) {
  // `issue_url` ends in the issue number; it is the only link back, and the
  // list endpoint gives no other.
  const match = /\/issues\/(\d+)$/.exec(String(entry.issue_url ?? ''));
  return {
    issueNumber: match ? Number(match[1]) : null,
    body: String(entry.body ?? '').slice(0, 20000),
    authorLogin: entry.user?.login ? String(entry.user.login) : 'unknown',
    createdAt: sqliteTime(entry.created_at),
  };
}

/**
 * Reads a repository's issues and every comment on them.
 *
 * `fetchImpl` is injected so the tests exercise pagination, the pull-request
 * split and the comment join without a network or a token.
 */
export async function listForgeIssues({ forge: forgeName, owner, repo, token = null } = {}, { fetchImpl = fetch } = {}) {
  const forge = normalizeForge(forgeName);
  if (forge.name !== 'github') {
    throw httpError(400, 'Issue import is available for GitHub only so far.', 'FORGE_ISSUES_UNSUPPORTED');
  }
  const ownerName = normalizeName(owner);
  const repoName = normalizeName(repo);
  const credential = normalizeImportToken(token);

  const request = async (path) => {
    const headers = { 'User-Agent': 'KukGit', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (credential) headers.Authorization = `Bearer ${credential}`;
    let response;
    try {
      response = await fetchImpl(`${forge.api}${path}`, { headers, signal: AbortSignal.timeout(DISCOVERY_LIMITS.requestTimeoutMs) });
    } catch (error) {
      throw httpError(504, `${forge.label} did not answer: ${String(error?.message ?? error).slice(0, 200)}`, 'FORGE_UNREACHABLE');
    }
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      throw httpError(429, `${forge.label} rate limit reached. An access token raises the limit considerably.`, 'FORGE_RATE_LIMITED');
    }
    if (response.status === 404) {
      throw httpError(404, `${forge.label} has no repository ${ownerName}/${repoName} visible to this token.`, 'FORGE_REPOSITORY_NOT_FOUND');
    }
    if (!response.ok) throw httpError(502, `${forge.label} refused the request: HTTP ${response.status}`, 'FORGE_REQUEST_FAILED');
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body)) throw httpError(502, `${forge.label} returned something that is not a list.`, 'FORGE_BAD_RESPONSE');
    return body;
  };

  const pages = async (path, limit) => {
    const collected = [];
    let truncated = false;
    for (let page = 1; page <= ISSUE_IMPORT_LIMITS.maxPages; page += 1) {
      const body = await request(`${path}&page=${page}`);
      for (const entry of body) {
        if (collected.length >= limit) { truncated = true; break; }
        collected.push(entry);
      }
      if (truncated || body.length < ISSUE_IMPORT_LIMITS.perPage) break;
      if (page === ISSUE_IMPORT_LIMITS.maxPages) { truncated = true; break; }
    }
    return { collected, truncated };
  };

  const base = `/repos/${encodeURIComponent(ownerName)}/${encodeURIComponent(repoName)}`;
  const raw = await pages(`${base}/issues?state=all&sort=created&direction=asc&per_page=${ISSUE_IMPORT_LIMITS.perPage}`, ISSUE_IMPORT_LIMITS.maxIssues);

  // The endpoint returns pull requests as well; they share the number space and
  // carry a `pull_request` key. A pull request whose branches are long gone
  // cannot become a KukGit pull request, and putting it in the bug tracker
  // instead would be worse than leaving it.
  const pullRequests = raw.collected.filter((entry) => entry.pull_request).length;
  const issues = raw.collected.filter((entry) => !entry.pull_request).map(githubIssue);
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));

  let comments = { collected: [], truncated: false };
  if (issues.length) {
    // One list for the whole repository. Two hundred issues cost three requests
    // rather than two hundred, which decides whether this fits in a rate limit.
    comments = await pages(`${base}/issues/comments?sort=created&direction=asc&per_page=${ISSUE_IMPORT_LIMITS.perPage}`, ISSUE_IMPORT_LIMITS.maxComments);
    for (const entry of comments.collected) {
      const comment = githubComment(entry);
      // A comment whose issue is not in the list belongs to a pull request, or
      // to an issue past the cap. Either way there is nothing to attach it to.
      byNumber.get(comment.issueNumber)?.comments.push(comment);
    }
  }

  const labelled = issues.filter((issue) => issue.labels.length).length;
  return {
    forge: forge.name,
    source: `${forge.host}/${ownerName}/${repoName}`,
    issues,
    pullRequests,
    commentCount: issues.reduce((total, issue) => total + issue.comments.length, 0),
    labelledIssues: labelled,
    truncated: raw.truncated || comments.truncated,
    note: raw.truncated || comments.truncated
      ? `Only the first ${issues.length} issues and ${comments.collected.length} comments were read; this repository has more.`
      : null,
  };
}

/**
 * Writes what was read into a repository here.
 *
 * Numbers are kept when the repository has none of its own — an imported body
 * full of `#42` references is worth nothing if #42 is now a different issue. A
 * repository that already has issues gets fresh numbers and says so, because
 * silently renumbering half a tracker is worse than either.
 */
export function importForgeIssues(db, { repositoryId, actorId, listing, keepNumbers = true }) {
  migrateImportedIssues(db);
  const existing = db.prepare('SELECT COALESCE(MAX(number), 0) AS highest, COUNT(*) AS count FROM issues WHERE repository_id = ?').get(repositoryId);
  const renumbered = !keepNumbers || existing.count > 0;
  let next = existing.highest;

  const insertIssue = db.prepare(`
    INSERT INTO issues (id, repository_id, number, title, body, status, priority, author_id, imported_author, imported_from, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'medium', ?, ?, ?, ?, ?)
  `);

  const written = [];
  const write = db.transaction(() => {
    for (const issue of listing.issues) {
      const number = renumbered ? (next += 1) : issue.number;
      const id = uid('iss');
      insertIssue.run(
        id, repositoryId, number, issue.title || `Imported issue ${issue.number}`, issue.body,
        issue.status, actorId, issue.authorLogin, listing.source,
        issue.createdAt ?? null, issue.updatedAt ?? issue.createdAt ?? null,
      );
      for (const comment of issue.comments) {
        // An empty comment is skipped rather than refused: one blank reply must
        // not fail an import of four hundred.
        if (!String(comment.body ?? '').trim()) continue;
        addIssueComment(db, {
          issueId: id,
          authorId: actorId,
          body: comment.body,
          importedAuthor: comment.authorLogin,
          importedFrom: listing.source,
          createdAt: comment.createdAt ?? issue.createdAt ?? null,
        });
      }
      written.push({ from: issue.number, to: number, comments: issue.comments.length });
    }
  });
  write();

  return {
    imported: written.length,
    comments: written.reduce((total, entry) => total + entry.comments, 0),
    renumbered,
    // Said out loud. Somebody reading an imported issue that says "see #42"
    // needs to know whether #42 here means what it meant there.
    note: renumbered
      ? 'This repository already had issues, so imported issues were given new numbers. References like #42 inside imported text still point at the old numbering.'
      : null,
    pullRequestsSkipped: listing.pullRequests,
    labelsDropped: listing.labelledIssues,
  };
}
