import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteExport, readSqliteExport } from '../src/database-portability.mjs';
import { runPostgresqlOfflineImport } from '../src/postgresql-offline-import.mjs';

class OfflineAdapter {
  constructor({ closeFailure = false } = {}) {
    this.tables = new Map();
    this.snapshot = null;
    this.rollbackCount = 0;
    this.commitCount = 0;
    this.closeFailure = closeFailure;
  }

  async connect() {
    return {
      database: 'kukgit_target',
      user: 'migration_user',
      serverVersionNumber: '170005',
      schema: 'kukgit_migration',
      sslMode: 'verify-full',
      databaseUrl: 'postgresql://***:***@db.example.com/kukgit',
    };
  }

  async close() {
    if (this.closeFailure) {
      const error = new Error('secret close details');
      error.code = 'POSTGRESQL_ADAPTER_CLOSE_FAILED';
      throw error;
    }
  }

  async listUserTables() { return [...this.tables.keys()].sort(); }
  async begin() { this.snapshot = structuredClone([...this.tables.entries()]); }
  async commit() { this.commitCount += 1; this.snapshot = null; }
  async rollback() { this.rollbackCount += 1; this.tables = new Map(structuredClone(this.snapshot || [])); this.snapshot = null; }

  async query(sql, values = []) {
    if (/^SET\s+LOCAL/i.test(sql.trim())) return;
    const create = sql.match(/^CREATE\s+TABLE\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/i);
    if (create) { this.tables.set(create[1] || create[2], []); return; }
    const insert = sql.match(/^INSERT\s+INTO\s+"([^"]+)"\s*\(([^)]+)\)\s+VALUES\s+/i);
    if (!insert) throw new Error('Unsupported fake SQL');
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-offline-pg-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE secrets (id TEXT PRIMARY KEY, payload TEXT NOT NULL, count INTEGER NOT NULL);');
  db.prepare('INSERT INTO secrets (id, payload, count) VALUES (?, ?, ?)')
    .run('secret_1', 'raw-private-value-never-in-artifacts', 42);
  const exportPath = path.join(directory, 'source.kgdb.json');
  createSqliteExport(db, exportPath);
  db.close();
  const source = readSqliteExport(exportPath);
  return {
    directory,
    exportPath,
    fingerprint: source.manifest.fingerprint,
    outputDirectory: path.join(directory, 'output'),
    adapterConfig: {
      databaseUrl: 'postgresql://migration:secret@db.example.com/kukgit',
      redactedDatabaseUrl: 'postgresql://***:***@db.example.com/kukgit',
      schema: 'kukgit_migration',
      sslMode: 'verify-full',
    },
  };
}

function factory(adapter) {
  return async () => adapter;
}

test('offline import requires explicit enablement, SQLite runtime and exact source confirmation', async (t) => {
  const value = fixture(t);
  await assert.rejects(() => runPostgresqlOfflineImport({
    ...value,
    confirmation: value.fingerprint,
    operator: 'support@kuklabs.com',
    enabled: false,
    adapterFactory: factory(new OfflineAdapter()),
  }), (error) => error.code === 'POSTGRESQL_IMPORT_NOT_ENABLED');

  await assert.rejects(() => runPostgresqlOfflineImport({
    ...value,
    confirmation: value.fingerprint,
    operator: 'support@kuklabs.com',
    enabled: true,
    runtimeDriver: 'postgresql',
    adapterFactory: factory(new OfflineAdapter()),
  }), (error) => error.code === 'POSTGRESQL_IMPORT_RUNTIME_DRIVER_INVALID');

  await assert.rejects(() => runPostgresqlOfflineImport({
    ...value,
    confirmation: 'wrong-fingerprint',
    operator: 'support@kuklabs.com',
    enabled: true,
    runtimeDriver: 'sqlite',
    adapterFactory: factory(new OfflineAdapter()),
  }), (error) => error.code === 'POSTGRESQL_IMPORT_CONFIRMATION_MISMATCH');
});

test('offline import commits verified data and writes only secret-free mode-0600 evidence', async (t) => {
  const value = fixture(t);
  const adapter = new OfflineAdapter();
  const result = await runPostgresqlOfflineImport({
    ...value,
    confirmation: value.fingerprint,
    operator: 'support@kuklabs.com',
    enabled: true,
    runtimeDriver: 'sqlite',
    adapterFactory: factory(adapter),
    batchSize: 1,
  });
  assert.equal(result.status, 'committed');
  assert.equal(adapter.commitCount, 1);
  assert.equal(adapter.rollbackCount, 0);
  assert.equal(result.warnings.length, 0);
  for (const target of Object.values(result.artifacts).filter(Boolean)) {
    const stat = fs.statSync(target);
    assert.equal(stat.mode & 0o777, 0o600);
    const content = fs.readFileSync(target, 'utf8');
    assert.equal(content.includes('raw-private-value-never-in-artifacts'), false);
    assert.equal(content.includes('migration:secret'), false);
  }
  const state = JSON.parse(fs.readFileSync(result.artifacts.statePath, 'utf8'));
  assert.equal(state.status, 'committed');
  assert.equal(state.progress.phase, 'complete');
});

test('pre-commit progress persistence failure rolls back and never writes a committed result', async (t) => {
  const value = fixture(t);
  const adapter = new OfflineAdapter();
  await assert.rejects(() => runPostgresqlOfflineImport({
    ...value,
    confirmation: value.fingerprint,
    operator: 'support@kuklabs.com',
    enabled: true,
    runtimeDriver: 'sqlite',
    adapterFactory: factory(adapter),
    onProgress: async (event) => {
      if (event.phase === 'batch_inserted') throw new Error('External progress sink unavailable');
    },
  }), /External progress sink unavailable/);
  assert.equal(adapter.rollbackCount, 1);
  assert.equal(adapter.commitCount, 0);
  const state = JSON.parse(fs.readFileSync(path.join(value.outputDirectory, 'postgresql-offline-import-state.json'), 'utf8'));
  assert.notEqual(state.status, 'committed');
});

test('connection close failure after commit is returned as a warning, not a false import failure', async (t) => {
  const value = fixture(t);
  const adapter = new OfflineAdapter({ closeFailure: true });
  const result = await runPostgresqlOfflineImport({
    ...value,
    confirmation: value.fingerprint,
    operator: 'support@kuklabs.com',
    enabled: true,
    runtimeDriver: 'sqlite',
    adapterFactory: factory(adapter),
  });
  assert.equal(result.status, 'committed');
  assert.equal(adapter.commitCount, 1);
  assert.ok(result.warnings.some((warning) => warning.artifact === 'connection_close'));
  assert.equal(JSON.stringify(result).includes('secret close details'), false);
});
