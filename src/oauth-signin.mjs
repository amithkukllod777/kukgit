import { uid } from './db.mjs';
import { instanceSetting } from './instance-settings.mjs';
import { hashToken, httpError, normalizeEmail, randomToken } from './security.mjs';

/**
 * Sign in with GitHub, and sign in with Google.
 *
 * Both are ordinary OAuth 2.0 authorization-code flows with a confidential
 * client: the browser is sent to the provider, comes back with a `code`, and
 * KukGit exchanges that for a token **server-side** using a secret the browser
 * never sees. What the provider then tells us about the person is handed to
 * `user-identities.mjs`, which decides whose account it is.
 *
 * Three things carry the weight.
 *
 * **`state`, stored server-side and spent once.** Without it, somebody can
 * hand you a link that finishes *their* half-completed flow in *your* browser —
 * which links their GitHub account to your KukGit session, and from then on
 * they can sign in as you. It is a login CSRF and it is the reason this module
 * has a table. The value is stored hashed, like every other credential here,
 * because a `state` sitting in a database is a `state` somebody can replay.
 *
 * **Where the person is sent afterwards is checked.** A `redirect_to` taken
 * from the request and used unchecked is an open redirect, and an open redirect
 * on a login route is a phishing page hosted on your own domain.
 *
 * **The access token is used and thrown away.** Signing somebody in needs their
 * identity, not ongoing access to their repositories, so the scopes are the
 * smallest that answer "who is this" and nothing is stored afterwards. Importing
 * from GitHub asks separately, with its own consent — that is a different
 * question and the person should be asked it separately.
 */

const STATE_LIFETIME_SECONDS = 10 * 60;

/**
 * What each provider is, in one place.
 *
 * The URLs are constants and never come from configuration. A base URL that
 * could be set per instance is a base URL somebody can point at a server that
 * will say yes to anything.
 */
export const OAUTH_PROVIDERS = Object.freeze({
  github: {
    id: 'github',
    label: 'GitHub',
    integration: 'auth.github',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    // `read:user` for the profile, `user:email` because the address — and
    // whether GitHub considers it verified — is only on a separate endpoint.
    // Deliberately not `repo`: this is sign-in.
    scope: 'read:user user:email',
  },
  google: {
    id: 'google',
    label: 'Google',
    integration: 'auth.google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
  },
});

