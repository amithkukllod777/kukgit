import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const EXPORT_FORMAT = 'kukgit-sqlite-export/1';
const MANIFEST_FORMAT = 'kukgit-database-manifest/1';
const SOURCE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs']);
const SQL_PATTERNS = [
  { id: 'pragma', severity: 'blocking', pattern: /\bPRAGMA\b/gi, guidance: 'Move PRAGMA behavior behind the SQLite driver.' },
  { id: 'sqlite-datetime', severity: 'blocking', pattern: /\b(?:datetime|julianday|strftime)\s*\(/gi, guidance: 'Replace SQLite date functions with adapter-owned clock expressions.' },
  { id: 'insert-or', severity: 'blocking', pattern: /\bINSERT\s+OR\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\b/gi, guidance: 'Translate to PostgreSQL ON CONFLICT or explicit transaction logic.' },
  { id: 'rowid', severity: 'blocking', pattern: /\browid\b/gi, guidance: 'Use declared primary keys instead of SQLite rowid.' },
  { id: 'sqlite-master', severity: 'blocking', pattern: /\bsqlite_master\b/gi, guidance: 'Use driver schema-inspection APIs.' },
  { id: 'last-insert-rowid', severity: 'blocking', pattern: /last_insert_rowid\s*\(/gi, guidance: 'Use INSERT ... RETURNING through the driver.' },
  { id: 'begin-immediate', severity: 'translation', pattern: /\bBEGIN\s+IMMEDIATE\b/gi, guidance: 'Map to an explicit PostgreSQL transaction and lock strategy.' },
  { id: 'question-placeholders', severity: 'translation', pattern: /\?/g, guidance: 'Compile positional parameters for the selected driver.' },
  { id: 'collate-nocase', severity: 'translation', pattern: /\bCOLLATE\s+NOCASE\b/gi, guidance: 'Use normalized columns or a PostgreSQL-compatible collation strategy.' },
  { id: 'autoincrement', severity: 'translation', pattern: /\bAUTOINCREMENT\b/gi, guidance: 'Use identity columns or sequences.' },
];

function quoteIdentifier(value) {
  const name = String(value);
  if (!name || name.includes('\0')) throw new Error('Invalid SQL identifier.');
  return `"${name.replaceAll('"', '""')}"`;
}

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

function tableNames(db) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
}

function tableSchema(db, table) {
  return db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)?.sql || '';
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => ({
    name: row.name,
    type: row.type || '',
    notNull: Boolean(row.notnull),
    defaultValue: row.dflt_value,
    primaryKeyOrder: Number(row.pk || 0),
  }));
}

function tableRows(db, table) {
  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all().map((row) => stableValue(row));
  rows.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return rows;
}

function tableRecord(db, table, { includeRows = false } = {}) {
  const schema = tableSchema(db, table);
  const columns = tableColumns(db, table);
  const rows = tableRows(db, table);
  const checksum = sha256(rows.map(stableJson).join('\n'));
  const record = {
    name: table,
    schema,
    schemaChecksum: sha256(schema),
    columns,
    rowCount: rows.length,
    rowChecksum: checksum,
  };
  if (includeRows) record.rows = rows;
  return record;
}

function foreignKeyFailures(db) {
  return db.prepare('PRAGMA foreign_key_check').all().map((row) => ({
    table: row.table,
    rowid: row.rowid,
    parent: row.parent,
    foreignKeyIndex: row.fkid,
  }));
}

export function buildSqliteManifest(db) {
  const tables = tableNames(db).map((table) => tableRecord(db, table));
  const failures = foreignKeyFailures(db);
  const fingerprint = sha256(stableJson(tables.map((table) => ({
    name: table.name,
    schemaChecksum: table.schemaChecksum,
    rowCount: table.rowCount,
    rowChecksum: table.rowChecksum,
  }))));
  return {
    format: MANIFEST_FORMAT,
    generatedAt: new Date().toISOString(),
    engine: 'sqlite',
    tableCount: tables.length,
    totalRows: tables.reduce((sum, table) => sum + table.rowCount, 0),
    foreignKeyFailures: failures,
    fingerprint,
    tables,
  };
}

export function createSqliteExport(db, outputPath) {
  const target = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tables = tableNames(db).map((table) => tableRecord(db, table, { includeRows: true }));
  const manifestTables = tables.map(({ rows, ...record }) => record);
  const manifest = {
    format: MANIFEST_FORMAT,
    generatedAt: new Date().toISOString(),
    engine: 'sqlite',
    tableCount: manifestTables.length,
    totalRows: manifestTables.reduce((sum, table) => sum + table.rowCount, 0),
    foreignKeyFailures: foreignKeyFailures(db),
    fingerprint: sha256(stableJson(manifestTables.map((table) => ({
      name: table.name,
      schemaChecksum: table.schemaChecksum,
      rowCount: table.rowCount,
      rowChecksum: table.rowChecksum,
    })))),
    tables: manifestTables,
  };
  const bundleWithoutChecksum = {
    format: EXPORT_FORMAT,
    createdAt: new Date().toISOString(),
    source: { engine: 'sqlite', manifest },
    tables: tables.map(({ name, rows }) => ({ name, rows })),
  };
  const bundle = {
    ...bundleWithoutChecksum,
    bundleChecksum: sha256(stableJson(bundleWithoutChecksum)),
  };
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(bundle)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, target);
  try { fs.chmodSync(target, 0o600); } catch {}
  return {
    path: target,
    manifest,
    bundleChecksum: bundle.bundleChecksum,
    sizeBytes: fs.statSync(target).size,
  };
}

