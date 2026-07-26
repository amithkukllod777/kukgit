import { createNotificationEventCapture as createCoreCapture } from './notification-events.mjs';

function eligible(pathname, method) {
  if (method !== 'POST') return false;
  return /^\/api\/repos\/[^/]+\/[^/]+\/pulls(?:\/\d+\/merge)?$/.test(pathname)
    || /^\/api\/governance\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/.test(pathname)
    || /^\/api\/status-checks\/[^/]+\/[^/]+\/commits\/[0-9a-f]{40}\/statuses$/i.test(pathname);
}

export function createNotificationEventCapture({ config, db, next }) {
  const core = createCoreCapture({ config, db, next });
  return function scopedNotificationEventCapture(req, res) {
    const pathname = new URL(req.url, config.baseUrl).pathname;
    return eligible(pathname, String(req.method || 'GET').toUpperCase()) ? core(req, res) : next(req, res);
  };
}
