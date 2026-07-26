import { createGitLfsHandler as createCoreGitLfsHandler } from './git-lfs.mjs';

export * from './git-lfs.mjs';

function isGitLfsRequest(req, baseUrl) {
  const pathname = new URL(req.url, baseUrl).pathname;
  return pathname.startsWith('/api/lfs') || /^\/git\/[a-z0-9][a-z0-9-]{1,62}\/[a-z0-9][a-z0-9-]{1,62}\.git\/info\/lfs(?:\/|$)/.test(pathname);
}

export function createGitLfsHandler(options) {
  const core = createCoreGitLfsHandler(options);
  return async function handleGitLfsSafely(req, res) {
    const eligible = isGitLfsRequest(req, options.config.baseUrl);
    const handled = await core(req, res);
    if (handled) return true;
    if (eligible && (res.headersSent || res.writableEnded)) return true;
    return false;
  };
}
