import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPostgresqlSchemaPlan,
  translateSqliteCreateTable,
} from '../src/postgresql-import-plan.mjs';

test('text timestamp defaults are explicitly cast for PostgreSQL', () => {
  const translated = translateSqliteCreateTable(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  assert.match(translated, /TEXT NOT NULL DEFAULT \(CURRENT_TIMESTAMP::text\)/);
});

test('PostgreSQL planner rejects identifiers that PostgreSQL would truncate or treat as unsafe', () => {
  const longName = `table_${'x'.repeat(64)}`;
  const manifest = {
    engine: 'sqlite',
    fingerprint: 'source',
    tables: [{
      name: longName,
      schema: `CREATE TABLE ${longName} (id TEXT PRIMARY KEY)`,
      schemaChecksum: 'schema',
      columns: [{ name: 'id' }],
      rowCount: 0,
      rowChecksum: 'rows',
    }],
  };
  assert.throws(() => buildPostgresqlSchemaPlan(manifest), /63-byte limit/i);
});
