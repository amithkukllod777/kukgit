import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit, openDatabase, seedCore, uid } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import {
  ensureSqliteRuntimeWriteMigrations,
  runtimeWriteMigrationDefinition,
} from '../src/runtime-write-migrations.mjs';
import {
  runtimeWriteServiceFor,
  runRuntimeWrite,
} from '../src/runtime-write-service.mjs';
import { runtimeWriteCatalog, runtimeWriteSpec } from '../src/runtime-write-catalog.mjs';
import {
  inventoryRuntimeWriteSurface,
  safeRuntimeWriteSurfaceReport,
} from '../src/runtime-write-surface.mjs';

function setup(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-runtime-write-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Repository Owner',
    ...overrides,
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  const seeded = seedCore(db, config);
  return { config, db, ...seeded };
}

test('runtime write catalog compiles portable audit insert SQL', () => {
  const catalog = runtimeWriteCatalog();
  assert.equal(catalog.length, 1);
  const spec = runtimeWriteSpec('audit_logs.insert');
  assert.equal(spec.risk, 'append_only');
  assert.match(spec.sqliteSql, /^INSERT INTO audit_logs/i);
  assert.match(spec.postgresqlSql, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7\)/);
  assert.equal(spec.parameters.length, 7);
});

test('SQLite migration history is idempotent and checksum verified', (t) => {
  const { db } = setup(t);
  const first = ensureSqliteRuntimeWriteMigrations(db);
  const second = ensureSqliteRuntimeWriteMigrations(db);
  const definition = runtimeWriteMigrationDefinition();
  assert.deepEqual(first, second);
  assert.equal(first.ready, true);
  assert.equal(first.currentVersion, definition.version);
  assert.equal(first.checksum, definition.checksum);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM kukgit_schema_migrations').get().count, 1);

  db.prepare('UPDATE kukgit_schema_migrations SET checksum = ? WHERE version = ?').run('0'.repeat(64), definition.version);
  assert.throws(
    () => ensureSqliteRuntimeWriteMigrations(db),
    (error) => error.code === 'RUNTIME_WRITE_MIGRATION_CHECKSUM_MISMATCH',
  );
});

test('audit writes preserve the existing synchronous API through the registered service', (t) => {
  const { db, userId, orgId } = setup(t);
  const service = runtimeWriteServiceFor(db);
  assert.equal(service?.backend, 'sqlite');
  const auditId = audit(db, {
    organizationId: orgId,
    userId,
    action: 'test.runtime_write',
    targetType: 'repository',
    targetId: 'repo_example',
    metadata: { safe: true },
  });
  const row = db.prepare(`
    SELECT id, organization_id AS organizationId, user_id AS userId, action,
      target_type AS targetType, target_id AS targetId, metadata_json AS metadataJson
    FROM audit_logs WHERE id = ?
  `).get(auditId);
  // `node:sqlite` returns rows with a null prototype, which strict deep equality
  // compares. Spreading gives an ordinary object so the assertion is about the
  // columns rather than the row's prototype.
  assert.deepEqual({ ...row }, {
    id: auditId,
    organizationId: orgId,
    userId,
    action: 'test.runtime_write',
    targetType: 'repository',
    targetId: 'repo_example',
    metadataJson: '{"safe":true}',
  });
  assert.equal(service.status().metrics.writes, 1);
});

test('disabled rollout flag preserves direct SQLite audit behavior and schema', (t) => {
  const { db, userId, orgId, config } = setup(t, { runtimeWriteServiceEnabled: false });
  assert.equal(config.runtimeWriteServiceEnabled, false);
  assert.equal(runtimeWriteServiceFor(db), null);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name = 'kukgit_schema_migrations'
  `).get().count, 0);
  const id = audit(db, {
    organizationId: orgId,
    userId,
    action: 'test.direct_fallback',
    targetType: 'database',
    targetId: 'sqlite',
  });
  assert.equal(db.prepare('SELECT action FROM audit_logs WHERE id = ?').get(id).action, 'test.direct_fallback');
});

test('SQLite runtime write transaction commits atomically', (t) => {
  const { db, userId, orgId } = setup(t);
  const service = runtimeWriteServiceFor(db);
  const ids = [uid('aud'), uid('aud')];
  const result = service.transaction((tx) => {
    tx.write('audit_logs.insert', [ids[0], orgId, userId, 'test.first', 'test', 'one', '{}']);
    tx.write('audit_logs.insert', [ids[1], orgId, userId, 'test.second', 'test', 'two', '{}']);
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs WHERE id IN (?, ?)').get(...ids).count, 2);
  assert.equal(service.status().metrics.transactions, 1);
});

test('SQLite runtime write transaction rolls back every write on failure', (t) => {
  const { db, userId, orgId } = setup(t);
  const service = runtimeWriteServiceFor(db);
  const id = uid('aud');
  assert.throws(() => service.transaction((tx) => {
    tx.write('audit_logs.insert', [id, orgId, userId, 'test.rollback', 'test', 'rollback', '{}']);
    throw new Error('force rollback');
  }), /Runtime metadata write failed/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs WHERE id = ?').get(id).count, 0);
  assert.equal(service.status().metrics.rollbacks, 1);
});

test('SQLite runtime write normalizes unique and foreign-key failures', (t) => {
  const { db, userId, orgId } = setup(t);
  const id = uid('aud');
  runRuntimeWrite(db, 'audit_logs.insert', [id, orgId, userId, 'test.first', 'test', null, '{}']);
  assert.throws(
    () => runRuntimeWrite(db, 'audit_logs.insert', [id, orgId, userId, 'test.duplicate', 'test', null, '{}']),
    (error) => error.code === 'RUNTIME_WRITE_CONFLICT' && error.backend === 'sqlite',
  );
  assert.throws(
    () => runRuntimeWrite(db, 'audit_logs.insert', [uid('aud'), 'org_missing', 'usr_missing', 'test.fk', 'test', null, '{}']),
    (error) => error.code === 'RUNTIME_WRITE_FOREIGN_KEY' && error.backend === 'sqlite',
  );
});

test('SQLite runtime write rejects cancellation and undefined parameters', (t) => {
  const { db, userId, orgId } = setup(t);
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => runRuntimeWrite(db, 'audit_logs.insert', [uid('aud'), orgId, userId, 'cancelled', 'test', null, '{}'], { signal: controller.signal }),
    (error) => error.code === 'RUNTIME_WRITE_CANCELLED',
  );
  assert.throws(
    () => runRuntimeWrite(db, 'audit_logs.insert', [uid('aud'), orgId, userId, undefined, 'test', null, '{}']),
    /parameter action is undefined/,
  );
});

test('write-surface report classifies writes without exposing SQL text', () => {
  const root = path.resolve('src');
  const report = inventoryRuntimeWriteSurface(root);
  assert.equal(report.format, 'kukgit-runtime-write-surface/1');
  assert.ok(report.counts.writes > 0);
  assert.ok(report.counts.transactions > 0);
  assert.ok(report.counts.managed > 0);
  assert.equal(report.fingerprint.length, 64);
  assert.ok(report.calls.some((call) => call.table === 'audit_logs' && call.risk === 'append_only' && call.managed));
  const safe = safeRuntimeWriteSurfaceReport(report);
  assert.equal(safe.calls.some((call) => 'sqlPreview' in call), false);
  assert.equal(safe.calls.some((call) => 'root' in call), false);
});
