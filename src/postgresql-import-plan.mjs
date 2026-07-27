import crypto from 'node:crypto';

const PLAN_FORMAT = 'kukgit-postgresql-import-plan/1';
const RECEIPT_FORMAT = 'kukgit-postgresql-import-receipt/1';

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

function quoteIdentifier(value) {
  const name = String(value || '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    if (!name || name.includes('\0')) throw new Error('PostgreSQL identifier is invalid.');
  }
  return `"${name.replaceAll('"', '""')}"`;
}

function restoreExportValue(value) {
  if (Array.isArray(value)) return value.map(restoreExportValue);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.$binary === 'string') return Buffer.from(value.$binary, 'base64');
    if (keys.length === 1 && typeof value.$bigint === 'string') return BigInt(value.$bigint);
    return Object.fromEntries(keys.map((key) => [key, restoreExportValue(value[key])]));
  }
  return value;
}

function manifestTables(manifest) {
  if (!manifest || manifest.engine !== 'sqlite' || !Array.isArray(manifest.tables)) {
    throw new Error('A valid SQLite source manifest is required.');
  }
  const map = new Map();
  for (const table of manifest.tables) {
    const name = String(table?.name || '');
    if (!name) throw new Error('Source manifest contains an invalid table name.');
    if (map.has(name)) throw new Error(`Source manifest contains a duplicate table: ${name}`);
    if (!Array.isArray(table.columns) || !table.columns.length) throw new Error(`Source table has no columns: ${name}`);
    map.set(name, table);
  }
  return map;
}

function referencedTables(schema) {
  const references = new Set();
  const pattern = /\bREFERENCES\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi;
  for (const match of String(schema || '').matchAll(pattern)) references.add(match[1] || match[2]);
  return references;
}

function dependencyOrder(tableMap) {
  const dependencies = new Map();
  for (const [name, table] of tableMap) {
    const refs = referencedTables(table.schema);
    refs.delete(name);
    for (const reference of refs) {
      if (!tableMap.has(reference)) throw new Error(`Table ${name} references missing source table ${reference}.`);
    }
    dependencies.set(name, refs);
  }

  const ready = [...dependencies.entries()].filter(([, refs]) => refs.size === 0).map(([name]) => name).sort();
  const ordered = [];
  const remaining = new Map([...dependencies.entries()].map(([name, refs]) => [name, new Set(refs)]));
  while (ready.length) {
    const name = ready.shift();
    if (!remaining.has(name)) continue;
    ordered.push(name);
    remaining.delete(name);
    for (const [candidate, refs] of remaining) {
      refs.delete(name);
      if (refs.size === 0 && !ready.includes(candidate)) ready.push(candidate);
    }
    ready.sort();
  }
  if (remaining.size) throw new Error(`PostgreSQL import dependency cycle detected: ${[...remaining.keys()].sort().join(', ')}`);
  return ordered;
}

export function translateSqliteCreateTable(schemaValue) {
  let schema = String(schemaValue || '').trim();
  if (!/^CREATE\s+TABLE\b/i.test(schema)) throw new Error('SQLite CREATE TABLE SQL is required.');
  schema = schema
    .replace(/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+/i, 'CREATE TABLE ')
    .replace(/\bAUTOINCREMENT\b/gi, '')
    .replace(/\bCOLLATE\s+NOCASE\b/gi, '')
    .replace(/\bINTEGER\b/gi, 'BIGINT')
    .replace(/\bREAL\b/gi, 'DOUBLE PRECISION')
    .replace(/\bBLOB\b/gi, 'BYTEA')
    .replace(/\bDATETIME\b/gi, 'TIMESTAMPTZ')
    .replace(/DEFAULT\s*\(\s*datetime\s*\(\s*'now'\s*\)\s*\)/gi, 'DEFAULT CURRENT_TIMESTAMP')
    .replace(/DEFAULT\s+datetime\s*\(\s*'now'\s*\)/gi, 'DEFAULT CURRENT_TIMESTAMP')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\b(?:PRAGMA|sqlite_master|INSERT\s+OR|julianday|strftime)\b/i.test(schema)) {
    throw new Error('SQLite-specific SQL remains in translated PostgreSQL table DDL.');
  }
  return schema.endsWith(';') ? schema : `${schema};`;
}

