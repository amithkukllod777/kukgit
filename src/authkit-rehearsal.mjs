import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './app.mjs';
import { createAuthKitBootstrapGuard } from './authkit-bootstrap.mjs';
import { createAuthKitApiHandler, createAuthKitIdentityMiddleware, decryptAuthKitSecret } from './authkit-identity.mjs';
import { createSecureAuthKitLoginApiHandler } from './authkit-secure-login.mjs';
import { createAuthKitCentralSessionGuard } from './authkit-session-guard.mjs';
import { createAuthKitSimulator } from './authkit-simulator.mjs';
import { loadConfig } from './config.mjs';
import { openDatabase } from './db.mjs';
import { applySchema } from './schema.mjs';

/**
 * The AuthKit rollout drill.
 *
 * [ONE_KUKLABS_ACCOUNT.md](../docs/ONE_KUKLABS_ACCOUNT.md) has always ended
 * with "verify OTP, password, Google, refresh, session and product-access flows
 * in staging", and three of the recovery rehearsal's manual sign-offs say the
 * same thing in different words. Neither could be done, because there was
 * nothing to verify against and no script to do the verifying. This is both.
 *
 * Every check below drives a real KukGit instance over real HTTP with a real
 * cookie jar, against an AuthKit that is either the simulator or — with
 * `--url` — the actual service. What it proves is not that the handlers work;
 * the unit tests do that by calling them directly. It proves the **round trip**:
 * that a browser talking to KukGit talking to AuthKit ends up with the right
 * cookie, the right refusal, and no token it should never have seen.
 *
 * Two things it refuses to pretend.
 *
 * **A run against the simulator does not sign off a production check.** The
 * record says which AuthKit it ran against, and only a run against a real one
 * is `verified`; the simulator produces `rehearsed`. A drill that let a
 * stand-in close a production gate would be worse than no drill.
 *
 * **A check that could not run is not a check that passed.** Anything skipped
 * is named in the record and makes the run incomplete.
 */

export const DRILL_CHECKS = Object.freeze([
  { id: 'authkit.contract', description: 'AuthKit answers /v1/auth/status with the expected contract.' },
  { id: 'authkit.login', description: 'Password sign-in returns a KukGit cookie and links one local user row.' },
  { id: 'authkit.no_token_to_browser', description: 'The browser never receives an access or refresh token.' },
  { id: 'authkit.tokens_encrypted_at_rest', description: 'Stored AuthKit secrets are ciphertext, not the tokens themselves.' },
  { id: 'authkit.product_header', description: 'Every upstream request carries X-Kuklabs-Product.' },
  { id: 'authkit.otp_signup', description: 'Signup requires an OTP, and verifying it opens a session.' },
  { id: 'authkit.google', description: 'Google sign-in links through AuthKit rather than a separate OAuth project.' },
  { id: 'authkit.refresh_rotation', description: 'An expired access token triggers one refresh, and both stored secrets change.' },
  { id: 'authkit.refresh_replay', description: 'A spent refresh token is never replayed by KukGit.' },
  { id: 'authkit.device_revocation', description: 'Revoking the central device session refuses the bridge and clears the cookie.' },
  { id: 'authkit.product_denied', description: 'Blocked product membership denies access.' },
  { id: 'authkit.fails_closed', description: 'Protected APIs fail closed when AuthKit is unreachable; health stays up.' },
  { id: 'authkit.outage_keeps_cookie', description: 'An outage refuses requests without signing everybody out.' },
  { id: 'authkit.logout', description: 'Logout removes the local bridge even when central logout is unavailable.' },
  { id: 'authkit.bad_password', description: 'A wrong password is refused and creates no session.' },
]);

const FOUNDER_EMAIL = 'founder@kuklabs.com';
const FOUNDER_PASSWORD = 'rehearsal-password-not-a-secret';

/* ------------------------------------------------------------- the client */

/**
 * One browser. It keeps cookies the way a browser does and, deliberately,
 * records every `Set-Cookie` it is given — the drill needs to see the cookie
 * being cleared, not merely stop working.
 */
