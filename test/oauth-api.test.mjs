import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSession, hashPassword } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { migrateAccountVerification } from '../src/account-verification.mjs';
import { migrateInstanceSettings, putInstanceSetting } from '../src/instance-settings.mjs';
import { OAUTH_PROVIDERS, migrateOAuthSignIn } from '../src/oauth-signin.mjs';
import { migrateUserIdentities } from '../src/user-identities.mjs';
import { OAUTH_ERROR_CODES, createOAuthApiHandler, oauthErrorCode } from '../src/oauth-api.mjs';

/**
 * The routes behind the two sign-in buttons.
 *
 * Two of them are `GET`s the browser is *redirected* to, which means no
 * `Origin` header, no custom header, and nothing to check except the `state`.
 * So most of what is below is a way of arriving at the callback holding
 * something other than a state this server issued, and watching it refuse.
 *
 * The rest is about what the callback is allowed to read out of its own URL:
 * the answer is `code` and `state`, and nothing else. Where somebody goes
 * afterwards, and whether this is a sign-in or a link, were both decided when
 * the flow started.
 */

async function workspace(t, { authMode = 'local' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-oauth-api-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  let handler;
  const node = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => node.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => node.close(resolve)));
  const origin = `http://127.0.0.1:${node.address().port}`;

  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'test.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    baseUrl: origin,
    nodeEnv: 'test',
    authMode,
    ...(authMode === 'authkit'
      ? { authkitBaseUrl: 'https://auth.kuklabs.com', authkitEncryptionKey: 'a'.repeat(40) }
      : {}),
    adminEmail: 'founder@kuklabs.com',
    adminPassword: 'secure-test-password',
    adminName: 'Founder',
    secretsEncryptionKey: 'k'.repeat(48),
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, { ...config, authMode: 'local' });
  migrateInstanceSettings(db);
  migrateAccountVerification(db);
  migrateOAuthSignIn(db);
  migrateUserIdentities(db);

  const github = githubSimulator();
  const api = createOAuthApiHandler({ config, db, fetchImpl: github });
  handler = async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); };

  const configure = (provider = 'github') => {
    putInstanceSetting(db, config, { integration: `auth.${provider}`, field: 'clientId', value: `${provider}-client-id` });
    putInstanceSetting(db, config, { integration: `auth.${provider}`, field: 'clientSecret', value: `${provider}-secret-nobody-reads` });
  };

  const person = (email, { verified = false } = {}) => {
    const id = uid('usr');
    db.prepare('INSERT INTO users (id, email, password_hash, display_name, email_verified) VALUES (?, ?, ?, ?, ?)')
      .run(id, email, hashPassword('a-real-enough-password'), email.split('@')[0], verified ? 1 : 0);
    return id;
  };

  const call = async (pathname, { userId, method = 'GET', originHeader } = {}) => {
    const headers = {};
    if (originHeader) headers.Origin = originHeader;
    if (userId) headers.Cookie = `kukgit_session=${createSession(db, userId).token}`;
    const response = await fetch(`${origin}${pathname}`, { method, headers, redirect: 'manual' });
    return {
      status: response.status,
      location: response.headers.get('location'),
      setCookie: response.headers.get('set-cookie'),
      cacheControl: response.headers.get('cache-control'),
      body: await response.json().catch(() => null),
    };
  };

  /** Starts a real flow and returns the `state` the server put in the URL. */
  const startFlow = async (provider = 'github', { userId, redirectTo } = {}) => {
    const query = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
    const started = await call(`/api/auth/${provider}/start${query}`, { userId });
    assert.equal(started.status, 302, 'flow did not start');
    return { state: new URL(started.location).searchParams.get('state'), started };
  };

  return { config, db, origin, configure, person, call, startFlow, github };
}

