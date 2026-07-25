import path from 'node:path';
import { spawnGitHttpBackend } from './git.mjs';
import { safeEqual } from './security.mjs';

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
  res.end('Authentication required.\n');
}

export function isGitHttpPath(pathname) {
  return pathname.startsWith('/git/') && pathname.includes('.git');
}

export function handleGitHttp(req, res, { config, db, pathname, queryString }) {
  const match = pathname.match(/^\/git\/([a-z0-9][a-z0-9-]{1,62})\/([a-z0-9][a-z0-9-]{1,62})\.git(\/.*)?$/);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Repository not found.\n');
  }
  const [, orgSlug, repoSlug, suffix = '/'] = match;
  const repo = db.prepare(`SELECT r.visibility FROM repositories r JOIN organizations o ON o.id = r.organization_id WHERE o.slug = ? AND r.slug = ?`).get(orgSlug, repoSlug);
  if (!repo) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Repository not found.\n');
  }

  const isPush = suffix.includes('git-receive-pack') || queryString.includes('service=git-receive-pack');
  const requiresAuth = isPush || repo.visibility !== 'public';
  if (requiresAuth) {
    const credentials = parseBasicAuth(req.headers.authorization);
    if (!credentials || !config.gitToken || !safeEqual(credentials.password, config.gitToken)) return rejectAuth(res);
  }

  const env = {
    GIT_PROJECT_ROOT: config.repositoriesDir,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: `/${orgSlug}/${repoSlug}.git${suffix}`,
    REQUEST_METHOD: req.method,
    QUERY_STRING: queryString,
    CONTENT_TYPE: req.headers['content-type'] ?? '',
    CONTENT_LENGTH: req.headers['content-length'] ?? '',
    REMOTE_USER: requiresAuth ? 'kukgit-user' : '',
    REMOTE_ADDR: req.socket.remoteAddress ?? '',
    SERVER_PROTOCOL: `HTTP/${req.httpVersion}`,
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
