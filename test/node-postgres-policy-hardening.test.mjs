import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNodePostgresAdapter,
  loadNodePostgresAdapterConfig,
} from '../src/node-postgres-adapter.mjs';

const base = {
  databaseUrl: 'postgresql://migration:secret@db.example.com/kukgit',
  schema: 'kukgit_migration',
};

test('connection URL cannot override KukGit PostgreSQL session or timeout policy', () => {
  for (const parameter of [
    'options=-c%20search_path%3Dpublic',
    'application_name=spoofed',
    'connect_timeout=0',
    'statement_timeout=0',
    'lock_timeout=0',
    'target_session_attrs=read-write',
  ]) {
    assert.throws(() => loadNodePostgresAdapterConfig({
      ...base,
      databaseUrl: `${base.databaseUrl}?${parameter}`,
    }), /must not contain/i);
  }
});

test('schema inventory includes views, sequences and partitioned relations', async () => {
  class RelationClient {
    async connect() {}
    async end() {}
    async query(sql) {
      if (sql.includes('information_schema.schemata')) return { rows: [{ exists: true, can_use: true, can_create: true }] };
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes("current_setting('server_version_num')")) {
        return { rows: [{ database: 'kukgit', user: 'migration', server_version_num: '170005' }] };
      }
      if (sql.includes('information_schema.tables')) return { rows: [{ name: 'existing_table' }] };
      if (sql.includes('pg_catalog.pg_class')) {
        return { rows: [{ name: 'existing_view' }, { name: 'existing_sequence' }, { name: 'existing_partitioned' }] };
      }
      return { rows: [] };
    }
  }

  const adapter = await createNodePostgresAdapter(base, { pgModule: { Client: RelationClient } });
  await adapter.connect();
  assert.deepEqual(await adapter.listUserTables(), [
    'existing_partitioned',
    'existing_sequence',
    'existing_table',
    'existing_view',
  ]);
  await adapter.close();
});