/** A GitHub that answers the way GitHub actually does. */
function githubSimulator({ verified = true, email = 'octocat@example.com', id = 4242 } = {}) {
  const impl = async (url, options = {}) => {
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (String(url) === OAUTH_PROVIDERS.github.tokenUrl) {
      const sent = new URLSearchParams(String(options.body ?? ''));
      // A bad code is a 200 with an `error` field, not a 4xx.
      if (sent.get('code') !== 'good-code') return reply(200, { error: 'bad_verification_code' });
      return reply(200, { access_token: 'gho_simulated', token_type: 'bearer' });
    }
    if (String(url) === 'https://api.github.com/user') {
      return reply(200, { id: impl.id, login: 'octocat', name: 'Octo Cat', email: impl.email });
    }
    if (String(url) === 'https://api.github.com/user/emails') {
      return reply(200, [{ email: impl.email, primary: true, verified: impl.verified }]);
    }
    return reply(404, { message: 'Not Found' });
  };
  impl.verified = verified;
  impl.email = email;
  impl.id = id;
  return impl;
}

/* --------------------------------------------------------- what is offered */

test('the sign-in screen is told only about providers this instance can actually use', async (t) => {
  const space = await workspace(t);
  // Before anything is configured: no buttons. A button that leads to GitHub
  // with an empty `client_id` produces an error page on GitHub's domain, which
  // reads as "KukGit is broken".
  assert.deepEqual((await space.call('/api/auth/providers')).body.providers, []);

  space.configure('github');
  assert.deepEqual((await space.call('/api/auth/providers')).body.providers, [{ id: 'github', label: 'GitHub' }]);
});

test('nothing here answers when Kuklabs Account owns the sessions', async (t) => {
  const space = await workspace(t, { authMode: 'authkit' });
  space.configure('github');
  for (const pathname of ['/api/auth/providers', '/api/auth/github/start', '/api/auth/github/callback', '/api/auth/identities']) {
    // 404, not 403: a refusal tells a stranger the route exists and might work
    // on another instance.
    assert.equal((await space.call(pathname)).status, 404, pathname);
  }
});

test('routes belonging to other handlers are left alone, not claimed', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  // The AuthKit login handler owns these. Answering 404 for them here would
  // take them away from it depending on registration order.
  for (const pathname of ['/api/auth/login', '/api/auth/signup', '/api/auth/otp/verify']) {
    const response = await space.call(pathname);
    assert.equal(response.status, 404, pathname);
    // The test server's own 404, which carries no request id — proof this
    // handler declined rather than answered.
    assert.equal(response.body, null, pathname);
  }
});

/* ------------------------------------------------------------- starting */

test('starting a flow sends the browser to GitHub with a state this server issued', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  const started = await space.call('/api/auth/github/start');

  assert.equal(started.status, 302);
  const target = new URL(started.location);
  assert.equal(target.origin + target.pathname, 'https://github.com/login/oauth/authorize');
  assert.ok(target.searchParams.get('state'));
  assert.ok(!started.location.includes('secret-nobody-reads'));
  // A cached 302 that carries a session is a session handed to whoever uses
  // the machine next.
  assert.match(started.cacheControl, /no-store/);
});

test('whether this is a sign-in or a link is decided at the start, not at the callback', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  const owner = space.person('owner@kuklabs.com');

  await space.startFlow('github', { userId: owner });
  const linked = space.db.prepare('SELECT link_user_id AS linkUserId FROM oauth_states').get();
  assert.equal(linked.linkUserId, owner);

  space.db.prepare('DELETE FROM oauth_states').run();
  await space.startFlow('github');
  // Nobody signed in: the callback will sign in rather than link. Reading the
  // session at callback time instead is the login CSRF this table exists for —
  // a link somebody sends you finishes their GitHub flow against your session.
  assert.equal(space.db.prepare('SELECT link_user_id AS linkUserId FROM oauth_states').get().linkUserId, null);
});

/* ------------------------------------------------------------ signing in */