export function buildPostgresqlSchemaPlan(manifest) {
  const tableMap = manifestTables(manifest);
  const order = dependencyOrder(tableMap);
  const tables = order.map((name) => {
    const source = tableMap.get(name);
    const ddl = translateSqliteCreateTable(source.schema);
    return {
      name,
      dependencies: [...referencedTables(source.schema)].filter((dependency) => dependency !== name).sort(),
      sourceSchemaChecksum: source.schemaChecksum,
      ddl,
      ddlChecksum: sha256(ddl),
      rowCount: source.rowCount,
      rowChecksum: source.rowChecksum,
    };
  });
  const fingerprint = sha256(stableJson(tables.map((table) => ({
    name: table.name,
    dependencies: table.dependencies,
    sourceSchemaChecksum: table.sourceSchemaChecksum,
    ddlChecksum: table.ddlChecksum,
    rowCount: table.rowCount,
    rowChecksum: table.rowChecksum,
  }))));
  return {
    format: PLAN_FORMAT,
    sourceFingerprint: manifest.fingerprint,
    generatedAt: new Date().toISOString(),
    tableCount: tables.length,
    totalRows: tables.reduce((sum, table) => sum + Number(table.rowCount || 0), 0),
    fingerprint,
    tables,
  };
}

export function renderPostgresqlSchemaSql(schemaPlan) {
  if (schemaPlan?.format !== PLAN_FORMAT) throw new Error('A valid PostgreSQL schema plan is required.');
  const statements = [
    'BEGIN;',
    "SET LOCAL TIME ZONE 'UTC';",
    ...schemaPlan.tables.map((table) => table.ddl),
    'COMMIT;',
  ];
  return `${statements.join('\n\n')}\n`;
}

