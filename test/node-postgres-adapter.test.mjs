import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNodePostgresAdapter,
  loadNodePostgresAdapterConfig,
} from '../src/node-postgres-adapter.mjs';

class MockClient {
  static instances = [];

  constructor(config) {
    this.config = config;
    this.connected = false;
    this.ended = false;
    this.queries = [];
    this.tables = ['organizations'];
    this.fetchCount = 0;
    this.failNext = null;
    MockClient.instances.push(this);
  }

  async connect() { this.connected = true; }
  async end() { this.ended = true; }

  async query(sql, values = []) {
    this.queries.push({ sql, values });
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    if (sql.includes('information_schema.schemata')) {
      return { rows: [{ exists: true, can_use: true, can_create: true }] };
    }
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes("current_setting('server_version_num')")) {
      return { rows: [{ database: 'kukgit_target', user: 'migration_user', server_version_num: '170005' }] };
    }
    if (sql.includes('information_schema.tables')) return { rows: this.tables.map((name) => ({ name })) };
    if (/^FETCH FORWARD/i.test(sql)) {
      this.fetchCount += 1;
      return this.fetchCount === 1
        ? { rows: [{ id: 'org_1', count: '42' }] }
        : { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  }
}

function config(overrides = {}) {
  return loadNodePostgresAdapterConfig({
    databaseUrl: 'postgresql://migration:very-secret@db.example.com:5432/kukgit',
    schema: 'kukgit_migration',
    sslMode: 'verify-full',
    ...overrides,
  });
}

test('adapter config defaults to verified TLS and redacts credentials', () => {
  const value = config();
  assert.equal(value.sslMode, 'verify-full');
  assert.equal(value.schema, 'kukgit_migration');
  assert.equal(value.redactedDatabaseUrl.includes('very-secret'), false);
  assert.match(value.redactedDatabaseUrl, /\*\*\*/);
});

test('adapter config rejects URL TLS overrides, public schema and insecure transport without explicit opt-in', () => {
  assert.throws(() => config({
    databaseUrl: 'postgresql://user:pass@db.example.com/kukgit?sslmode=disable',
  }), /must not contain sslmode/i);
  assert.throws(() => config({ schema: 'public' }), /public schema is blocked/i);
  assert.throws(() => config({ sslMode: 'require' }), /ALLOW_UNVERIFIED_TLS/i);
  assert.throws(() => config({ sslMode: 'disable' }), /ALLOW_INSECURE/i);
  assert.equal(config({ sslMode: 'require', allowUnverifiedTls: true }).sslMode, 'require');
  assert.equal(config({ sslMode: 'disable', allowInsecure: true }).sslMode, 'disable');
});

test('adapter uses one dedicated client for connection, transaction and cursor scan', async () => {
  MockClient.instances.length = 0;
  const adapter = await createNodePostgresAdapter(config(), { pgModule: { Client: MockClient } });
  const diagnostics = await adapter.connect();
  assert.equal(diagnostics.database, 'kukgit_target');
  assert.equal(diagnostics.schema, 'kukgit_migration');
  assert.equal(diagnostics.databaseUrl.includes('very-secret'), false);
  assert.deepEqual(await adapter.listUserTables(), ['organizations']);

  await adapter.begin();
  await adapter.query('CREATE TABLE sample (id TEXT PRIMARY KEY);', []);
  const rows = [];
  for await (const batch of adapter.scanTable('organizations', ['id', 'count'], { batchSize: 10 })) rows.push(...batch);
  await adapter.commit();
  await adapter.close();

  assert.equal(MockClient.instances.length, 1);
  const client = MockClient.instances[0];
  assert.equal(client.config.ssl.rejectUnauthorized, true);
  assert.equal(client.config.application_name, 'kukgit-migration');
  assert.equal(client.ended, true);
  assert.deepEqual(rows, [{ id: 'org_1', count: '42' }]);
  assert.ok(client.queries.some((query) => query.sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE'));
  assert.ok(client.queries.some((query) => query.sql.includes('SET LOCAL search_path')));
  assert.ok(client.queries.some((query) => query.sql.startsWith('DECLARE')));
  assert.ok(client.queries.some((query) => query.sql.startsWith('FETCH FORWARD 10')));
  assert.ok(client.queries.some((query) => query.sql === 'COMMIT'));
});

test('adapter errors expose SQLSTATE but never driver messages or credentials', async () => {
  MockClient.instances.length = 0;
  const adapter = await createNodePostgresAdapter(config(), { pgModule: { Client: MockClient } });
  await adapter.connect();
  await adapter.begin();
  const client = MockClient.instances[0];
  const failure = new Error('duplicate key; password=very-secret; SQL contained private metadata');
  failure.code = '23505';
  client.failNext = failure;
  let thrown;
  try { await adapter.query('INSERT INTO sample VALUES ($1)', ['private']); }
  catch (error) { thrown = error; }
  assert.equal(thrown.code, 'POSTGRESQL_ADAPTER_OPERATION_FAILED');
  assert.equal(thrown.sqlState, '23505');
  assert.equal(thrown.message.includes('very-secret'), false);
  assert.equal(thrown.message.includes('private'), false);
  await adapter.rollback();
  await adapter.close();
});

test('adapter fails closed when the migration advisory lock is unavailable', async () => {
  class LockedClient extends MockClient {
    async query(sql, values = []) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }] };
      return super.query(sql, values);
    }
  }
  const adapter = await createNodePostgresAdapter(config(), { pgModule: { Client: LockedClient } });
  await assert.rejects(() => adapter.connect(), (error) => {
    assert.equal(error.code, 'POSTGRESQL_ADAPTER_CONNECT_FAILED');
    assert.equal(error.message.includes('lock'), false);
    return true;
  });
});
