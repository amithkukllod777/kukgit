function matchDeployKeyRoute(pathname) {
  const match = pathname.match(/^\/api\/ssh-keys\/([^/]+)\/([^/]+)\/deploy-keys(?:\/[^/]+)?$/);
  if (!match) return null;
  try {
    return { orgSlug: decodeURIComponent(match[1]), repoSlug: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

function sendArchived(res) {
  const body = JSON.stringify({
    error: {
      code: 'REPOSITORY_ARCHIVED',
      message: 'This repository is archived and read-only. Unarchive it before changing deploy keys.',
    },
  });
  res.writeHead(409, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export function createSshKeysArchiveGuard({ config, db, next }) {
  return async function sshKeysArchiveGuard(req, res) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase())) return next(req, res);
    const url = new URL(req.url, config.baseUrl);
    const reference = matchDeployKeyRoute(url.pathname);
    if (!reference) return next(req, res);
    const repository = db.prepare(`
      SELECT r.archived_at AS archivedAt
      FROM repositories r JOIN organizations o ON o.id = r.organization_id
      WHERE o.slug = ? AND r.slug = ? AND r.deleted_at IS NULL
    `).get(reference.orgSlug, reference.repoSlug);
    if (repository?.archivedAt) {
      sendArchived(res);
      return;
    }
    return next(req, res);
  };
}