test('a first sign-in creates the account and hands back a session', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  const { state } = await space.startFlow('github', { redirectTo: '#/kuklabs' });

  const done = await space.call(`/api/auth/github/callback?code=good-code&state=${state}`);
  assert.equal(done.status, 302);
  assert.equal(done.location, '/#/kuklabs');
  assert.match(done.setCookie, /kukgit_session=/);

  const user = space.db.prepare('SELECT id, email, email_verified AS verified, password_hash AS hash FROM users WHERE email = ?').get('octocat@example.com');
  assert.ok(user);
  assert.equal(user.verified, 1);
  // Not a password, and not something `verifyPassword` could ever match. An
  // account made from a GitHub sign-in has no password until its owner sets
  // one through the reset flow, which proves the address first.
  assert.ok(!user.hash.startsWith('scrypt$'));

  // No organization. Joining or creating one has a name, a slug and a plan
  // attached, and belongs to onboarding rather than to a redirect somebody is
  // halfway through.
  const orgs = space.db.prepare('SELECT COUNT(*) AS count FROM org_members WHERE user_id = ?').get(user.id).count;
  assert.equal(orgs, 0);
});

test('coming back a second time signs into the same account, it does not make another', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  for (const _ of [1, 2]) {
    const { state } = await space.startFlow('github');
    assert.equal((await space.call(`/api/auth/github/callback?code=good-code&state=${state}`)).status, 302);
  }
  assert.equal(space.db.prepare("SELECT COUNT(*) AS count FROM users WHERE email = 'octocat@example.com'").get().count, 1);
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM user_identities').get().count, 1);
});

test('the account is found by the provider id, not by the name, which can be given away', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  const { state } = await space.startFlow('github');
  await space.call(`/api/auth/github/callback?code=good-code&state=${state}`);

  // The same numeric id, renamed, with a different address. GitHub logins can
  // be released and taken by somebody else; the id cannot.
  space.github.email = 'renamed@example.com';
  const second = await space.startFlow('github');
  await space.call(`/api/auth/github/callback?code=good-code&state=${second.state}`);

  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 2, 'founder plus one');
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM user_identities').get().count, 1);
});

/* ------------------------------------------------------------- refusals */

test('a state this server never issued does not sign anybody in', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  const done = await space.call('/api/auth/github/callback?code=good-code&state=made-up');

  assert.equal(done.status, 302);
  assert.equal(done.location, '/#/sign-in?error=state_invalid&provider=github');
  assert.equal(done.setCookie, null);
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM user_identities').get().count, 0);
});

test('the same callback URL replayed a second time fails', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  const { state } = await space.startFlow('github');
  const callback = `/api/auth/github/callback?code=good-code&state=${state}`;

  assert.match((await space.call(callback)).setCookie ?? '', /kukgit_session=/);
  const replay = await space.call(callback);
  // Spent by the delete, not by a read followed by a delete — the second is a
  // window in which the same URL passes twice.
  assert.equal(replay.location, '/#/sign-in?error=state_invalid&provider=github');
  assert.equal(replay.setCookie, null);
});

test('a state issued for GitHub cannot finish a Google callback', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  space.configure('google');
  const { state } = await space.startFlow('github');

  const done = await space.call(`/api/auth/google/callback?code=good-code&state=${state}`);
  assert.equal(done.location, '/#/sign-in?error=state_invalid&provider=google');
  assert.equal(done.setCookie, null);
});

test('pressing Cancel on GitHub comes back as a message, not as a broken page', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  const { state } = await space.startFlow('github');

  const done = await space.call(`/api/auth/github/callback?error=access_denied&state=${state}`);
  assert.equal(done.location, '/#/sign-in?error=access_denied&provider=github');
  assert.equal(done.setCookie, null);
  // The state is spent even so. A cancelled flow whose state survives is a
  // state somebody can come back and use.
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM oauth_states').get().count, 0);
});

test('an address GitHub has not verified does not sign anybody in', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  space.github.verified = false;
  space.person('octocat@example.com', { verified: true });
  const { state } = await space.startFlow('github');

  const done = await space.call(`/api/auth/github/callback?code=good-code&state=${state}`);
  // Both sides have to have proved the address. Otherwise anybody who can get
  // an unverified address onto GitHub owns the KukGit account using it.
  assert.equal(done.location, '/#/sign-in?error=email_conflict&provider=github');
  assert.equal(done.setCookie, null);
});

