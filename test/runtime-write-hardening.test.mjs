import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import {
  runtimeWriteMigrationDefinition,
  verifyRuntimeWriteMigrationRows,
} from '../src/runtime-write-migrations.mjs';
import { normalizeRuntimeWriteError } from '../src/runtime-write-service.mjs';

test('Stage 7 rollout defaults on outside production and off in production', () => {
  const development = loadConfig({ nodeEnv: 'test' });
  assert.equal(development.runtimeWriteServiceEnabled, true);

  const production = loadConfig({
    nodeEnv: 'production',
    authMode: 'authkit',
    authkitBaseUrl: 'https://auth.kuklabs.com',
    authkitEncryptionKey: 'a'.repeat(32),
    cookieSecure: true,
  });
  assert.equal(production.runtimeWriteServiceEnabled, false);

  const explicitlyEnabled = loadConfig({
    nodeEnv: 'production',
    authMode: 'authkit',
    authkitBaseUrl: 'https://auth.kuklabs.com',
    authkitEncryptionKey: 'b'.repeat(32),
    cookieSecure: true,
    runtimeWriteServiceEnabled: true,
  });
  assert.equal(explicitlyEnabled.runtimeWriteServiceEnabled, true);
});

test('migration history accepts only the exact current definition', () => {
  const definition = runtimeWriteMigrationDefinition();
  assert.deepEqual(
    verifyRuntimeWriteMigrationRows([{
      version: definition.version,
      migration_id: definition.id,
      checksum: definition.checksum,
    }]),
    {
      ready: true,
      currentVersion: definition.version,
      expectedVersion: definition.version,
      checksum: definition.checksum,
    },
  );
  assert.deepEqual(verifyRuntimeWriteMigrationRows([]), {
    ready: false,
    currentVersion: 0,
    expectedVersion: definition.version,
  });
});

test('migration history rejects malformed, duplicate, future and tampered rows', () => {
  const definition = runtimeWriteMigrationDefinition();
  assert.throws(
    () => verifyRuntimeWriteMigrationRows([{ version: 0, migration_id: definition.id, checksum: definition.checksum }]),
    (error) => error.code === 'RUNTIME_WRITE_MIGRATION_INVALID',
  );
  assert.throws(
    () => verifyRuntimeWriteMigrationRows([
      { version: 1, migration_id: definition.id, checksum: definition.checksum },
      { version: 2, migration_id: definition.id, checksum: definition.checksum },
    ]),
    (error) => error.code === 'RUNTIME_WRITE_MIGRATION_DUPLICATE',
  );
  assert.throws(
    () => verifyRuntimeWriteMigrationRows([{
      version: definition.version + 1,
      migration_id: 'runtime-write-future-v2',
      checksum: '1'.repeat(64),
    }]),
    (error) => error.code === 'RUNTIME_WRITE_MIGRATION_FUTURE_VERSION',
  );
  assert.throws(
    () => verifyRuntimeWriteMigrationRows([{
      version: definition.version,
      migration_id: definition.id,
      checksum: '0'.repeat(64),
    }]),
    (error) => error.code === 'RUNTIME_WRITE_MIGRATION_CHECKSUM_MISMATCH',
  );
});

test('database-specific failures normalize without exposing original messages', () => {
  const sqlite = normalizeRuntimeWriteError(
    Object.assign(new Error('UNIQUE constraint failed: users.email'), { code: 'ERR_SQLITE_ERROR' }),
    'sqlite',
  );
  assert.equal(sqlite.code, 'RUNTIME_WRITE_CONFLICT');
  assert.equal(sqlite.message.includes('users.email'), false);

  const postgresql = normalizeRuntimeWriteError(
    Object.assign(new Error('duplicate key value violates unique constraint users_email_key'), { code: 'POSTGRESQL_ADAPTER_OPERATION_FAILED', sqlState: '23505' }),
    'postgresql',
  );
  assert.equal(postgresql.code, 'RUNTIME_WRITE_CONFLICT');
  assert.equal(postgresql.sqlState, '23505');
  assert.equal(postgresql.message.includes('users_email_key'), false);
});
