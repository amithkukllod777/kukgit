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
import { createPhoneVerifyPageHandler, phoneVerifyCsp } from '../src/phone-verify-page.mjs';

/**
 * Phone verification on a page of its own.
 *
 * Firebase phone auth loads code from `gstatic.com` and runs reCAPTCHA in an
 * iframe from `google.com`. KukGit's policy is `script-src 'self'` with no
 * frames and no outbound connections, and widening it inside the application
 * would widen it on every page for every customer.
 *
 * So the point of these tests is not that the page renders. It is that the
 * widening stops at this one document — that a repository page, the sign-in
 * page and the API keep the strict policy while this page has its own.
 */

const PROJECT = 'kukchat-b6402';

async function workspace(t, { firebaseProjectId = PROJECT, authMode = 'local' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-phone-page-'));
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
    firebaseProjectId,
    firebaseApiKey: firebaseProjectId ? 'AIza-public-web-key' : '',
    adminEmail: 'founder@kuklabs.com',
    adminPassword: 'secure-test-password',
    adminName: 'Founder',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, { ...config, authMode: 'local' });

  const page = createPhoneVerifyPageHandler({ config, db });
  const app = createApp({ config, db });
  handler = async (req, res) => { if (await page(req, res)) return; await app(req, res); };

  const person = () => {
    const id = uid('usr');
    db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(id, 'owner@kuklabs.com', hashPassword('a-real-enough-password'), 'Owner');
    return id;
  };

  const call = async (pathname, { userId, method = 'GET' } = {}) => {
    const headers = {};
    if (userId) headers.Cookie = `kukgit_session=${createSession(db, userId).token}`;
    const response = await fetch(`${origin}${pathname}`, { method, headers, redirect: 'manual' });
    const text = await response.text();
    return {
      status: response.status,
      csp: response.headers.get('content-security-policy'),
      type: response.headers.get('content-type'),
      location: response.headers.get('location'),
      text,
      json: (() => { try { return JSON.parse(text); } catch { return null; } })(),
    };
  };

  return { config, db, origin, person, call };
}

/* ------------------------------------------------------------ the policy */

test('the widening stops at this one page', async (t) => {
  const space = await workspace(t);
  const owner = space.person();

  const verifyPage = await space.call('/account/phone', { userId: owner });
  assert.equal(verifyPage.status, 200);
  assert.match(verifyPage.csp, /https:\/\/www\.gstatic\.com/);
  assert.match(verifyPage.csp, /frame-src[^;]*https:\/\/www\.google\.com/);

  // The application, which is the thing being protected. If this ever inherits
  // the page's policy, every customer's repository page can load and frame
  // Google's code.
  for (const pathname of ['/', '/index.html', '/app.js', '/api/dashboard']) {
    const other = await space.call(pathname, { userId: owner });
    assert.match(other.csp, /script-src 'self'/, pathname);
    assert.ok(!other.csp.includes('gstatic'), `${pathname} must not allow gstatic`);
    assert.ok(!other.csp.includes('frame-src'), `${pathname} must not allow frames`);
  }
});

test('the policy names the hosts Firebase needs and no others', async (t) => {
  const space = await workspace(t);
  const csp = phoneVerifyCsp(space.config);

  // Each of these is here because phone auth does not work without it.
  assert.match(csp, /script-src[^;]*https:\/\/www\.gstatic\.com/);
  assert.match(csp, /connect-src[^;]*https:\/\/identitytoolkit\.googleapis\.com/);
  assert.match(csp, /connect-src[^;]*https:\/\/securetoken\.googleapis\.com/);
  assert.match(csp, new RegExp(`frame-src[^;]*https://${PROJECT}\\.firebaseapp\\.com`));

  // And these are what keeps it a policy rather than a formality.
  assert.match(csp, /default-src 'none'/);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), 'inline script would make script-src meaningless');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
});

test('the page loads no inline script, so its own policy applies to it', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  const verifyPage = await space.call('/account/phone', { userId: owner });

  // A page whose logic is inline needs `'unsafe-inline'`, and a policy with
  // `'unsafe-inline'` in `script-src` stops being one.
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(verifyPage.text), 'no inline <script> on the page');
  assert.match(verifyPage.text, /<script type="module" src="\/account\/phone\/app\.js">/);
});

test('the SDK version is pinned, not floating', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  const script = await space.call('/account/phone/app.js', { userId: owner });
  const settings = await space.call('/api/account/phone/config', { userId: owner });

  assert.match(script.type, /javascript/);
  // Third-party code that changes without a deploy is third-party code nobody
  // reviewed.
  assert.match(String(settings.json.sdkVersion), /^\d+\.\d+\.\d+$/);
  assert.match(script.text, /gstatic\.com\/firebasejs/);
});

/* ------------------------------------------------------------- who gets it */

test('a stranger gets sent to sign in rather than a page that sends SMS', async (t) => {
  const space = await workspace(t);

  const verifyPage = await space.call('/account/phone');
  assert.equal(verifyPage.status, 302);
  assert.equal(verifyPage.location, '/#/');

  const settings = await space.call('/api/account/phone/config');
  assert.equal(settings.status, 401);
});

test('an instance with no Firebase project does not have the page at all', async (t) => {
  const space = await workspace(t, { firebaseProjectId: '' });
  const owner = space.person();

  for (const pathname of ['/account/phone', '/account/phone/app.js', '/api/account/phone/config']) {
    const response = await space.call(pathname, { userId: owner });
    // The application's catch-all would answer 200 with `index.html` for an
    // unknown path, so this asserts the handler claimed it and refused.
    assert.equal(response.status, 404, pathname);
  }
});

test('nothing here answers when Kuklabs Account owns the sessions', async (t) => {
  const space = await workspace(t, { authMode: 'authkit' });
  const owner = space.person();
  assert.equal((await space.call('/account/phone', { userId: owner })).status, 404);
});

test('the public values are public, and no more than that', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  const settings = await space.call('/api/account/phone/config', { userId: owner });

  assert.equal(settings.json.projectId, PROJECT);
  assert.equal(settings.json.apiKey, 'AIza-public-web-key');
  assert.equal(settings.json.authDomain, `${PROJECT}.firebaseapp.com`);
  // A web API key is a project identifier, not a secret — but nothing else on
  // the config belongs in a browser, so the response is a fixed shape rather
  // than a slice of the config object.
  assert.deepEqual(
    Object.keys(settings.json).sort(),
    ['apiKey', 'authDomain', 'projectId', 'requestId', 'sdkVersion'],
  );
});

test('the page is GET only', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  assert.equal((await space.call('/account/phone', { userId: owner, method: 'POST' })).status, 405);
});
