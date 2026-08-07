import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { migrateInstanceSettings, putInstanceSetting } from '../src/instance-settings.mjs';
import {
  OAUTH_PROVIDERS,
  availableOAuthProviders,
  beginOAuthSignIn,
  claimOAuthState,
  fetchOAuthProfile,
  migrateOAuthSignIn,
  oauthCallbackUrl,
  oauthConfigured,
  pruneOAuthStates,
  safeRedirect,
} from '../src/oauth-signin.mjs';

/**
 * Signing in with GitHub and with Google.
 *
 * The flow itself is ordinary OAuth. What these tests are about is the three
 * places it goes wrong when written quickly: a `state` that is not really
 * single-use, a `redirect_to` nobody checked, and an email address taken as
 * proved because the provider mentioned it.
 */

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-oauth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'test.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    baseUrl: 'https://git.kuklabs.com',
    nodeEnv: 'test',
    adminEmail: 'founder@kuklabs.com',
    adminPassword: 'secure-test-password',
    adminName: 'Founder',
    secretsEncryptionKey: 'k'.repeat(48),
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  migrateInstanceSettings(db);
  migrateOAuthSignIn(db);

  const configure = (provider = 'github') => {
    putInstanceSetting(db, config, { integration: `auth.${provider}`, field: 'clientId', value: `${provider}-client-id` });
    putInstanceSetting(db, config, { integration: `auth.${provider}`, field: 'clientSecret', value: `${provider}-client-secret-nobody-reads` });
  };
  return { config, db, configure };
}

/**
 * A GitHub that behaves like GitHub, including the parts that catch people out:
 * `/user` never says whether an address is verified, and a bad code comes back
 * as 200 with an `error` field rather than a 4xx.
 */
function githubSimulator({ verified = true, email = 'octocat@example.com', code = 'good-code', privateEmail = false } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET', body: options.body ?? null, headers: options.headers ?? {} });
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (String(url) === OAUTH_PROVIDERS.github.tokenUrl) {
      const sent = new URLSearchParams(String(options.body ?? ''));
      // GitHub answers 200 with an error body for a bad code. Anything checking
      // only the status would treat that as a successful sign-in.
      if (sent.get('code') !== code) return reply(200, { error: 'bad_verification_code' });
      if (!sent.get('client_secret')) return reply(200, { error: 'incorrect_client_credentials' });
      return reply(200, { access_token: 'gho_simulated', token_type: 'bearer', scope: 'read:user,user:email' });
    }
    if (String(url) === 'https://api.github.com/user') {
      return reply(200, { id: 4242, login: 'octocat', name: 'Octo Cat', email: privateEmail ? null : email });
    }
    if (String(url) === 'https://api.github.com/user/emails') {
      return reply(200, [
        { email: 'secondary@example.com', primary: false, verified: true },
        { email, primary: true, verified },
      ]);
    }
    return reply(404, { message: 'Not Found' });
  };
  impl.calls = calls;
  return impl;
}

/* -------------------------------------------------------- configuration */

test('a provider nobody has configured is not offered', async (t) => {
  const space = workspace(t);
  assert.deepEqual(availableOAuthProviders(space.db, space.config), []);
  assert.equal(oauthConfigured(space.db, space.config, 'github'), false);

  space.configure('github');
  assert.deepEqual(availableOAuthProviders(space.db, space.config), [{ id: 'github', label: 'GitHub' }]);
});

test('starting a flow for an unconfigured provider is a 404, not a broken redirect', async (t) => {
  const space = workspace(t);
  // A self-hosted instance has none of these. Sending somebody to GitHub with
  // an empty `client_id` produces an error page on GitHub's domain, which looks
  // like KukGit is broken.
  assert.throws(() => beginOAuthSignIn(space.db, space.config, { provider: 'github' }), { code: 'OAUTH_PROVIDER_UNAVAILABLE' });
});

test('the callback URL is derived, not configured', async (t) => {
  const space = workspace(t);
  assert.equal(oauthCallbackUrl(space.config, 'github'), 'https://git.kuklabs.com/api/auth/github/callback');
  assert.equal(oauthCallbackUrl(space.config, 'google'), 'https://git.kuklabs.com/api/auth/google/callback');
});

test('the provider endpoints are constants', async () => {
  // A base URL that could be set per instance is one somebody can point at a
  // server that says yes to anything.
  assert.equal(OAUTH_PROVIDERS.github.authorizeUrl, 'https://github.com/login/oauth/authorize');
  assert.equal(OAUTH_PROVIDERS.google.tokenUrl, 'https://oauth2.googleapis.com/token');
  // Sign-in scopes only. `repo` is a different question and gets asked
  // separately, with its own consent.
  assert.equal(OAUTH_PROVIDERS.github.scope, 'read:user user:email');
  assert.ok(!OAUTH_PROVIDERS.github.scope.includes('repo'));
});

/* --------------------------------------------------------------- state */

