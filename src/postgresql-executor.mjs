import crypto from 'node:crypto';
import { verifyPostgresqlTargetSnapshot } from './postgresql-import-plan.mjs';

const EXECUTION_REPORT_FORMAT = 'kukgit-postgresql-execution-report/1';
const TARGET_SNAPSHOT_FORMAT = 'kukgit-postgresql-target-snapshot/1';
const DEFAULT_MAX_PARAMETERS = 60000;
const DEFAULT_SCAN_BATCH_SIZE = 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableValue(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $binary: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function compareStable(left, right) {
  const leftJson = stableJson(left);
  const rightJson = stableJson(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function compareNames(left, right) {
  const leftName = String(left?.name ?? left);
  const rightName = String(right?.name ?? right);
  return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
}

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw errorWithCode('PostgreSQL import was cancelled.', 'POSTGRESQL_IMPORT_CANCELLED');
}

function requireMethod(adapter, name) {
  if (typeof adapter?.[name] !== 'function') {
    throw errorWithCode(`PostgreSQL adapter must implement ${name}().`, 'POSTGRESQL_ADAPTER_INVALID');
  }
}

function validateAdapter(adapter, { collector = false } = {}) {
  for (const method of collector
    ? ['listUserTables', 'scanTable']
    : ['listUserTables', 'begin', 'query', 'commit', 'rollback', 'scanTable']) {
    requireMethod(adapter, method);
  }
  return adapter;
}

function manifestTables(manifest) {
  if (!manifest || manifest.engine !== 'sqlite' || !Array.isArray(manifest.tables) || !manifest.fingerprint) {
    throw errorWithCode('A valid SQLite source manifest is required.', 'POSTGRESQL_SOURCE_MANIFEST_INVALID');
  }
  const map = new Map();
  for (const table of manifest.tables) {
    const name = String(table?.name || '');
    if (!name || map.has(name) || !Array.isArray(table.columns)) {
      throw errorWithCode('Source manifest table metadata is invalid.', 'POSTGRESQL_SOURCE_MANIFEST_INVALID');
    }
    const columnNames = table.columns.map((column) => String(column?.name || ''));
    if (columnNames.some((column) => !column) || new Set(columnNames).size !== columnNames.length) {
      throw errorWithCode('Source manifest column metadata is invalid.', 'POSTGRESQL_SOURCE_MANIFEST_INVALID');
    }
    map.set(name, table);
  }
  return map;
}

function validatePlan(importPlan, sourceManifest) {
  if (!importPlan || importPlan.format !== 'kukgit-postgresql-import-plan/1') {
    throw errorWithCode('A valid PostgreSQL import plan is required.', 'POSTGRESQL_IMPORT_PLAN_INVALID');
  }
  if (importPlan.sourceFingerprint !== sourceManifest.fingerprint) {
    throw errorWithCode('PostgreSQL import plan does not match the source manifest.', 'POSTGRESQL_IMPORT_SOURCE_MISMATCH');
  }
  if (!importPlan.schemaPlan || !Array.isArray(importPlan.schemaPlan.tables) || !Array.isArray(importPlan.operations)) {
    throw errorWithCode('PostgreSQL import plan is incomplete.', 'POSTGRESQL_IMPORT_PLAN_INVALID');
  }
  if (Number(importPlan.tableCount) !== importPlan.schemaPlan.tables.length
      || Number(importPlan.operationCount) !== importPlan.operations.length) {
    throw errorWithCode('PostgreSQL import plan counts are inconsistent.', 'POSTGRESQL_IMPORT_PLAN_INVALID');
  }
  const expectedRows = sourceManifest.tables.reduce((sum, table) => sum + Number(table.rowCount || 0), 0);
  const plannedRows = importPlan.operations.reduce((sum, operation) => sum + Number(operation.rowCount || 0), 0);
  if (Number(importPlan.totalRows) !== expectedRows || plannedRows !== expectedRows) {
    throw errorWithCode('PostgreSQL import plan row totals do not match the source manifest.', 'POSTGRESQL_IMPORT_ROW_TOTAL_MISMATCH');
  }
  return importPlan;
}

function singleStatement(sql, code) {
  const trimmed = String(sql || '').trim();
  if (!trimmed || /--|\/\*/.test(trimmed)) {
    throw errorWithCode('PostgreSQL migration SQL comments are not allowed.', code);
  }
  const body = trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed;
  if (!body || body.includes(';')) {
    throw errorWithCode('PostgreSQL migration operations must contain exactly one SQL statement.', code);
  }
  return body;
}

function parsedIdentifier(match) {
  return match?.[1] ? match[1].replaceAll('""', '"') : match?.[2] || null;
}

function validateTableDdl(table) {
  if (!table?.name || typeof table.ddl !== 'string') {
    throw errorWithCode('PostgreSQL schema plan contains invalid table DDL.', 'POSTGRESQL_SCHEMA_PLAN_INVALID');
  }
  const body = singleStatement(table.ddl, 'POSTGRESQL_SCHEMA_PLAN_INVALID');
  const match = body.match(/^CREATE\s+TABLE\s+(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_]*))\s*\(/i);
  if (!match || parsedIdentifier(match) !== table.name) {
    throw errorWithCode('PostgreSQL schema DDL table name does not match the import plan.', 'POSTGRESQL_SCHEMA_PLAN_INVALID');
  }
  return table;
}

function validateOperation(operation, maxParameters) {
  if (!operation || typeof operation.sql !== 'string' || !Array.isArray(operation.values) || !operation.table) {
    throw errorWithCode('PostgreSQL import operation is invalid.', 'POSTGRESQL_IMPORT_OPERATION_INVALID');
  }
  const body = singleStatement(operation.sql, 'POSTGRESQL_IMPORT_SQL_REJECTED');
  const tableMatch = body.match(/^INSERT\s+INTO\s+(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_]*))\s*\(/i);
  if (!tableMatch || parsedIdentifier(tableMatch) !== operation.table) {
    throw errorWithCode('PostgreSQL INSERT table does not match the import operation.', 'POSTGRESQL_IMPORT_SQL_REJECTED');
  }
  if (operation.values.length > maxParameters) {
    throw errorWithCode(`PostgreSQL import operation exceeds the ${maxParameters}-parameter safety limit.`, 'POSTGRESQL_IMPORT_PARAMETER_LIMIT');
  }
  const parameters = [...body.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  const expected = Array.from({ length: operation.values.length }, (_, index) => index + 1);
  if (parameters.length !== expected.length || parameters.some((value, index) => value !== expected[index])) {
    throw errorWithCode('PostgreSQL import operation parameter numbering is invalid.', 'POSTGRESQL_IMPORT_PARAMETERS_INVALID');
  }
  if (!Number.isInteger(operation.rowCount) || operation.rowCount < 1) {
    throw errorWithCode('PostgreSQL import operation row count is invalid.', 'POSTGRESQL_IMPORT_OPERATION_INVALID');
  }
  return operation;
}

async function emit(onProgress, event) {
  if (!onProgress) return;
  await onProgress({ ...event, timestamp: new Date().toISOString() });
}

async function emitBestEffort(onProgress, event) {
  try {
    await emit(onProgress, event);
    return null;
  } catch (error) {
    return { code: error?.code || 'POSTGRESQL_PROGRESS_NOTIFICATION_FAILED' };
  }
}

function normalizeUserTables(value) {
  if (!Array.isArray(value)) throw errorWithCode('PostgreSQL adapter returned an invalid table list.', 'POSTGRESQL_ADAPTER_RESULT_INVALID');
  const names = value.map((item) => String(item?.name ?? item));
  if (names.some((name) => !name) || new Set(names).size !== names.length) {
    throw errorWithCode('PostgreSQL adapter returned duplicate or invalid table names.', 'POSTGRESQL_ADAPTER_RESULT_INVALID');
  }
  return names.sort();
}

function normalizeTargetScalar(value, column) {
  if (value === null || value === undefined) return value;
  const type = String(column?.type || '').toUpperCase();
  if (/INT/.test(type)) {
    if (typeof value === 'bigint') {
      const numeric = Number(value);
      return Number.isSafeInteger(numeric) ? numeric : value;
    }
    if (typeof value === 'string' && /^-?\d+$/.test(value)) {
      const numeric = Number(value);
      return Number.isSafeInteger(numeric) ? numeric : BigInt(value);
    }
  }
  if (/(REAL|FLOA|DOUB|NUMERIC|DECIMAL)/.test(type) && typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  if (/BLOB/.test(type) && value instanceof ArrayBuffer) return Buffer.from(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

function validateRow(row, columns, tableName) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw errorWithCode(`PostgreSQL adapter returned an invalid row for ${tableName}.`, 'POSTGRESQL_ADAPTER_ROW_INVALID');
  }
  const names = columns.map((column) => column.name);
  const keys = Object.keys(row).sort();
  const expected = [...names].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw errorWithCode(`PostgreSQL target row columns do not match the source manifest: ${tableName}.`, 'POSTGRESQL_TARGET_COLUMNS_MISMATCH');
  }
  const normalized = Object.fromEntries(columns.map((column) => [
    column.name,
    normalizeTargetScalar(row[column.name], column),
  ]));
  return stableValue(normalized);
}

export async function collectPostgresqlTargetSnapshot({
  adapter,
  sourceManifest,
  signal = null,
  onProgress = null,
  scanBatchSize = DEFAULT_SCAN_BATCH_SIZE,
} = {}) {
  validateAdapter(adapter, { collector: true });
  const sourceMap = manifestTables(sourceManifest);
  const batchSize = Number(scanBatchSize);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000) {
    throw errorWithCode('PostgreSQL target scan batch size must be between 1 and 10000.', 'POSTGRESQL_SCAN_BATCH_INVALID');
  }
  assertNotAborted(signal);
  const actualTables = normalizeUserTables(await adapter.listUserTables());
  const actualSet = new Set(actualTables);
  const expectedTables = [...sourceMap.keys()].sort();
  const tableDifferences = [];
  for (const name of [...new Set([...actualTables, ...expectedTables])].sort()) {
    if (!sourceMap.has(name)) tableDifferences.push({ table: name, type: 'unexpected_table' });
    else if (!actualSet.has(name)) tableDifferences.push({ table: name, type: 'missing_table' });
  }
  if (tableDifferences.length) {
    const error = errorWithCode('PostgreSQL target table set does not match the source manifest.', 'POSTGRESQL_TARGET_TABLES_MISMATCH');
    error.differences = tableDifferences;
    throw error;
  }

  const tables = [];
  for (const name of expectedTables) {
    assertNotAborted(signal);
    const sourceTable = sourceMap.get(name);
    const columns = sourceTable.columns;
    const columnNames = columns.map((column) => column.name);
    const rows = [];
    const iterable = adapter.scanTable(name, columnNames, { batchSize, signal });
    if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') {
      throw errorWithCode('PostgreSQL adapter scanTable() must return an async iterable.', 'POSTGRESQL_ADAPTER_RESULT_INVALID');
    }
    for await (const item of iterable) {
      assertNotAborted(signal);
      const batch = Array.isArray(item) ? item : [item];
      for (const row of batch) rows.push(validateRow(row, columns, name));
    }
    rows.sort(compareStable);
    const rowChecksum = sha256(rows.map(stableJson).join('\n'));
    tables.push({ name, rowCount: rows.length, rowChecksum });
    await emit(onProgress, { phase: 'target_scanned', table: name, rowCount: rows.length });
  }

  const ordered = tables.sort(compareNames);
  return {
    format: TARGET_SNAPSHOT_FORMAT,
    engine: 'postgresql',
    generatedAt: new Date().toISOString(),
    sourceFingerprint: sourceManifest.fingerprint,
    tableCount: ordered.length,
    totalRows: ordered.reduce((sum, table) => sum + table.rowCount, 0),
    tables: ordered,
    fingerprint: sha256(stableJson(ordered)),
  };
}

