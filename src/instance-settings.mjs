import crypto from 'node:crypto';
import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';
import { decryptSecretValue, encryptSecretValue } from './secrets-vault.mjs';

/**
 * Integration settings an operator sets from the console.
 *
 * Everything an instance connects to used to live in the environment file,
 * which means every change is an SSH session and a restart — and a restart is
 * where somebody discovers the key had a trailing space. These are set from the
 * Instance Admin panel, stored encrypted, and read at the moment they are used.
 *
 * Three rules, and the first one is the whole point:
 *
 * **A secret is never read back.** Not by the API, not by the panel, not by an
 * operator. What can be read is whether it is set, a fingerprint, and who set
 * it last. An endpoint that returns the value is one stolen session away from
 * being every credential the business has.
 *
 * **Only declared settings exist.** An unknown key is refused rather than
 * stored. A settings table anybody can put anything into is a settings table
 * nobody can audit, and a typo becomes a value that silently never applies.
 *
 * **The environment still wins where it is set.** An operator who has already
 * put a key in `/etc/kukgit.env` gets what they configured; the console fills
 * the gaps. Two sources with the console winning would mean an environment file
 * that looks authoritative and is not.
 */

const SCOPE = 'instance';

/**
 * What can be configured, and which parts of it are secret.
 *
 * `env` names the variable that already carries this value, and takes
 * precedence when it is set.
 */
export const INTEGRATIONS = Object.freeze({
  'email.resend': {
    label: 'Resend',
    summary: 'Transactional email — invitations, notifications, security alerts.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, env: 'KUKGIT_RESEND_API_KEY' },
      { key: 'fromAddress', label: 'From address', secret: false, env: 'KUKGIT_EMAIL_FROM' },
      { key: 'fromName', label: 'From name', secret: false },
    ],
  },
  'billing.razorpay': {
    label: 'Razorpay',
    summary: 'Payments in India — UPI, netbanking, cards, e-mandate.',
    fields: [
      { key: 'keyId', label: 'Key ID', secret: false, env: 'KUKGIT_RAZORPAY_KEY_ID' },
      { key: 'keySecret', label: 'Key secret', secret: true, env: 'KUKGIT_RAZORPAY_KEY_SECRET' },
      { key: 'webhookSecret', label: 'Webhook secret', secret: true, env: 'KUKGIT_RAZORPAY_WEBHOOK_SECRET' },
    ],
  },
  'billing.stripe': {
    label: 'Stripe',
    summary: 'Payments outside India — cards and subscriptions.',
    fields: [
      { key: 'publishableKey', label: 'Publishable key', secret: false, env: 'KUKGIT_STRIPE_PUBLISHABLE_KEY' },
      { key: 'secretKey', label: 'Secret key', secret: true, env: 'KUKGIT_STRIPE_SECRET_KEY' },
      { key: 'webhookSecret', label: 'Webhook signing secret', secret: true, env: 'KUKGIT_STRIPE_WEBHOOK_SECRET' },
    ],
  },
  'auth.google': {
    label: 'Google',
    summary: 'Sign-in with Google. Production identity is One Kuklabs Account — federate this inside AuthKit rather than beside it.',
    fields: [
      { key: 'clientId', label: 'Client ID', secret: false, env: 'KUKGIT_GOOGLE_CLIENT_ID' },
      { key: 'clientSecret', label: 'Client secret', secret: true, env: 'KUKGIT_GOOGLE_CLIENT_SECRET' },
    ],
  },
  'auth.github': {
    label: 'GitHub',
    summary: 'Sign-in with GitHub. Same caveat as Google.',
    fields: [
      { key: 'clientId', label: 'Client ID', secret: false, env: 'KUKGIT_GITHUB_CLIENT_ID' },
      { key: 'clientSecret', label: 'Client secret', secret: true, env: 'KUKGIT_GITHUB_CLIENT_SECRET' },
    ],
  },
});

