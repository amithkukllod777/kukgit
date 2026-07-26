import { audit, orgAccess } from './db.mjs';
import { spawnGitHttpBackend } from './git.mjs';
import { getEffectiveRepositoryAccess, permissionAtLeast } from './repository-access.mjs';
import { safeEqual } from './security.mjs';
import { verifyPersonalAccessToken } from './tokens.mjs';

function parseBasicAuth(header = '') {
  if (!header.startsWith('Basic ')) return null;
  try {
    const raw = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const index = raw.indexOf(':');
    return index >= 0 ? { username: raw.slice(0, index), password: raw.slice(index + 1) } : null;
  } catch {
    return null;
  }
}

function rejectAuth(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="KukGit"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Authentication required. Use a scoped KukGit personal access token.\n');
}

export function isGitHttpPath(pathname) {
  return pathname.startsWith('/git/') && pathname.includes('.git');
}

export function authorizeGitCredential(db, config, { credential, orgSlug, repoSlug = null, isPush }) {
  const presented = String(credential ?? '');
  if (!presented) return null;

  if (!config.isProduction && config.gitToken && safeEqual(presented, config.gitToken)) {
    return { authType: 'development-token', userId: null, username: 'kukgit-development-token', organization: null, repositoryPermission: 'admin' };
  }

  const requiredScope = isPush ? 'repo:write' : 'repo:read';
  const token = verifyPersonalAccessToken(db, presented, requiredScope);
  if (!token) return null;

  if (repoSlug) {
    const access = getEffectiveRepositoryAccess(db, { userId: token.userId, orgSlug, repoSlug });
    const requiredPermission = isPush ? 'write' : 'read';
    if (!access || !permissionAtLeast(access.permission, requiredPermission)) return null;
    return {
      authType: 'personal-access-token',
      userId: token.userId,
      username: token.email,
      tokenId: token.id,
      organization: { id: access.repository.organizationId, slug: access.repository.orgSlug, name: access.repository.orgName },
      repositoryPermission: access.permission,
    };
  }

  const organization = orgAccess(db, token.userId, orgSlug, isPush ? 'developer' : 'viewer');
  if (!organization) return null;
  return { authType: 'personal-access-token', userId: token.userId, username: token.email, tokenId: token.id, organization, repositoryPermission: null };
}

export function handleGitHttp(req, res, { config, db, pathname, queryString }) {
  const match = pathname.match(/^\/git\/([a-z0-9][a-z0-9-]{1,62})\/([a-z0-9][a-z0-9-]{1,62})\.git(\/.*)?$/);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Repository not found.\n');
  }
  const [, orgSlug, repoSlug, suffix = '/'] = match;
  const repo = db.prepare(`
    SELECT r.id, r.visibility, r.organization_id AS organizationId
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ?
  `).get(orgSlug, repoSlug);
  if (!repo) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Repository not found.\n');
  }

  const isPush = suffix.includes('git-receive-pack') || queryString.includes('service=git-receive-pack');
  const requiresAuth = isPush || repo.visibility !== 'public';
  let authenticated = null;
  if (requiresAuth) {
    const credentials = parseBasicAuth(req.headers.authorization);
    const credential = credentials?.password || (credentials?.username?.startsWith('kgp_') ? credentials.username : '');
    authenticated = authorizeGitCredential(db, config, { credential, orgSlug, repoSlug, isPush });
    if (!authenticated) return rejectAuth(res);
    audit(db, {
      organizationId: repo.organizationId,
      userId: authenticated.userId,
      action: isPush ? 'git.push' : 'git.fetch',
      targetType: 'repository',
      targetId: repo.id,
      metadata: { repository: repoSlug, authType: authenticated.authType, repositoryPermission: authenticated.repositoryPermission },
    });
  }

  const env = {
    GIT_PROJECT_ROOT: config.repositoriesDir,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: `/${orgSlug}/${repoSlug}.git${suffix}`,
    REQUEST_METHOD: req.method,
    QUERY_STRING: queryString,
    CONTENT_TYPE: req.headers['content-type'] ?? '',
    CONTENT_LENGTH: req.headers['content-length'] ?? '',
    REMOTE_USER: authenticated?.username ?? '',
    REMOTE_ADDR: req.socket.remoteAddress ?? '',
    SERVER_PROTOCOL: `HTTP/${req.httpVersion}`,
    KUKGIT_DATABASE_PATH: config.databasePath,
    KUKGIT_REPOSITORY_ID: repo.id,
    KUKGIT_AUTH_USER_ID: authenticated?.userId ?? '',
  };

  const child = spawnGitHttpBackend({ env });
  let headerBuffer = Buffer.alloc(0);
  let headersSent = false;

  child.stdout.on('data', (chunk) => {
    if (headersSent) return void res.write(chunk);
    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    const separator = headerBuffer.indexOf('\r\n\r\n');
    const altSeparator = separator < 0 ? headerBuffer.indexOf('\n\n') : -1;
    const end = separator >= 0 ? separator : altSeparator;
    const width = separator >= 0 ? 4 : 2;
    if (end < 0) return;
    const rawHeaders = headerBuffer.subarray(0, end).toString('utf8').split(/\r?\n/);
    const responseHeaders = {};
    let status = 200;
    for (const line of rawHeaders) {
      const index = line.indexOf(':');
      if (index < 0) continue;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]) || 200;
      else responseHeaders[key] = value;
    }
    res.writeHead(status, responseHeaders);
    headersSent = true;
    const remainder = headerBuffer.subarray(end + width);
    if (remainder.length) res.write(remainder);
    headerBuffer = Buffer.alloc(0);
  });

  child.stderr.on('data', (chunk) => process.stderr.write(`[git-http] ${chunk}`));
  child.on('error', (error) => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Git backend error: ${error.message}\n`);
  });
  child.on('close', (code) => {
    if (!headersSent && !res.headersSent) res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end();
  });
  req.pipe(child.stdin);
}