test('the authorize URL carries a state, and the secret is not in it', async (t) => {
  const space = workspace(t);
  space.configure('github');
  const { url, state } = beginOAuthSignIn(space.db, space.config, { provider: 'github' });

  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(parsed.searchParams.get('client_id'), 'github-client-id');
  assert.equal(parsed.searchParams.get('state'), state);
  assert.equal(parsed.searchParams.get('redirect_uri'), 'https://git.kuklabs.com/api/auth/github/callback');
  // The browser gets the id, never the secret.
  assert.ok(!url.includes('client-secret'));
});

test('the state is stored hashed', async (t) => {
  const space = workspace(t);
  space.configure('github');
  const { state } = beginOAuthSignIn(space.db, space.config, { provider: 'github' });

  const stored = space.db.prepare('SELECT state_hash AS hash FROM oauth_states').get().hash;
  // A state somebody can read out of the table is a state they can replay.
  assert.notEqual(stored, state);
  assert.match(stored, /^[0-9a-f]{64}$/);
});

test('a state works once', async (t) => {
  const space = workspace(t);
  space.configure('github');
  const { state } = beginOAuthSignIn(space.db, space.config, { provider: 'github' });

  assert.ok(claimOAuthState(space.db, { provider: 'github', state }));
  // The same callback URL, replayed out of history or a log, must not sign
  // anybody in a second time.
  assert.throws(() => claimOAuthState(space.db, { provider: 'github', state }), { code: 'OAUTH_STATE_INVALID' });
});

test('a state issued for one provider does not finish another', async (t) => {
  const space = workspace(t);
  space.configure('github');
  space.configure('google');
  const { state } = beginOAuthSignIn(space.db, space.config, { provider: 'github' });

  assert.throws(() => claimOAuthState(space.db, { provider: 'google', state }), { code: 'OAUTH_STATE_INVALID' });
});

test('a state expires, and an invented one is refused', async (t) => {
  const space = workspace(t);
  space.configure('github');
  const { state } = beginOAuthSignIn(space.db, space.config, { provider: 'github' });
  const later = new Date(Date.now() + 11 * 60 * 1000);

  assert.throws(() => claimOAuthState(space.db, { provider: 'github', state, now: later }), { code: 'OAUTH_STATE_INVALID' });
  assert.throws(() => claimOAuthState(space.db, { provider: 'github', state: 'invented' }), { code: 'OAUTH_STATE_INVALID' });
  assert.throws(() => claimOAuthState(space.db, { provider: 'github', state: '' }), { code: 'OAUTH_STATE_INVALID' });
});

test('whether this is a sign-in or a link is decided when the flow starts', async (t) => {
  const space = workspace(t);
  space.configure('github');
  const userId = uid('usr');
  space.db.prepare("INSERT INTO users (id, email, password_hash, display_name) VALUES (?, 'one@kuklabs.com', 'x', 'One')").run(userId);

  const { state } = beginOAuthSignIn(space.db, space.config, { provider: 'github', linkUserId: userId });
  // Taken from the stored row, never from the callback URL — otherwise the
  // person coming back could say which account to attach the identity to.
  assert.equal(claimOAuthState(space.db, { provider: 'github', state }).linkUserId, userId);
});

test('housekeeping drops states nobody came back for', async (t) => {
  const space = workspace(t);
  space.configure('github');
  beginOAuthSignIn(space.db, space.config, { provider: 'github' });
  assert.equal(pruneOAuthStates(space.db, {}), 0);
  assert.equal(pruneOAuthStates(space.db, { now: new Date(Date.now() + 11 * 60 * 1000) }), 1);
});

/* ------------------------------------------------------ where they land */

test('only a route inside this application is accepted', async () => {
  // An open redirect on a login route is a phishing page on your own domain:
  // the URL really is git.kuklabs.com, the person really did sign in, and then
  // they land somewhere else.
  assert.equal(safeRedirect('#/repo/kuklabs/kukgit'), '#/repo/kuklabs/kukgit');
  assert.equal(safeRedirect('#/settings?tab=keys'), '#/settings?tab=keys');

  for (const hostile of [
    'https://evil.example',
    '//evil.example',
    '/api/tokens',
    'javascript:alert(1)',
    '#\\/evil',
    'http://git.kuklabs.com.evil.example',
    '',
    null,
  ]) {
    assert.equal(safeRedirect(hostile), '#/', `${hostile} was accepted`);
  }
});

test('the landing place is remembered with the state, not read from the callback', async (t) => {
  const space = workspace(t);
  space.configure('github');
  const { state } = beginOAuthSignIn(space.db, space.config, { provider: 'github', redirectTo: '#/repo/kuklabs/kukgit' });
  assert.equal(claimOAuthState(space.db, { provider: 'github', state }).redirectTo, '#/repo/kuklabs/kukgit');
});

test('a hostile redirect is neutralised when it is stored, not only when it is read', async (t) => {
  const space = workspace(t);
  space.configure('github');
  beginOAuthSignIn(space.db, space.config, { provider: 'github', redirectTo: 'https://evil.example' });
  assert.equal(space.db.prepare('SELECT redirect_to AS target FROM oauth_states').get().target, '#/');
});

