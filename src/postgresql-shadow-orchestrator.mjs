import fs from 'node:fs';
import path from 'node:path';
import { normalizeDatabaseDriver } from './database-selection.mjs';
import { createNodePostgresAdapter, loadNodePostgresAdapterConfig } from './node-postgres-adapter.mjs';
import { verifyPostgresqlShadowReads } from './postgresql-shadow-read.mjs';

const STATE_FORMAT = 'kukgit-postgresql-shadow-state/1';

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function safeOperator(value) {
  const operator = String(value || '').trim();
  if (operator.length < 3 || operator.length > 200 || /[\r\n\u0000]/.test(operator)) {
    throw new Error('PostgreSQL shadow operator must contain 3 to 200 safe characters.');
  }
  return operator;
}

function safeCode(error, fallback) {
  const code = String(error?.code || '');
  return /^[A-Z0-9_]{3,100}$/.test(code) ? code : fallback;
}

function writeAtomic(target, payload) {
  const absolute = path.resolve(target);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, absolute);
  try { fs.chmodSync(absolute, 0o600); } catch {}
  return absolute;
}

function prepareDirectory(directory) {
  const target = path.resolve(directory);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
  return target;
}

function safeProgress(event) {
  const allowed = ['phase', 'id', 'status', 'sampleCount', 'mismatchCount', 'errorCount', 'timestamp'];
  return Object.fromEntries(allowed.filter((key) => event?.[key] !== undefined).map((key) => [key, event[key]]));
}

export async function runPostgresqlShadowVerification({
  sqlite,
  sourceManifest,
  confirmation,
  operator,
  outputDirectory,
  enabled = booleanValue(process.env.KUKGIT_POSTGRESQL_SHADOW_ENABLED, false),
  runtimeDriver = process.env.KUKGIT_DATABASE_DRIVER || 'sqlite',
  adapterConfig = null,
  adapterFactory = createNodePostgresAdapter,
  pgModule = null,
  ids = null,
  sampleLimit = 10,
  signal = null,
  onProgress = null,
} = {}) {
  if (!enabled) {
    const error = new Error('PostgreSQL shadow verification requires KUKGIT_POSTGRESQL_SHADOW_ENABLED=true.');
    error.code = 'POSTGRESQL_SHADOW_NOT_ENABLED';
    throw error;
  }
  if (normalizeDatabaseDriver(runtimeDriver) !== 'sqlite') {
    const error = new Error('PostgreSQL shadow verification is allowed only while runtime remains on SQLite.');
    error.code = 'POSTGRESQL_SHADOW_RUNTIME_DRIVER_INVALID';
    throw error;
  }
  if (!sourceManifest?.fingerprint || sourceManifest.engine !== 'sqlite') {
    const error = new Error('A valid live SQLite manifest is required.');
    error.code = 'POSTGRESQL_SHADOW_SOURCE_INVALID';
    throw error;
  }
  if (String(confirmation || '').trim() !== sourceManifest.fingerprint) {
    const error = new Error('Exact live SQLite source fingerprint confirmation is required.');
    error.code = 'POSTGRESQL_SHADOW_CONFIRMATION_MISMATCH';
    throw error;
  }
  const normalizedOperator = safeOperator(operator);
  const directory = prepareDirectory(outputDirectory);
  const statePath = path.join(directory, 'postgresql-shadow-state.json');
  const reportPath = path.join(directory, 'postgresql-shadow-report.json');
  const config = loadNodePostgresAdapterConfig(adapterConfig || {});
  let state = {
    format: STATE_FORMAT,
    status: 'prepared',
    updatedAt: new Date().toISOString(),
    operator: normalizedOperator,
    sourceFingerprint: sourceManifest.fingerprint,
    target: {
      databaseUrl: config.redactedDatabaseUrl,
      schema: config.schema,
      sslMode: config.sslMode,
    },
  };
  writeAtomic(statePath, state);

  const adapter = await adapterFactory(config, { pgModule });
  let transaction = false;
  let primaryError = null;
  let report = null;
  let diagnostics = null;
  const warnings = [];
  const progress = async (event) => {
    const safe = safeProgress(event);
    state = { ...state, status: 'running', updatedAt: new Date().toISOString(), progress: safe };
    writeAtomic(statePath, state);
    if (onProgress) await onProgress(safe);
  };

  try {
    diagnostics = await adapter.connect();
    if (typeof adapter.beginReadOnly !== 'function') {
      const error = new Error('PostgreSQL adapter must implement beginReadOnly() for shadow verification.');
      error.code = 'POSTGRESQL_SHADOW_ADAPTER_INVALID';
      throw error;
    }
    await adapter.beginReadOnly();
    transaction = true;
    report = await verifyPostgresqlShadowReads({
      sqlite,
      postgresql: adapter,
      ids,
      sampleLimit,
      signal,
      onProgress: progress,
    });
  } catch (error) {
    primaryError = error;
  }

  if (transaction) {
    try { await adapter.rollback(); }
    catch (error) {
      const warning = { code: safeCode(error, 'POSTGRESQL_SHADOW_ROLLBACK_FAILED') };
      if (primaryError) primaryError.rollbackWarning = warning;
      else warnings.push({ stage: 'rollback', ...warning });
    }
  }
  try { await adapter.close(); }
  catch (error) {
    const warning = { code: safeCode(error, 'POSTGRESQL_ADAPTER_CLOSE_FAILED') };
    if (primaryError) primaryError.closeWarning = warning;
    else warnings.push({ stage: 'close', ...warning });
  }

  if (primaryError) {
    state = {
      ...state,
      status: primaryError?.code === 'POSTGRESQL_SHADOW_CANCELLED' ? 'cancelled' : 'failed',
      updatedAt: new Date().toISOString(),
      error: { code: safeCode(primaryError, 'POSTGRESQL_SHADOW_FAILED') },
      warnings,
    };
    try { writeAtomic(statePath, state); } catch {}
    throw primaryError;
  }

  const evidence = {
    ...report,
    operator: normalizedOperator,
    sourceFingerprint: sourceManifest.fingerprint,
    connection: {
      database: diagnostics?.database || '',
      user: diagnostics?.user || '',
      serverVersionNumber: diagnostics?.serverVersionNumber || '',
      schema: diagnostics?.schema || config.schema,
      sslMode: diagnostics?.sslMode || config.sslMode,
      databaseUrl: config.redactedDatabaseUrl,
    },
    warnings,
    boundary: 'Shadow verification is read-only; PostgreSQL runtime and cutover remain disabled.',
  };
  writeAtomic(reportPath, evidence);
  state = {
    ...state,
    status: report.status,
    updatedAt: new Date().toISOString(),
    progress: { phase: 'complete', timestamp: new Date().toISOString() },
    reportPath,
    reportFingerprint: report.reportFingerprint,
    summary: report.summary,
    warnings,
  };
  writeAtomic(statePath, state);
  return {
    status: report.status,
    sourceFingerprint: sourceManifest.fingerprint,
    reportFingerprint: report.reportFingerprint,
    summary: report.summary,
    statePath,
    reportPath,
    warnings,
    boundary: evidence.boundary,
  };
}

export const POSTGRESQL_SHADOW_STATE_FORMAT = STATE_FORMAT;