function batchInsert(tableName, columns, rows) {
  const quotedColumns = columns.map(quoteIdentifier);
  const values = [];
  let parameter = 1;
  const groups = rows.map((row) => {
    const placeholders = columns.map((column) => {
      values.push(restoreExportValue(row[column]));
      return `$${parameter++}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  return {
    sql: `INSERT INTO ${quoteIdentifier(tableName)} (${quotedColumns.join(', ')}) VALUES ${groups.join(', ')};`,
    values,
  };
}

export function buildPostgresqlImportPlan(exportResult, { batchSize = 250 } = {}) {
  const bundle = exportResult?.bundle || exportResult;
  const manifest = bundle?.source?.manifest;
  const schemaPlan = buildPostgresqlSchemaPlan(manifest);
  const size = Number(batchSize);
  if (!Number.isInteger(size) || size < 1 || size > 5000) throw new Error('PostgreSQL import batch size must be between 1 and 5000.');
  const sourceTables = new Map((bundle.tables || []).map((table) => [table.name, table]));
  const manifestMap = manifestTables(manifest);
  const operations = [];
  const tableSummaries = [];
  for (const table of schemaPlan.tables) {
    const source = sourceTables.get(table.name);
    const manifestTable = manifestMap.get(table.name);
    if (!source || !Array.isArray(source.rows)) throw new Error(`Export rows are missing for table ${table.name}.`);
    const columns = manifestTable.columns.map((column) => column.name);
    for (const row of source.rows) {
      const keys = Object.keys(row).sort();
      const expected = [...columns].sort();
      if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
        throw new Error(`Export row columns do not match the manifest: ${table.name}`);
      }
    }
    let batchCount = 0;
    for (let offset = 0; offset < source.rows.length; offset += size) {
      const rows = source.rows.slice(offset, offset + size);
      const statement = batchInsert(table.name, columns, rows);
      operations.push({
        table: table.name,
        batch: batchCount + 1,
        rowOffset: offset,
        rowCount: rows.length,
        sql: statement.sql,
        values: statement.values,
      });
      batchCount += 1;
    }
    tableSummaries.push({
      name: table.name,
      columns,
      rowCount: source.rows.length,
      rowChecksum: manifestTable.rowChecksum,
      batchCount,
    });
  }
  const fingerprint = sha256(stableJson({
    schemaFingerprint: schemaPlan.fingerprint,
    sourceFingerprint: manifest.fingerprint,
    batchSize: size,
    tables: tableSummaries,
    operations: operations.map(({ table, batch, rowOffset, rowCount, sql }) => ({ table, batch, rowOffset, rowCount, sql })),
  }));
  return {
    format: PLAN_FORMAT,
    generatedAt: new Date().toISOString(),
    sourceFingerprint: manifest.fingerprint,
    schemaPlan,
    batchSize: size,
    tableCount: tableSummaries.length,
    totalRows: tableSummaries.reduce((sum, table) => sum + table.rowCount, 0),
    operationCount: operations.length,
    tables: tableSummaries,
    operations,
    fingerprint,
  };
}

export function safePostgresqlImportPlan(plan) {
  if (plan?.format !== PLAN_FORMAT) throw new Error('A valid PostgreSQL import plan is required.');
  return {
    format: plan.format,
    generatedAt: plan.generatedAt,
    sourceFingerprint: plan.sourceFingerprint,
    schemaFingerprint: plan.schemaPlan?.fingerprint,
    fingerprint: plan.fingerprint,
    batchSize: plan.batchSize,
    tableCount: plan.tableCount,
    totalRows: plan.totalRows,
    operationCount: plan.operationCount,
    tables: plan.tables,
    operations: plan.operations.map(({ table, batch, rowOffset, rowCount, sql }) => ({
      table,
      batch,
      rowOffset,
      rowCount,
      sqlChecksum: sha256(sql),
    })),
  };
}

export function verifyPostgresqlTargetSnapshot(sourceManifest, targetSnapshot) {
  const sourceMap = manifestTables(sourceManifest);
  if (!targetSnapshot || !Array.isArray(targetSnapshot.tables)) throw new Error('A PostgreSQL target snapshot is required.');
  const targetMap = new Map();
  for (const table of targetSnapshot.tables) {
    if (!table?.name || targetMap.has(table.name)) throw new Error('PostgreSQL target snapshot table names must be unique.');
    targetMap.set(table.name, table);
  }
  const differences = [];
  for (const name of [...new Set([...sourceMap.keys(), ...targetMap.keys()])].sort()) {
    const source = sourceMap.get(name);
    const target = targetMap.get(name);
    if (!source) differences.push({ table: name, type: 'unexpected_table' });
    else if (!target) differences.push({ table: name, type: 'missing_table' });
    else {
      if (Number(target.rowCount) !== Number(source.rowCount)) {
        differences.push({ table: name, type: 'row_count', expected: source.rowCount, actual: target.rowCount });
      }
      if (target.rowChecksum !== source.rowChecksum) {
        differences.push({ table: name, type: 'row_checksum', expected: source.rowChecksum, actual: target.rowChecksum });
      }
    }
  }
  const targetFingerprint = sha256(stableJson([...targetMap.values()].sort((left, right) => left.name.localeCompare(right.name)).map((table) => ({
    name: table.name,
    rowCount: table.rowCount,
    rowChecksum: table.rowChecksum,
  }))));
  return {
    valid: differences.length === 0,
    sourceFingerprint: sourceManifest.fingerprint,
    targetFingerprint,
    tableCount: targetMap.size,
    totalRows: [...targetMap.values()].reduce((sum, table) => sum + Number(table.rowCount || 0), 0),
    differences,
  };
}

export function createPostgresqlImportReceipt({ sourceManifest, importPlan, targetSnapshot, operator = null }) {
  if (importPlan?.format !== PLAN_FORMAT || importPlan.sourceFingerprint !== sourceManifest?.fingerprint) {
    throw new Error('PostgreSQL import plan does not match the source manifest.');
  }
  const verification = verifyPostgresqlTargetSnapshot(sourceManifest, targetSnapshot);
  if (!verification.valid) throw new Error('PostgreSQL target verification failed.');
  const receipt = {
    format: RECEIPT_FORMAT,
    status: 'verified',
    createdAt: new Date().toISOString(),
    operator,
    sourceFingerprint: sourceManifest.fingerprint,
    schemaFingerprint: importPlan.schemaPlan.fingerprint,
    importPlanFingerprint: importPlan.fingerprint,
    targetFingerprint: verification.targetFingerprint,
    tableCount: verification.tableCount,
    totalRows: verification.totalRows,
  };
  return { ...receipt, receiptChecksum: sha256(stableJson(receipt)) };
}

export const POSTGRESQL_IMPORT_PLAN_FORMAT = PLAN_FORMAT;
export const POSTGRESQL_IMPORT_RECEIPT_FORMAT = RECEIPT_FORMAT;
