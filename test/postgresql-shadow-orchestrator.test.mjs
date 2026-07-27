import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { buildSqliteManifest } from '../src/database-portability.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';
import { runPostgresqlShadowVerification } from '../src/postgresql-shadow-orchestrator.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-shadow-orchestrator-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  const seeded = seedCore(db, config);
  return { dataDir, config, db, ...seeded };
}

function adapterFactory(db, { mismatch = false, failQuery = false } = {}) {
  const lifecycle = [];
  const factory = async () => ({
    async connect() {
      lifecycle.push('connect');
      return {
        serverVersionNumber: '160002',
        schema: 'kukgit_shadow',
        sslMode: 'disable',
        databaseUrl: 'postgresql://shadow:***@localhost:5432/kukgit',
      };
    },
    async beginReadOnly() { lifecycle.push('beginReadOnly'); },
    async query(_sql, values) {
      lifecycle.push('query');
      if (failQuery) {
        const error = new Error('row contains owner@example.com and secret');
        error.code = 'POSTGRESQL_SHADOW_FAKE_FAILURE';
        throw error;
      }
      const row = db.prepare(`
        SELECT o.id, o.slug, o.name, o.plan, om.role
        FROM organizations o JOIN org_members om ON om.organization_id = o.id
        WHERE o.slug = ? AND om.user_id = ?
      `).get(...values);
      return { rows: row ? [{ ...row, ...(mismatch ? { role: 'viewer' } : {}) }] : [] };
    },
    async rollback() { lifecycle.push('rollback'); },
    async close() { lifecycle.push('close'); },
  });
  return { factory, lifecycle };
}

function adapterConfig() {
  return {
    databaseUrl: 'postgresql://shadow:top-secret@localhost:5432/kukgit',
    schema: 'kukgit_shadow',
    sslMode: 'disable',
    allowInsecure: true,
    applicationName: 'kukgit-shadow-test',
  };
}

test('orchestrator verifies live SQLite fingerprint and writes private evidence', async (t) => {
  const { db, dataDir } = setup(t);
  const manifest = buildSqliteManifest(db);
  const outputDirectory = path.join(dataDir, 'shadow-evidence');
  const mock = adapterFactory(db);
  const result = await runPostgresqlShadowVerification({
    sqlite: db,
    sourceManifest: manifest,
    confirmation: manifest.fingerprint,
    operator: 'owner@example.com',
    outputDirectory,
    enabled: true,
    runtimeDriver: 'sqlite',
    adapterConfig: adapterConfig(),
    adapterFactory: mock.factory,
    ids: ['organizations.access_by_slug_and_user'],
    sampleLimit: 5,
    readTimeoutMs: 1000,
  });
  assert.equal(result.status, 'verified');
  assert.deepEqual(mock.lifecycle, ['connect', 'beginReadOnly', 'query', 'rollback', 'close']);
  assert.equal(fs.statSync(result.statePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(result.reportPath).mode & 0o777, 0o600);
  const reportText = fs.readFileSync(result.reportPath, 'utf8');
  const report = JSON.parse(reportText);
  assert.equal(report.boundary.includes('SQLite remains authoritative'), true);
  assert.equal(report.connection.databaseUrl.includes('top-secret'), false);
  assert.equal(reportText.includes('secure-owner-password'), false);
  assert.equal(reportText.includes('owner@example.com'), true);
  assert.equal(report.summary.matched, 1);
});

test('orchestrator returns failed evidence for mismatch without changing authoritative result', async (t) => {
  const { db, dataDir } = setup(t);
  const manifest = buildSqliteManifest(db);
  const mock = adapterFactory(db, { mismatch: true });
  const result = await runPostgresqlShadowVerification({
    sqlite: db,
    sourceManifest: manifest,
    confirmation: manifest.fingerprint,
    operator: 'verified operator',
    outputDirectory: path.join(dataDir, 'mismatch'),
    enabled: true,
    runtimeDriver: 'sqlite',
    adapterConfig: adapterConfig(),
    adapterFactory: mock.factory,
    ids: ['organizations.access_by_slug_and_user'],
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.summary.mismatches, 1);
  const authoritative = db.prepare(`
    SELECT om.role FROM org_members om JOIN organizations o ON o.id = om.organization_id
    WHERE o.slug = 'kuklabs'
  `).get();
  assert.equal(authoritative.role, 'owner');
});

test('orchestrator guards enablement, SQLite runtime, exact confirmation and source drift', async (t) => {
  const { db, dataDir } = setup(t);
  const manifest = buildSqliteManifest(db);
  const base = {
    sqlite: db,
    sourceManifest: manifest,
    confirmation: manifest.fingerprint,
    operator: 'verified operator',
    outputDirectory: path.join(dataDir, 'guards'),
    adapterConfig: adapterConfig(),
    adapterFactory: adapterFactory(db).factory,
    ids: ['organizations.access_by_slug_and_user'],
  };
  await assert.rejects(() => runPostgresqlShadowVerification({ ...base, enabled: false }), (error) => error.code === 'POSTGRESQL_SHADOW_NOT_ENABLED');
  await assert.rejects(() => runPostgresqlShadowVerification({ ...base, enabled: true, runtimeDriver: 'postgresql' }), (error) => error.code === 'POSTGRESQL_SHADOW_RUNTIME_DRIVER_INVALID');
  await assert.rejects(() => runPostgresqlShadowVerification({ ...base, enabled: true, runtimeDriver: 'sqlite', confirmation: 'wrong' }), (error) => error.code === 'POSTGRESQL_SHADOW_CONFIRMATION_MISMATCH');
  db.prepare("UPDATE organizations SET name = 'Changed' WHERE slug = 'kuklabs'").run();
  await assert.rejects(() => runPostgresqlShadowVerification({ ...base, enabled: true, runtimeDriver: 'sqlite' }), (error) => error.code === 'POSTGRESQL_SHADOW_SOURCE_DRIFT');
});

test('orchestrator evidence redacts thrown error text and still rolls back and closes', async (t) => {
  const { db, dataDir } = setup(t);
  const manifest = buildSqliteManifest(db);
  const mock = adapterFactory(db, { failQuery: true });
  const outputDirectory = path.join(dataDir, 'errors');
  const result = await runPostgresqlShadowVerification({
    sqlite: db,
    sourceManifest: manifest,
    confirmation: manifest.fingerprint,
    operator: 'verified operator',
    outputDirectory,
    enabled: true,
    runtimeDriver: 'sqlite',
    adapterConfig: adapterConfig(),
    adapterFactory: mock.factory,
    ids: ['organizations.access_by_slug_and_user'],
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(mock.lifecycle, ['connect', 'beginReadOnly', 'query', 'rollback', 'close']);
  const text = fs.readFileSync(result.reportPath, 'utf8');
  assert.equal(text.includes('owner@example.com'), false);
  assert.equal(text.includes('secret'), false);
  assert.equal(text.includes('POSTGRESQL_SHADOW_FAKE_FAILURE'), true);
});
