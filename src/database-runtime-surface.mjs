import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs']);
const CALL_PATTERN = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*(prepare|exec|transaction)\s*\(/g;

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

function walk(root) {
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

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function readStringArgument(source, start) {
  let index = start;
  while (/\s/.test(source[index] || '')) index += 1;
  const quote = source[index];
  if (!["'", '"', '`'].includes(quote)) return { dynamic: true, end: index };
  let value = '';
  let interpolated = false;
  for (index += 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      value += character;
      if (index + 1 < source.length) value += source[++index];
      continue;
    }
    if (quote === '`' && character === '$' && source[index + 1] === '{') interpolated = true;
    if (character === quote) return { value, interpolated, dynamic: false, end: index + 1 };
    value += character;
  }
  return { dynamic: true, unterminated: true, end: source.length };
}

function normalizeSql(value) {
  return String(value || '').replace(/\\`/g, '`').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();
}

function operation(sql, method) {
  if (method === 'transaction') return 'transaction';
  const keyword = String(sql || '').match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() || '';
  if (['SELECT', 'WITH', 'VALUES'].includes(keyword)) return 'read';
  if (keyword === 'PRAGMA') return 'schema_read';
  if (['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(keyword)) return 'write';
  if (['CREATE', 'ALTER', 'DROP', 'VACUUM', 'REINDEX'].includes(keyword)) return 'ddl';
  return method === 'exec' ? 'batch_or_ddl' : 'unknown';
}

function portability(sql) {
  const value = String(sql || '');
  const findings = [];
  const rules = [
    ['pragma', /\bPRAGMA\b/i],
    ['question_placeholders', /\?/],
    ['sqlite_datetime', /\b(?:datetime|julianday|strftime)\s*\(/i],
    ['insert_or', /\bINSERT\s+OR\s+/i],
    ['rowid', /\browid\b/i],
    ['sqlite_master', /\bsqlite_master\b/i],
    ['last_insert_rowid', /last_insert_rowid\s*\(/i],
    ['begin_immediate', /\bBEGIN\s+IMMEDIATE\b/i],
    ['collate_nocase', /\bCOLLATE\s+NOCASE\b/i],
    ['autoincrement', /\bAUTOINCREMENT\b/i],
  ];
  for (const [id, pattern] of rules) if (pattern.test(value)) findings.push(id);
  return findings;
}

export function inventoryDatabaseRuntimeSurface(roots) {
  const rootList = (Array.isArray(roots) ? roots : [roots]).map((root) => path.resolve(root));
  const files = [...new Set(rootList.flatMap(walk))].sort();
  const calls = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    CALL_PATTERN.lastIndex = 0;
    for (const match of source.matchAll(CALL_PATTERN)) {
      const argument = readStringArgument(source, match.index + match[0].length);
      const dynamic = match[2] === 'transaction' ? false : Boolean(argument.dynamic || argument.interpolated);
      const sql = dynamic || match[2] === 'transaction' ? null : normalizeSql(argument.value);
      const relativeRoot = rootList.find((root) => file === root || file.startsWith(`${root}${path.sep}`)) || path.dirname(file);
      const record = {
        file: path.relative(relativeRoot, file).replaceAll(path.sep, '/'),
        root: relativeRoot,
        line: lineNumber(source, match.index),
        receiver: match[1],
        method: match[2],
        dynamic,
        operation: operation(sql, match[2]),
        sqlFingerprint: sql ? sha256(sql) : null,
        portabilityFindings: sql ? portability(sql) : match[2] === 'transaction' ? [] : ['dynamic_sql'],
        sqlPreview: sql ? sql.slice(0, 240) : null,
      };
      calls.push(record);
    }
  }
  calls.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.method.localeCompare(right.method));
  const counts = {
    files: new Set(calls.map((call) => `${call.root}:${call.file}`)).size,
    calls: calls.length,
    reads: calls.filter((call) => call.operation === 'read' || call.operation === 'schema_read').length,
    writes: calls.filter((call) => call.operation === 'write').length,
    ddl: calls.filter((call) => call.operation === 'ddl' || call.operation === 'batch_or_ddl').length,
    transactions: calls.filter((call) => call.operation === 'transaction').length,
    dynamic: calls.filter((call) => call.dynamic).length,
    portableWithoutFindings: calls.filter((call) => !call.dynamic && call.portabilityFindings.length === 0).length,
  };
  const fingerprint = sha256(stableJson(calls.map(({ root, sqlPreview, ...call }) => call)));
  return {
    format: 'kukgit-database-runtime-surface/1',
    generatedAt: new Date().toISOString(),
    roots: rootList,
    counts,
    fingerprint,
    calls,
  };
}

export function safeRuntimeSurfaceReport(report) {
  if (report?.format !== 'kukgit-database-runtime-surface/1') throw new Error('A valid database runtime surface report is required.');
  return {
    format: report.format,
    generatedAt: report.generatedAt,
    counts: { ...report.counts },
    fingerprint: report.fingerprint,
    calls: report.calls.map(({ root, ...call }) => call),
  };
}