export function migrateOAuthSignIn(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      -- sha256 of the value in the URL. A state somebody can read out of this
      -- table is a state they can replay.
      state_hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      -- Set when somebody already signed in is adding a second way to sign in,
      -- null when they are arriving cold. The two are different operations and
      -- which one this is must be decided when the flow starts, not when it
      -- comes back.
      link_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      redirect_to TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states(expires_at);
  `);
}

export function oauthProvider(name) {
  const provider = OAUTH_PROVIDERS[String(name ?? '').trim().toLowerCase()];
  if (!provider) throw httpError(404, 'Unknown sign-in provider.', 'OAUTH_PROVIDER_UNKNOWN');
  return provider;
}

export function oauthCredentials(db, config, name) {
  const provider = oauthProvider(name);
  return {
    provider,
    clientId: instanceSetting(db, config, provider.integration, 'clientId') || '',
    clientSecret: instanceSetting(db, config, provider.integration, 'clientSecret') || '',
  };
}

export function oauthConfigured(db, config, name) {
  const { clientId, clientSecret } = oauthCredentials(db, config, name);
  return Boolean(clientId && clientSecret);
}

/** Which providers this instance can actually offer, for the sign-in screen. */
export function availableOAuthProviders(db, config) {
  return Object.values(OAUTH_PROVIDERS)
    .filter((provider) => oauthConfigured(db, config, provider.id))
    .map((provider) => ({ id: provider.id, label: provider.label }));
}

export function oauthCallbackUrl(config, name) {
  const provider = oauthProvider(name);
  return `${String(config.baseUrl).replace(/\/$/, '')}/api/auth/${provider.id}/callback`;
}

/**
 * Where somebody may be sent after signing in.
 *
 * Only a route inside this application. A `redirect_to` used unchecked is an
 * open redirect, and an open redirect on a login route is a phishing page on
 * your own domain: the URL really is `git.kuklabs.com`, the person really did
 * sign in, and then they land somewhere else entirely.
 */
export function safeRedirect(value) {
  const target = String(value ?? '').trim();
  if (!target) return '#/';
  // `#/…` only. Not `/…`, because `//evil.example` is a path that leaves.
  if (!/^#\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/.test(target)) return '#/';
  return target.slice(0, 512);
}

/**
 * Starts a flow and returns where to send the browser.
 *
 * @param {string|null} linkUserId set when somebody signed in is adding a
 *   provider, so the callback links rather than signs in
 */
export function beginOAuthSignIn(db, config, { provider, linkUserId = null, redirectTo = null, now = new Date() }) {
  const { provider: known, clientId } = oauthCredentials(db, config, provider);
  if (!oauthConfigured(db, config, known.id)) {
    throw httpError(404, 'That sign-in provider is not available.', 'OAUTH_PROVIDER_UNAVAILABLE');
  }

  const state = randomToken(32);
  db.prepare(`
    INSERT INTO oauth_states (state_hash, provider, link_user_id, redirect_to, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    hashToken(state),
    known.id,
    linkUserId,
    safeRedirect(redirectTo),
    new Date(now.getTime() + STATE_LIFETIME_SECONDS * 1000).toISOString(),
  );

  const url = new URL(known.authorizeUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', oauthCallbackUrl(config, known.id));
  url.searchParams.set('scope', known.scope);
  url.searchParams.set('state', state);
  if (known.id === 'google') {
    url.searchParams.set('response_type', 'code');
    // So the address is on the token response rather than needing another call.
    url.searchParams.set('access_type', 'online');
  }
  return { url: url.toString(), state };
}

/**
 * Claims a `state` exactly once.
 *
 * Deleting is the check. A read followed by a delete leaves a window in which
 * the same callback URL, replayed twice, passes twice.
 */
export function claimOAuthState(db, { provider, state, now = new Date() }) {
  const known = oauthProvider(provider);
  const presented = String(state ?? '');
  const invalid = () => httpError(400, 'This sign-in attempt has expired. Start again.', 'OAUTH_STATE_INVALID');
  if (!presented) throw invalid();

  const hash = hashToken(presented);
  const row = db.prepare('SELECT provider, link_user_id AS linkUserId, redirect_to AS redirectTo, expires_at AS expiresAt FROM oauth_states WHERE state_hash = ?').get(hash);
  const removed = db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(hash);
  if (!row || !removed.changes) throw invalid();
  // A state issued for GitHub must not finish a Google callback.
  if (row.provider !== known.id) throw invalid();
  if (Date.parse(row.expiresAt) <= now.getTime()) throw invalid();

  return { linkUserId: row.linkUserId, redirectTo: safeRedirect(row.redirectTo) };
}

async function providerJson(fetchImpl, url, options, { provider, what }) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch {
    throw httpError(502, `${provider.label} could not be reached. Try again.`, 'OAUTH_PROVIDER_UNREACHABLE');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    throw httpError(502, `${provider.label} refused to complete the sign-in.`, 'OAUTH_PROVIDER_REFUSED');
  }
  // GitHub answers 200 with `{error: …}` when the code is wrong, so the status
  // alone is not the answer.
  if (payload.error) throw httpError(400, `${provider.label} refused to complete the sign-in.`, 'OAUTH_PROVIDER_REFUSED');
  if (!payload && what) throw httpError(502, `${provider.label} returned nothing.`, 'OAUTH_PROVIDER_REFUSED');
  return payload;
}

async function exchangeCode(db, config, { provider, code, fetchImpl }) {
  const { clientId, clientSecret } = oauthCredentials(db, config, provider.id);
  const payload = await providerJson(fetchImpl, provider.tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: String(code ?? ''),
      redirect_uri: oauthCallbackUrl(config, provider.id),
      grant_type: 'authorization_code',
    }).toString(),
  }, { provider, what: 'a token' });

  const token = String(payload.access_token ?? '');
  if (!token) throw httpError(502, `${provider.label} did not return a token.`, 'OAUTH_TOKEN_MISSING');
  return token;
}

/**
 * Who GitHub says this is.
 *
 * The address needs a second call. `/user` reports `email: null` for anybody
 * who has kept theirs private, and — more importantly — it never says whether
 * GitHub has *verified* it. `/user/emails` does, and that flag is what decides
 * whether this identity may join an existing KukGit account.
 */
async function githubProfile(fetchImpl, token) {
  const provider = OAUTH_PROVIDERS.github;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'KukGit',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const user = await providerJson(fetchImpl, 'https://api.github.com/user', { headers }, { provider, what: 'a profile' });
  if (!user.id) throw httpError(502, 'GitHub did not identify the account.', 'OAUTH_PROFILE_INVALID');

  let email = null;
  let emailVerified = false;
  const addresses = await providerJson(fetchImpl, 'https://api.github.com/user/emails', { headers }, { provider, what: 'addresses' })
    .catch(() => []);
  if (Array.isArray(addresses)) {
    const primary = addresses.find((entry) => entry?.primary) ?? addresses[0] ?? null;
    if (primary?.email) {
      email = normalizeEmail(primary.email);
      // Read, never assumed. This one boolean is what stands between "link to
      // the existing account" and "hand somebody else's account away".
      emailVerified = primary.verified === true;
    }
  }

  return {
    provider: 'github',
    providerUserId: String(user.id),
    providerLogin: user.login ? String(user.login) : null,
    displayName: user.name ? String(user.name) : (user.login ? String(user.login) : null),
    email,
    emailVerified,
  };
}

async function googleProfile(fetchImpl, token) {
  const provider = OAUTH_PROVIDERS.google;
  const user = await providerJson(fetchImpl, 'https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  }, { provider, what: 'a profile' });
  if (!user.sub) throw httpError(502, 'Google did not identify the account.', 'OAUTH_PROFILE_INVALID');

  return {
    provider: 'google',
    providerUserId: String(user.sub),
    providerLogin: user.email ? String(user.email) : null,
    displayName: user.name ? String(user.name) : null,
    email: user.email ? normalizeEmail(user.email) : null,
    emailVerified: user.email_verified === true,
  };
}

/**
 * Exchanges the code and returns a profile the caller can trust.
 *
 * "Trust" here means: this came from the provider over a server-to-server call
 * authenticated with our secret, not from the browser. Nothing in the redirect
 * except the `code` and the `state` is used for anything.
 */
export async function fetchOAuthProfile(db, config, { provider, code, fetchImpl = globalThis.fetch }) {
  const known = oauthProvider(provider);
  const token = await exchangeCode(db, config, { provider: known, code, fetchImpl });
  const profile = known.id === 'github'
    ? await githubProfile(fetchImpl, token)
    : await googleProfile(fetchImpl, token);
  // The token is not returned and not stored. Signing somebody in needs their
  // identity, not continuing access to their repositories — importing asks for
  // that separately, with its own consent.
  return profile;
}

/** Housekeeping for states nobody came back for. */
export function pruneOAuthStates(db, { now = new Date() } = {}) {
  return db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now.toISOString()).changes;
}

export function newOAuthRequestId() {
  return uid('req');
}
