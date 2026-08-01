import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { loadDatabaseSelection, validatePostgresqlReadiness } from '../src/database-selection.mjs';
import { loadNodePostgresAdapterConfig } from '../src/node-postgres-adapter.mjs';
import { loadPostgresqlRuntimeObserverConfig } from '../src/postgresql-runtime-observer.mjs';

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

function validateRuntimeApproval(runtime) {
  const report = JSON.parse(fs.readFileSync(runtime.stage5ReportPath, 'utf8'));
  if (report?.format !== 'kukgit-postgresql-shadow-read-report/1' || report.status !== 'verified') {
    throw new Error('Stage 6 requires a verified Stage 5 PostgreSQL shadow report.');
  }
  if (!/^[0-9a-f]{64}$/i.test(runtime.approval) || report.reportFingerprint !== runtime.approval) {
    throw new Error('KUKGIT_POSTGRESQL_RUNTIME_SHADOW_APPROVAL must exactly match the verified Stage 5 report fingerprint.');
  }
  const stateDirectory = path.dirname(runtime.statePath);
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  fs.accessSync(stateDirectory, fs.constants.R_OK | fs.constants.W_OK);
  if (path.resolve(runtime.statePath) === path.resolve(runtime.stage5ReportPath)) {
    throw new Error('Stage 6 state path cannot equal the Stage 5 report path.');
  }
  return report.reportFingerprint;
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

  const runtime = loadPostgresqlRuntimeObserverConfig(config);
  if (runtime.enabled) {
    if (selection.driver !== 'sqlite') throw new Error('PostgreSQL runtime shadow requires SQLite to remain authoritative.');
    const fingerprint = validateRuntimeApproval(runtime);
    const adapter = loadNodePostgresAdapterConfig();
    console.log(`✓ PostgreSQL runtime shadow: approved ${fingerprint.slice(0, 12)}…, schema ${adapter.schema}, sample rate ${runtime.sampleRate}, queue ${runtime.maxQueue}, concurrency ${runtime.concurrency}`);
  } else {
    console.log('✓ PostgreSQL runtime shadow: disabled');
  }

  if (config.runtimeWriteServiceEnabled) {
    if (selection.driver !== 'sqlite') throw new Error('Stage 7 runtime write service requires SQLite to remain authoritative.');
    console.log('✓ Runtime write service: enabled for SQLite-authoritative managed writes; PostgreSQL writes remain CI-only');
  } else {
    console.log('✓ Runtime write service: disabled; direct SQLite write behavior remains active');
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
