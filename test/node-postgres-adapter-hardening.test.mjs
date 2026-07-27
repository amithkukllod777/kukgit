import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNodePostgresAdapter,
  loadNodePostgresAdapterConfig,
} from '../src/node-postgres-adapter.mjs';

class CaptureClient {
  static lastConfig = null;
  constructor(config) { CaptureClient.lastConfig = config; }
  async connect() {}
  async end() {}
  async query(sql) {
    if (sql.includes('information_schema.schemata')) return { rows: [{ exists: true, can_use: true, can_create: true }] };
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes("current_setting('server_version_num')")) {
      return { rows: [{ database: 'kukgit', user: 'migration', server_version_num: '170005' }] };
    }
    return { rows: [] };
  }
}

test('partial adapter config is normalized and cannot bypass verified TLS defaults', async () => {
  const adapter = await createNodePostgresAdapter({
    databaseUrl: 'postgresql://migration:secret@db.example.com/kukgit',
    schema: 'kukgit_migration',
  }, { pgModule: { Client: CaptureClient } });
  assert.equal(CaptureClient.lastConfig.ssl.rejectUnauthorized, true);
  assert.equal(CaptureClient.lastConfig.application_name, 'kukgit-migration');
  assert.equal(CaptureClient.lastConfig.connectionTimeoutMillis, 10000);
  assert.equal(adapter.config.databaseUrl.includes('secret'), false);
});

test('application name rejects control characters and overlong UTF-8 values', () => {
  const base = {
    databaseUrl: 'postgresql://migration:secret@db.example.com/kukgit',
    schema: 'kukgit_migration',
  };
  assert.throws(() => loadNodePostgresAdapterConfig({ ...base, applicationName: 'kukgit\nmalicious' }), /safe UTF-8 bytes/i);
  assert.throws(() => loadNodePostgresAdapterConfig({ ...base, applicationName: '🚀'.repeat(20) }), /safe UTF-8 bytes/i);
});
