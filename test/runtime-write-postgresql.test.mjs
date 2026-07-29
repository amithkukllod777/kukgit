import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createNodePostgresAdapter, loadNodePostgresAdapterConfig } from '../src/node-postgres-adapter.mjs';
import {
  ensurePostgresqlRuntimeWriteMigrations,
  runtimeWriteMigrationDefinition,
} from '../src/runtime-write-migrations.mjs';
import { createPostgresqlCompatibilityWriteService } from '../src/runtime-write-service.mjs';

const databaseUrl = String(process.env.KUKGIT_TEST_POSTGRES_URL || '').trim();

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Unsafe PostgreSQL test identifier.');
  return `"${value}"`;
}

test('PostgreSQL write compatibility preserves constraints and transaction semantics', { skip: !databaseUrl }, async () => {
  const pg = await import('pg');
  const Client = pg.Client || pg.default?.Client;
  const schema = `kg_stage7_${crypto.randomBytes(8).toString('hex')}`;
  const quoted = identifier(schema);
  const bootstrap = new Client({ connectionString: databaseUrl, ssl: false });
  let adapter = null;

  await bootstrap.connect();
  try {
    await bootstrap.query(`CREATE SCHEMA ${quoted}`);
    await bootstrap.query(`
      CREATE TABLE ${quoted}.users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE ${quoted}.organizations (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE ${quoted}.audit_logs (
        id TEXT PRIMARY KEY,
        organization_id TEXT REFERENCES ${quoted}.organizations(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES ${quoted}.users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const config = loadNodePostgresAdapterConfig({
      databaseUrl,
      schema,
      sslMode: 'disable',
      allowInsecure: true,
      applicationName: 'kukgit-stage7-write-test',
      statementTimeoutMillis: 30000,
      queryTimeoutMillis: 35000,
    });
    adapter = await createNodePostgresAdapter(config);
    const diagnostics = await adapter.connect();
    assert.equal(diagnostics.schema, schema);

    const firstMigration = await ensurePostgresqlRuntimeWriteMigrations(adapter);
    const secondMigration = await ensurePostgresqlRuntimeWriteMigrations(adapter);
    assert.deepEqual(firstMigration, secondMigration);
    assert.equal(firstMigration.ready, true);

    await bootstrap.query(
      `INSERT INTO ${quoted}.users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)`,
      ['usr_stage7', 'stage7@example.com', 'authkit$managed', 'Stage Seven'],
    );
    await bootstrap.query(
      `INSERT INTO ${quoted}.organizations (id, slug, name, plan) VALUES ($1, $2, $3, $4)`,
      ['org_stage7', 'stage7', 'Stage Seven', 'free'],
    );

    const service = createPostgresqlCompatibilityWriteService({ adapter });
    const write = await service.write('audit_logs.insert', [
      'aud_stage7_success',
      'org_stage7',
      'usr_stage7',
      'stage7.success',
      'database',
      'write-service',
      '{"safe":true}',
    ]);
    assert.deepEqual(write, { id: 'audit_logs.insert', backend: 'postgresql', changes: 1 });

    const inserted = await bootstrap.query(`
      SELECT id, organization_id, user_id, action, target_type, target_id, metadata_json,
        created_at IS NOT NULL AS has_timestamp
      FROM ${quoted}.audit_logs WHERE id = $1
    `, ['aud_stage7_success']);
    assert.deepEqual(inserted.rows[0], {
      id: 'aud_stage7_success',
      organization_id: 'org_stage7',
      user_id: 'usr_stage7',
      action: 'stage7.success',
      target_type: 'database',
      target_id: 'write-service',
      metadata_json: '{"safe":true}',
      has_timestamp: true,
    });

    await assert.rejects(
      service.transaction(async (tx) => {
        await tx.write('audit_logs.insert', [
          'aud_stage7_rollback', 'org_stage7', 'usr_stage7', 'stage7.rollback', 'database', null, '{}',
        ]);
        throw new Error('force rollback');
      }),
      (error) => error.code === 'RUNTIME_WRITE_FAILED',
    );
    const rolledBack = await bootstrap.query(`SELECT COUNT(*)::int AS count FROM ${quoted}.audit_logs WHERE id = $1`, ['aud_stage7_rollback']);
    assert.equal(rolledBack.rows[0].count, 0);

    await assert.rejects(
      service.write('audit_logs.insert', [
        'aud_stage7_fk', 'org_missing', 'usr_missing', 'stage7.fk', 'database', null, '{}',
      ]),
      (error) => error.code === 'RUNTIME_WRITE_FOREIGN_KEY' && error.sqlState === '23503',
    );

    await assert.rejects(
      service.write('audit_logs.insert', [
        'aud_stage7_success', 'org_stage7', 'usr_stage7', 'stage7.duplicate', 'database', null, '{}',
      ]),
      (error) => error.code === 'RUNTIME_WRITE_CONFLICT' && error.sqlState === '23505',
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      service.write('audit_logs.insert', [
        'aud_stage7_cancelled', 'org_stage7', 'usr_stage7', 'stage7.cancelled', 'database', null, '{}',
      ], { signal: controller.signal }),
      (error) => error.code === 'RUNTIME_WRITE_CANCELLED',
    );

    const definition = runtimeWriteMigrationDefinition();
    await bootstrap.query(
      `UPDATE ${quoted}.kukgit_schema_migrations SET checksum = $1 WHERE version = $2`,
      ['0'.repeat(64), definition.version],
    );
    await assert.rejects(
      ensurePostgresqlRuntimeWriteMigrations(adapter),
      (error) => error.code === 'RUNTIME_WRITE_MIGRATION_CHECKSUM_MISMATCH',
    );
  } finally {
    try { await adapter?.close(); } catch {}
    try { await bootstrap.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); } catch {}
    await bootstrap.end();
  }
});
