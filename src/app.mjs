import fs from 'node:fs';
import path from 'node:path';
import { authenticate, clearSessionCookie, createSession, currentUser, destroySession, requireUser, sessionCookie } from './auth.mjs';
import { analyzeRepository } from './analysis.mjs';
import { audit, findRepo, orgAccess, uid } from './db.mjs';
import {
  commitFile,
  compareBranches,
  createBareRepository,
  createBranch,
  deleteBareRepository,
  importMirror,
  listBranches,
  listCommits,
  listTree,
  mergeBranches,
  readBlob,
  repositoryExists,
} from './git.mjs';
import { handleGitHttp, isGitHttpPath } from './git-http.mjs';
import { assertBranch, assertSlug, httpError, originAllowed, validateRemoteUrl } from './security.mjs';
import { PUBLISHED_DEV_CREDENTIALS } from './config.mjs';
import { assertWithinPlan } from './plan-limits.mjs';
import { normalizeImportToken } from './repository-import.mjs';
import { startTwoFactorChallenge, twoFactorEnabled } from './two-factor.mjs';
import { KUKGIT_VERSION } from './version.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function sendNoContent(res, headers = {}) {
  res.writeHead(204, headers);
  res.end();
}

/**
 * What the sign-in page is allowed to fill in for the caller.
 *
 * The starter founder account is published — README, `.env.example`, this
 * repository. Printing it on the sign-in page is a convenience on a laptop and
 * an advertisement on anything with a public address, so the page is told the
 * credentials only when the instance is demonstrably still using them.
 *
 * Every condition has to hold, and each one alone is enough to withhold them:
 * local auth mode, not production, and both values still the published ones. A
 * deployment that changed either value gets nothing — the page then shows an
 * empty form, which is the correct thing to show a stranger.
 */
export function signInHints(config) {
  if (config.isProduction) return { demoAccount: null };
  if (config.authMode !== 'local') return { demoAccount: null };
  if (config.adminEmail !== PUBLISHED_DEV_CREDENTIALS.email) return { demoAccount: null };
  if (config.adminPassword !== PUBLISHED_DEV_CREDENTIALS.password) return { demoAccount: null };
  return { demoAccount: { ...PUBLISHED_DEV_CREDENTIALS } };
}

async function readJson(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.'); }
}

function routeMatch(pathname, pattern) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  }) + '$');
  const match = pathname.match(regex);
  if (!match) return null;
  return Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
}

function requireOrg(db, user, orgSlug, role = 'viewer') {
  const org = orgAccess(db, user.id, orgSlug, role);
  if (!org) throw httpError(403, 'You do not have permission for this organization.', 'FORBIDDEN');
  return org;
}

function requireRepo(db, config, user, orgSlug, repoSlug, role = 'viewer') {
  const org = requireOrg(db, user, orgSlug, role);
  const repo = findRepo(db, orgSlug, repoSlug);
  if (!repo || !repositoryExists(config, orgSlug, repoSlug)) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
  return { org, repo };
}

function repoDto(config, row) {
  return {
    id: row.id,
    orgSlug: row.org_slug ?? row.orgSlug,
    orgName: row.org_name ?? row.orgName,
    slug: row.slug,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    defaultBranch: row.default_branch ?? row.defaultBranch,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
    cloneUrl: `${config.baseUrl}/git/${row.org_slug ?? row.orgSlug}/${row.slug}.git`,
  };
}

