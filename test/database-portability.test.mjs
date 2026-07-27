import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import {
  auditSqlPortability,
  buildSqliteManifest,
  createSqliteExport,
  readSqliteExport,
  verifySqliteAgainstManifest,
} from '../src/database-portability.mjs';
import {
  assertPostgresqlCutoverReady,
  createPostgresqlReadinessMarker,
  loadDatabaseSelection,
  redactPostgresqlUrl,
  validatePostgresqlReadiness,
} from '../src/database-selection.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-db-portability-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  const seeded = seedCore(db, config);
  db.prepare(`INSERT INTO audit_logs
    (id, organization_id, user_id, action, target_type, target_id, metadata_json)
    VALUES ('aud_portable', ?, ?, 'database.test', 'database', 'source', '{"safe":true}')`)
    .run(seeded.orgId, seeded.userId);
  return { dataDir, config, db, seeded };
}

test('SQLite manifest is deterministic and verifies row/schema changes', (t) => {
  const context = setup(t);
  const first = buildSqliteManifest(context.db);
  const second = buildSqliteManifest(context.db);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.foreignKeyFailures.length, 0);
  assert.ok(first.tableCount > 5);
  assert.ok(first.totalRows > 0);
  assert.equal(verifySqliteAgainstManifest(context.db, first).valid, true);

  context.db.prepare(`UPDATE users SET display_name = 'Changed Owner' WHERE id = ?`).run(context.seeded.userId);
  const changed = verifySqliteAgainstManifest(context.db, first);
  assert.equal(changed.valid, false);
  assert.ok(changed.differences.some((difference) => difference.table === 'users' && difference.type === 'row_checksum'));
});

test('database export is permission-restricted and detects tampering', (t) => {
  const context = setup(t);
  const target = path.join(context.dataDir, 'migration', 'metadata.kgdb.json');
  const created = createSqliteExport(context.db, target);
  assert.equal(created.path, target);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  const verified = readSqliteExport(target);
  assert.equal(verified.manifest.fingerprint, created.manifest.fingerprint);
  assert.equal(verified.manifest.foreignKeyFailures.length, 0);

  const bundle = JSON.parse(fs.readFileSync(target, 'utf8'));
  const users = bundle.tables.find((table) => table.name === 'users');
  users.rows[0].display_name = 'Tampered';
  fs.writeFileSync(target, JSON.stringify(bundle));
  assert.throws(() => readSqliteExport(target), /checksum mismatch/i);
});

test('SQL portability audit identifies blocking SQLite constructs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-sql-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'sample.mjs'), `
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare("INSERT OR IGNORE INTO jobs (id) VALUES (?)").run(id);
    db.prepare("SELECT datetime('now'), rowid FROM jobs").all();
  `);
  const report = auditSqlPortability(root);
  assert.ok(report.blockingCount >= 4);
  assert.ok(report.byRule.pragma);
  assert.ok(report.byRule['insert-or']);
  assert.ok(report.byRule['sqlite-datetime']);
  assert.ok(report.byRule.rowid);
  assert.ok(report.byRule['question-placeholders']);
});

test('PostgreSQL URL redaction never exposes credentials', () => {
  const redacted = redactPostgresqlUrl('postgresql://kukgit:super-secret@db.example.com:5432/kukgit?sslmode=require&api_token=abc');
  assert.equal(redacted.includes('super-secret'), false);
  assert.equal(redacted.includes('abc'), false);
  assert.match(redacted, /%2A%2A%2A|\*\*\*/);
  assert.match(redacted, /db\.example\.com/);
  assert.throws(() => loadDatabaseSelection({ driver: 'postgresql', databaseUrl: 'https://example.com/db' }), /postgres/i);
});

test('PostgreSQL cutover requires an untampered verified readiness marker', (t) => {
  const context = setup(t);
  const source = buildSqliteManifest(context.db);
  const markerPath = path.join(context.dataDir, 'postgres-ready.json');
  const selection = loadDatabaseSelection({
    driver: 'postgresql',
    databaseUrl: 'postgresql://kukgit:password@db.example.com/kukgit',
    readinessMarkerPath: markerPath,
    requireVerifiedCutover: true,
  });
  assert.equal(validatePostgresqlReadiness(selection, source.fingerprint).ready, false);
  assert.throws(() => assertPostgresqlCutoverReady(selection, source.fingerprint), /not ready/i);

  createPostgresqlReadinessMarker({
    markerPath,
    sourceManifest: source,
    target: {
      host: 'db.example.com',
      database: 'kukgit',
      schema: 'public',
      schemaFingerprint: 'schema-fingerprint',
      rowFingerprint: 'row-fingerprint',
    },
    verification: {
      valid: true,
      foreignKeyFailures: 0,
      missingTables: 0,
      rowCountDifferences: 0,
      checksumDifferences: 0,
    },
    operator: 'support@kuklabs.com',
  });
  assert.equal(validatePostgresqlReadiness(selection, source.fingerprint).ready, true);
  assert.equal(assertPostgresqlCutoverReady(selection, source.fingerprint).driver, 'postgresql');

  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  marker.target.database = 'other';
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  const tampered = validatePostgresqlReadiness(selection, source.fingerprint);
  assert.equal(tampered.ready, false);
  assert.equal(tampered.reason, 'POSTGRESQL_MARKER_CHECKSUM_INVALID');
});
