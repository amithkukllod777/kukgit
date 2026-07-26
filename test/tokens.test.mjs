import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, seedCore } from '../src/db.mjs';
import {
  createPersonalAccessToken,
  listPersonalAccessTokens,
  normalizeTokenScopes,
  revokePersonalAccessToken,
  tokenHasScope,
  verifyPersonalAccessToken,
} from '../src/tokens.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-token-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const db = openDatabase({ databasePath: path.join(dataDir, 'test.db'), isProduction: false, adminEmail: 'founder@example.com', adminPassword: 'secure-test-password', adminName: 'Founder' });
  t.after(() => db.close());
  const seeded = seedCore(db, { isProduction: false, adminEmail: 'founder@example.com', adminPassword: 'secure-test-password', adminName: 'Founder' });
  return { db, userId: seeded.userId };
}

test('creates a hashed scoped personal access token and reveals plaintext once', (t) => {
  const { db, userId } = setup(t);
  const created = createPersonalAccessToken(db, userId, { name: 'Developer laptop', scopes: ['repo:read', 'repo:write'] });
  assert.match(created.token, /^kgp_[A-Za-z0-9_-]+$/);
  assert.deepEqual(created.scopes, ['repo:read', 'repo:write']);

  const stored = db.prepare('SELECT token_hash AS tokenHash, token_prefix AS tokenPrefix FROM personal_access_tokens WHERE id = ?').get(created.id);
  assert.notEqual(stored.tokenHash, created.token);
  assert.equal(stored.tokenPrefix, created.token.slice(0, 12));

  const verified = verifyPersonalAccessToken(db, created.token, 'repo:write');
  assert.equal(verified.userId, userId);
  assert.equal(verified.email, 'founder@example.com');
  assert.ok(db.prepare('SELECT last_used_at AS lastUsedAt FROM personal_access_tokens WHERE id = ?').get(created.id).lastUsedAt);
});

test('enforces scope hierarchy, expiry and revocation', (t) => {
  const { db, userId } = setup(t);
  const readOnly = createPersonalAccessToken(db, userId, { name: 'Read only', scopes: ['repo:read'] });
  assert.ok(verifyPersonalAccessToken(db, readOnly.token, 'repo:read'));
  assert.equal(verifyPersonalAccessToken(db, readOnly.token, 'repo:write'), null);

  const write = createPersonalAccessToken(db, userId, { name: 'Write token', scopes: ['repo:write'] });
  assert.ok(verifyPersonalAccessToken(db, write.token, 'repo:read'));
  assert.ok(tokenHasScope(['repo:write'], 'repo:read'));

  const revoked = revokePersonalAccessToken(db, userId, write.id);
  assert.ok(revoked.revokedAt);
  assert.equal(verifyPersonalAccessToken(db, write.token, 'repo:write'), null);
  assert.equal(listPersonalAccessTokens(db, userId).length, 2);
});

test('rejects invalid token configuration', (t) => {
  const { db, userId } = setup(t);
  assert.throws(() => normalizeTokenScopes(['admin']), /Unsupported/);
  assert.throws(() => createPersonalAccessToken(db, userId, { name: '', scopes: ['repo:read'] }), /name is required/i);
  assert.throws(() => createPersonalAccessToken(db, userId, { name: 'Expired', scopes: ['repo:read'], expiresAt: '2020-01-01T00:00:00Z' }), /future/);
});
