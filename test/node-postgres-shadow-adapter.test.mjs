import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodePostgresShadowAdapter } from '../src/node-postgres-shadow-adapter.mjs';

function pgModule({ canUse = true } = {}) {
  const calls = [];
  class Client {
    constructor(options) { this.options = options; }
    async connect() { calls.push({ sql: 'CONNECT', values: [] }); }
    async end() { calls.push({ sql: 'END', values: [] }); }
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('information_schema.schemata')) return { rows: [{ exists: true, can_use: canUse }] };
      if (sql.includes("current_setting('server_version_num')")) return { rows: [{ server_version_num: '160002' }] };
      if (/^SELECT \$1::text AS value/.test(sql)) return { rows: [{ value: values[0] }] };
      return { rows: [] };
    }
  }
  return { module: { Client }, calls };
}

function config() {
  return {
    databaseUrl: 'postgresql://shadow:secret@localhost:5432/kukgit',
    schema: 'kukgit_shadow',
    sslMode: 'disable',
    allowInsecure: true,
    applicationName: 'kukgit-shadow-test',
  };
}

test('shadow adapter uses read-only transaction and requires no CREATE privilege', async () => {
  const pg = pgModule();
  const adapter = await createNodePostgresShadowAdapter(config(), { pgModule: pg.module });
  const diagnostics = await adapter.connect();
  assert.equal(diagnostics.schema, 'kukgit_shadow');
  assert.equal(diagnostics.databaseUrl.includes('secret'), false);
  await adapter.beginReadOnly();
  const result = await adapter.query('SELECT $1::text AS value', ['safe']);
  assert.deepEqual(result.rows, [{ value: 'safe' }]);
  await assert.rejects(() => adapter.query('UPDATE users SET email = $1', ['x']), (error) => error.code === 'POSTGRESQL_SHADOW_SQL_REJECTED');
  await adapter.rollback();
  await adapter.close();
  const sql = pg.calls.map((call) => call.sql).join('\n');
  assert.match(sql, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.equal(sql.includes("'CREATE'"), false);
  assert.equal(sql.includes('pg_try_advisory_lock'), false);
});

test('shadow adapter fails closed without schema USAGE', async () => {
  const pg = pgModule({ canUse: false });
  const adapter = await createNodePostgresShadowAdapter(config(), { pgModule: pg.module });
  await assert.rejects(() => adapter.connect(), (error) => error.code === 'POSTGRESQL_SHADOW_CONNECT_FAILED');
  assert.ok(pg.calls.some((call) => call.sql === 'END'));
});