export async function executePostgresqlImport({
  adapter,
  importPlan,
  sourceManifest,
  signal = null,
  onProgress = null,
  maxParameters = DEFAULT_MAX_PARAMETERS,
  scanBatchSize = DEFAULT_SCAN_BATCH_SIZE,
} = {}) {
  validateAdapter(adapter);
  manifestTables(sourceManifest);
  validatePlan(importPlan, sourceManifest);
  const parameterLimit = Number(maxParameters);
  if (!Number.isInteger(parameterLimit) || parameterLimit < 1 || parameterLimit > 65535) {
    throw errorWithCode('PostgreSQL maximum parameter setting must be between 1 and 65535.', 'POSTGRESQL_IMPORT_PARAMETER_LIMIT_INVALID');
  }
  assertNotAborted(signal);
  const existingTables = normalizeUserTables(await adapter.listUserTables());
  if (existingTables.length) {
    const error = errorWithCode('PostgreSQL import target must be empty.', 'POSTGRESQL_IMPORT_TARGET_NOT_EMPTY');
    error.tables = existingTables;
    throw error;
  }

  await emit(onProgress, {
    phase: 'validated',
    tableCount: importPlan.tableCount,
    totalRows: importPlan.totalRows,
    operationCount: importPlan.operationCount,
  });

  let transactionStarted = false;
  let committed = false;
  let completedOperations = 0;
  try {
    assertNotAborted(signal);
    await adapter.begin();
    transactionStarted = true;
    await emit(onProgress, { phase: 'transaction_started' });
    await adapter.query("SET LOCAL TIME ZONE 'UTC'", []);

    for (const table of importPlan.schemaPlan.tables) {
      assertNotAborted(signal);
      validateTableDdl(table);
      await adapter.query(table.ddl, []);
      await emit(onProgress, { phase: 'table_created', table: table.name });
    }

    for (const operation of importPlan.operations) {
      assertNotAborted(signal);
      validateOperation(operation, parameterLimit);
      await adapter.query(operation.sql, operation.values);
      completedOperations += 1;
      await emit(onProgress, {
        phase: 'batch_inserted',
        table: operation.table,
        batch: operation.batch,
        rowCount: operation.rowCount,
        completedOperations,
        totalOperations: importPlan.operations.length,
      });
    }

    const targetSnapshot = await collectPostgresqlTargetSnapshot({
      adapter,
      sourceManifest,
      signal,
      onProgress,
      scanBatchSize,
    });
    const verification = verifyPostgresqlTargetSnapshot(sourceManifest, targetSnapshot);
    if (!verification.valid) {
      const error = errorWithCode('PostgreSQL target verification failed before commit.', 'POSTGRESQL_IMPORT_VERIFICATION_FAILED');
      error.differences = verification.differences;
      throw error;
    }
    await emit(onProgress, {
      phase: 'target_verified',
      tableCount: verification.tableCount,
      totalRows: verification.totalRows,
      targetFingerprint: verification.targetFingerprint,
    });

    assertNotAborted(signal);
    await adapter.commit();
    committed = true;
    const progressWarning = await emitBestEffort(onProgress, { phase: 'committed', completedOperations });

    const report = {
      format: EXECUTION_REPORT_FORMAT,
      status: 'committed',
      completedAt: new Date().toISOString(),
      sourceFingerprint: sourceManifest.fingerprint,
      schemaFingerprint: importPlan.schemaPlan.fingerprint,
      importPlanFingerprint: importPlan.fingerprint,
      targetFingerprint: verification.targetFingerprint,
      tableCount: verification.tableCount,
      totalRows: verification.totalRows,
      operationCount: completedOperations,
      ...(progressWarning ? { progressWarning } : {}),
    };
    return { ...report, reportChecksum: sha256(stableJson(report)), targetSnapshot };
  } catch (error) {
    if (transactionStarted && !committed) {
      let rollbackSucceeded = false;
      try {
        await adapter.rollback();
        rollbackSucceeded = true;
      } catch (rollbackError) {
        error.rollbackFailed = true;
        error.rollbackCode = rollbackError?.code || 'POSTGRESQL_ROLLBACK_FAILED';
      }
      if (rollbackSucceeded) await emitBestEffort(onProgress, { phase: 'rolled_back', completedOperations });
    }
    throw error;
  }
}

export const POSTGRESQL_EXECUTION_REPORT_FORMAT = EXECUTION_REPORT_FORMAT;
export const POSTGRESQL_TARGET_SNAPSHOT_FORMAT = TARGET_SNAPSHOT_FORMAT;
export const POSTGRESQL_DEFAULT_MAX_PARAMETERS = DEFAULT_MAX_PARAMETERS;
