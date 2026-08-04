import { normalizeEmail, httpError } from './security.mjs';
import { instanceSetting } from './instance-settings.mjs';
import { sendSmtpMessage, smtpConfigured } from './email-transport.mjs';

/**
 * Resend, as an email transport.
 *
 * SMTP is a protocol and Resend is an HTTP API, so this is a different
 * transport rather than a different configuration. Both end at the same
 * contract — `send(config, message)` returning `{ accepted, response }` or
 * throwing — because the outbox, the retry history and the bounce classifier
 * are all written against that and none of them should care which one ran.
 *
 * The API key is read from the integration settings at the moment it is used,
 * so rotating it in the console takes effect on the next message rather than on
 * the next restart.
 */

const ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 15_000;

export function resendCredentials(db, config) {
  return {
    apiKey: instanceSetting(db, config, 'email.resend', 'apiKey'),
    fromAddress: instanceSetting(db, config, 'email.resend', 'fromAddress') || config.emailFrom,
    fromName: instanceSetting(db, config, 'email.resend', 'fromName') || config.emailFromName,
  };
}

export function resendConfigured(db, config) {
  const { apiKey, fromAddress } = resendCredentials(db, config);
  // Both, because a key with nothing to send from fails on the first message
  // and looks like an outage rather than a missing setting.
  return Boolean(apiKey && fromAddress);
}

function fromHeader({ fromAddress, fromName }) {
  const address = normalizeEmail(fromAddress);
  return fromName ? `${String(fromName).replace(/["\\\r\n]/g, '')} <${address}>` : address;
}

/** Removes the key from anything the provider said back to us. */
function redactKey(text, apiKey) {
  const value = String(text ?? '');
  if (!apiKey) return value;
  return value.split(apiKey).join('[redacted]');
}

/**
 * Which protocol stage a failure belongs to.
 *
 * The bounce classifier suppresses a recipient on a recipient-side failure and
 * must not on ours. Resend answers with one status code for both, so the
 * mapping is by what the code means: `401`/`403` is our key, `422` is the
 * message or the address we supplied, and `429`/`5xx` is theirs and worth
 * retrying.
 */
function stageFor(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 422 || status === 400) return 'data';
  if (status === 404) return 'sender';
  return 'transport';
}

export async function sendResendMessage(db, config, message) {
  const credentials = resendCredentials(db, config);
  if (!credentials.apiKey) throw httpError(503, 'Resend delivery is not configured.', 'RESEND_NOT_CONFIGURED');
  if (!credentials.fromAddress) throw httpError(503, 'Resend has no from address configured.', 'RESEND_NOT_CONFIGURED');

  const body = {
    from: fromHeader(credentials),
    to: [normalizeEmail(message.to)],
    subject: String(message.subject ?? ''),
    text: String(message.text ?? ''),
    headers: {
      // The same headers the SMTP path sets, for the same reason: a
      // transactional message that provokes an out-of-office reply generates a
      // loop nobody is watching.
      'Auto-Submitted': 'auto-generated',
      'X-Auto-Response-Suppress': 'All',
      'X-KukGit-Notification': 'transactional',
    },
  };
  if (message.html) body.html = String(message.html);
  if (config.emailReplyTo) body.reply_to = normalizeEmail(config.emailReplyTo);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    // A network failure is theirs and retryable. It must not read as a bad
    // recipient, or the address gets suppressed for an outage.
    const error = httpError(502, 'Resend could not be reached.', 'RESEND_UNREACHABLE');
    error.smtpStage = 'transport';
    error.cause = cause;
    throw error;
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    let detail = text.slice(0, 500);
    try { detail = JSON.parse(text)?.message ?? detail; } catch { /* not JSON */ }
    // Resend echoing the key back does not make it ours to keep. This message
    // is stored on the outbox row and read later by whoever is debugging the
    // failure, which is exactly how an API key ends up somewhere it should not
    // be.
    const error = httpError(
      response.status >= 500 ? 502 : 400,
      `Resend refused the message: ${redactKey(detail, credentials.apiKey)}`,
      'RESEND_REJECTED',
    );
    error.smtpStage = stageFor(response.status);
    error.responseCode = response.status;
    throw error;
  }

  let id = '';
  try { id = JSON.parse(text)?.id ?? ''; } catch { /* an id we cannot read is not a failure */ }
  return { accepted: true, responseCode: response.status, response: id ? `resend id ${id}` : 'accepted' };
}

/**
 * The transport this instance should use.
 *
 * Resend wins when it is configured, because configuring it is a deliberate
 * act and an SMTP host left in an environment file is often just history. The
 * name is reported so the console and `npm run doctor` can say which one is
 * actually going to run — "email is configured" without saying by what is how
 * somebody debugs the wrong transport for an hour.
 */
export function emailTransport(db, config) {
  if (resendConfigured(db, config)) {
    return {
      name: 'resend',
      configured: true,
      send: (settings, message) => sendResendMessage(db, settings, message),
    };
  }
  if (smtpConfigured(config)) {
    return { name: 'smtp', configured: true, send: sendSmtpMessage };
  }
  return {
    name: 'none',
    configured: false,
    send: () => { throw httpError(503, 'No email transport is configured.', 'EMAIL_NOT_CONFIGURED'); },
  };
}
