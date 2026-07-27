import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteExport, readSqliteExport } from '../src/database-portability.mjs';
import { buildPostgresqlImportPlan } from '../src/postgresql-import-plan.mjs';
import {
  collectPostgresqlTargetSnapshot,
  executePostgresqlImport,
} from '../src/postgresql-executor.mjs';

class FakePostgresqlAdapter {
  constructor({ existingTables = {}, failQueryAt = null } = {}) {
    this.tables = new Map(Object.entries(existingTables).map(([name, rows]) => [name, structuredClone(rows)]));
    this.failQueryAt = failQueryAt;
    this.queryCount = 0;
    this.beginCount = 0;
    this.commitCount = 0;
    this.rollbackCount = 0;
    this.snapshot = null;
    this.queries = [];
  }

  async listUserTables() {
    return [...this.tables.keys()].sort();
  }

  async begin() {
    this.beginCount += 1;
    this.snapshot = structuredClone([...this.tables.entries()]);
  }

  async query(sql, values = []) {
    this.queryCount += 1;
    this.queries.push({ sql, valueCount: values.length });
    if (this.failQueryAt === this.queryCount) {
      const error = new Error('Injected database failure');
      error.code = 'FAKE_QUERY_FAILURE';
      throw error;
    }
    if (/^SET\s+LOCAL/i.test(sql.trim())) return { rowCount: 0 };
    const create = sql.match(/^CREATE\s+TABLE\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/i);
    if (create) {
      const name = create[1] || create[2];
      if (this.tables.has(name)) throw new Error(`Table already exists: ${name}`);
      this.tables.set(name, []);
      return { rowCount: 0 };
    }
    const insert = sql.match(/^INSERT\s+INTO\s+"([^"]+)"\s*\(([^)]+)\)\s+VALUES\s+/i);
    if (insert) {
      const name = insert[1];
      const columns = [...insert[2].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      if (!this.tables.has(name) || !columns.length || values.length % columns.length !== 0) {
        throw new Error('Invalid fake INSERT operation');
      }
      const rows = this.tables.get(name);
      for (let offset = 0; offset < values.length; offset += columns.length) {
        rows.push(Object.fromEntries(columns.map((column, index) => [column, values[offset + index]])));
      }
      return { rowCount: values.length / columns.length };
    }
    throw new Error(`Unsupported fake query: ${sql.slice(0, 80)}`);
  }

  async commit() {
    this.commitCount += 1;
    this.snapshot = null;
  }

  async rollback() {
    this.rollbackCount += 1;
    this.tables = new Map(structuredClone(this.snapshot || []));
    this.snapshot = null;
  }

  async *scanTable(name, columns, { batchSize = 1000 } = {}) {
    const rows = this.tables.get(name) || [];
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      yield rows.slice(offset, offset + batchSize).map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
    }
  }
}

