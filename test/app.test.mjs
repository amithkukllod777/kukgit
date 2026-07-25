import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';

test('authenticates and creates a repository through the HTTP API', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-app-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({ dataDir, databasePath: path.join(dataDir, 'test.db'), repositoriesDir: path.join(dataDir, 'repos'), tempDir: path.join(dataDir, 'tmp'), nodeEnv: 'test', adminEmail: 'founder@example.com', adminPassword: 'secure-test-password', adminName: 'Founder' });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  const server = http.createServer(createApp({ config, db }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'founder@example.com', password: 'secure-test-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const create = await fetch(`${origin}/api/repos`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ orgSlug: 'kuklabs', name: 'API Demo', slug: 'api-demo', visibility: 'private' }) });
  assert.equal(create.status, 201);
  const payload = await create.json();
  assert.equal(payload.repository.slug, 'api-demo');
  const list = await fetch(`${origin}/api/repos`, { headers: { Cookie: cookie } });
  assert.equal((await list.json()).repositories.length, 1);
});
