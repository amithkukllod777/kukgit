import fs from 'node:fs';
import path from 'node:path';
import { readSqliteExport } from './database-portability.mjs';
import { normalizeDatabaseDriver } from './database-selection.mjs';
import { buildPostgresqlImportPlan, createPostgresqlImportReceipt } from './postgresql-import-plan.mjs';
import { executePostgresqlImport } from './postgresql-executor.mjs';
import { createNodePostgresAdapter, loadNodePostgresAdapterConfig } from './node-postgres-adapter.mjs';

const STATE_FORMAT = 'kukgit-postgresql-offline-import-state/1';

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function safeOperator(value) {
  const operator = String(value || '').trim();
  if (operator.length < 3 || operator.length > 200 || /[\r\n\u0000]/.test(operator)) {
    throw new Error('PostgreSQL migration operator must contain 3 to 200 safe characters.');
  }
  return operator;
}

function safeErrorCode(error, fallback) {
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

function prepareOutputDirectory(directory) {
  const target = path.resolve(directory);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
  const probe = path.join(target, `.kukgit-write-probe-${process.pid}-${Date.now()}`);
  fs.writeFileSync(probe, 'ok', { mode: 0o600, flag: 'wx' });
  fs.rmSync(probe, { force: true });
  return target;
}

function safeEvent(event) {
  const allowed = [
    'phase', 'table', 'batch', 'rowCount', 'completedOperations', 'totalOperations',
    'tableCount', 'totalRows', 'operationCount', 'targetFingerprint', 'timestamp',
  ];
  return Object.fromEntries(allowed.filter((key) => event?.[key] !== undefined).map((key) => [key, event[key]]));
}

export async function runPostgresqlOfflineImport({
  exportPath,
  confirmation,
  operator,
  outputDirectory,
  enabled = booleanValue(process.env.KUKGIT_POSTGRESQL_IMPORT_ENABLED, false),
  runtimeDriver = process.env.KUKGIT_DATABASE_DRIVER || 'sqlite',
  adapterConfig = null,
  adapterFactory = createNodePostgresAdapter,
  pgModule = null,
  batchSize = 250,
  maxParameters = 60000,
  scanBatchSize = 1000,
  signal = null,
  onProgress = null,
} = {}) {
  if (!enabled) {
    const error = new Error('Offline PostgreSQL import requires KUKGIT_POSTGRESQL_IMPORT_ENABLED=true.');
    error.code = 'POSTGRESQL_IMPORT_NOT_ENABLED';
    throw error;
  }
  if (normalizeDatabaseDriver(runtimeDriver) !== 'sqlite') {
    const error = new Error('Offline PostgreSQL import is allowed only while KukGit runtime remains on SQLite.');
    error.code = 'POSTGRESQL_IMPORT_RUNTIME_DRIVER_INVALID';
    throw error;
  }
  const source = readSqliteExport(exportPath);
  if (String(confirmation || '').trim() !== source.manifest.fingerprint) {
    const error = new Error('Exact SQLite source fingerprint confirmation is required.');
    error.code = 'POSTGRESQL_IMPORT_CONFIRMATION_MISMATCH';
    throw error;
  }
  const normalizedOperator = safeOperator(operator);
  const directory = prepareOutputDirectory(outputDirectory);
  const statePath = path.join(directory, 'postgresql-offline-import-state.json');
  const targetPath = path.join(directory, 'postgresql-target-snapshot.json');
  const reportPath = path.join(directory, 'postgresql-execution-report.json');
  const receiptPath = path.join(directory, 'postgresql-import-receipt.json');
  const importPlan = buildPostgresqlImportPlan(source, { batchSize });
  const config = adapterConfig?.databaseUrl ? adapterConfig : loadNodePostgresAdapterConfig(adapterConfig || {});

  let state = {
    format: STATE_FORMAT,
    status: 'prepared',
    updatedAt: new Date().toISOString(),
    operator: normalizedOperator,
    sourceFingerprint: source.manifest.fingerprint,
    schemaFingerprint: importPlan.schemaPlan.fingerprint,
    importPlanFingerprint: importPlan.fingerprint,
    target: {
      databaseUrl: config.redactedDatabaseUrl,
      schema: config.schema,
      sslMode: config.sslMode,
    },
  };
  writeAtomic(statePath, state);

  const adapter = await adapterFactory(config, { pgModule });
  let connectionDiagnostics = null;
  let execution = null;
  let primaryError = null;
  const artifactWarnings = [];
  const progress = async (event) => {
    const safe = safeEvent(event);
    state = {
      ...state,
      status: safe.phase === 'committed' ? 'committed' : safe.phase === 'rolled_back' ? 'rolled_back' : 'running',
      updatedAt: new Date().toISOString(),
      progress: safe,
    };
    writeAtomic(statePath, state);
    if (onProgress) await onProgress(safe);
  };

  try {
    connectionDiagnostics = await adapter.connect();
    state = {
      ...state,
      status: 'connected',
      updatedAt: new Date().toISOString(),
      connection: {
        database: connectionDiagnostics.database,
        user: connectionDiagnostics.user,
        serverVersionNumber: connectionDiagnostics.serverVersionNumber,
        schema: connectionDiagnostics.schema,
        sslMode: connectionDiagnostics.sslMode,
      },
    };
    writeAtomic(statePath, state);

    execution = await executePostgresqlImport({
      adapter,
      importPlan,
      sourceManifest: source.manifest,
      signal,
      onProgress: progress,
      maxParameters,
      scanBatchSize,
    });
  } catch (error) {
    primaryError = error;
    state = {
      ...state,
      status: error?.code === 'POSTGRESQL_IMPORT_CANCELLED' ? 'cancelled' : 'failed',
      updatedAt: new Date().toISOString(),
      error: { code: safeErrorCode(error, 'POSTGRESQL_OFFLINE_IMPORT_FAILED') },
    };
    try { writeAtomic(statePath, state); } catch {}
  }

  try {
    await adapter.close();
  } catch (error) {
    const warning = { code: safeErrorCode(error, 'POSTGRESQL_ADAPTER_CLOSE_FAILED') };
    if (primaryError) primaryError.closeWarning = warning;
    else artifactWarnings.push({ artifact: 'connection_close', ...warning });
  }

  if (primaryError) throw primaryError;

  let receipt = null;
  try {
    receipt = createPostgresqlImportReceipt({
      sourceManifest: source.manifest,
      importPlan,
      targetSnapshot: execution.targetSnapshot,
      operator: normalizedOperator,
    });
  } catch (error) {
    artifactWarnings.push({ artifact: 'receipt', code: safeErrorCode(error, 'POSTGRESQL_RECEIPT_FAILED') });
  }

  const safeReport = {
    format: execution.format,
    status: execution.status,
    completedAt: execution.completedAt,
    sourceFingerprint: execution.sourceFingerprint,
    schemaFingerprint: execution.schemaFingerprint,
    importPlanFingerprint: execution.importPlanFingerprint,
    targetFingerprint: execution.targetFingerprint,
    tableCount: execution.tableCount,
    totalRows: execution.totalRows,
    operationCount: execution.operationCount,
    reportChecksum: execution.reportChecksum,
    ...(execution.progressWarning ? { progressWarning: execution.progressWarning } : {}),
    connection: connectionDiagnostics,
  };

  for (const [artifact, target, payload] of [
    ['target_snapshot', targetPath, execution.targetSnapshot],
    ['execution_report', reportPath, safeReport],
    ['import_receipt', receiptPath, receipt],
  ]) {
    if (!payload) continue;
    try { writeAtomic(target, payload); }
    catch (error) { artifactWarnings.push({ artifact, code: safeErrorCode(error, 'POSTGRESQL_ARTIFACT_WRITE_FAILED') }); }
  }

  state = {
    ...state,
    status: 'committed',
    updatedAt: new Date().toISOString(),
    progress: { phase: 'complete', timestamp: new Date().toISOString() },
    artifacts: {
      statePath,
      targetPath,
      reportPath,
      receiptPath: receipt ? receiptPath : null,
    },
    warnings: artifactWarnings,
  };
  try { writeAtomic(statePath, state); }
  catch (error) { artifactWarnings.push({ artifact: 'final_state', code: safeErrorCode(error, 'POSTGRESQL_ARTIFACT_WRITE_FAILED') }); }

  return {
    status: 'committed',
    sourceFingerprint: source.manifest.fingerprint,
    targetFingerprint: execution.targetFingerprint,
    schemaFingerprint: importPlan.schemaPlan.fingerprint,
    importPlanFingerprint: importPlan.fingerprint,
    tableCount: execution.tableCount,
    totalRows: execution.totalRows,
    operationCount: execution.operationCount,
    artifacts: state.artifacts,
    warnings: artifactWarnings,
    boundary: 'PostgreSQL runtime and cutover remain disabled.',
  };
}

export const POSTGRESQL_OFFLINE_IMPORT_STATE_FORMAT = STATE_FORMAT;