export function migrateInstanceSettings(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_settings (
      integration TEXT NOT NULL,
      field TEXT NOT NULL,
      value_plain TEXT,
      value_ciphertext TEXT,
      fingerprint TEXT,
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (integration, field)
    );
    CREATE TABLE IF NOT EXISTS instance_integration_state (
      integration TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function settingsTableExists(db) {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'instance_settings'").get());
}

function definition(integration, field) {
  const entry = INTEGRATIONS[integration];
  if (!entry) throw httpError(404, 'Unknown integration.', 'INTEGRATION_UNKNOWN');
  if (field === undefined) return { entry, field: null };
  const known = entry.fields.find((candidate) => candidate.key === field);
  // Refused rather than stored. A typo becomes a value that silently never
  // applies, and a table anybody can write anything into cannot be audited.
  if (!known) throw httpError(422, `Unknown field for ${integration}.`, 'INTEGRATION_FIELD_UNKNOWN');
  return { entry, field: known };
}

/**
 * A short, non-reversible marker so two people can agree they are looking at
 * the same key without either of them seeing it.
 */
function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

export function putInstanceSetting(db, config, { integration, field, value, actorId = null }) {
  const { field: known } = definition(integration, field);
  const text = String(value ?? '');
  if (!text.trim()) throw httpError(422, 'A value is required.', 'INTEGRATION_VALUE_REQUIRED');
  if (text.length > 4096) throw httpError(413, 'That value is too long.', 'INTEGRATION_VALUE_TOO_LONG');

  const name = `${integration}.${field}`;
  const encrypted = known.secret ? encryptSecretValue(config, text, { scope: SCOPE, scopeId: integration, name }) : null;

  db.prepare(`
    INSERT INTO instance_settings (integration, field, value_plain, value_ciphertext, fingerprint, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(integration, field) DO UPDATE SET
      value_plain = excluded.value_plain,
      value_ciphertext = excluded.value_ciphertext,
      fingerprint = excluded.fingerprint,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(integration, field, known.secret ? null : text, encrypted, fingerprint(text), actorId);

  audit(db, {
    userId: actorId,
    action: 'instance_settings.updated',
    targetType: 'integration',
    targetId: integration,
    // The field and a fingerprint. Never the value, and never a prefix of it —
    // an audit log is read by more people and kept longer than this table.
    metadata: { field, secret: known.secret, fingerprint: fingerprint(text) },
  });
  return { integration, field, secret: known.secret, fingerprint: fingerprint(text) };
}

export function deleteInstanceSetting(db, { integration, field, actorId = null }) {
  definition(integration, field);
  const removed = db.prepare('DELETE FROM instance_settings WHERE integration = ? AND field = ?').run(integration, field);
  if (removed.changes) {
    audit(db, {
      userId: actorId,
      action: 'instance_settings.cleared',
      targetType: 'integration',
      targetId: integration,
      metadata: { field },
    });
  }
  return { removed: removed.changes > 0 };
}

export function setIntegrationEnabled(db, { integration, enabled, actorId = null }) {
  definition(integration);
  db.prepare(`
    INSERT INTO instance_integration_state (integration, enabled, updated_by, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(integration) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
  `).run(integration, enabled ? 1 : 0, actorId);
  audit(db, {
    userId: actorId,
    action: enabled ? 'instance_settings.enabled' : 'instance_settings.disabled',
    targetType: 'integration',
    targetId: integration,
    metadata: {},
  });
  return { integration, enabled: Boolean(enabled) };
}

/**
 * One field's value, for the code that actually uses it.
 *
 * The environment wins where it is set: an operator who already configured
 * `/etc/kukgit.env` gets what they configured, and the console fills the gaps.
 * The alternative is an environment file that looks authoritative and is not.
 */
export function instanceSetting(db, config, integration, field) {
  const { field: known } = definition(integration, field);
  if (known.env && process.env[known.env]) return process.env[known.env];
  // Asked from modules that do not own this table and may run before its
  // migration — email delivery, billing. Not configured is a real answer and a
  // better one than a crash inside somebody else's feature.
  if (!settingsTableExists(db)) return null;

  const row = db.prepare('SELECT value_plain, value_ciphertext FROM instance_settings WHERE integration = ? AND field = ?')
    .get(integration, field);
  if (!row) return null;
  if (!known.secret) return row.value_plain;
  if (!row.value_ciphertext) return null;
  return decryptSecretValue(config, row.value_ciphertext, { scope: SCOPE, scopeId: integration, name: `${integration}.${field}` });
}

/** Every field of one integration, ready to hand to a client library. */
export function integrationCredentials(db, config, integration) {
  const { entry } = definition(integration);
  const values = {};
  for (const field of entry.fields) values[field.key] = instanceSetting(db, config, integration, field.key);
  return values;
}

export function integrationEnabled(db, integration) {
  const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'instance_integration_state'").get();
  if (!table) return false;
  const row = db.prepare('SELECT enabled FROM instance_integration_state WHERE integration = ?').get(integration);
  return Boolean(row?.enabled);
}

/**
 * Everything the console needs to draw the page, and nothing it does not.
 *
 * A secret field reports `set`, a fingerprint and who set it. The value is not
 * here, is not reachable from here, and there is no endpoint that returns it.
 */
export function describeIntegrations(db, config) {
  const rows = db.prepare('SELECT * FROM instance_settings').all();
  const stored = new Map(rows.map((row) => [`${row.integration}.${row.field}`, row]));

  return Object.entries(INTEGRATIONS).map(([id, entry]) => {
    const fields = entry.fields.map((field) => {
      const row = stored.get(`${id}.${field.key}`);
      const fromEnvironment = Boolean(field.env && process.env[field.env]);
      return {
        key: field.key,
        label: field.label,
        secret: field.secret,
        set: fromEnvironment || Boolean(row),
        // Where it came from, because "I set that and nothing changed" is
        // otherwise unanswerable when an environment variable is winning.
        source: fromEnvironment ? 'environment' : row ? 'console' : null,
        environmentVariable: field.env ?? null,
        value: field.secret ? null : (fromEnvironment ? process.env[field.env] : row?.value_plain ?? null),
        fingerprint: fromEnvironment ? null : row?.fingerprint ?? null,
        updatedAt: row?.updated_at ?? null,
        updatedBy: row?.updated_by ?? null,
      };
    });
    return {
      id,
      label: entry.label,
      summary: entry.summary,
      enabled: integrationEnabled(db, id),
      // Enabling something half-configured is how a customer meets a broken
      // sign-in button, so the console can say so before it is switched on.
      complete: fields.every((field) => field.set),
      fields,
    };
  });
}

export function createInstanceSettingsApiHandler({ config, db, isInstanceAdmin }) {
  return async function instanceSettingsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const listRoute = url.pathname === '/api/instance-admin/integrations';
    const fieldRoute = /^\/api\/instance-admin\/integrations\/([a-z.]+)\/fields\/([A-Za-z]+)$/.exec(url.pathname);
    const enableRoute = /^\/api\/instance-admin\/integrations\/([a-z.]+)\/enabled$/.exec(url.pathname);
    if (!listRoute && !fieldRoute && !enableRoute) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    const method = String(req.method || 'GET').toUpperCase();

    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
      return true;
    };

    try {
      const user = requireUser(db, req);
      if (!isInstanceAdmin(config, user)) {
        throw httpError(403, 'KukGit instance administrator access is required.', 'INSTANCE_ADMIN_REQUIRED');
      }

      if (listRoute) {
        if (method !== 'GET') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
        return send(200, { integrations: describeIntegrations(db, config) });
      }

      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');

      if (fieldRoute && method === 'DELETE') {
        return send(200, {
          ...deleteInstanceSetting(db, {
            integration: decodeURIComponent(fieldRoute[1]),
            field: decodeURIComponent(fieldRoute[2]),
            actorId: user.id,
          }),
          requestId,
        });
      }

      if (method !== 'PUT' && method !== 'POST') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');

      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024) throw httpError(413, 'Request body is too large.', 'REQUEST_TOO_LARGE');
        chunks.push(chunk);
      }
      let body = {};
      if (chunks.length) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
      }

      if (enableRoute) {
        return send(200, {
          ...setIntegrationEnabled(db, {
            integration: decodeURIComponent(enableRoute[1]),
            enabled: Boolean(body.enabled),
            actorId: user.id,
          }),
          requestId,
        });
      }

      return send(200, {
        ...putInstanceSetting(db, config, {
          integration: decodeURIComponent(fieldRoute[1]),
          field: decodeURIComponent(fieldRoute[2]),
          value: body.value,
          actorId: user.id,
        }),
        requestId,
      });
    } catch (error) {
      const status = Number(error.status) || 500;
      return send(status, {
        error: {
          code: error.code || 'INTEGRATION_FAILED',
          message: status >= 500 ? 'Integration settings are temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}
