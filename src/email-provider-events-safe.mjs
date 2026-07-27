import {
  createEmailProviderEventsApiHandler as createCoreHandler,
  ingestEmailProviderEvent,
  verifyEmailProviderSignature,
} from './email-provider-events.mjs';
import { httpError } from './security.mjs';

const MAX_WEBHOOK_BYTES = 256 * 1024;

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

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_WEBHOOK_BYTES) throw httpError(413, 'Request body is too large.', 'EMAIL_PROVIDER_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(raw) {
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

function sanitizeProviderPayload(db, payload) {
  const sanitized = { ...payload };
  delete sanitized.message_id;
  const requested = sanitized.outbox_id === null || sanitized.outbox_id === undefined
    ? ''
    : String(sanitized.outbox_id).trim();
  if (!requested || requested.length > 160) {
    delete sanitized.outbox_id;
    return sanitized;
  }
  const exists = db.prepare('SELECT 1 FROM email_outbox WHERE id = ?').get(requested);
  if (!exists) delete sanitized.outbox_id;
  else sanitized.outbox_id = requested;
  return sanitized;
}

function isAdministrationPath(pathname, method) {
  return pathname.startsWith('/api/email-provider/admin/') || (
    method === 'POST' && (
      /^\/api\/instance-admin\/email\/[^/]+\/retry$/.test(pathname) ||
      /^\/api\/notifications\/admin\/email\/[^/]+\/retry$/.test(pathname)
    )
  );
}

function strictOriginAllowed(req, config) {
  const supplied = String(req.headers.origin || '').trim();
  if (!supplied) return true;
  try { return new URL(supplied).origin === new URL(config.baseUrl).origin; }
  catch { return false; }
}

export function createEmailProviderEventsApiHandler({ config, db }) {
  const core = createCoreHandler({ config, db });
  return async function safeEmailProviderEventsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    if (isAdministrationPath(url.pathname, req.method) && !strictOriginAllowed(req, config)) {
      return sendJson(res, 403, {
        error: { code: 'CSRF_BLOCKED', message: 'Request origin is not allowed.' },
      });
    }
    if (req.method !== 'POST' || url.pathname !== '/api/email-provider/events') {
      return core(req, res);
    }
    if (!config.emailProviderEventsEnabled) {
      return sendJson(res, 404, {
        error: { code: 'EMAIL_PROVIDER_EVENTS_DISABLED', message: 'Email provider events are not enabled.' },
      });
    }
    try {
      const raw = await readRaw(req);
      verifyEmailProviderSignature(config, req.headers, raw);
      const payload = sanitizeProviderPayload(db, parseJson(raw));
      const result = ingestEmailProviderEvent(db, config, payload, raw);
      return sendJson(res, result.duplicate ? 200 : 202, result);
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'EMAIL_PROVIDER_EVENT_FAILED',
          message: status >= 500 ? 'Email provider event processing failed.' : error.message,
        },
      });
    }
  };
}
