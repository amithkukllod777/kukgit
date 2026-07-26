import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha256File } from './backup-archive.mjs';
import { currentSchemaVersion, KUKGIT_SCHEMA_VERSION } from './migrations.mjs';
import { httpError } from './security.mjs';

export const POSTGRES_MIGRATION_FORMAT = 'kukgit-postgresql-migration';
export const POSTGRES_MIGRATION_VERSION = 1;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_TABLES = 512;
const MAX_COLUMNS = 1024;

function assertIdentifier(value, label = 'database identifier') {
  const identifier = String(value ?? '');
  if (!IDENTIFIER.test(identifier)) {
    throw httpError(400, `Unsupported ${label} '${identifier}'.`, 'DB_PORTABILITY_IDENTIFIER_UNSUPPORTED');
  }
  return identifier;
}

function sqliteIdentifier(value) {
  return `"${assertIdentifier(value).replaceAll('"', '""')}"`;
}

function postgresIdentifier(value) {
  return `"${assertIdentifier(value).replaceAll('"', '""')}"`;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value, spacing = 2) {
  return `${JSON.stringify(canonicalValue(value), null, spacing)}\n`;
}

function groupForeignKeys(rows) {
  const groups = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    const group = groups.get(id) ?? {
      id,
      table: assertIdentifier(row.table, 'referenced table'),
      from: [],
      to: [],
      onUpdate: String(row.on_update || 'NO ACTION').toUpperCase(),
      onDelete: String(row.on_delete || 'NO ACTION').toUpperCase(),
      match: String(row.match || 'NONE').toUpperCase(),
    };
    group.from[Number(row.seq)] = assertIdentifier(row.from, 'foreign-key column');
    group.to[Number(row.seq)] = assertIdentifier(row.to, 'referenced column');
    groups.set(id, group);
  }
  return [...groups.values()].sort((left, right) => left.id - right.id);
}

function indexColumns(db, name) {
  const rows = db.prepare(`PRAGMA index_xinfo(${sqliteIdentifier(name)})`).all();
  const columns = [];
  for (const row of rows) {
    if (Number(row.key) !== 1) continue;
    if (Number(row.cid) < 0 || !row.name) {
      columns.push({ expression: true, sequence: Number(row.seqno) });
      continue;
    }
    columns.push({
      name: assertIdentifier(row.name, 'index column'),
      descending: Number(row.desc) === 1,
      sequence: Number(row.seqno),
    });
  }
  return columns.sort((left, right) => left.sequence - right.sequence);
}

