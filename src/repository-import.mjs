import { httpError } from './security.mjs';

/**
 * Credentials for importing a repository somebody else is hosting.
 *
 * Until now KukGit could only import public repositories. `validateRemoteUrl`
 * refuses a URL with credentials in it, which is right — a URL is written to
 * `remote.origin.url` in the clone's config, appears in reflogs, and is echoed
 * back in Git's own error output — but it left no way at all to bring in a
 * private repository, which is most of what anybody actually wants to move.
 *
 * So the token travels separately from the URL, and this module is the whole of
 * how. Three decisions, each of which is the reason the next one is possible:
 *
 *   1. **It is never stored.** The token arrives in the request body, is used
 *      for one clone, and is gone when that clone finishes. There is no table,
 *      no encryption key to rotate, and nothing for a database backup to leak.
 *      Continuous mirroring will need storage; a one-shot import does not, and
 *      the cheapest secret to protect is the one that was never written down.
 *
 *   2. **It is passed in the environment, not on the command line.**
 *      `/proc/<pid>/cmdline` is world-readable on Linux: any user on the box can
 *      read the arguments of a running process. `/proc/<pid>/environ` is readable
 *      only by the process owner. Both are worse than not having the secret at
 *      all, and one of them is much worse than the other.
 *
 *   3. **It is scoped to the URL being cloned.** `http.extraHeader` on its own
 *      attaches the header to every HTTP request Git makes, including one to a
 *      host it was redirected to. `http.<url>.extraHeader` attaches it to that
 *      URL and nothing else, so a redirect somewhere unexpected takes the token
 *      nowhere.
 */

// Basic auth needs a username; every forge that accepts a token in the password
// field ignores what is in the username field. GitHub documents this one.
export const IMPORT_CREDENTIAL_USERNAME = 'x-access-token';

const MAX_TOKEN_LENGTH = 500;

/**
 * A token that is safe to put in a header.
 *
 * The check that matters is the control-character one. `extraHeader` is written
 * into the HTTP request verbatim, so a token containing a carriage return and a
 * newline does not become part of the Authorization header — it ends it, and
 * whatever follows becomes headers of the caller's choosing. That is request
 * splitting, and it is the difference between "the import fails" and "the import
 * server makes a request somebody else wrote".
 */
export function normalizeImportToken(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const token = String(raw);
  if (!token.trim()) return null;
  if (token.length > MAX_TOKEN_LENGTH) {
    throw httpError(400, 'The access token is too long.', 'IMPORT_TOKEN_INVALID');
  }
  // Everything outside printable ASCII, which is exactly what a header may hold.
  if (/[^\x20-\x7e]/.test(token)) {
    throw httpError(400, 'The access token contains characters that are not allowed in a request header.', 'IMPORT_TOKEN_INVALID');
  }
  return token;
}

/**
 * The Git config pairs that authenticate one clone, and nothing else.
 *
 * Returned as pairs rather than a finished environment so a caller can see what
 * is being set, and so the test can read it back without parsing.
 */
export function importCredentialConfig(remoteUrl, token, { username = IMPORT_CREDENTIAL_USERNAME } = {}) {
  const value = normalizeImportToken(token);
  if (!value) return [];
  const url = String(remoteUrl ?? '');
  if (!url.startsWith('https://')) {
    // An SSH remote authenticates with a key at the transport layer; there is no
    // header to put a token in, and silently ignoring the token would produce a
    // clone that fails for a reason the caller cannot see from here.
    throw httpError(400, 'An access token can only be used with an HTTPS repository URL. Use a deploy key for SSH.', 'IMPORT_TOKEN_UNSUPPORTED');
  }
  const authorization = `Basic ${Buffer.from(`${username}:${value}`, 'utf8').toString('base64')}`;
  return [
    // Scoped to this URL. Not `http.extraHeader`, which would attach it to every
    // request Git makes for the lifetime of the process.
    [`http.${url}.extraHeader`, `Authorization: ${authorization}`],
    // An empty helper is not "no configuration", it is "no helper" — it clears
    // any helper the machine has configured globally, so the token cannot be
    // handed to something that writes it to disk.
    ['credential.helper', ''],
  ];
}

/**
 * The environment for a clone: the config above, plus the two variables that
 * decide whether a bad token fails or hangs.
 *
 * Without them Git asks for a password. There is no terminal to ask on, so it
 * blocks until the timeout kills it, and a wrong token costs three minutes and
 * reports a timeout rather than a refusal.
 */
export function importEnvironment(remoteUrl, token, options = {}) {
  const pairs = importCredentialConfig(remoteUrl, token, options);
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1' };
  if (!pairs.length) return env;
  env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/**
 * Takes a secret out of text that is about to be shown to somebody.
 *
 * Git does not echo the header back, but it does echo URLs, and a caller who
 * pasted their token into the URL field by mistake would otherwise see it
 * returned in the error — and so would the audit log, and the server log, and
 * whoever they forwarded the screenshot to.
 */
export function redactToken(text, token) {
  const value = String(text ?? '');
  const secret = token === undefined || token === null ? '' : String(token);
  if (!secret || secret.length < 6) return value;
  return value.split(secret).join('«redacted»');
}

/**
 * What to tell somebody whose import was refused by the far end.
 *
 * Git's own message for a private repository without credentials is
 * "repository not found" — deliberately, so that a wrong guess cannot be used to
 * discover which private repositories exist. That is the right thing for GitHub
 * to say and the wrong thing for KukGit to repeat unchanged, because here it
 * sends people looking for a typo in a URL that is correct.
 */
export function importHint(stderr, { hadToken }) {
  const text = String(stderr ?? '').toLowerCase();
  const denied = text.includes('not found') || text.includes('authentication failed') ||
    text.includes('could not read username') || text.includes('403') || text.includes('permission denied');
  if (!denied) return null;
  return hadToken
    ? 'The token was rejected, or it cannot read this repository. Check that it has not expired and that it grants read access to the repository contents.'
    : 'If this repository is private, supply an access token — a private repository answers the same way as one that does not exist.';
}
