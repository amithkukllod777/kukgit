import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';
import {
  compareRuntimeReadResults,
  runPostgresqlRuntimeRead,
  verifyPostgresqlShadowReads,
} from '../src/postgresql-shadow-read.mjs';
import { runtimeReadSpec } from '../src/runtime-read-catalog.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-shadow-read-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  const seeded = seedCore(db, config);
  return { db, config, ...seeded };
}

test('canonical comparison normalizes dates, bigint and object key order', () => {
  const spec = { id: 'test.one', mode: 'one' };
  const left = { b: 2n, at: new Date('2026-07-27T12:00:00.000Z'), a: 1 };
  const right = { a: 1, at: new Date('2026-07-27T12:00:00.000Z'), b: 2 };
  const comparison = compareRuntimeReadResults(spec, left, right);
  assert.equal(comparison.valid, true);
  assert.match(comparison.sourceFingerprint, /^[0-9a-f]{64}$/);
});

test('shadow verifier reports matched authoritative SQLite reads', async (t) => {
  const { db, userId } = setup(t);
  const expected = db.prepare(`
    SELECT o.id, o.slug, o.name, o.plan, om.role
    FROM organizations o JOIN org_members om ON om.organization_id = o.id
    WHERE o.slug = ? AND om.user_id = ?
  `).get('kuklabs', userId);
  const reader = { query: async () => ({ rows: [expected] }) };
  const report = await verifyPostgresqlShadowReads({
    sqlite: db,
    postgresql: reader,
    ids: ['organizations.access_by_slug_and_user'],
    sampleLimit: 5,
    readTimeoutMs: 1000,
  });
  assert.equal(report.status, 'verified');
  assert.equal(report.summary.matched, 1);
  assert.equal(report.summary.samples, 1);
  assert.equal(report.checks[0].samples[0].status, 'matched');
});

test('mismatch evidence contains fingerprints but no sampled values or secrets', async (t) => {
  const { db } = setup(t);
  const reader = {
    query: async (_sql, values) => ({
      rows: [{
        id: 'different',
        email: values[0],
        displayName: 'Mismatch',
        passwordHash: 'must-not-appear',
      }],
    }),
  };
  const report = await verifyPostgresqlShadowReads({
    sqlite: db,
    postgresql: reader,
    ids: ['auth.user_core_by_email'],
    sampleLimit: 2,
    readTimeoutMs: 1000,
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.summary.mismatches, 1);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('owner@example.com'), false);
  assert.equal(serialized.includes('must-not-appear'), false);
  assert.equal(serialized.includes('secure-owner-password'), false);
  assert.match(report.checks[0].samples[0].sourceFingerprint, /^[0-9a-f]{64}$/);
});

test('PostgreSQL read timeout and parameter mismatch fail visibly', async () => {
  const spec = runtimeReadSpec('auth.user_core_by_email');
  await assert.rejects(
    () => runPostgresqlRuntimeRead({ query: () => new Promise(() => {}) }, spec, ['a@example.com'], { timeoutMs: 100 }),
    (error) => error.code === 'POSTGRESQL_SHADOW_READ_TIMEOUT',
  );
  await assert.rejects(
    () => runPostgresqlRuntimeRead({ query: async () => ({ rows: [] }) }, spec, [], { timeoutMs: 100 }),
    /parameter count mismatch/i,
  );
});

test('shadow verification cancellation and unknown operations fail closed', async (t) => {
  const { db } = setup(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => verifyPostgresqlShadowReads({
      sqlite: db,
      postgresql: { query: async () => ({ rows: [] }) },
      ids: ['auth.user_core_by_email'],
      signal: controller.signal,
    }),
    (error) => error.code === 'POSTGRESQL_SHADOW_CANCELLED',
  );
  await assert.rejects(
    () => verifyPostgresqlShadowReads({
      sqlite: db,
      postgresql: { query: async () => ({ rows: [] }) },
      ids: ['missing.operation'],
    }),
    /unknown runtime read catalog/i,
  );
});
