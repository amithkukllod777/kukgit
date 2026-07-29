import crypto from 'node:crypto';
import { inventoryDatabaseRuntimeSurface } from './database-runtime-surface.mjs';
import { runtimeWriteCatalog } from './runtime-write-catalog.mjs';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function tableName(sql) {
  const value = String(sql || '');
  return value.match(/^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i)?.[1]
    || value.match(/^UPDATE\s+([A-Za-z_][A-Za-z0-9_]*)/i)?.[1]
    || value.match(/^DELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i)?.[1]
    || null;
}

function classify(call) {
  if (call.dynamic) return { category: 'dynamic', risk: 'review_required', table: null };
  if (call.operation === 'transaction') return { category: 'transaction', risk: 'transaction_boundary', table: null };
  if (call.operation === 'ddl' || call.operation === 'batch_or_ddl') return { category: 'schema', risk: 'migration_only', table: tableName(call.sqlPreview) };
  if (call.operation !== 'write') return null;

  const sql = String(call.sqlPreview || '');
  const keyword = sql.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() || '';
  const table = tableName(sql);
  if (keyword === 'DELETE') return { category: 'delete', risk: 'destructive', table };
  if (keyword === 'UPDATE' || /^REPLACE\b/i.test(sql) || /^INSERT\s+OR\s+/i.test(sql)) {
    return { category: 'mutation', risk: 'mutable', table };
  }
  if (keyword === 'INSERT') {
    const appendOnlyTables = new Set([
      'audit_logs',
      'email_delivery_attempts',
      'notifications',
      'webhook_deliveries',
      'repository_access_history',
      'external_access_review_decisions',
    ]);
    return {
      category: appendOnlyTables.has(table) ? 'append' : 'create',
      risk: appendOnlyTables.has(table) ? 'append_only' : 'identity_or_state_create',
      table,
    };
  }
  return { category: 'unknown_write', risk: 'review_required', table };
}

function managedCatalogCalls() {
  return runtimeWriteCatalog().map((spec) => ({
    file: 'runtime-write-catalog',
    root: 'managed',
    line: 0,
    receiver: 'runtimeWriteService',
    method: 'catalog',
    dynamic: false,
    operation: 'write',
    sqlFingerprint: sha256(spec.sqliteSql),
    portabilityFindings: [],
    sqlPreview: spec.sqliteSql,
    category: spec.operation === 'delete' ? 'delete' : spec.operation === 'update' ? 'mutation' : spec.risk === 'append_only' ? 'append' : 'create',
    risk: spec.risk,
    table: tableName(spec.sqliteSql),
    managed: true,
    catalogId: spec.id,
  }));
}

export function inventoryRuntimeWriteSurface(roots) {
  const runtime = inventoryDatabaseRuntimeSurface(roots);
  const calls = [
    ...runtime.calls
      .map((call) => {
        const classification = classify(call);
        return classification ? { ...call, ...classification, managed: false } : null;
      })
      .filter(Boolean),
    ...managedCatalogCalls(),
  ].sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || String(left.catalogId || '').localeCompare(String(right.catalogId || '')));

  const counts = {
    calls: calls.length,
    writes: calls.filter((call) => ['append', 'create', 'mutation', 'delete', 'unknown_write'].includes(call.category)).length,
    transactions: calls.filter((call) => call.category === 'transaction').length,
    schema: calls.filter((call) => call.category === 'schema').length,
    dynamic: calls.filter((call) => call.category === 'dynamic').length,
    managed: calls.filter((call) => call.managed).length,
    appendOnly: calls.filter((call) => call.risk === 'append_only').length,
    mutable: calls.filter((call) => call.risk === 'mutable').length,
    destructive: calls.filter((call) => call.risk === 'destructive').length,
    reviewRequired: calls.filter((call) => call.risk === 'review_required').length,
  };
  const fingerprint = sha256(stableJson(calls.map(({ root, sqlPreview, ...call }) => call)));
  return {
    format: 'kukgit-runtime-write-surface/1',
    generatedAt: new Date().toISOString(),
    sourceFingerprint: runtime.fingerprint,
    fingerprint,
    counts,
    calls,
  };
}

export function safeRuntimeWriteSurfaceReport(report) {
  if (report?.format !== 'kukgit-runtime-write-surface/1') throw new Error('A valid runtime write surface report is required.');
  return {
    format: report.format,
    generatedAt: report.generatedAt,
    sourceFingerprint: report.sourceFingerprint,
    fingerprint: report.fingerprint,
    counts: { ...report.counts },
    calls: report.calls.map(({ root, sqlPreview, ...call }) => call),
  };
}