function serveStatic(req, res, config, pathname) {
  let requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const extension = path.extname(requested);
  if (!extension && !requested.startsWith('assets/')) requested = 'index.html';
  const target = path.resolve(config.publicDir, requested);
  if (!target.startsWith(path.resolve(config.publicDir) + path.sep) && target !== path.resolve(config.publicDir, 'index.html')) {
    throw httpError(403, 'Forbidden.');
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    const fallback = path.join(config.publicDir, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    return fs.createReadStream(fallback).pipe(res);
  }
  const stat = fs.statSync(target);
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  // Images are addressed by a name that changes when the image does. The
  // application code is not: `app.js` keeps its URL across every deploy, so a
  // plain max-age meant a browser held the old file for an hour and never asked
  // — including for a fix to what that file shows a signed-out visitor. These
  // revalidate instead, which costs a 304 and lands a deploy immediately.
  const longLived = requested.startsWith('assets/');
  const cacheControl = longLived ? 'public, max-age=3600' : 'no-cache';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(target).pipe(res);
}

function repoQuery(db, userId) {
  return db.prepare(`
    SELECT r.*, o.slug AS org_slug, o.name AS org_name, om.role
    FROM repositories r
    JOIN organizations o ON o.id = r.organization_id
    JOIN org_members om ON om.organization_id = o.id
    WHERE om.user_id = ?
    ORDER BY r.updated_at DESC
  `).all(userId);
}

export function createApp({ config, db }) {
  return async function app(req, res) {
    const started = Date.now();
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");

    try {
      const url = new URL(req.url, config.baseUrl);
      const pathname = url.pathname;

      if (isGitHttpPath(pathname)) {
        return handleGitHttp(req, res, { config, db, pathname, queryString: url.searchParams.toString() });
      }

      if (!pathname.startsWith('/api/')) return serveStatic(req, res, config, pathname);
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');

      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { status: 'ok', service: 'kukgit', version: KUKGIT_VERSION, uptimeSeconds: Math.floor(process.uptime()), requestId });
      }

      if (req.method === 'GET' && pathname === '/api/auth/sign-in-hints') {
        return sendJson(res, 200, signInHints(config));
      }

      if (req.method === 'POST' && pathname === '/api/auth/login') {
        const body = await readJson(req);
        const user = authenticate(db, body.email, body.password);
        if (twoFactorEnabled(db, user.id)) {
          // No session yet, and deliberately nothing that resembles one. The
          // challenge names an account whose password was just proved; it
          // grants nothing until a code is added to it.
          audit(db, { userId: user.id, action: 'auth.two_factor_required', targetType: 'user', targetId: user.id });
          return sendJson(res, 200, {
            twoFactorRequired: true,
            challenge: startTwoFactorChallenge(db, { userId: user.id }),
          });
        }
        const session = createSession(db, user.id);
        audit(db, { userId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id });
        return sendJson(res, 200, { user: { id: user.id, email: user.email, displayName: user.displayName } }, { 'Set-Cookie': sessionCookie(session.token, config.cookieSecure) });
      }

      if (req.method === 'POST' && pathname === '/api/auth/logout') {
        const user = currentUser(db, req);
        destroySession(db, req);
        if (user) audit(db, { userId: user.id, action: 'auth.logout', targetType: 'user', targetId: user.id });
        return sendNoContent(res, { 'Set-Cookie': clearSessionCookie(config.cookieSecure) });
      }

      if (req.method === 'GET' && pathname === '/api/auth/me') {
        const user = currentUser(db, req);
        if (!user) return sendJson(res, 200, { user: null });
        const organizations = db.prepare(`SELECT o.id, o.slug, o.name, o.plan, om.role FROM organizations o JOIN org_members om ON om.organization_id = o.id WHERE om.user_id = ? ORDER BY o.name`).all(user.id);
        return sendJson(res, 200, { user, organizations });
      }

      const user = requireUser(db, req);

      if (req.method === 'GET' && pathname === '/api/dashboard') {
        const repositories = repoQuery(db, user.id);
        const repoIds = repositories.map((repo) => repo.id);
        const placeholders = repoIds.map(() => '?').join(',') || "''";
        const openIssues = repoIds.length ? db.prepare(`SELECT COUNT(*) AS count FROM issues WHERE status = 'open' AND repository_id IN (${placeholders})`).get(...repoIds).count : 0;
        const openPulls = repoIds.length ? db.prepare(`SELECT COUNT(*) AS count FROM pull_requests WHERE status = 'open' AND repository_id IN (${placeholders})`).get(...repoIds).count : 0;
        const latestAnalyses = repoIds.length ? db.prepare(`
          SELECT a.score FROM analyses a
          JOIN (SELECT repository_id, MAX(created_at) AS latest FROM analyses GROUP BY repository_id) latest
          ON latest.repository_id = a.repository_id AND latest.latest = a.created_at
          WHERE a.repository_id IN (${placeholders})
        `).all(...repoIds) : [];
        const aiHealth = latestAnalyses.length ? Math.round(latestAnalyses.reduce((sum, row) => sum + row.score, 0) / latestAnalyses.length) : null;
        const activity = db.prepare(`
          SELECT a.action, a.target_type AS targetType, a.target_id AS targetId, a.metadata_json AS metadataJson, a.created_at AS createdAt,
            o.name AS organizationName, u.display_name AS userName
          FROM audit_logs a LEFT JOIN organizations o ON o.id = a.organization_id LEFT JOIN users u ON u.id = a.user_id
          WHERE a.organization_id IN (SELECT organization_id FROM org_members WHERE user_id = ?)
          ORDER BY a.created_at DESC LIMIT 12
        `).all(user.id).map((row) => ({ ...row, metadata: JSON.parse(row.metadataJson || '{}'), metadataJson: undefined }));
        return sendJson(res, 200, {
          metrics: { repositories: repositories.length, openIssues, openPulls, aiHealth },
          repositories: repositories.slice(0, 8).map((repo) => repoDto(config, repo)),
          activity,
        });
      }

      if (req.method === 'GET' && pathname === '/api/orgs') {
        const organizations = db.prepare(`SELECT o.id, o.slug, o.name, o.plan, om.role, o.created_at AS createdAt FROM organizations o JOIN org_members om ON om.organization_id = o.id WHERE om.user_id = ? ORDER BY o.name`).all(user.id);
        return sendJson(res, 200, { organizations });
      }

      if (req.method === 'GET' && pathname === '/api/repos') {
        const repositories = repoQuery(db, user.id).map((repo) => repoDto(config, repo));
        return sendJson(res, 200, { repositories });
      }

      if (req.method === 'POST' && pathname === '/api/repos') {
        const body = await readJson(req);
        const orgSlug = assertSlug(body.orgSlug, 'organization slug');
        const slug = assertSlug(body.slug, 'repository slug');
        const org = requireOrg(db, user, orgSlug, 'maintainer');
        if (findRepo(db, orgSlug, slug)) throw httpError(409, 'A repository with this name already exists.');
        // Before the bare repository exists on disk, so a refusal leaves
        // nothing behind to clean up.
        assertWithinPlan(db, config, { organizationId: org.id, resource: 'repositories' });
        const visibility = ['public', 'private', 'internal'].includes(body.visibility) ? body.visibility : 'private';
        const repoId = uid('repo');
        createBareRepository(config, orgSlug, slug);
        try {
          db.prepare(`INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by) VALUES (?, ?, ?, ?, ?, ?, 'main', ?)`)
            .run(repoId, org.id, slug, String(body.name || slug).slice(0, 120), String(body.description || '').slice(0, 500), visibility, user.id);
        } catch (error) {
          deleteBareRepository(config, orgSlug, slug);
          throw error;
        }
        audit(db, { organizationId: org.id, userId: user.id, action: 'repository.created', targetType: 'repository', targetId: repoId, metadata: { slug, visibility } });
        return sendJson(res, 201, { repository: repoDto(config, findRepo(db, orgSlug, slug)) });
      }

      if (req.method === 'POST' && pathname === '/api/repos/import') {
        const body = await readJson(req);
        const orgSlug = assertSlug(body.orgSlug, 'organization slug');
        const slug = assertSlug(body.slug, 'repository slug');
        const sourceUrl = validateRemoteUrl(body.sourceUrl);
        // Validated before the network call, so a malformed token is refused in
        // a millisecond rather than after a three-minute clone.
        const credential = normalizeImportToken(body.accessToken);
        const org = requireOrg(db, user, orgSlug, 'maintainer');
        if (findRepo(db, orgSlug, slug)) throw httpError(409, 'A repository with this name already exists.');
        // The same limit the create route enforces. Without it a plan's
        // repository cap was enforced on `Create new` and bypassed by anybody
        // who chose `Import existing` — the identical resource, billed the same,
        // reached by a different button.
        assertWithinPlan(db, config, { organizationId: org.id, resource: 'repositories' });
        await importMirror(config, orgSlug, slug, sourceUrl, { credential });
        const branches = listBranches(config, orgSlug, slug);
        const defaultBranch = branches.some((branch) => branch.name === 'main') ? 'main' : branches.some((branch) => branch.name === 'master') ? 'master' : branches[0]?.name || 'main';
        const repoId = uid('repo');
        try {
          db.prepare(`INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(repoId, org.id, slug, String(body.name || slug).slice(0, 120), String(body.description || `Imported from ${new URL(sourceUrl.replace(/^git@([^:]+):/, 'ssh://git@$1/')).hostname}`).slice(0, 500), body.visibility === 'public' ? 'public' : 'private', defaultBranch, user.id);
        } catch (error) {
          deleteBareRepository(config, orgSlug, slug);
          throw error;
        }
        audit(db, { organizationId: org.id, userId: user.id, action: 'repository.imported', targetType: 'repository', targetId: repoId, // Whether a token was used, never the token. An audit row is read by
        // more people than a database row, and is exported.
        metadata: { slug, sourceHost: sourceUrl.split('/')[2] || 'ssh', authenticated: Boolean(credential) } });
        return sendJson(res, 201, { repository: repoDto(config, findRepo(db, orgSlug, slug)) });
      }

      let params = routeMatch(pathname, '/api/repos/:org/:repo');
      if (req.method === 'GET' && params) {
        const { repo } = requireRepo(db, config, user, params.org, params.repo);
        const branches = listBranches(config, params.org, params.repo);
        const issues = db.prepare("SELECT COUNT(*) AS count FROM issues WHERE repository_id = ? AND status = 'open'").get(repo.id).count;
        const pulls = db.prepare("SELECT COUNT(*) AS count FROM pull_requests WHERE repository_id = ? AND status = 'open'").get(repo.id).count;
        return sendJson(res, 200, { repository: { ...repoDto(config, repo), branches: branches.length, openIssues: issues, openPulls: pulls } });
      }

      params = routeMatch(pathname, '/api/repos/:org/:repo/branches');
      if (req.method === 'GET' && params) {
        const { repo } = requireRepo(db, config, user, params.org, params.repo);
        return sendJson(res, 200, { defaultBranch: repo.default_branch, branches: listBranches(config, params.org, params.repo) });
      }
      if (req.method === 'POST' && params) {
        const { org } = requireRepo(db, config, user, params.org, params.repo, 'developer');
        const body = await readJson(req);
        const branch = createBranch(config, params.org, params.repo, body.name, body.fromRef || 'main');
        audit(db, { organizationId: org.id, userId: user.id, action: 'branch.created', targetType: 'branch', metadata: { repository: params.repo, ...branch } });
        return sendJson(res, 201, { branch });
      }

      params = routeMatch(pathname, '/api/repos/:org/:repo/commits');
      if (req.method === 'GET' && params) {
        const { repo } = requireRepo(db, config, user, params.org, params.repo);
        const ref = url.searchParams.get('ref') || repo.default_branch;
        return sendJson(res, 200, { ref, commits: listCommits(config, params.org, params.repo, ref, url.searchParams.get('limit')) });
      }

      params = routeMatch(pathname, '/api/repos/:org/:repo/tree');
      if (req.method === 'GET' && params) {
        const { repo } = requireRepo(db, config, user, params.org, params.repo);
        const ref = url.searchParams.get('ref') || repo.default_branch;
        const directory = url.searchParams.get('path') || '';
        return sendJson(res, 200, { ref, path: directory, entries: listTree(config, params.org, params.repo, ref, directory) });
      }

      params = routeMatch(pathname, '/api/repos/:org/:repo/blob');
      if (req.method === 'GET' && params) {
        const { repo } = requireRepo(db, config, user, params.org, params.repo);
        const ref = url.searchParams.get('ref') || repo.default_branch;
        const filePath = url.searchParams.get('path');
        return sendJson(res, 200, { ref, file: readBlob(config, params.org, params.repo, ref, filePath) });
      }

      params = routeMatch(pathname, '/api/repos/:org/:repo/files');
      if (req.method === 'POST' && params) {
        const { org, repo } = requireRepo(db, config, user, params.org, params.repo, 'developer');
        const body = await readJson(req, 2 * 1024 * 1024);
        const result = await commitFile(config, params.org, params.repo, {
          branch: body.branch || repo.default_branch,
          filePath: body.path,
          content: body.content,
          message: body.message,
          authorName: user.displayName,
          authorEmail: user.email,
        });
        db.prepare('UPDATE repositories SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(repo.id);
        audit(db, { organizationId: org.id, userId: user.id, action: 'commit.created', targetType: 'commit', targetId: result.sha, metadata: { repository: params.repo, branch: result.branch, path: result.path } });
        return sendJson(res, 201, { commit: result });
      }

      params = routeMatch(pathname, '/api/repos/:org/:repo/issues');
      if (req.method === 'GET' && params) {
        const { repo } = requireRepo(db, config, user, params.org, params.repo);
        const status = url.searchParams.get('status');
        const rows = status === 'closed' || status === 'open'
          ? db.prepare(`SELECT i.*, u.display_name AS author_name, a.display_name AS assignee_name FROM issues i JOIN users u ON u.id = i.author_id LEFT JOIN users a ON a.id = i.assignee_id WHERE i.repository_id = ? AND i.status = ? ORDER BY i.created_at DESC`).all(repo.id, status)
          : db.prepare(`SELECT i.*, u.display_name AS author_name, a.display_name AS assignee_name FROM issues i JOIN users u ON u.id = i.author_id LEFT JOIN users a ON a.id = i.assignee_id WHERE i.repository_id = ? ORDER BY i.created_at DESC`).all(repo.id);
        return sendJson(res, 200, { issues: rows.map((row) => ({ id: row.id, number: row.number, title: row.title, body: row.body, status: row.status, priority: row.priority, authorName: row.author_name, assigneeName: row.assignee_name, createdAt: row.created_at, updatedAt: row.updated_at })) });
      }
      if (req.method === 'POST' && params) {
        const { org, repo } = requireRepo(db, config, user, params.org, params.repo, 'developer');
        const body = await readJson(req);
        if (!String(body.title || '').trim()) throw httpError(400, 'Issue title is required.');
        const number = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM issues WHERE repository_id = ?').get(repo.id).next;
        const id = uid('iss');
        const priority = ['low', 'medium', 'high', 'critical'].includes(body.priority) ? body.priority : 'medium';
        db.prepare('INSERT INTO issues (id, repository_id, number, title, body, priority, author_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, repo.id, number, String(body.title).trim().slice(0, 220), String(body.body || '').slice(0, 20000), priority, user.id);
        audit(db, { organizationId: org.id, userId: user.id, action: 'issue.created', targetType: 'issue', targetId: id, metadata: { repository: params.repo, number, title: body.title } });
        return sendJson(res, 201, { issue: { id, number, title: body.title, body: body.body || '', status: 'open', priority, authorName: user.displayName } });
      }

      params = routeMatch(pathname, '/api/repos/:org/:repo/issues/:number');
      if (req.method === 'PATCH' && params) {
        const { org, repo } = requireRepo(db, config, user, params.org, params.repo, 'developer');
        const body = await readJson(req);
        const issue = db.prepare('SELECT * FROM issues WHERE repository_id = ? AND number = ?').get(repo.id, Number(params.number));
        if (!issue) throw httpError(404, 'Issue not found.');
        const status = body.status === 'closed' ? 'closed' : body.status === 'open' ? 'open' : issue.status;
        db.prepare('UPDATE issues SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, issue.id);
        audit(db, { organizationId: org.id, userId: user.id, action: `issue.${status}`, targetType: 'issue', targetId: issue.id, metadata: { repository: params.repo, number: issue.number } });
        return sendJson(res, 200, { issue: { ...issue, status } });
      }

      params = routeMatch(pathname, '/api/repos/:org/:repo/pulls');
      if (req.method === 'GET' && params) {
        const { repo } = requireRepo(db, config, user, params.org, params.repo);
        const pulls = db.prepare(`SELECT p.*, u.display_name AS author_name FROM pull_requests p JOIN users u ON u.id = p.author_id WHERE p.repository_id = ? ORDER BY p.created_at DESC`).all(repo.id).map((row) => {
          let comparison = null;
          if (row.status === 'open') {
            try { comparison = compareBranches(config, params.org, params.repo, row.base_branch, row.head_branch); } catch { comparison = null; }
          }
          return { id: row.id, number: row.number, title: row.title, body: row.body, baseBranch: row.base_branch, headBranch: row.head_branch, status: row.status, authorName: row.author_name, mergedAt: row.merged_at, createdAt: row.created_at, updatedAt: row.updated_at, comparison };
        });
        return sendJson(res, 200, { pullRequests: pulls });
      }
      if (req.method === 'POST' && params) {
        const { org, repo } = requireRepo(db, config, user, params.org, params.repo, 'developer');
        const body = await readJson(req);
        const title = String(body.title || '').trim();
        if (!title) throw httpError(400, 'Pull request title is required.');
        const baseBranch = assertBranch(body.baseBranch || repo.default_branch);
        const headBranch = assertBranch(body.headBranch);
        const comparison = compareBranches(config, params.org, params.repo, baseBranch, headBranch);
        if (comparison.ahead < 1) throw httpError(409, 'The head branch has no commits to merge.');
        const number = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM pull_requests WHERE repository_id = ?').get(repo.id).next;
        const id = uid('pr');
        db.prepare('INSERT INTO pull_requests (id, repository_id, number, title, body, base_branch, head_branch, author_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, repo.id, number, title.slice(0, 220), String(body.body || '').slice(0, 20000), baseBranch, headBranch, user.id);
        audit(db, { organizationId: org.id, userId: user.id, action: 'pull_request.created', targetType: 'pull_request', targetId: id, metadata: { repository: params.repo, number, baseBranch, headBranch } });
        return sendJson(res, 201, { pullRequest: { id, number, title, body: body.body || '', baseBranch, headBranch, status: 'open', comparison } });
      }

      params = routeMatch(pathname, '/api/repos/:org/:repo/pulls/:number/merge');
      if (req.method === 'POST' && params) {
        const { org, repo } = requireRepo(db, config, user, params.org, params.repo, 'maintainer');
        const pull = db.prepare('SELECT * FROM pull_requests WHERE repository_id = ? AND number = ?').get(repo.id, Number(params.number));
        if (!pull) throw httpError(404, 'Pull request not found.');
        if (pull.status !== 'open') throw httpError(409, 'Only open pull requests can be merged.');
        const result = await mergeBranches(config, params.org, params.repo, { baseBranch: pull.base_branch, headBranch: pull.head_branch, title: `Merge pull request #${pull.number}: ${pull.title}`, authorName: user.displayName, authorEmail: user.email });
        db.prepare("UPDATE pull_requests SET status = 'merged', merged_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(pull.id);
        db.prepare('UPDATE repositories SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(repo.id);
        audit(db, { organizationId: org.id, userId: user.id, action: 'pull_request.merged', targetType: 'pull_request', targetId: pull.id, metadata: { repository: params.repo, number: pull.number, commit: result.sha } });
        return sendJson(res, 200, { pullRequest: { ...pull, status: 'merged', mergeCommit: result } });
      }

      params = routeMatch(pathname, '/api/repos/:org/:repo/analyze');
      if (req.method === 'POST' && params) {
        const { org, repo } = requireRepo(db, config, user, params.org, params.repo, 'developer');
        const body = await readJson(req);
        const ref = body.ref || repo.default_branch;
        const result = analyzeRepository(config, db, repo, ref);
        const id = uid('ana');
        db.prepare('INSERT INTO analyses (id, repository_id, ref, score, payload_json) VALUES (?, ?, ?, ?, ?)')
          .run(id, repo.id, ref, result.score, JSON.stringify(result));
        audit(db, { organizationId: org.id, userId: user.id, action: 'analysis.completed', targetType: 'analysis', targetId: id, metadata: { repository: params.repo, ref, score: result.score } });
        return sendJson(res, 200, { analysis: { id, ...result } });
      }
      if (req.method === 'GET' && params) {
        const { repo } = requireRepo(db, config, user, params.org, params.repo);
        const row = db.prepare('SELECT id, payload_json AS payloadJson, created_at AS createdAt FROM analyses WHERE repository_id = ? ORDER BY created_at DESC LIMIT 1').get(repo.id);
        return sendJson(res, 200, { analysis: row ? { id: row.id, createdAt: row.createdAt, ...JSON.parse(row.payloadJson) } : null });
      }

      if (req.method === 'GET' && pathname === '/api/issues') {
        const rows = db.prepare(`
          SELECT i.number, i.title, i.status, i.priority, i.created_at AS createdAt, r.slug AS repoSlug, o.slug AS orgSlug
          FROM issues i JOIN repositories r ON r.id = i.repository_id JOIN organizations o ON o.id = r.organization_id
          JOIN org_members om ON om.organization_id = o.id WHERE om.user_id = ? ORDER BY i.created_at DESC LIMIT 100
        `).all(user.id);
        return sendJson(res, 200, { issues: rows });
      }

      if (req.method === 'GET' && pathname === '/api/pulls') {
        const rows = db.prepare(`
          SELECT p.number, p.title, p.status, p.base_branch AS baseBranch, p.head_branch AS headBranch, p.created_at AS createdAt, r.slug AS repoSlug, o.slug AS orgSlug
          FROM pull_requests p JOIN repositories r ON r.id = p.repository_id JOIN organizations o ON o.id = r.organization_id
          JOIN org_members om ON om.organization_id = o.id WHERE om.user_id = ? ORDER BY p.created_at DESC LIMIT 100
        `).all(user.id);
        return sendJson(res, 200, { pullRequests: rows });
      }

      if (req.method === 'GET' && pathname === '/api/audit') {
        const rows = db.prepare(`
          SELECT a.action, a.target_type AS targetType, a.target_id AS targetId, a.metadata_json AS metadataJson, a.created_at AS createdAt,
            o.slug AS orgSlug, u.display_name AS userName
          FROM audit_logs a LEFT JOIN organizations o ON o.id = a.organization_id LEFT JOIN users u ON u.id = a.user_id
          WHERE a.organization_id IN (SELECT organization_id FROM org_members WHERE user_id = ?)
          ORDER BY a.created_at DESC LIMIT 100
        `).all(user.id).map((row) => ({ ...row, metadata: JSON.parse(row.metadataJson), metadataJson: undefined }));
        return sendJson(res, 200, { auditLogs: rows });
      }

      throw httpError(404, 'API endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}]`, error);
      if (!res.headersSent) sendJson(res, status, { error: { code: error.code || 'INTERNAL_ERROR', message: status >= 500 ? 'An unexpected server error occurred.' : error.message, requestId } });
      else res.end();
    } finally {
      if (config.nodeEnv !== 'test') console.log(`${req.method} ${req.url} ${res.statusCode || 200} ${Date.now() - started}ms ${requestId}`);
    }
  };
}
