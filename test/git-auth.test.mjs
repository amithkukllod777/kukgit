import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, seedCore } from '../src/db.mjs';
import { authorizeGitCredential } from '../src/git-http.mjs';
import { createPersonalAccessToken } from '../src/tokens.mjs';

test('authorizes Git operations with scope and organization role checks', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-git-auth-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = { databasePath: path.join(dataDir, 'test.db'), isProduction: true, gitToken: 'legacy-disabled' };
  const db = openDatabase(config);
  t.after(() => db.close());
  const { userId } = seedCore(db, { isProduction: false, adminEmail: 'founder@example.com', adminPassword: 'secure-test-password', adminName: 'Founder' });

  const read = createPersonalAccessToken(db, userId, { name: 'Read', scopes: ['repo:read'] });
  assert.ok(authorizeGitCredential(db, config, { credential: read.token, orgSlug: 'kuklabs', isPush: false }));
  assert.equal(authorizeGitCredential(db, config, { credential: read.token, orgSlug: 'kuklabs', isPush: true }), null);

  const write = createPersonalAccessToken(db, userId, { name: 'Write', scopes: ['repo:write'] });
  const authorized = authorizeGitCredential(db, config, { credential: write.token, orgSlug: 'kuklabs', isPush: true });
  assert.equal(authorized.userId, userId);
  assert.equal(authorized.authType, 'personal-access-token');
  assert.equal(authorizeGitCredential(db, config, { credential: write.token, orgSlug: 'other-org', isPush: false }), null);
});

test('legacy server token is accepted only outside production', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-legacy-token-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const db = openDatabase({ databasePath: path.join(dataDir, 'test.db') });
  t.after(() => db.close());
  assert.ok(authorizeGitCredential(db, { isProduction: false, gitToken: 'dev-token' }, { credential: 'dev-token', orgSlug: 'kuklabs', isPush: true }));
  assert.equal(authorizeGitCredential(db, { isProduction: true, gitToken: 'dev-token' }, { credential: 'dev-token', orgSlug: 'kuklabs', isPush: true }), null);
});