export function readSqliteExport(inputPath) {
  const source = path.resolve(inputPath);
  const bundle = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (bundle.format !== EXPORT_FORMAT) throw new Error('Unsupported KukGit database export format.');
  const { bundleChecksum, ...withoutChecksum } = bundle;
  const actualBundleChecksum = sha256(stableJson(withoutChecksum));
  if (!bundleChecksum || bundleChecksum !== actualBundleChecksum) throw new Error('Database export bundle checksum mismatch.');
  const manifest = bundle.source?.manifest;
  if (manifest?.format !== MANIFEST_FORMAT) throw new Error('Database export manifest is missing or unsupported.');
  if (manifest.foreignKeyFailures?.length) throw new Error('Database export contains foreign-key violations.');
  const tableMap = new Map((bundle.tables || []).map((table) => [table.name, table]));
  for (const record of manifest.tables || []) {
    const table = tableMap.get(record.name);
    if (!table) throw new Error(`Database export table is missing: ${record.name}`);
    const rows = (table.rows || []).map(stableValue).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
    if (rows.length !== record.rowCount) throw new Error(`Database export row count mismatch: ${record.name}`);
    if (sha256(rows.map(stableJson).join('\n')) !== record.rowChecksum) {
      throw new Error(`Database export row checksum mismatch: ${record.name}`);
    }
  }
  return { path: source, bundle, manifest, bundleChecksum };
}

export function verifySqliteAgainstManifest(db, manifest) {
  if (manifest?.format !== MANIFEST_FORMAT) throw new Error('Unsupported database manifest.');
  const current = buildSqliteManifest(db);
  const expectedByName = new Map(manifest.tables.map((table) => [table.name, table]));
  const currentByName = new Map(current.tables.map((table) => [table.name, table]));
  const differences = [];
  for (const name of [...new Set([...expectedByName.keys(), ...currentByName.keys()])].sort()) {
    const expected = expectedByName.get(name);
    const actual = currentByName.get(name);
    if (!expected) differences.push({ table: name, type: 'unexpected_table' });
    else if (!actual) differences.push({ table: name, type: 'missing_table' });
    else {
      if (expected.schemaChecksum !== actual.schemaChecksum) differences.push({ table: name, type: 'schema_checksum', expected: expected.schemaChecksum, actual: actual.schemaChecksum });
      if (expected.rowCount !== actual.rowCount) differences.push({ table: name, type: 'row_count', expected: expected.rowCount, actual: actual.rowCount });
      if (expected.rowChecksum !== actual.rowChecksum) differences.push({ table: name, type: 'row_checksum', expected: expected.rowChecksum, actual: actual.rowChecksum });
    }
  }
  return {
    valid: differences.length === 0 && current.foreignKeyFailures.length === 0,
    expectedFingerprint: manifest.fingerprint,
    actualFingerprint: current.fingerprint,
    foreignKeyFailures: current.foreignKeyFailures,
    differences,
  };
}

function walkSourceFiles(root) {
  const files = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(target);
    }
  };
  visit(path.resolve(root));
  return files.sort();
}

export function auditSqlPortability(root) {
  const base = path.resolve(root);
  const findings = [];
  for (const file of walkSourceFiles(base)) {
    const relativePath = path.relative(base, file).replaceAll(path.sep, '/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of SQL_PATTERNS) {
        rule.pattern.lastIndex = 0;
        const matches = [...line.matchAll(rule.pattern)];
        if (!matches.length) continue;
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          file: relativePath,
          line: index + 1,
          count: matches.length,
          guidance: rule.guidance,
          excerpt: line.trim().slice(0, 240),
        });
      }
    });
  }
  const byRule = {};
  for (const finding of findings) {
    byRule[finding.rule] ||= { severity: finding.severity, occurrences: 0, files: new Set() };
    byRule[finding.rule].occurrences += finding.count;
    byRule[finding.rule].files.add(finding.file);
  }
  return {
    format: 'kukgit-sql-portability-audit/1',
    generatedAt: new Date().toISOString(),
    root: base,
    fileCount: new Set(findings.map((finding) => finding.file)).size,
    findingCount: findings.reduce((sum, finding) => sum + finding.count, 0),
    blockingCount: findings.filter((finding) => finding.severity === 'blocking').reduce((sum, finding) => sum + finding.count, 0),
    byRule: Object.fromEntries(Object.entries(byRule).map(([rule, value]) => [rule, {
      severity: value.severity,
      occurrences: value.occurrences,
      files: [...value.files].sort(),
    }])),
    findings,
  };
}

export const DATABASE_EXPORT_FORMAT = EXPORT_FORMAT;
export const DATABASE_MANIFEST_FORMAT = MANIFEST_FORMAT;