/* ------------------------------------------------------- the profile */

test('GitHub sign-in returns an identity, and the verified flag is read not assumed', async (t) => {
  const space = workspace(t);
  space.configure('github');
  const fetchImpl = githubSimulator({ verified: true });

  const profile = await fetchOAuthProfile(space.db, space.config, { provider: 'github', code: 'good-code', fetchImpl });
  assert.deepEqual(profile, {
    provider: 'github',
    providerUserId: '4242',
    providerLogin: 'octocat',
    displayName: 'Octo Cat',
    email: 'octocat@example.com',
    emailVerified: true,
  });
});

test('an unverified GitHub address comes back as unverified', async (t) => {
  const space = workspace(t);
  space.configure('github');
  const profile = await fetchOAuthProfile(space.db, space.config, {
    provider: 'github', code: 'good-code', fetchImpl: githubSimulator({ verified: false }),
  });

  // This one boolean is what stands between "link to the existing account" and
  // "hand somebody else's account away".
  assert.equal(profile.emailVerified, false);
  assert.equal(profile.email, 'octocat@example.com');
});

test('the primary address is used, not the first one listed', async (t) => {
  const space = workspace(t);
  space.configure('github');
  const profile = await fetchOAuthProfile(space.db, space.config, {
    provider: 'github', code: 'good-code', fetchImpl: githubSimulator({}),
  });
  assert.equal(profile.email, 'octocat@example.com');
});

test('a hidden GitHub address still signs in', async (t) => {
  const space = workspace(t);
  space.configure('github');
  const profile = await fetchOAuthProfile(space.db, space.config, {
    provider: 'github', code: 'good-code', fetchImpl: githubSimulator({ privateEmail: true }),
  });
  // `/user` reports null for anybody who keeps theirs private; `/user/emails`
  // still has it, which is the whole reason for the second call.
  assert.equal(profile.email, 'octocat@example.com');
  assert.equal(profile.providerUserId, '4242');
});

test('the secret is sent to GitHub and never to the browser', async (t) => {
  const space = workspace(t);
  space.configure('github');
  const fetchImpl = githubSimulator({});
  await fetchOAuthProfile(space.db, space.config, { provider: 'github', code: 'good-code', fetchImpl });

  const exchange = fetchImpl.calls.find((call) => call.url === OAUTH_PROVIDERS.github.tokenUrl);
  assert.equal(exchange.method, 'POST');
  const sent = new URLSearchParams(exchange.body);
  assert.equal(sent.get('client_secret'), 'github-client-secret-nobody-reads');
  // And the redirect_uri goes with it, which is what stops a code issued for
  // one application being spent by another.
  assert.equal(sent.get('redirect_uri'), 'https://git.kuklabs.com/api/auth/github/callback');
});

test('a bad code is refused even though GitHub answers 200', async (t) => {
  const space = workspace(t);
  space.configure('github');
  // GitHub returns 200 with `{error: "bad_verification_code"}`. Anything
  // checking only the status would treat that as a successful sign-in.
  await assert.rejects(
    () => fetchOAuthProfile(space.db, space.config, { provider: 'github', code: 'wrong', fetchImpl: githubSimulator({}) }),
    { code: 'OAUTH_PROVIDER_REFUSED' },
  );
});

test('a provider that cannot be reached is a 502, not a crash', async (t) => {
  const space = workspace(t);
  space.configure('github');
  const dead = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(
    () => fetchOAuthProfile(space.db, space.config, { provider: 'github', code: 'good-code', fetchImpl: dead }),
    { code: 'OAUTH_PROVIDER_UNREACHABLE' },
  );
});

test('a profile with no id is refused rather than signed in as nobody', async (t) => {
  const space = workspace(t);
  space.configure('github');
  const odd = async (url, options) => {
    if (String(url) === OAUTH_PROVIDERS.github.tokenUrl) {
      return new Response(JSON.stringify({ access_token: 'gho_x' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ login: 'octocat' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await assert.rejects(
    () => fetchOAuthProfile(space.db, space.config, { provider: 'github', code: 'good-code', fetchImpl: odd }),
    { code: 'OAUTH_PROFILE_INVALID' },
  );
});

test('Google sign-in reads sub and email_verified', async (t) => {
  const space = workspace(t);
  space.configure('google');
  const fetchImpl = async (url, options = {}) => {
    const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (String(url) === OAUTH_PROVIDERS.google.tokenUrl) return reply({ access_token: 'ya29.simulated' });
    return reply({ sub: '11223344', email: 'octocat@gmail.com', email_verified: true, name: 'Octo Cat' });
  };

  const profile = await fetchOAuthProfile(space.db, space.config, { provider: 'google', code: 'good-code', fetchImpl });
  // `sub` and not the address: a Google account's address can change, the
  // subject cannot.
  assert.equal(profile.providerUserId, '11223344');
  assert.equal(profile.emailVerified, true);
});
