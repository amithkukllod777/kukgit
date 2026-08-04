import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';

async function instance(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-static-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  // A copy, because one of these tests deploys over app.js. The real one is
  // read by other test files in this suite.
  const publicDir = path.join(dataDir, 'public');
  fs.cpSync(new URL('../public', import.meta.url), publicDir, { recursive: true });
  const config = loadConfig({
    publicDir,
    dataDir,
    databasePath: path.join(dataDir, 'test.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'founder@example.com',
    adminPassword: 'secure-test-password',
    adminName: 'Founder',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  const server = http.createServer(createApp({ config, db }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, config };
}

test('the application code is revalidated, not held for an hour', async (t) => {
  const { origin } = await instance(t);
  const response = await fetch(`${origin}/app.js`);
  assert.equal(response.status, 200);
  // The bug this replaces: `max-age=3600` with nothing to validate against, on
  // a URL that never changes. A deploy that fixed what the signed-out page
  // shows could not reach a browser that had already loaded it.
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.ok(response.headers.get('etag'), 'app.js has no ETag to revalidate with');
});

test('an unchanged file comes back as 304 with no body', async (t) => {
  const { origin } = await instance(t);
  const first = await fetch(`${origin}/app.js`);
  const etag = first.headers.get('etag');
  await first.text();

  const second = await fetch(`${origin}/app.js`, { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 304);
  assert.equal(await second.text(), '');
  // Revalidating has to stay cheap, or the fix trades one problem for another.
  assert.equal(second.headers.get('etag'), etag);
});

test('a changed file gets a new ETag, so the next deploy lands', async (t) => {
  const { origin, config } = await instance(t);
  const first = await fetch(`${origin}/app.js`);
  const etag = first.headers.get('etag');
  await first.text();

  const target = path.join(config.publicDir, 'app.js');
  fs.appendFileSync(target, '\n// deployed\n');

  const second = await fetch(`${origin}/app.js`, { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 200);
  assert.notEqual(second.headers.get('etag'), etag);
  assert.match(await second.text(), /\/\/ deployed/);
});

test('index.html keeps revalidating too', async (t) => {
  const { origin } = await instance(t);
  const response = await fetch(`${origin}/`);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.ok(response.headers.get('etag'));
});
