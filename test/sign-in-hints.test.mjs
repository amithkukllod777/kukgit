import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp, signInHints } from '../src/app.mjs';
import { PUBLISHED_DEV_CREDENTIALS, loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';

function workspace(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-hints-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'test.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminName: 'Founder',
    ...overrides,
  });
}

function starterCredentials(t, overrides = {}) {
  return workspace(t, {
    adminEmail: PUBLISHED_DEV_CREDENTIALS.email,
    adminPassword: PUBLISHED_DEV_CREDENTIALS.password,
    ...overrides,
  });
}

test('a checkout still using the starter account is told so', async (t) => {
  // The convenience this exists for: a laptop that has changed nothing yet.
  assert.deepEqual(signInHints(starterCredentials(t)).demoAccount, { ...PUBLISHED_DEV_CREDENTIALS });
});

test('changing either half of the starter account withholds both', async (t) => {
  // The account is published. Once an operator has moved off it, printing it is
  // no longer a reminder of their own password — it is telling a stranger what
  // the default is, on a box that may well be answering the whole internet.
  assert.equal(signInHints(starterCredentials(t, { adminEmail: 'amith@kuklabs.com' })).demoAccount, null);
  assert.equal(signInHints(starterCredentials(t, { adminPassword: 'a-private-password' })).demoAccount, null);
});

test('production never gets the starter account, whatever else is set', async () => {
  // Built by hand rather than through loadConfig, which refuses local auth in
  // production outright. That refusal is the real defence; this is the second
  // one, and it is only worth having if it holds when the first is bypassed.
  const config = { isProduction: true, authMode: 'local', ...PUBLISHED_DEV_CREDENTIALS, adminEmail: PUBLISHED_DEV_CREDENTIALS.email, adminPassword: PUBLISHED_DEV_CREDENTIALS.password };
  assert.equal(signInHints(config).demoAccount, null);
});

test('AuthKit mode never gets it either — there is no local password to prefill', async (t) => {
  const config = starterCredentials(t, { authMode: 'authkit', authkitBaseUrl: 'https://accounts.example.com', authkitProductId: 'kukgit', authkitEncryptionKey: 'k'.repeat(40) });
  assert.equal(signInHints(config).demoAccount, null);
});

test('the endpoint answers without a session, and withholds a changed account', async (t) => {
  // Signed out is the only state this route is ever called in, so it has to be
  // reachable — and it is therefore reachable by anybody who can reach the box.
  const config = workspace(t, { adminEmail: 'amith@kuklabs.com', adminPassword: 'a-private-password' });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  const server = http.createServer(createApp({ config, db }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/sign-in-hints`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.demoAccount, null);
  // Not just absent from `demoAccount` — absent from the response altogether.
  assert.doesNotMatch(JSON.stringify(payload), /kuklabs\.local|KukGit@2026/);
});

test('the sign-in page ships no credentials of its own', async () => {
  // The check that would have caught the original bug: the values were in the
  // page source, so no server-side decision could have withheld them.
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const login = source.slice(source.indexOf('function renderLogin'), source.indexOf('function renderShell'));
  assert.doesNotMatch(login, /admin@kuklabs\.local|KukGit@2026/);
});
