import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import {
  auditSqlPortability,
  buildSqliteManifest,
  createSqliteExport,
  readSqliteExport,
  verifySqliteAgainstManifest,
} from '../src/database-portability.mjs';
import {
  loadDatabaseSelection,
  readPostgresqlReadinessMarker,
  validatePostgresqlReadiness,
} from '../src/database-selection.mjs';
import {
  buildPostgresqlImportPlan,
  buildPostgresqlSchemaPlan,
  createPostgresqlImportReceipt,
  renderPostgresqlSchemaSql,
  safePostgresqlImportPlan,
  verifyPostgresqlTargetSnapshot,
} from '../src/postgresql-import-plan.mjs';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function writeFileAtomic(target, content) {
  const absolute = path.resolve(target);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, absolute);
  try { fs.chmodSync(absolute, 0o600); } catch {}
  return absolute;
}

function writeJson(target, payload) {
  return writeFileAtomic(target, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(target) {
  return JSON.parse(fs.readFileSync(path.resolve(target), 'utf8'));
}

const command = process.argv[2] || 'status';
const config = loadConfig();
const migrationDir = path.resolve(argument('--directory', path.join(config.dataDir, 'database-migration')));

if (command === 'audit-sql') {
  const roots = [path.join(config.root, 'src'), path.join(config.root, 'scripts')];
  const reports = roots.map((root) => auditSqlPortability(root));
  const findings = reports.flatMap((report) => report.findings);
  const report = {
    format: 'kukgit-sql-portability-audit/1',
    generatedAt: new Date().toISOString(),
    roots,
    findingCount: findings.reduce((sum, finding) => sum + finding.count, 0),
    blockingCount: findings.filter((finding) => finding.severity === 'blocking').reduce((sum, finding) => sum + finding.count, 0),
    findings,
  };
  const target = writeJson(argument('--output', path.join(migrationDir, 'sql-portability.json')), report);
  print({ command, target, findingCount: report.findingCount, blockingCount: report.blockingCount });
  process.exit(report.blockingCount && flag('--fail-on-blocking') ? 2 : 0);
}

if (command === 'verify-export') {
  const input = argument('--input');
  if (!input) fail('Use --input <file.kgdb.json>.');
  const result = readSqliteExport(input);
  print({
    command,
    valid: true,
    path: result.path,
    bundleChecksum: result.bundleChecksum,
    fingerprint: result.manifest.fingerprint,
    tableCount: result.manifest.tableCount,
    totalRows: result.manifest.totalRows,
  });
  process.exit(0);
}

if (command === 'postgresql-schema' || command === 'postgresql-plan' || command === 'verify-postgresql-target' || command === 'postgresql-receipt') {
  const input = argument('--input');
  if (!input) fail('Use --input <file.kgdb.json>.');
  const exportResult = readSqliteExport(input);
  const batchSize = Number(argument('--batch-size', '250'));
  if (command === 'postgresql-schema') {
    const plan = buildPostgresqlSchemaPlan(exportResult.manifest);
    const target = writeFileAtomic(
      argument('--output', path.join(migrationDir, 'postgresql-schema.sql')),
      renderPostgresqlSchemaSql(plan),
    );
    print({
      command,
      target,
      sourceFingerprint: plan.sourceFingerprint,
      schemaFingerprint: plan.fingerprint,
      tableCount: plan.tableCount,
      totalRows: plan.totalRows,
      boundary: 'Table DDL only. Secondary indexes, triggers and runtime cutover remain disabled.',
    });
    process.exit(0);
  }

  const importPlan = buildPostgresqlImportPlan(exportResult, { batchSize });
  if (command === 'postgresql-plan') {
    const safePlan = safePostgresqlImportPlan(importPlan);
    const target = writeJson(argument('--output', path.join(migrationDir, 'postgresql-import-plan.json')), safePlan);
    print({ command, target, ...safePlan, operations: undefined, tables: undefined });
    process.exit(0);
  }

  const targetManifestPath = argument('--target-manifest');
  if (!targetManifestPath) fail('Use --target-manifest <postgresql-target-manifest.json>.');
  const targetSnapshot = readJson(targetManifestPath);
  const verification = verifyPostgresqlTargetSnapshot(exportResult.manifest, targetSnapshot);
  if (command === 'verify-postgresql-target') {
    const output = argument('--output');
    const reportPath = output ? writeJson(output, verification) : null;
    print({ command, reportPath, ...verification });
    process.exit(verification.valid ? 0 : 2);
  }

  const receipt = createPostgresqlImportReceipt({
    sourceManifest: exportResult.manifest,
    importPlan,
    targetSnapshot,
    operator: argument('--operator'),
  });
  const target = writeJson(argument('--output', path.join(migrationDir, 'postgresql-import-receipt.json')), receipt);
  print({ command, target, ...receipt });
  process.exit(0);
}

if (command === 'postgresql-status') {
  const selection = loadDatabaseSelection({ dataDir: config.dataDir });
  const status = validatePostgresqlReadiness(selection, argument('--source-fingerprint'));
  print({
    command,
    driver: selection.driver,
    databaseUrl: selection.redactedDatabaseUrl,
    readinessMarkerPath: selection.readinessMarkerPath,
    requireVerifiedCutover: selection.requireVerifiedCutover,
    readiness: status,
  });
  process.exit(status.ready ? 0 : 2);
}

if (command === 'readiness-marker') {
  const selection = loadDatabaseSelection({ dataDir: config.dataDir });
  print({ command, marker: readPostgresqlReadinessMarker(selection.readinessMarkerPath) });
  process.exit(0);
}

const db = openDatabase(config);
try {
  if (command === 'status' || command === 'inventory') {
    const manifest = buildSqliteManifest(db);
    const output = argument('--output');
    const target = output ? writeJson(output, manifest) : null;
    print({
      command,
      engine: manifest.engine,
      databasePath: config.databasePath,
      fingerprint: manifest.fingerprint,
      tableCount: manifest.tableCount,
      totalRows: manifest.totalRows,
      foreignKeyFailures: manifest.foreignKeyFailures.length,
      manifestPath: target,
      tables: flag('--tables') ? manifest.tables.map((table) => ({
        name: table.name,
        rowCount: table.rowCount,
        schemaChecksum: table.schemaChecksum,
        rowChecksum: table.rowChecksum,
      })) : undefined,
    });
  } else if (command === 'export') {
    const target = argument('--output', path.join(migrationDir, `kukgit-metadata-${Date.now()}.kgdb.json`));
    const result = createSqliteExport(db, target);
    print({
      command,
      path: result.path,
      sizeBytes: result.sizeBytes,
      bundleChecksum: result.bundleChecksum,
      fingerprint: result.manifest.fingerprint,
      tableCount: result.manifest.tableCount,
      totalRows: result.manifest.totalRows,
      warning: 'This export contains full metadata and must be protected like a database backup.',
    });
  } else if (command === 'verify-live') {
    const manifestPath = argument('--manifest');
    if (!manifestPath) fail('Use --manifest <manifest.json>.');
    const manifest = readJson(manifestPath);
    const verification = verifySqliteAgainstManifest(db, manifest);
    print({ command, ...verification });
    if (!verification.valid) process.exitCode = 2;
  } else {
    fail('Commands: status, inventory, export, verify-export, verify-live, audit-sql, postgresql-schema, postgresql-plan, verify-postgresql-target, postgresql-receipt, postgresql-status, readiness-marker.');
  }
} finally {
  db.close();
}
