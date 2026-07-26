import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';
import { createTokenApiHandler } from '../src/token-api.mjs';

function startTestServer(config, db) {
  const app = createApp({ config, db });
  const tokenApi = createTokenApiHandler({ config, db });
  return http.createServer(async (req, res) => {
    if (await tokenApi(req, res)) return;
    return app(req, res);
  });
}

async function login(origin) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'founder@example.com', password: 'secure-test-password' }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

function testConfig(dataDir) {
  return loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'test.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'founder@example.com',
    adminPassword: 'secure-test-password',
    adminName: 'Founder',
  });
}

test('creates, lists and revokes a personal access token through the browser API', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-token-api-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const config = testConfig(dataDir);
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);

  const server = startTestServer(config, db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const unauthenticated = await fetch(`${origin}/api/settings/tokens`);
  assert.equal(unauthenticated.status, 401);

  const cookie = await login(origin);
  const initial = await fetch(`${origin}/api/settings/tokens`, { headers: { Cookie: cookie } });
  assert.equal(initial.status, 200);
  assert.deepEqual((await initial.json()).tokens, []);

  const create = await fetch(`${origin}/api/settings/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Test laptop', scopes: ['repo:read', 'repo:write'], expiresInDays: 30 }),
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.match(created.token.token, /^kgp_[A-Za-z0-9_-]+$/);
  assert.equal(created.token.name, 'Test laptop');
  assert.deepEqual(created.token.scopes, ['repo:read', 'repo:write']);

  const list = await fetch(`${origin}/api/settings/tokens`, { headers: { Cookie: cookie } });
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.tokens.length, 1);
  assert.equal(listed.tokens[0].id, created.token.id);
  assert.equal(listed.tokens[0].token, undefined);
  assert.equal(listed.tokens[0].revokedAt, null);

  const revoke = await fetch(`${origin}/api/settings/tokens/${created.token.id}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  assert.equal(revoke.status, 200);
  const revoked = await revoke.json();
  assert.ok(revoked.token.revokedAt);

  const afterRevoke = await fetch(`${origin}/api/settings/tokens`, { headers: { Cookie: cookie } });
  const finalList = await afterRevoke.json();
  assert.ok(finalList.tokens[0].revokedAt);

  const auditRows = db.prepare("SELECT action FROM audit_logs WHERE action LIKE 'personal_access_token.%' ORDER BY rowid").all();
  assert.deepEqual(auditRows.map((row) => row.action), ['personal_access_token.created', 'personal_access_token.revoked']);
});

test('rejects unsupported token expiry, empty scopes and cross-origin writes', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-token-validation-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = testConfig(dataDir);
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);

  const server = startTestServer(config, db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cookie = await login(origin);

  const badExpiry = await fetch(`${origin}/api/settings/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Bad expiry', scopes: ['repo:read'], expiresInDays: 2 }),
  });
  assert.equal(badExpiry.status, 400);

  const noScopes = await fetch(`${origin}/api/settings/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'No scopes', scopes: [], expiresInDays: 30 }),
  });
  assert.equal(noScopes.status, 400);

  const crossOrigin = await fetch(`${origin}/api/settings/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://attacker.example' },
    body: JSON.stringify({ name: 'Blocked', scopes: ['repo:read'], expiresInDays: 30 }),
  });
  assert.equal(crossOrigin.status, 403);
});
