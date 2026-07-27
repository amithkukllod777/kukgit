import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { loadDatabaseSelection, validatePostgresqlReadiness } from '../src/database-selection.mjs';
import { loadNodePostgresAdapterConfig } from '../src/node-postgres-adapter.mjs';

function enabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function bounded(value, fallback, minimum, maximum, label) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

try {
  const config = loadConfig();
  const selection = loadDatabaseSelection();
  const shadowEnabled = enabled(process.env.KUKGIT_POSTGRESQL_SHADOW_ENABLED);
  if (shadowEnabled) {
    if (selection.driver !== 'sqlite') throw new Error('PostgreSQL shadow verification requires SQLite to remain the authoritative runtime.');
    const sampleLimit = bounded(process.env.KUKGIT_POSTGRESQL_SHADOW_SAMPLE_LIMIT, 10, 1, 100, 'KUKGIT_POSTGRESQL_SHADOW_SAMPLE_LIMIT');
    const timeout = bounded(process.env.KUKGIT_POSTGRESQL_SHADOW_READ_TIMEOUT_MS, 5000, 100, 60000, 'KUKGIT_POSTGRESQL_SHADOW_READ_TIMEOUT_MS');
    const outputDirectory = path.resolve(process.env.KUKGIT_POSTGRESQL_SHADOW_OUTPUT_DIR || path.join(config.dataDir, 'database-migration', 'postgresql-shadow'));
    if (outputDirectory === path.resolve(config.databasePath)) throw new Error('PostgreSQL shadow output directory cannot equal the SQLite database path.');
    fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    fs.accessSync(outputDirectory, fs.constants.R_OK | fs.constants.W_OK);
    const adapter = loadNodePostgresAdapterConfig();
    console.log(`✓ PostgreSQL shadow reads: enabled, schema ${adapter.schema}, TLS ${adapter.sslMode}, ${sampleLimit} samples/read, ${timeout} ms timeout`);
  } else {
    console.log('✓ PostgreSQL shadow reads: disabled (SQLite-only runtime remains authoritative)');
  }

  if (selection.driver === 'sqlite') {
    console.log(`✓ Metadata database: SQLite runtime (${selection.driver})`);
    process.exit(0);
  }
  const readiness = validatePostgresqlReadiness(selection);
  const status = readiness.ready ? 'readiness marker valid' : `not ready: ${readiness.reason}`;
  console.error(`✗ Metadata database: PostgreSQL selected (${status}), but runtime cutover is not delivered. Keep KUKGIT_DATABASE_DRIVER=sqlite.`);
  process.exit(1);
} catch (error) {
  console.error(`✗ Metadata database: ${error.message}`);
  process.exit(1);
}