function fixture(t, { batchSize = 1 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-pg-executor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE repositories (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      payload BLOB
    );
  `);
  db.prepare('INSERT INTO organizations (id, name) VALUES (?, ?)').run('org_1', 'Kuklabs');
  db.prepare('INSERT INTO organizations (id, name) VALUES (?, ?)').run('org_2', 'कुकलैब्स');
  db.prepare('INSERT INTO repositories (id, organization_id, name, payload) VALUES (?, ?, ?, ?)')
    .run('repo_1', 'org_1', 'KukGit', Buffer.from('private-binary'));
  const exportPath = path.join(directory, 'metadata.kgdb.json');
  createSqliteExport(db, exportPath);
  const exportResult = readSqliteExport(exportPath);
  const importPlan = buildPostgresqlImportPlan(exportResult, { batchSize });
  return { exportResult, importPlan };
}

test('executor creates schema, inserts rows, verifies target and commits atomically', async (t) => {
  const { exportResult, importPlan } = fixture(t);
  const adapter = new FakePostgresqlAdapter();
  const events = [];
  const result = await executePostgresqlImport({
    adapter,
    importPlan,
    sourceManifest: exportResult.manifest,
    onProgress: async (event) => events.push(event),
  });
  assert.equal(result.status, 'committed');
  assert.equal(adapter.beginCount, 1);
  assert.equal(adapter.commitCount, 1);
  assert.equal(adapter.rollbackCount, 0);
  assert.deepEqual(await adapter.listUserTables(), ['organizations', 'repositories']);
  assert.equal(result.targetSnapshot.totalRows, 3);
  assert.match(result.reportChecksum, /^[0-9a-f]{64}$/);
  assert.equal(events.at(-1).phase, 'committed');
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes('private-binary'), false);
  assert.equal(serializedEvents.includes('values'), false);
});

test('executor rejects a non-empty target before opening a transaction', async (t) => {
  const { exportResult, importPlan } = fixture(t);
  const adapter = new FakePostgresqlAdapter({ existingTables: { legacy: [] } });
  await assert.rejects(() => executePostgresqlImport({
    adapter,
    importPlan,
    sourceManifest: exportResult.manifest,
  }), (error) => error.code === 'POSTGRESQL_IMPORT_TARGET_NOT_EMPTY');
  assert.equal(adapter.beginCount, 0);
  assert.equal(adapter.rollbackCount, 0);
});

test('database failure rolls back every schema and row change', async (t) => {
  const { exportResult, importPlan } = fixture(t);
  const adapter = new FakePostgresqlAdapter({ failQueryAt: 4 });
  await assert.rejects(() => executePostgresqlImport({
    adapter,
    importPlan,
    sourceManifest: exportResult.manifest,
  }), /Injected database failure/);
  assert.equal(adapter.commitCount, 0);
  assert.equal(adapter.rollbackCount, 1);
  assert.deepEqual(await adapter.listUserTables(), []);
});

test('cancellation and progress checkpoint failures both roll back', async (t) => {
  const first = fixture(t);
  const cancellationAdapter = new FakePostgresqlAdapter();
  const controller = new AbortController();
  await assert.rejects(() => executePostgresqlImport({
    adapter: cancellationAdapter,
    importPlan: first.importPlan,
    sourceManifest: first.exportResult.manifest,
    signal: controller.signal,
    onProgress: async (event) => {
      if (event.phase === 'batch_inserted') controller.abort();
    },
  }), (error) => error.code === 'POSTGRESQL_IMPORT_CANCELLED');
  assert.equal(cancellationAdapter.rollbackCount, 1);
  assert.deepEqual(await cancellationAdapter.listUserTables(), []);

  const second = fixture(t);
  const checkpointAdapter = new FakePostgresqlAdapter();
  await assert.rejects(() => executePostgresqlImport({
    adapter: checkpointAdapter,
    importPlan: second.importPlan,
    sourceManifest: second.exportResult.manifest,
    onProgress: async (event) => {
      if (event.phase === 'table_created') throw new Error('Checkpoint storage unavailable');
    },
  }), /Checkpoint storage unavailable/);
  assert.equal(checkpointAdapter.rollbackCount, 1);
  assert.deepEqual(await checkpointAdapter.listUserTables(), []);
});

test('parameter safety limit is enforced inside the transaction and rolls back', async (t) => {
  const { exportResult, importPlan } = fixture(t);
  const adapter = new FakePostgresqlAdapter();
  await assert.rejects(() => executePostgresqlImport({
    adapter,
    importPlan,
    sourceManifest: exportResult.manifest,
    maxParameters: 1,
  }), (error) => error.code === 'POSTGRESQL_IMPORT_PARAMETER_LIMIT');
  assert.equal(adapter.rollbackCount, 1);
  assert.deepEqual(await adapter.listUserTables(), []);
});

test('target collector produces source-equivalent checksums independent of scan order', async (t) => {
  const { exportResult } = fixture(t);
  const tables = Object.fromEntries(exportResult.bundle.tables.map((table) => [table.name, [...table.rows].reverse()]));
  const adapter = new FakePostgresqlAdapter({ existingTables: tables });
  const snapshot = await collectPostgresqlTargetSnapshot({
    adapter,
    sourceManifest: exportResult.manifest,
    scanBatchSize: 1,
  });
  assert.equal(snapshot.engine, 'postgresql');
  assert.equal(snapshot.sourceFingerprint, exportResult.manifest.fingerprint);
  for (const sourceTable of exportResult.manifest.tables) {
    const targetTable = snapshot.tables.find((table) => table.name === sourceTable.name);
    assert.equal(targetTable.rowCount, sourceTable.rowCount);
    assert.equal(targetTable.rowChecksum, sourceTable.rowChecksum);
  }
});