test('an existing account that never proved its address is not handed over', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  // Somebody signed up here as octocat@example.com and never proved it. The
  // real owner of that address now arrives from GitHub.
  space.person('octocat@example.com', { verified: false });
  const { state } = await space.startFlow('github');

  const done = await space.call(`/api/auth/github/callback?code=good-code&state=${state}`);
  assert.equal(done.location, '/#/sign-in?error=email_conflict&provider=github');
  assert.equal(done.setCookie, null);
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM user_identities').get().count, 0);
});

test('a bad code is refused even though GitHub answers it with a 200', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  const { state } = await space.startFlow('github');

  const done = await space.call(`/api/auth/github/callback?code=wrong&state=${state}`);
  assert.match(done.location, /error=provider_error/);
  assert.equal(done.setCookie, null);
});

/* -------------------------------------------------------- open redirect */

test('where somebody lands is read from the state row, never from the callback URL', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  const { state } = await space.startFlow('github', { redirectTo: '#/settings' });

  // The attacker appends their own destination to the callback GitHub sends.
  const done = await space.call(`/api/auth/github/callback?code=good-code&state=${state}&redirect_to=${encodeURIComponent('https://evil.example/steal')}`);
  assert.equal(done.location, '/#/settings');
});

test('a destination that leaves the site is replaced, not followed', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  for (const hostile of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
    space.db.prepare('DELETE FROM oauth_states').run();
    const { state } = await space.startFlow('github', { redirectTo: hostile });
    const done = await space.call(`/api/auth/github/callback?code=good-code&state=${state}`);
    // An open redirect on a login route is a phishing page on your own domain:
    // the URL really is KukGit and the person really did sign in.
    assert.equal(done.location, '/#/', hostile);
  }
});

/* ------------------------------------------------------------- linking */

test('somebody already signed in gets the provider linked, and no new session', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  const owner = space.person('owner@kuklabs.com', { verified: true });
  const { state } = await space.startFlow('github', { userId: owner, redirectTo: '#/settings/account' });

  const done = await space.call(`/api/auth/github/callback?code=good-code&state=${state}`);
  assert.equal(done.location, '/#/settings/account');
  // They were already signed in. Re-issuing a session here would only widen
  // what a redirect route is able to do.
  assert.equal(done.setCookie, null);

  const linked = space.db.prepare('SELECT user_id AS userId, provider FROM user_identities').get();
  assert.equal(linked.userId, owner);
  assert.equal(linked.provider, 'github');
});

test('a GitHub account already linked elsewhere is not linked twice', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  const first = space.person('first@kuklabs.com');
  const second = space.person('second@kuklabs.com');

  const a = await space.startFlow('github', { userId: first });
  await space.call(`/api/auth/github/callback?code=good-code&state=${a.state}`);
  const b = await space.startFlow('github', { userId: second });
  const done = await space.call(`/api/auth/github/callback?code=good-code&state=${b.state}`);

  assert.equal(done.location, '/#/sign-in?error=already_linked&provider=github');
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM user_identities').get().count, 1);
});

/* ----------------------------------------------------------- unlinking */

test('removing the only way into an account is refused', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  const { state } = await space.startFlow('github');
  await space.call(`/api/auth/github/callback?code=good-code&state=${state}`);
  const created = space.db.prepare("SELECT id FROM users WHERE email = 'octocat@example.com'").get().id;

  const removed = await space.call('/api/auth/identities/github', {
    method: 'DELETE', userId: created, originHeader: space.origin,
  });
  // No password, one provider. An account nobody can sign into is an account
  // nobody can delete or transfer either.
  assert.equal(removed.status, 409);
  assert.equal(removed.body.error.code, 'IDENTITY_LAST_METHOD');
});