function browser(origin) {
  const jar = new Map();
  const setCookies = [];

  return {
    jar,
    setCookies,
    cookieHeader() {
      return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    async request(pathname, { method = 'GET', body = null, headers = {} } = {}) {
      const cookie = this.cookieHeader();
      const response = await fetch(`${origin}${pathname}`, {
        method,
        redirect: 'manual',
        headers: {
          // Same-origin, because every one of these routes checks it.
          Origin: origin,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        setCookies.push(raw);
        const [pair] = raw.split(';');
        const index = pair.indexOf('=');
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (!value || /(^|;)\s*Max-Age=0/i.test(raw) || /Expires=Thu, 01 Jan 1970/i.test(raw)) jar.delete(name);
        else jar.set(name, value);
      }
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      return { status: response.status, payload, text };
    },
  };
}

/* --------------------------------------------------------- the instance */

/**
 * A port to bind to, chosen before the config is built.
 *
 * `baseUrl` has to be right *before* the server exists, because every one of
 * these routes compares the request's `Origin` against it — a drill that let
 * KukGit guess its own address would spend its first run being refused for
 * cross-origin, which is exactly what happened.
 */
async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function buildInstance({ dataDir, authkitBaseUrl, port }) {
  const config = loadConfig({
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    authMode: 'authkit',
    authkitBaseUrl,
    authkitProductId: 'kukgit',
    authkitEncryptionKey: 'rehearsal-authkit-encryption-key-at-least-32-chars',
    adminEmail: FOUNDER_EMAIL,
    adminPassword: 'unused-in-authkit-mode',
    adminName: 'Founder',
  });
  const db = openDatabase(config);
  // The production schema, not a subset of it. Copying the migration list here
  // is how a drill ends up passing against tables the real instance does not
  // have — so both call the same function.
  applySchema(db, config);

  // The same order as server.mjs. A drill that assembled the stack differently
  // would be rehearsing a program nobody runs.
  const app = createApp({ config, db });
  const secureLoginApi = createSecureAuthKitLoginApiHandler({ config, db });
  const authApi = createAuthKitApiHandler({ config, db });
  const dispatch = async (req, res) => {
    if (await secureLoginApi(req, res)) return;
    if (await authApi(req, res)) return;
    return app(req, res);
  };
  const bootstrap = createAuthKitBootstrapGuard({ config, db, next: dispatch });
  const central = createAuthKitCentralSessionGuard({ config, db, next: bootstrap });
  const identity = createAuthKitIdentityMiddleware({ config, db, next: central });
  const server = http.createServer(identity);
  return { config, db, server };
}

/* ------------------------------------------------------------ the checks */

function sessionRow(db) {
  return db.prepare(`
    SELECT token_hash AS tokenHash, auth_mode AS authMode, authkit_sid AS authkitSid,
           authkit_access_ciphertext AS accessCiphertext, authkit_refresh_ciphertext AS refreshCiphertext,
           authkit_access_expires_at AS accessExpiresAt
    FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get();
}

async function signIn(page) {
  return page.request('/api/auth/login', {
    method: 'POST',
    body: { identifier: FOUNDER_EMAIL, password: FOUNDER_PASSWORD },
  });
}

/**
 * Runs the drill.
 *
 * @param {object} [options]
 * @param {string} [options.authkitBaseUrl] an AuthKit to point at; the
 *   simulator is started when this is absent
 * @param {string} [options.operator] who ran it, recorded in the evidence
 */
export async function runAuthKitRehearsal(options = {}) {
  const results = [];
  const record = (id, ok, detail = '') => results.push({ id, ok: Boolean(ok), detail: String(detail) });

  const external = Boolean(options.authkitBaseUrl);
  if (external) {
    // Against the real service every one of these calls creates or destroys
    // something in somebody's account.
    throw new Error(
      'Running the drill against a live AuthKit is not implemented yet: it would create accounts and revoke '
      + 'real device sessions. Run it against the simulator, and see docs/AUTHKIT_REHEARSAL.md for what a '
      + 'staging run still has to prove by hand.',
    );
  }

  const simulator = createAuthKitSimulator({
    accounts: [{ email: FOUNDER_EMAIL, password: FOUNDER_PASSWORD, name: 'Founder' }],
    // Short enough that the drill can watch one expire without waiting.
    accessTtlSeconds: 900,
  });
  const authkitOrigin = await simulator.listen();

  const dataDir = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), 'kukgit-authkit-drill-'));
  const port = await freePort();
  const instance = buildInstance({ dataDir, authkitBaseUrl: authkitOrigin, port });
  await new Promise((resolve) => instance.server.listen(port, '127.0.0.1', resolve));
  const origin = instance.config.baseUrl;

  const startedAt = new Date();
  try {
    const { db } = instance;
    let contract = null;
    try {

    /* 1 — the contract the rollout checklist names */
    const status = await fetch(`${authkitOrigin}/v1/auth/status`, { headers: { 'X-Kuklabs-Product': 'kukgit' } })
      .then((response) => response.json());
    contract = status?.contract ?? null;
    record('authkit.contract', contract === 'kuklabs-authkit-rest/1', `contract ${contract ?? 'missing'}`);

    /* 2 — a wrong password, first, so a later pass cannot be a leftover session */
    const wrong = browser(origin);
    const refused = await wrong.request('/api/auth/login', { method: 'POST', body: { identifier: FOUNDER_EMAIL, password: 'not-the-password' } });
    record('authkit.bad_password',
      refused.status === 401 && db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n === 0,
      `status ${refused.status}, sessions ${db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n}`);

    /* 3 — sign in */
    const page = browser(origin);
    const login = await signIn(page);
    // Captured now, while it is the newest row. Reading "the latest session"
    // later would read whichever browser signed in most recently — which is how
    // the refresh and revocation checks first came to inspect a session that
    // was never refreshed.
    const founderSession = sessionRow(db);
    const linked = db.prepare('SELECT id, kuklabs_user_id AS kuklabsUserId, password_hash AS passwordHash FROM users WHERE email = ?').get(FOUNDER_EMAIL);
    record('authkit.login',
      login.status === 200 && page.jar.has('kukgit_session') && Boolean(linked?.kuklabsUserId),
      `status ${login.status}, cookie ${page.jar.has('kukgit_session')}, kuklabs id ${linked?.kuklabsUserId ?? 'none'}`);

    /* 4 — what the browser was handed */
    const serialized = JSON.stringify(login.payload ?? {}) + page.setCookies.join(' ');
    const leaked = /access_token|refresh_token|"rt_|eyJhbGciOi|\.unsigned-simulator/.test(serialized);
    record('authkit.no_token_to_browser', !leaked, leaked ? 'a token reached the browser' : 'cookie only');

    /* 5 — what the database holds */
    const stored = sessionRow(db);
    const ciphertextIsNotTheToken = Boolean(stored?.accessCiphertext)
      && Boolean(stored?.refreshCiphertext)
      && !stored.accessCiphertext.includes('unsigned-simulator')
      && !stored.refreshCiphertext.startsWith('rt_');
    record('authkit.tokens_encrypted_at_rest', ciphertextIsNotTheToken,
      ciphertextIsNotTheToken ? 'both secrets are ciphertext' : 'a token is stored in the clear');

    /* 6 — the product header, on every call so far */
    const withoutHeader = simulator.state.missingProductHeader;
    record('authkit.product_header', withoutHeader.length === 0,
      withoutHeader.length ? `missing on ${withoutHeader.join(', ')}` : `present on ${simulator.calls.length} requests`);

    /* 7 — signup needs an OTP, and the OTP opens a session */
    const joiner = browser(origin);
    const signup = await joiner.request('/api/auth/signup', {
      method: 'POST',
      body: { identifier: 'newcomer@kuklabs.com', password: 'newcomer-password', full_name: 'Newcomer' },
    });
    const verified = await joiner.request('/api/auth/otp/verify', {
      method: 'POST',
      body: { identifier: 'newcomer@kuklabs.com', code: simulator.settings.otpCode },
    });
    const joinerSession = db.prepare('SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?').get('newcomer@kuklabs.com').n;
    record('authkit.otp_signup',
      signup.status !== 200 && verified.status === 200 && joinerSession === 1,
      `signup ${signup.status}, verify ${verified.status}, sessions ${joinerSession}`);

    /* 8 — Google, through AuthKit and not around it */
    const googlePage = browser(origin);
    const google = await googlePage.request('/api/auth/google', {
      method: 'POST',
      body: { id_token: simulator.settings.googleIdToken, email: FOUNDER_EMAIL },
    });
    record('authkit.google', google.status === 200 && googlePage.jar.has('kukgit_session'), `status ${google.status}`);

    /* 9 — refresh rotation */
    const before = founderSession;
    simulator.expireAccessTokens();
    const afterExpiry = await page.request('/api/auth/me');
    const after = db.prepare('SELECT authkit_access_ciphertext AS accessCiphertext, authkit_refresh_ciphertext AS refreshCiphertext FROM sessions WHERE token_hash = ?').get(before.tokenHash);
    // Compared after decryption, not as ciphertext. AES-GCM uses a fresh IV
    // every time, so re-encrypting the *same* token produces different bytes —
    // a check on the stored strings would report a rotation that never
    // happened.
    const plain = (row, column) => (row?.[column] ? decryptAuthKitSecret(instance.config, row[column], before.tokenHash) : null);
    const rotated = Boolean(after)
      && plain(after, 'accessCiphertext') !== plain(before, 'accessCiphertext')
      && plain(after, 'refreshCiphertext') !== plain(before, 'refreshCiphertext');
    record('authkit.refresh_rotation', afterExpiry.status === 200 && rotated,
      `me ${afterExpiry.status}, access rotated ${plain(after, 'accessCiphertext') !== plain(before, 'accessCiphertext')}, refresh rotated ${plain(after, 'refreshCiphertext') !== plain(before, 'refreshCiphertext')}`);

    /* 10 — and the spent one is never presented again */
    const sessionsBefore = simulator.liveSessions().length;
    simulator.expireAccessTokens();
    await page.request('/api/auth/me');
    const survived = simulator.liveSessions().length === sessionsBefore;
    record('authkit.refresh_replay', survived,
      survived ? 'no spent refresh token was replayed' : 'AuthKit killed the session for refresh reuse');

    /* 11 — central device revocation */
    const bridge = db.prepare('SELECT authkit_sid AS sid, token_hash AS tokenHash FROM sessions WHERE token_hash = ?').get(before.tokenHash);
    let revocationDetail = 'no device-session id was bound to the bridge';
    let revocationOk = false;
    if (bridge?.sid) {
      simulator.revokeSession(bridge.sid);
      const afterRevoke = await page.request('/api/repos');
      const bridgeGone = !db.prepare('SELECT 1 AS found FROM sessions WHERE token_hash = ?').get(bridge.tokenHash);
      const cookieCleared = !page.jar.has('kukgit_session');
      revocationOk = afterRevoke.status === 401 && bridgeGone && cookieCleared;
      revocationDetail = `status ${afterRevoke.status}, bridge removed ${bridgeGone}, cookie cleared ${cookieCleared}`;
    }
    record('authkit.device_revocation', revocationOk, revocationDetail);

    /* 12 — blocked product membership */
    const blockedPage = browser(origin);
    await signIn(blockedPage);
    simulator.setProductAccess('blocked');
    const blocked = await blockedPage.request('/api/repos');
    simulator.setProductAccess('active');
    record('authkit.product_denied', blocked.status === 401 || blocked.status === 403, `status ${blocked.status}`);

    /* 13 — AuthKit unreachable */
    const outagePage = browser(origin);
    await signIn(outagePage);
    simulator.setOffline(true);
    const protectedDuringOutage = await outagePage.request('/api/repos');
    const healthDuringOutage = await outagePage.request('/api/health');
    simulator.setOffline(false);
    record('authkit.fails_closed',
      protectedDuringOutage.status >= 400 && healthDuringOutage.status === 200,
      `protected ${protectedDuringOutage.status}, health ${healthDuringOutage.status}`);

    // The other half of failing closed, and the half that is easy to get wrong
    // while fixing the first: refusing during an outage must not clear the
    // cookie. Clearing it signs out every user of a healthy instance because
    // one dependency was briefly unreachable, and they cannot sign back in
    // until it returns.
    const stillSignedIn = outagePage.jar.has('kukgit_session')
      && (await outagePage.request('/api/repos')).status === 200;
    record('authkit.outage_keeps_cookie', stillSignedIn,
      stillSignedIn ? 'the session survived the outage' : 'the outage signed the user out');

    /* 14 — logout, with the central service still down */
    const logoutPage = browser(origin);
    await signIn(logoutPage);
    const bridgesBefore = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    simulator.setOffline(true);
    const logout = await logoutPage.request('/api/auth/logout', { method: 'POST' });
    simulator.setOffline(false);
    const bridgesAfter = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    record('authkit.logout',
      bridgesAfter < bridgesBefore && !logoutPage.jar.has('kukgit_session'),
      `status ${logout.status}, bridges ${bridgesBefore} → ${bridgesAfter}, cookie cleared ${!logoutPage.jar.has('kukgit_session')}`);

    } catch (error) {
      // A drill that stops at the first surprise reports one problem and hides
      // the rest, and the surprise is usually a check failing in a way the
      // check did not anticipate. Everything still unrecorded is a failure with
      // the reason attached — never a silence.
      for (const check of DRILL_CHECKS) {
        if (!results.some((result) => result.id === check.id)) record(check.id, false, `did not run: ${error.message}`);
      }
    }

    const failures = results.filter((result) => !result.ok);
    const missing = DRILL_CHECKS.filter((check) => !results.some((result) => result.id === check.id));

    return {
      record: {
        format: 'kukgit-authkit-rehearsal/1',
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        operator: options.operator ?? null,
        authkit: { kind: 'simulator', baseUrl: authkitOrigin, contract },
        // The simulator can rehearse a check; it cannot certify one. Only a run
        // against the real service does that, and this field is how a reader
        // tells the two apart six months later.
        confidence: 'rehearsed',
        upstreamCalls: simulator.calls.length,
        checks: results.map((result) => ({
          ...result,
          description: DRILL_CHECKS.find((check) => check.id === result.id)?.description ?? '',
        })),
        skipped: missing.map((check) => check.id),
        failures: failures.map((result) => `${result.id}: ${result.detail}`),
        result: failures.length ? 'failed' : 'passed',
        // A drill that could not run every check did not pass; it ran less.
        complete: failures.length === 0 && missing.length === 0,
      },
    };
  } finally {
    await new Promise((resolve) => instance.server.close(resolve));
    instance.db.close();
    await simulator.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
