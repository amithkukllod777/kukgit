import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteExport, readSqliteExport } from '../src/database-portability.mjs';
import { buildPostgresqlImportPlan } from '../src/postgresql-import-plan.mjs';
import { collectPostgresqlTargetSnapshot, executePostgresqlImport } from '../src/postgresql-executor.mjs';

class MemoryAdapter {
  constructor({ failQueryAt = null } = {}) {
    this.tables = new Map();
    this.snapshot = null;
    this.queryCount = 0;
    this.failQueryAt = failQueryAt;
    this.commitCount = 0;
    this.rollbackCount = 0;
  }

  async listUserTables() { return [...this.tables.keys()].sort(); }
  async begin() { this.snapshot = structuredClone([...this.tables.entries()]); }
  async commit() { this.commitCount += 1; this.snapshot = null; }
  async rollback() { this.rollbackCount += 1; this.tables = new Map(structuredClone(this.snapshot || [])); this.snapshot = null; }

  async query(sql, values = []) {
    this.queryCount += 1;
    if (this.queryCount === this.failQueryAt) throw new Error('Injected query failure');
    if (/^SET\s+LOCAL/i.test(sql.trim())) return;
    const create = sql.match(/^CREATE\s+TABLE\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/i);
    if (create) { this.tables.set(create[1] || create[2], []); return; }
    const insert = sql.match(/^INSERT\s+INTO\s+"([^"]+)"\s*\(([^)]+)\)\s+VALUES\s+/i);
    if (!insert) throw new Error('Unsupported SQL');
    const columns = [...insert[2].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    const rows = this.tables.get(insert[1]);
    for (let offset = 0; offset < values.length; offset += columns.length) {
      rows.push(Object.fromEntries(columns.map((column, index) => [column, values[offset + index]])));
    }
  }

  async *scanTable(name, columns) {
    yield (this.tables.get(name) || []).map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
  }
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-pg-executor-hardening-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE counters (id TEXT PRIMARY KEY, value INTEGER NOT NULL);');
  db.prepare('INSERT INTO counters (id, value) VALUES (?, ?)').run('count_1', 42);
  const target = path.join(directory, 'metadata.kgdb.json');
  createSqliteExport(db, target);
  const exportResult = readSqliteExport(target);
  return { exportResult, importPlan: buildPostgresqlImportPlan(exportResult, { batchSize: 1 }) };
}

test('a post-commit progress callback failure cannot turn a committed import into failure', async (t) => {
  const { exportResult, importPlan } = fixture(t);
  const adapter = new MemoryAdapter();
  const result = await executePostgresqlImport({
    adapter,
    importPlan,
    sourceManifest: exportResult.manifest,
    onProgress: async (event) => {
      if (event.phase === 'committed') {
        const error = new Error('Progress sink unavailable after commit');
        error.code = 'PROGRESS_SINK_DOWN';
        throw error;
      }
    },
  });
  assert.equal(result.status, 'committed');
  assert.equal(adapter.commitCount, 1);
  assert.equal(adapter.rollbackCount, 0);
  assert.equal(result.progressWarning.code, 'PROGRESS_SINK_DOWN');
});

test('a rolled-back progress callback failure does not claim that rollback failed', async (t) => {
  const { exportResult, importPlan } = fixture(t);
  const adapter = new MemoryAdapter({ failQueryAt: 3 });
  let thrown;
  try {
    await executePostgresqlImport({
      adapter,
      importPlan,
      sourceManifest: exportResult.manifest,
      onProgress: async (event) => {
        if (event.phase === 'rolled_back') throw new Error('Rollback event sink unavailable');
      },
    });
  } catch (error) {
    thrown = error;
  }
  assert.match(thrown.message, /Injected query failure/);
  assert.equal(thrown.rollbackFailed, undefined);
  assert.equal(adapter.rollbackCount, 1);
  assert.deepEqual(await adapter.listUserTables(), []);
});

test('executor rejects multi-statement schema and insert SQL and rolls back', async (t) => {
  const first = fixture(t);
  first.importPlan.schemaPlan.tables[0].ddl += ' DROP TABLE counters;';
  const schemaAdapter = new MemoryAdapter();
  await assert.rejects(() => executePostgresqlImport({
    adapter: schemaAdapter,
    importPlan: first.importPlan,
    sourceManifest: first.exportResult.manifest,
  }), (error) => error.code === 'POSTGRESQL_SCHEMA_PLAN_INVALID');
  assert.equal(schemaAdapter.rollbackCount, 1);

  const second = fixture(t);
  second.importPlan.operations[0].sql += ' DROP TABLE counters;';
  const insertAdapter = new MemoryAdapter();
  await assert.rejects(() => executePostgresqlImport({
    adapter: insertAdapter,
    importPlan: second.importPlan,
    sourceManifest: second.exportResult.manifest,
  }), (error) => error.code === 'POSTGRESQL_IMPORT_SQL_REJECTED');
  assert.equal(insertAdapter.rollbackCount, 1);
});

test('target collector normalizes PostgreSQL BIGINT strings to SQLite integer checksums', async (t) => {
  const { exportResult } = fixture(t);
  const adapter = {
    async listUserTables() { return ['counters']; },
    async *scanTable() { yield [{ id: 'count_1', value: '42' }]; },
  };
  const snapshot = await collectPostgresqlTargetSnapshot({ adapter, sourceManifest: exportResult.manifest });
  assert.equal(snapshot.tables[0].rowCount, 1);
  assert.equal(snapshot.tables[0].rowChecksum, exportResult.manifest.tables[0].rowChecksum);
});
