import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildSqliteManifest,
  createSqliteExport,
  readSqliteExport,
} from '../src/database-portability.mjs';
import {
  buildPostgresqlImportPlan,
  buildPostgresqlSchemaPlan,
  createPostgresqlImportReceipt,
  renderPostgresqlSchemaSql,
  safePostgresqlImportPlan,
  translateSqliteCreateTable,
  verifyPostgresqlTargetSnapshot,
} from '../src/postgresql-import-plan.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-pg-plan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE parents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE children (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      payload BLOB
    );
  `);
  db.prepare('INSERT INTO parents (id, name) VALUES (?, ?)').run('parent_1', 'Kuklabs');
  db.prepare('INSERT INTO parents (id, name) VALUES (?, ?)').run('parent_2', 'KukBook');
  db.prepare('INSERT INTO children (id, parent_id, enabled, payload) VALUES (?, ?, ?, ?)')
    .run('child_1', 'parent_1', 1, Buffer.from('private-metadata'));
  const target = path.join(directory, 'metadata.kgdb.json');
  const created = createSqliteExport(db, target);
  const exportResult = readSqliteExport(target);
  return { directory, db, created, exportResult };
}

test('PostgreSQL schema plan translates types and orders foreign-key dependencies', (t) => {
  const { exportResult } = fixture(t);
  const plan = buildPostgresqlSchemaPlan(exportResult.manifest);
  assert.equal(plan.tables[0].name, 'parents');
  assert.equal(plan.tables[1].name, 'children');
  const child = plan.tables.find((table) => table.name === 'children');
  assert.match(child.ddl, /BIGINT/);
  assert.match(child.ddl, /BYTEA/);
  assert.match(child.ddl, /REFERENCES parents/);
  assert.equal(child.ddl.includes('AUTOINCREMENT'), false);
  const sql = renderPostgresqlSchemaSql(plan);
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /SET LOCAL TIME ZONE 'UTC'/);
  assert.match(sql, /COMMIT;\n$/);
});

test('PostgreSQL import plan uses parameterized batches and safe summaries omit row values', (t) => {
  const { exportResult } = fixture(t);
  const plan = buildPostgresqlImportPlan(exportResult, { batchSize: 1 });
  assert.equal(plan.totalRows, 3);
  assert.equal(plan.operationCount, 3);
  assert.equal(plan.operations[0].table, 'parents');
  assert.match(plan.operations[0].sql, /\$1/);
  assert.ok(plan.operations.some((operation) => operation.values.some((value) => Buffer.isBuffer(value))));
  const safe = safePostgresqlImportPlan(plan);
  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes('private-metadata'), false);
  assert.equal(serialized.includes('values'), false);
  assert.equal(safe.operations.length, plan.operations.length);
  assert.ok(safe.operations.every((operation) => /^[0-9a-f]{64}$/.test(operation.sqlChecksum)));
});

test('target snapshot verification detects missing rows and creates a secret-free receipt only after success', (t) => {
  const { exportResult } = fixture(t);
  const plan = buildPostgresqlImportPlan(exportResult);
  const target = {
    engine: 'postgresql',
    tables: exportResult.manifest.tables.map((table) => ({
      name: table.name,
      rowCount: table.rowCount,
      rowChecksum: table.rowChecksum,
    })),
  };
  const verified = verifyPostgresqlTargetSnapshot(exportResult.manifest, target);
  assert.equal(verified.valid, true);
  const receipt = createPostgresqlImportReceipt({
    sourceManifest: exportResult.manifest,
    importPlan: plan,
    targetSnapshot: target,
    operator: 'support@kuklabs.com',
  });
  assert.equal(receipt.status, 'verified');
  assert.equal(JSON.stringify(receipt).includes('private-metadata'), false);
  assert.match(receipt.receiptChecksum, /^[0-9a-f]{64}$/);

  target.tables[0].rowCount += 1;
  const failed = verifyPostgresqlTargetSnapshot(exportResult.manifest, target);
  assert.equal(failed.valid, false);
  assert.ok(failed.differences.some((difference) => difference.type === 'row_count'));
  assert.throws(() => createPostgresqlImportReceipt({
    sourceManifest: exportResult.manifest,
    importPlan: plan,
    targetSnapshot: target,
  }), /verification failed/i);
});

test('schema planner fails closed for unsupported SQLite SQL and dependency cycles', () => {
  assert.throws(() => translateSqliteCreateTable("CREATE TABLE sample (created TEXT DEFAULT (strftime('%s','now')));"), /SQLite-specific SQL remains/i);
  const manifest = {
    engine: 'sqlite',
    fingerprint: 'source',
    tables: [
      { name: 'alpha', schema: 'CREATE TABLE alpha (id TEXT PRIMARY KEY, beta_id TEXT REFERENCES beta(id))', schemaChecksum: 'a', columns: [{ name: 'id' }], rowCount: 0, rowChecksum: 'a' },
      { name: 'beta', schema: 'CREATE TABLE beta (id TEXT PRIMARY KEY, alpha_id TEXT REFERENCES alpha(id))', schemaChecksum: 'b', columns: [{ name: 'id' }], rowCount: 0, rowChecksum: 'b' },
    ],
  };
  assert.throws(() => buildPostgresqlSchemaPlan(manifest), /dependency cycle/i);
});

test('source manifest remains deterministic for the fixture', (t) => {
  const { db, exportResult } = fixture(t);
  assert.equal(buildSqliteManifest(db).fingerprint, exportResult.manifest.fingerprint);
});
