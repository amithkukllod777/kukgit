import crypto from 'node:crypto';
import { parametersFromSample, runtimeReadCatalog, runtimeReadSpec } from './runtime-read-catalog.mjs';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $binary: Buffer.from(value).toString('base64') };
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : { $bigint: value.toString() };
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function resultShape(value, mode) {
  if (mode === 'one') return value ? [value] : [];
  if (!Array.isArray(value)) throw new Error('Runtime read many-result must be an array.');
  return value;
}

function safeError(error, fallback) {
  const code = String(error?.code || '');
  return {
    code: /^[A-Z0-9_]{3,100}$/.test(code) ? code : fallback,
    ...(error?.sqlState && /^[0-9A-Z]{5}$/.test(String(error.sqlState)) ? { sqlState: String(error.sqlState) } : {}),
  };
}

function assertReader(reader) {
  if (typeof reader?.query !== 'function') throw new Error('PostgreSQL shadow reader must implement query(sql, values).');
  return reader;
}

function assertSqlite(db) {
  if (typeof db?.prepare !== 'function') throw new Error('SQLite shadow source must implement prepare(sql).');
  return db;
}

export function runSqliteRuntimeRead(db, specValue, parameters) {
  assertSqlite(db);
  const spec = typeof specValue === 'string' ? runtimeReadSpec(specValue) : specValue;
  if (!Array.isArray(parameters) || parameters.length !== spec.parameters.length) {
    throw new Error(`SQLite runtime read parameter count mismatch: ${spec.id}`);
  }
  const statement = db.prepare(spec.sqliteSql);
  return spec.mode === 'one' ? statement.get(...parameters) || null : statement.all(...parameters);
}

export async function runPostgresqlRuntimeRead(reader, specValue, parameters) {
  assertReader(reader);
  const spec = typeof specValue === 'string' ? runtimeReadSpec(specValue) : specValue;
  if (!Array.isArray(parameters) || parameters.length !== spec.parameters.length) {
    throw new Error(`PostgreSQL runtime read parameter count mismatch: ${spec.id}`);
  }
  const result = await reader.query(spec.postgresqlSql, parameters);
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  return spec.mode === 'one' ? rows[0] || null : rows;
}

export function compareRuntimeReadResults(specValue, sqliteResult, postgresqlResult) {
  const spec = typeof specValue === 'string' ? runtimeReadSpec(specValue) : specValue;
  const sourceRows = resultShape(sqliteResult, spec.mode).map(canonicalValue);
  const targetRows = resultShape(postgresqlResult, spec.mode).map(canonicalValue);
  const sourceJson = stableJson(sourceRows);
  const targetJson = stableJson(targetRows);
  return {
    valid: sourceJson === targetJson,
    sourceRowCount: sourceRows.length,
    targetRowCount: targetRows.length,
    sourceFingerprint: sha256(sourceJson),
    targetFingerprint: sha256(targetJson),
  };
}

export function sampleRuntimeReadParameters(db, specValue, limit = 10) {
  assertSqlite(db);
  const spec = typeof specValue === 'string' ? runtimeReadSpec(specValue) : specValue;
  const size = Number(limit);
  if (!Number.isInteger(size) || size < 1 || size > 100) throw new Error('Runtime read sample limit must be between 1 and 100.');
  const samples = db.prepare(spec.sampleSql).all(size);
  const deduplicated = new Map();
  for (const sample of samples) {
    const parameters = parametersFromSample(spec, sample);
    const key = stableJson(parameters);
    if (!deduplicated.has(key)) deduplicated.set(key, parameters);
  }
  return [...deduplicated.values()];
}

async function emit(onProgress, event) {
  if (!onProgress) return;
  await onProgress({ ...event, timestamp: new Date().toISOString() });
}

export async function verifyPostgresqlShadowReads({
  sqlite,
  postgresql,
  ids = null,
  sampleLimit = 10,
  signal = null,
  onProgress = null,
} = {}) {
  assertSqlite(sqlite);
  assertReader(postgresql);
  const requested = ids ? new Set(ids.map(String)) : null;
  const catalog = runtimeReadCatalog().filter((spec) => !requested || requested.has(spec.id));
  if (requested) {
    const unknown = [...requested].filter((id) => !catalog.some((spec) => spec.id === id));
    if (unknown.length) throw new Error(`Unknown runtime read catalog entries: ${unknown.join(', ')}`);
  }
  const checks = [];
  for (const spec of catalog) {
    if (signal?.aborted) {
      const error = new Error('PostgreSQL shadow verification was cancelled.');
      error.code = 'POSTGRESQL_SHADOW_CANCELLED';
      throw error;
    }
    const parametersList = sampleRuntimeReadParameters(sqlite, spec, sampleLimit);
    if (!parametersList.length) {
      checks.push({ id: spec.id, status: 'skipped', sampleCount: 0, mismatchCount: 0, errorCount: 0 });
      await emit(onProgress, { phase: 'read_skipped', id: spec.id, sampleCount: 0 });
      continue;
    }
    let mismatchCount = 0;
    let errorCount = 0;
    const samples = [];
    for (let index = 0; index < parametersList.length; index += 1) {
      if (signal?.aborted) {
        const error = new Error('PostgreSQL shadow verification was cancelled.');
        error.code = 'POSTGRESQL_SHADOW_CANCELLED';
        throw error;
      }
      try {
        const sqliteResult = runSqliteRuntimeRead(sqlite, spec, parametersList[index]);
        const postgresqlResult = await runPostgresqlRuntimeRead(postgresql, spec, parametersList[index]);
        const comparison = compareRuntimeReadResults(spec, sqliteResult, postgresqlResult);
        if (!comparison.valid) mismatchCount += 1;
        samples.push({ sample: index + 1, status: comparison.valid ? 'matched' : 'mismatched', ...comparison });
      } catch (error) {
        errorCount += 1;
        samples.push({ sample: index + 1, status: 'error', error: safeError(error, 'POSTGRESQL_SHADOW_READ_FAILED') });
      }
    }
    const status = errorCount ? 'error' : mismatchCount ? 'mismatched' : 'matched';
    checks.push({
      id: spec.id,
      status,
      sampleCount: parametersList.length,
      mismatchCount,
      errorCount,
      samples,
    });
    await emit(onProgress, {
      phase: 'read_verified',
      id: spec.id,
      status,
      sampleCount: parametersList.length,
      mismatchCount,
      errorCount,
    });
  }
  const summary = {
    catalogCount: checks.length,
    matched: checks.filter((check) => check.status === 'matched').length,
    mismatched: checks.filter((check) => check.status === 'mismatched').length,
    errors: checks.filter((check) => check.status === 'error').length,
    skipped: checks.filter((check) => check.status === 'skipped').length,
    samples: checks.reduce((sum, check) => sum + check.sampleCount, 0),
    mismatches: checks.reduce((sum, check) => sum + check.mismatchCount, 0),
    sampleErrors: checks.reduce((sum, check) => sum + check.errorCount, 0),
  };
  const reportBody = {
    format: 'kukgit-postgresql-shadow-read-report/1',
    status: summary.mismatched || summary.errors ? 'failed' : 'verified',
    generatedAt: new Date().toISOString(),
    summary,
    checks,
  };
  return { ...reportBody, reportFingerprint: sha256(stableJson({ summary, checks })) };
}