function inspectIndexes(db, tableName) {
  const rows = db.prepare(`PRAGMA index_list(${sqliteIdentifier(tableName)})`).all();
  return rows.map((row) => {
    const name = assertIdentifier(row.name, 'index');
    const record = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name);
    return {
      name,
      unique: Number(row.unique) === 1,
      origin: String(row.origin || 'c'),
      partial: Number(row.partial) === 1,
      columns: indexColumns(db, name),
      originalSql: record?.sql ?? null,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function sensitiveColumns(columns) {
  const sensitive = /(password|secret|token|ciphertext|private|credential|authorization|html_body|text_body)/i;
  return columns.filter((column) => sensitive.test(column.name)).map((column) => column.name);
}

function extractCheckExpressions(sql) {
  const source = String(sql || '');
  const expressions = [];
  const upper = source.toUpperCase();
  let cursor = 0;
  while (cursor < source.length) {
    const index = upper.indexOf('CHECK', cursor);
    if (index < 0) break;
    let open = index + 5;
    while (/\s/.test(source[open] || '')) open += 1;
    if (source[open] !== '(') {
      cursor = open + 1;
      continue;
    }
    let depth = 0;
    let quote = null;
    let end = -1;
    for (let position = open; position < source.length; position += 1) {
      const character = source[position];
      if (quote) {
        if (character === quote) {
          if (source[position + 1] === quote) position += 1;
          else quote = null;
        }
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }
      if (character === '(') depth += 1;
      if (character === ')') {
        depth -= 1;
        if (depth === 0) {
          end = position;
          break;
        }
      }
    }
    if (end < 0) break;
    expressions.push(source.slice(open + 1, end).trim());
    cursor = end + 1;
  }
  return [...new Set(expressions.filter(Boolean))];
}

export function inspectSqliteSchema(db) {
  const tableRows = db.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
  if (tableRows.length > MAX_TABLES) throw httpError(413, 'Database contains too many tables for migration export.', 'DB_PORTABILITY_TOO_MANY_TABLES');

  const tables = tableRows.map((tableRow) => {
    const name = assertIdentifier(tableRow.name, 'table');
    const columns = db.prepare(`PRAGMA table_info(${sqliteIdentifier(name)})`).all().map((column) => ({
      cid: Number(column.cid),
      name: assertIdentifier(column.name, 'column'),
      declaredType: String(column.type || '').trim().toUpperCase(),
      notNull: Number(column.notnull) === 1,
      defaultValue: column.dflt_value === null ? null : String(column.dflt_value),
      primaryKeyPosition: Number(column.pk),
    }));
    if (columns.length > MAX_COLUMNS) throw httpError(413, `Table '${name}' contains too many columns.`, 'DB_PORTABILITY_TOO_MANY_COLUMNS');
    const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${sqliteIdentifier(name)}`).get().count);
    return {
      name,
      originalSql: String(tableRow.sql || ''),
      columns,
      primaryKey: columns.filter((column) => column.primaryKeyPosition > 0)
        .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
        .map((column) => column.name),
      foreignKeys: groupForeignKeys(db.prepare(`PRAGMA foreign_key_list(${sqliteIdentifier(name)})`).all()),
      indexes: inspectIndexes(db, name),
      checks: extractCheckExpressions(tableRow.sql),
      rowCount: count,
      sensitiveColumns: sensitiveColumns(columns),
    };
  });

  const order = foreignKeySafeOrder(tables);
  return {
    format: 'kukgit-sqlite-schema',
    version: 1,
    schemaVersion: currentSchemaVersion(db) ?? KUKGIT_SCHEMA_VERSION,
    sourceEngine: 'sqlite',
    tables,
    importOrder: order.order,
    dependencyCycles: order.cycles,
  };
}

export function foreignKeySafeOrder(tables) {
  const names = new Set(tables.map((table) => table.name));
  const dependencies = new Map(tables.map((table) => [
    table.name,
    new Set(table.foreignKeys.map((foreignKey) => foreignKey.table).filter((name) => name !== table.name && names.has(name))),
  ]));
  const order = [];
  const remaining = new Set([...names].sort());
  while (remaining.size) {
    const ready = [...remaining].filter((name) => [...dependencies.get(name)].every((dependency) => order.includes(dependency))).sort();
    if (!ready.length) break;
    for (const name of ready) {
      order.push(name);
      remaining.delete(name);
    }
  }
  const cycles = [...remaining].sort();
  order.push(...cycles);
  return { order, cycles };
}

function postgresType(column, table) {
  const type = column.declaredType;
  const singleIntegerPrimaryKey = table.primaryKey.length === 1 && table.primaryKey[0] === column.name && /INT/.test(type);
  const autoIncrement = singleIntegerPrimaryKey && new RegExp(`\\b${column.name}\\b\\s+INTEGER\\s+PRIMARY\\s+KEY\\s+AUTOINCREMENT`, 'i').test(table.originalSql);
  if (autoIncrement) return 'BIGINT GENERATED BY DEFAULT AS IDENTITY';
  if (/INT/.test(type)) return 'BIGINT';
  if (/(CHAR|CLOB|TEXT)/.test(type)) return 'TEXT';
  if (/BLOB/.test(type) || !type) return 'BYTEA';
  if (/(REAL|FLOA|DOUB)/.test(type)) return 'DOUBLE PRECISION';
  if (/(NUMERIC|DECIMAL)/.test(type)) return 'NUMERIC';
  if (/BOOL/.test(type)) return 'BOOLEAN';
  return 'TEXT';
}

function postgresDefault(value) {
  if (value === null) return null;
  const source = String(value).trim();
  if (/^CURRENT_TIMESTAMP$/i.test(source)) return 'CURRENT_TIMESTAMP';
  if (/^NULL$/i.test(source)) return 'NULL';
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(source)) return source;
  if (/^'(?:''|[^'])*'$/.test(source)) return source;
  if (/^"(?:""|[^"])*"$/.test(source)) return `'${source.slice(1, -1).replaceAll("'", "''")}'`;
  return null;
}

function referentialAction(value) {
  const normalized = String(value || 'NO ACTION').toUpperCase();
  return new Set(['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL', 'SET DEFAULT']).has(normalized) ? normalized : 'NO ACTION';
}

function indexWhereClause(index) {
  if (!index.partial || !index.originalSql) return '';
  const match = index.originalSql.match(/\sWHERE\s([\s\S]+)$/i);
  return match ? ` WHERE ${match[1].trim()}` : '';
}

export function validateSchemaForPostgres(schema) {
  const errors = [];
  const warnings = [];
  const names = new Set(schema.tables.map((table) => table.name));
  for (const table of schema.tables) {
    if (!table.primaryKey.length) warnings.push({ code: 'TABLE_WITHOUT_PRIMARY_KEY', table: table.name });
    if (/WITHOUT\s+ROWID/i.test(table.originalSql)) warnings.push({ code: 'SQLITE_WITHOUT_ROWID', table: table.name });
    if (/COLLATE\s+NOCASE/i.test(table.originalSql)) warnings.push({ code: 'SQLITE_NOCASE_COLLATION', table: table.name });
    for (const foreignKey of table.foreignKeys) {
      if (!names.has(foreignKey.table)) errors.push({ code: 'FOREIGN_KEY_TARGET_MISSING', table: table.name, target: foreignKey.table });
    }
    for (const index of table.indexes) {
      if (index.columns.some((column) => column.expression)) errors.push({ code: 'EXPRESSION_INDEX_UNSUPPORTED', table: table.name, index: index.name });
    }
    for (const column of table.columns) {
      if (column.defaultValue !== null && postgresDefault(column.defaultValue) === null) {
        warnings.push({ code: 'DEFAULT_REQUIRES_REVIEW', table: table.name, column: column.name, value: column.defaultValue });
      }
    }
  }
  for (const table of schema.dependencyCycles || []) warnings.push({ code: 'FOREIGN_KEY_DEPENDENCY_CYCLE', table });
  return { compatible: errors.length === 0, errors, warnings };
}

export function buildPostgresDdl(schema, { schemaName = 'kukgit' } = {}) {
  assertIdentifier(schemaName, 'PostgreSQL schema');
  const validation = validateSchemaForPostgres(schema);
  if (!validation.compatible) {
    throw httpError(409, 'SQLite schema contains features that require manual PostgreSQL conversion.', 'POSTGRES_SCHEMA_INCOMPATIBLE');
  }
  const tableByName = new Map(schema.tables.map((table) => [table.name, table]));
  const lines = [
    '-- Generated by KukGit PostgreSQL migration foundation.',
    `-- Source schema version: ${schema.schemaVersion}`,
    '-- Review and test this DDL before production cutover.',
    'BEGIN;',
    `CREATE SCHEMA IF NOT EXISTS ${postgresIdentifier(schemaName)};`,
    `SET search_path TO ${postgresIdentifier(schemaName)}, public;`,
    '',
  ];

  for (const tableName of schema.importOrder) {
    const table = tableByName.get(tableName);
    const definitions = table.columns.map((column) => {
      const parts = [postgresIdentifier(column.name), postgresType(column, table)];
      if (column.notNull) parts.push('NOT NULL');
      const defaultValue = postgresDefault(column.defaultValue);
      if (defaultValue !== null) parts.push(`DEFAULT ${defaultValue}`);
      return `  ${parts.join(' ')}`;
    });
    if (table.primaryKey.length) definitions.push(`  PRIMARY KEY (${table.primaryKey.map(postgresIdentifier).join(', ')})`);
    const uniqueConstraints = table.indexes.filter((index) => index.unique && index.origin === 'u' && index.columns.every((column) => !column.expression));
    for (const index of uniqueConstraints) {
      definitions.push(`  CONSTRAINT ${postgresIdentifier(`uq_${table.name}_${index.name}`)} UNIQUE (${index.columns.map((column) => `${postgresIdentifier(column.name)}${column.descending ? ' DESC' : ''}`).join(', ')})`);
    }
    for (const [index, expression] of table.checks.entries()) {
      definitions.push(`  CONSTRAINT ${postgresIdentifier(`ck_${table.name}_${index + 1}`)} CHECK (${expression})`);
    }
    lines.push(`CREATE TABLE ${postgresIdentifier(table.name)} (`, definitions.join(',\n'), ');', '');
  }

  for (const tableName of schema.importOrder) {
    const table = tableByName.get(tableName);
    for (const foreignKey of table.foreignKeys) {
      lines.push(
        `ALTER TABLE ${postgresIdentifier(table.name)} ADD CONSTRAINT ${postgresIdentifier(`fk_${table.name}_${foreignKey.id}`)}`,
        `  FOREIGN KEY (${foreignKey.from.map(postgresIdentifier).join(', ')})`,
        `  REFERENCES ${postgresIdentifier(foreignKey.table)} (${foreignKey.to.map(postgresIdentifier).join(', ')})`,
        `  ON UPDATE ${referentialAction(foreignKey.onUpdate)} ON DELETE ${referentialAction(foreignKey.onDelete)};`,
      );
    }
  }
  lines.push('');

  for (const tableName of schema.importOrder) {
    const table = tableByName.get(tableName);
    const indexes = table.indexes.filter((index) => index.origin === 'c' && index.columns.every((column) => !column.expression));
    for (const index of indexes) {
      lines.push(
        `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${postgresIdentifier(index.name)}`,
        `  ON ${postgresIdentifier(table.name)} (${index.columns.map((column) => `${postgresIdentifier(column.name)}${column.descending ? ' DESC' : ''}`).join(', ')})${indexWhereClause(index)};`,
      );
    }
  }

  if (validation.warnings.length) {
    lines.push('', '-- Compatibility warnings retained in schema.json:');
    for (const warning of validation.warnings) lines.push(`-- ${warning.code}: ${warning.table}${warning.column ? `.${warning.column}` : ''}`);
  }
  lines.push('', 'COMMIT;', '');
  return lines.join('\n');
}

function encodeDatabaseValue(value) {
  if (Buffer.isBuffer(value)) return { $binary: value.toString('base64') };
  if (typeof value === 'bigint') return { $integer: value.toString() };
  if (value === undefined) return null;
  return value;
}

function deterministicOrderColumns(table) {
  if (table.primaryKey.length) return table.primaryKey;
  return table.columns.map((column) => column.name);
}

function writeTableNdjson(db, table, filePath) {
  const columns = table.columns.map((column) => column.name);
  const ordering = deterministicOrderColumns(table).map((column) => postgresIdentifier(column)).join(', ');
  const statement = db.prepare(`SELECT * FROM ${sqliteIdentifier(table.name)}${ordering ? ` ORDER BY ${ordering}` : ''}`);
  const fd = fs.openSync(filePath, 'wx', 0o600);
  let rowCount = 0;
  try {
    for (const row of statement.iterate()) {
      const serialized = {};
      for (const column of columns) serialized[column] = encodeDatabaseValue(row[column]);
      fs.writeSync(fd, `${JSON.stringify(serialized)}\n`);
      rowCount += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (rowCount !== table.rowCount) {
    throw httpError(409, `Table '${table.name}' changed during export. Retry in maintenance mode.`, 'DB_EXPORT_CONCURRENT_CHANGE');
  }
  return rowCount;
}

function safeBundlePath(root, relativePath) {
  const target = path.resolve(root, relativePath);
  const base = path.resolve(root);
  if (!target.startsWith(`${base}${path.sep}`)) throw httpError(400, 'Migration bundle path escaped its root.', 'DB_BUNDLE_PATH_ESCAPE');
  return target;
}

async function fileRecord(root, relativePath) {
  const absolute = safeBundlePath(root, relativePath);
  const digest = await sha256File(absolute);
  return { path: relativePath, sha256: digest.sha256, size: digest.size };
}

export async function exportPostgresMigrationBundle(db, outputDir, {
  createdAt = new Date().toISOString(),
  sourceDatabase = 'kukgit.db',
} = {}) {
  const destination = path.resolve(outputDir);
  if (fs.existsSync(destination)) throw httpError(409, 'Migration bundle destination already exists.', 'DB_BUNDLE_DESTINATION_EXISTS');
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.mkdirSync(path.join(temporary, 'tables'), { recursive: true, mode: 0o700 });
  try {
    db.exec('BEGIN IMMEDIATE');
    let schema;
    try {
      schema = inspectSqliteSchema(db);
      const compatibility = validateSchemaForPostgres(schema);
      schema.compatibility = compatibility;
      if (!compatibility.compatible) throw httpError(409, 'Current SQLite schema is not automatically portable to PostgreSQL.', 'POSTGRES_SCHEMA_INCOMPATIBLE');

      fs.writeFileSync(path.join(temporary, 'schema.json'), canonicalJson(schema), { mode: 0o600, flag: 'wx' });
      fs.writeFileSync(path.join(temporary, 'postgresql.sql'), buildPostgresDdl(schema), { mode: 0o600, flag: 'wx' });

      const tableRecords = [];
      for (const tableName of schema.importOrder) {
        const table = schema.tables.find((candidate) => candidate.name === tableName);
        const relativePath = `tables/${table.name}.ndjson`;
        const absolutePath = safeBundlePath(temporary, relativePath);
        const rowCount = writeTableNdjson(db, table, absolutePath);
        tableRecords.push({
          name: table.name,
          ...await fileRecord(temporary, relativePath),
          rowCount,
          sensitiveColumns: table.sensitiveColumns,
        });
      }
      db.exec('COMMIT');

      const schemaFile = await fileRecord(temporary, 'schema.json');
      const postgresFile = await fileRecord(temporary, 'postgresql.sql');
      const manifest = {
        format: POSTGRES_MIGRATION_FORMAT,
        version: POSTGRES_MIGRATION_VERSION,
        createdAt,
        source: {
          engine: 'sqlite',
          database: path.basename(sourceDatabase),
          schemaVersion: schema.schemaVersion,
        },
        target: { engine: 'postgresql', schema: 'kukgit' },
        importOrder: schema.importOrder,
        dependencyCycles: schema.dependencyCycles,
        compatibility: schema.compatibility,
        files: { schema: schemaFile, postgresql: postgresFile, tables: tableRecords },
        totals: {
          tables: tableRecords.length,
          rows: tableRecords.reduce((sum, record) => sum + record.rowCount, 0),
          bytes: [schemaFile, postgresFile, ...tableRecords].reduce((sum, record) => sum + record.size, 0),
        },
        exclusions: [
          'Bare Git repositories remain under KUKGIT_DATA_DIR/repos.',
          'Git LFS object bytes remain under KUKGIT_LFS_DIR.',
          'Verified .kgbak backups remain under KUKGIT_BACKUPS_DIR.',
        ],
      };
      fs.writeFileSync(path.join(temporary, 'manifest.json'), canonicalJson(manifest), { mode: 0o600, flag: 'wx' });
      const manifestDigest = await sha256File(path.join(temporary, 'manifest.json'));
      fs.writeFileSync(path.join(temporary, 'manifest.sha256'), `${manifestDigest.sha256}  manifest.json\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, destination);
      fs.chmodSync(destination, 0o700);
      return { outputDir: destination, manifest, manifestSha256: manifestDigest.sha256 };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function countNdjsonRows(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content) return 0;
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    try { JSON.parse(line); }
    catch { throw httpError(400, `Migration table file '${path.basename(filePath)}' contains invalid JSON.`, 'DB_BUNDLE_TABLE_JSON_INVALID'); }
  }
  return lines.length;
}

async function verifyFile(root, record) {
  if (!record || typeof record.path !== 'string' || !/^[0-9a-f]{64}$/i.test(String(record.sha256 || ''))) {
    throw httpError(400, 'Migration manifest file record is invalid.', 'DB_BUNDLE_FILE_RECORD_INVALID');
  }
  const absolute = safeBundlePath(root, record.path);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw httpError(400, `Migration bundle file '${record.path}' is missing.`, 'DB_BUNDLE_FILE_MISSING');
  const digest = await sha256File(absolute);
  if (digest.sha256 !== record.sha256 || digest.size !== record.size) {
    throw httpError(400, `Migration bundle file '${record.path}' failed checksum verification.`, 'DB_BUNDLE_CHECKSUM_MISMATCH');
  }
  return absolute;
}

export async function verifyPostgresMigrationBundle(bundleDir) {
  const root = path.resolve(bundleDir);
  const manifestPath = safeBundlePath(root, 'manifest.json');
  const checksumPath = safeBundlePath(root, 'manifest.sha256');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(checksumPath)) throw httpError(404, 'Migration bundle manifest was not found.', 'DB_BUNDLE_MANIFEST_MISSING');
  const checksumLine = fs.readFileSync(checksumPath, 'utf8').trim();
  const expectedManifestHash = checksumLine.match(/^([0-9a-f]{64})\s+manifest\.json$/i)?.[1]?.toLowerCase();
  if (!expectedManifestHash) throw httpError(400, 'Migration manifest checksum file is invalid.', 'DB_BUNDLE_MANIFEST_CHECKSUM_INVALID');
  const manifestDigest = await sha256File(manifestPath);
  if (manifestDigest.sha256 !== expectedManifestHash) throw httpError(400, 'Migration manifest checksum does not match.', 'DB_BUNDLE_MANIFEST_CORRUPT');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { throw httpError(400, 'Migration manifest JSON is invalid.', 'DB_BUNDLE_MANIFEST_JSON_INVALID'); }
  if (manifest.format !== POSTGRES_MIGRATION_FORMAT || manifest.version !== POSTGRES_MIGRATION_VERSION) {
    throw httpError(400, 'Unsupported PostgreSQL migration bundle format.', 'DB_BUNDLE_FORMAT_UNSUPPORTED');
  }
  const schemaPath = await verifyFile(root, manifest.files?.schema);
  await verifyFile(root, manifest.files?.postgresql);
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  if (canonicalJson(schema) !== fs.readFileSync(schemaPath, 'utf8')) throw httpError(400, 'Migration schema JSON is not canonical.', 'DB_BUNDLE_SCHEMA_NOT_CANONICAL');
  const tableRecords = Array.isArray(manifest.files?.tables) ? manifest.files.tables : [];
  if (tableRecords.length !== manifest.totals?.tables) throw httpError(400, 'Migration table count does not match the manifest.', 'DB_BUNDLE_TABLE_COUNT_MISMATCH');
  let rows = 0;
  for (const record of tableRecords) {
    const tablePath = await verifyFile(root, record);
    const rowCount = countNdjsonRows(tablePath);
    if (rowCount !== record.rowCount) throw httpError(400, `Migration row count mismatch for '${record.name}'.`, 'DB_BUNDLE_ROW_COUNT_MISMATCH');
    rows += rowCount;
  }
  if (rows !== manifest.totals?.rows) throw httpError(400, 'Migration total row count does not match the manifest.', 'DB_BUNDLE_TOTAL_ROWS_MISMATCH');
  if (canonicalJson(manifest) !== fs.readFileSync(manifestPath, 'utf8')) throw httpError(400, 'Migration manifest JSON is not canonical.', 'DB_BUNDLE_MANIFEST_NOT_CANONICAL');
  return {
    valid: true,
    bundleDir: root,
    manifestSha256: manifestDigest.sha256,
    schemaVersion: manifest.source.schemaVersion,
    tables: tableRecords.length,
    rows,
    warnings: manifest.compatibility?.warnings ?? [],
  };
}