test('unlinking is a state change, so it is checked like one', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  const owner = space.person('owner@kuklabs.com');
  const { state } = await space.startFlow('github', { userId: owner });
  await space.call(`/api/auth/github/callback?code=good-code&state=${state}`);

  const noSession = await space.call('/api/auth/identities/github', { method: 'DELETE', originHeader: space.origin });
  assert.equal(noSession.status, 401);

  const crossSite = await space.call('/api/auth/identities/github', {
    method: 'DELETE', userId: owner, originHeader: 'https://evil.example',
  });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.body.error.code, 'CSRF_BLOCKED');

  const ok = await space.call('/api/auth/identities/github', { method: 'DELETE', userId: owner, originHeader: space.origin });
  assert.equal(ok.status, 200);
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM user_identities').get().count, 0);
});

test('the list of linked accounts needs a session', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  assert.equal((await space.call('/api/auth/identities')).status, 401);

  const owner = space.person('owner@kuklabs.com');
  const mine = await space.call('/api/auth/identities', { userId: owner });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.identities, []);
});

/* ------------------------------------------------------------- the codes */

test('every failure these modules can raise has something the screen can say', async () => {
  // Written after getting this wrong: the map named error codes that did not
  // exist, so a genuine provider failure came out as `server_error` and the
  // sign-in screen would have said "something went wrong" for a wrong client
  // secret. The codes are read out of the source rather than listed by hand,
  // so adding one to a module and forgetting it here fails right away.
  const sources = ['../src/oauth-signin.mjs', '../src/oauth-api.mjs', '../src/user-identities.mjs']
    .map((relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8'))
    .join('\n');
  const raised = new Set(sources.match(/'(?:OAUTH|IDENTITY)_[A-Z_]+'/g).map((quoted) => quoted.slice(1, -1)));
  // These never reach the callback, so they never need a screen message: the
  // first four are impossible there (no route arrives without a provider, and
  // the account-creating callback is this file's own), and the last is raised
  // only by unlinking, which is an ordinary JSON route that returns its code.
  const notCallbackFailures = new Set([
    'IDENTITY_PROVIDER_INVALID', 'IDENTITY_SUBJECT_INVALID',
    'IDENTITY_CREATE_UNAVAILABLE', 'IDENTITY_CREATE_FAILED', 'IDENTITY_LAST_METHOD',
  ]);

  assert.ok(raised.size >= 10, `only found ${raised.size} codes — the scan is not reading the sources`);
  for (const code of raised) {
    if (notCallbackFailures.has(code)) continue;
    const mapped = oauthErrorCode({ code });
    assert.ok(OAUTH_ERROR_CODES.includes(mapped), `${code} maps to ${mapped}, which the screen does not know`);
    assert.notEqual(mapped, 'server_error', `${code} is a real, explainable failure and is being reported as a bug in KukGit`);
  }
});

test('an unrecognised failure is a bug in KukGit and says so, rather than blaming the provider', async () => {
  assert.equal(oauthErrorCode({ code: 'SOMETHING_NEW' }), 'server_error');
  assert.equal(oauthErrorCode(undefined), 'server_error');
});

test('these routes are GET only, because that is all a redirect can be', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  const { state } = await space.startFlow('github');
  for (const [pathname, method] of [
    ['/api/auth/github/start', 'POST'],
    [`/api/auth/github/callback?code=good-code&state=${state}`, 'POST'],
    ['/api/auth/providers', 'POST'],
    ['/api/auth/identities', 'POST'],
    ['/api/auth/identities/github', 'POST'],
  ]) {
    const response = await space.call(pathname, { method, originHeader: space.origin });
    assert.equal(response.status, 405, `${method} ${pathname}`);
  }
  // And the state is still there: a refused method must not spend it, or a
  // stray form post would break a sign-in already under way.
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM oauth_states').get().count, 1);
});

test('a provider account with no email address cannot become a KukGit account', async (t) => {
  const space = await workspace(t);
  space.configure('github');
  // GitHub allows an account with every address kept private. There is then no
  // way to reach the owner and no way for them to recover the account later, so
  // it is refused rather than created half-formed.
  space.github.email = null;
  const { state } = await space.startFlow('github');

  const done = await space.call(`/api/auth/github/callback?code=good-code&state=${state}`);
  assert.match(done.location, /error=provider_error/);
  assert.equal(done.setCookie, null);
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1, 'only the founder');
});
