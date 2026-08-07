import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSession, hashPassword } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createApp } from '../src/app.mjs';
import { createAccountApiHandler } from '../src/account-api.mjs';
import { createOAuthApiHandler } from '../src/oauth-api.mjs';
import { createPhoneVerifyPageHandler } from '../src/phone-verify-page.mjs';
import { createTwoFactorApiHandler } from '../src/two-factor-api.mjs';
import { applySchema } from '../src/schema.mjs';

/**
 * Which handler answers which route, with the handlers mounted in the order the
 * server mounts them.
 *
 * This file exists because of a bug every other test in the repository passed
 * through. `account-api` claimed the whole `/api/account/` prefix and answered
 * anything unknown under it with a 405 — and it is POST-only. That took
 * `/api/account/phone/config` and `/api/account/two-factor` away from the
 * handlers that own them. Both are `GET`s. Neither was reachable on a running
 * server, and phone verification could not start at all.
 *
 * Nothing caught it because every test mounts its own handler alone, where the
 * route it is testing is the only one that exists. A smoke test against a real
 * server found it in one request.
 *
 * So this asserts the shape a chain of prefix-claiming handlers gets wrong: for
 * each route, that the handler which owns it is the one that answers.
 */

async function server(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-routes-'));
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
    authMode: 'local',
    firebaseProjectId: 'kukchat-b6402',
    firebaseApiKey: 'AIza-public-web-key',
    adminEmail: 'founder@kuklabs.com',
    adminPassword: 'a-long-and-private-founder-password',
    adminName: 'Founder',
    secretsEncryptionKey: 'k'.repeat(48),
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  applySchema(db, config);
  seedCore(db, config);

  // The same order as `server.mjs`. A test that mounts them in a convenient
  // order is testing a server nobody runs.
  const accountApi = createAccountApiHandler({ config, db });
  const oauthApi = createOAuthApiHandler({ config, db });
  const phoneVerifyPage = createPhoneVerifyPageHandler({ config, db });
  const twoFactorApi = createTwoFactorApiHandler({ config, db });
  const app = createApp({ config, db });
  handler = async (req, res) => {
    if (await accountApi(req, res)) return;
    if (await oauthApi(req, res)) return;
    if (await phoneVerifyPage(req, res)) return;
    if (await twoFactorApi(req, res)) return;
    await app(req, res);
  };

  const person = () => {
    const id = uid('usr');
    db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(id, 'owner@kuklabs.com', hashPassword('a-real-enough-password'), 'Owner');
    return id;
  };

  const call = async (pathname, { method = 'GET', userId, body } = {}) => {
    const headers = { 'Content-Type': 'application/json', Origin: origin };
    if (userId) headers.Cookie = `kukgit_session=${createSession(db, userId).token}`;
    const response = await fetch(`${origin}${pathname}`, {
      method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}), redirect: 'manual',
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  return { config, db, origin, person, call };
}

test('the GET routes under /api/account/ reach the handlers that own them', async (t) => {
  const space = await server(t);
  const owner = space.person();

  // The regression, in one line each. Both were 405 on a running server
  // because a POST-only handler had claimed the prefix they live under.
  const phone = await space.call('/api/account/phone/config', { userId: owner });
  assert.equal(phone.status, 200, JSON.stringify(phone.body));
  assert.equal(phone.body.projectId, 'kukchat-b6402');

  const twoFactor = await space.call('/api/account/two-factor', { userId: owner });
  assert.equal(twoFactor.status, 200, JSON.stringify(twoFactor.body));
  assert.equal(twoFactor.body.enabled, false);
});

test('the POST routes under /api/account/ still reach the account API', async (t) => {
  const space = await server(t);

  const reset = await space.call('/api/account/password-reset/request', {
    method: 'POST', body: { email: 'nobody@kuklabs.com' },
  });
  assert.equal(reset.status, 202);
  assert.match(reset.body.message, /If that address has a KukGit account/);
});

test('a name nobody owns under /api/account/ is a 404, not a 405', async (t) => {
  const space = await server(t);
  const owner = space.person();

  const unknown = await space.call('/api/account/not-a-route', { userId: owner });
  // 405 here would mean some handler claimed a name it does not implement,
  // which is how the two routes above went missing.
  assert.equal(unknown.status, 404);
});

test('the AuthKit login routes are not taken by the OAuth handler', async (t) => {
  const space = await server(t);

  const login = await space.call('/api/auth/login', {
    method: 'POST', body: { email: 'founder@kuklabs.com', password: 'a-long-and-private-founder-password' },
  });
  // `oauth-api` declines anything under `/api/auth/` that is not one of its
  // four routes, so this reaches `app`.
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.user.email, 'founder@kuklabs.com');
});

test('the OAuth and two-factor routes under /api/auth/ reach their own handlers', async (t) => {
  const space = await server(t);

  const providers = await space.call('/api/auth/providers');
  assert.equal(providers.status, 200);
  assert.deepEqual(providers.body.providers, []);

  const twoFactor = await space.call('/api/auth/two-factor', { method: 'POST', body: { challenge: 'nope' } });
  // Reached the two-factor handler and was refused by it, rather than being
  // answered by `app`'s catch-all.
  assert.equal(twoFactor.status, 401);
  assert.equal(twoFactor.body.error.code, 'TWO_FACTOR_CHALLENGE_INVALID');
});

test('the phone verification page carries its own policy and nothing else does', async (t) => {
  const space = await server(t);
  const owner = space.person();

  const page = await fetch(`${space.origin}/account/phone`, {
    headers: { Cookie: `kukgit_session=${createSession(space.db, owner).token}` },
    redirect: 'manual',
  });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /gstatic\.com/);

  const application = await fetch(`${space.origin}/`);
  assert.match(application.headers.get('content-security-policy'), /script-src 'self'/);
  assert.ok(!application.headers.get('content-security-policy').includes('gstatic'));
});
