import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import {
  buildPostgresDdl,
  canonicalJson,
  inspectSqliteSchema,
  validateSchemaForPostgres,
} from '../src/database-portability.mjs';
import {
  exportSafePostgresMigrationBundle,
  verifySafePostgresMigrationBundle,
} from '../src/database-portability-safe.mjs';
import {
  currentSchemaVersion,
  KUKGIT_SCHEMA_VERSION,
  migrateApplicationSchema,
  migratePostSeedSchema,
} from '../src/migrations.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-postgres-foundation-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    authMode: 'local',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Database Owner',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateApplicationSchema(db);
  const seeded = seedCore(db, config);
  migratePostSeedSchema(db);

  const repositoryId = uid('repo');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'portable-demo', 'Portable Demo', 'PostgreSQL migration fixture', 'private', 'main', ?)
  `).run(repositoryId, seeded.orgId, seeded.userId);
  db.prepare(`
    INSERT INTO issues
      (id, repository_id, number, title, body, status, priority, author_id)
    VALUES (?, ?, 1, 'Verify PostgreSQL export', 'Migration fixture', 'open', 'high', ?)
  `).run(uid('iss'), repositoryId, seeded.userId);
  db.prepare(`
    INSERT INTO personal_access_tokens
      (id, user_id, name, token_hash, token_prefix, scopes_json, expires_at)
    VALUES (?, ?, 'Migration fixture token', ?, 'kgp_fixture', '["repo:read"]', datetime('now', '+7 days'))
  `).run(uid('pat'), seeded.userId, 'a'.repeat(64));

  return { config, db, seeded, repositoryId, dataDir };
}

function table(schema, name) {
  const value = schema.tables.find((candidate) => candidate.name === name);
  assert.ok(value, `Expected table ${name}`);
  return value;
}

function recursiveFiles(root) {
  const files = [];
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else files.push(relative);
    }
  }
  walk(root);
  return files;
}

test('central migration runner records a complete stable schema and foreign-key-safe order', (t) => {
  const context = setup(t);
  const schema = inspectSqliteSchema(context.db);

  assert.equal(currentSchemaVersion(context.db), KUKGIT_SCHEMA_VERSION);
  assert.equal(schema.schemaVersion, KUKGIT_SCHEMA_VERSION);
  assert.ok(schema.tables.length >= 35);
  assert.equal(schema.dependencyCycles.length, 0);

  for (const name of [
    'users', 'sessions', 'organizations', 'org_members', 'teams', 'team_members',
    'repositories', 'issues', 'pull_requests', 'repository_collaborators',
    'repository_invitations', 'notifications', 'email_outbox', 'webhook_deliveries',
    'lfs_objects', 'repository_lfs_objects', 'lfs_pending_uploads',
    'kukgit_schema_metadata',
  ]) table(schema, name);

  const position = (name) => schema.importOrder.indexOf(name);
  assert.ok(position('users') < position('sessions'));
  assert.ok(position('users') < position('organizations'));
  assert.ok(position('organizations') < position('repositories'));
  assert.ok(position('repositories') < position('issues'));
  assert.ok(position('repositories') < position('pull_requests'));
  assert.ok(position('teams') < position('team_members'));
  assert.ok(position('lfs_objects') < position('repository_lfs_objects'));

  assert.equal(table(schema, 'users').sensitiveColumns.includes('password_hash'), true);
  assert.equal(table(schema, 'sessions').sensitiveColumns.includes('authkit_refresh_ciphertext'), true);
  assert.equal(table(schema, 'personal_access_tokens').rowCount, 1);
  assert.equal(table(schema, 'issues').rowCount, 1);

  context.db.prepare(`
    UPDATE kukgit_schema_metadata SET updated_at = '2000-01-01T00:00:00.000Z'
    WHERE key = 'schema_version'
  `).run();
  migratePostSeedSchema(context.db);
  const metadata = context.db.prepare(`
    SELECT value, updated_at AS updatedAt FROM kukgit_schema_metadata
    WHERE key = 'schema_version'
  `).get();
  assert.equal(metadata.value, KUKGIT_SCHEMA_VERSION);
  assert.equal(metadata.updatedAt, '2000-01-01T00:00:00.000Z');
});

test('generates PostgreSQL DDL for every current table without SQLite runtime syntax', (t) => {
  const context = setup(t);
  const schema = inspectSqliteSchema(context.db);
  const validation = validateSchemaForPostgres(schema);
  assert.equal(validation.compatible, true, JSON.stringify(validation.errors));

  const ddl = buildPostgresDdl(schema);
  assert.match(ddl, /CREATE SCHEMA IF NOT EXISTS "kukgit";/);
  assert.match(ddl, /CREATE TABLE "users"/);
  assert.match(ddl, /CREATE TABLE "repositories"/);
  assert.match(ddl, /ALTER TABLE "issues" ADD CONSTRAINT/);
  assert.match(ddl, /REFERENCES "repositories" \("id"\)/);
  assert.match(ddl, /CREATE INDEX "idx_repositories_org"/);
  assert.doesNotMatch(ddl, /\bPRAGMA\b/i);
  assert.doesNotMatch(ddl, /\bAUTOINCREMENT\b/i);
  assert.doesNotMatch(ddl, /sqlite_master/i);
  assert.match(ddl, /BEGIN;[\s\S]*COMMIT;/);

  const createdTables = [...ddl.matchAll(/CREATE TABLE "([A-Za-z0-9_]+)"/g)].map((match) => match[1]);
  assert.equal(createdTables.length, schema.tables.length);
  assert.deepEqual(createdTables, schema.importOrder);
});

test('exports deterministic checksummed bundles and verifies row counts', async (t) => {
  const context = setup(t);
  const first = path.join(context.dataDir, 'bundle-a');
  const second = path.join(context.dataDir, 'bundle-b');
  const createdAt = '2026-07-27T00:00:00.000Z';

  const exportA = await exportSafePostgresMigrationBundle(context.db, first, {
    createdAt,
    sourceDatabase: context.config.databasePath,
  });
  const exportB = await exportSafePostgresMigrationBundle(context.db, second, {
    createdAt,
    sourceDatabase: context.config.databasePath,
  });

  assert.equal(exportA.manifestSha256, exportB.manifestSha256);
  assert.deepEqual(recursiveFiles(first), recursiveFiles(second));
  for (const relative of recursiveFiles(first)) {
    assert.deepEqual(fs.readFileSync(path.join(first, relative)), fs.readFileSync(path.join(second, relative)), relative);
  }

  const verification = await verifySafePostgresMigrationBundle(first);
  assert.equal(verification.valid, true);
  assert.equal(verification.schemaVersion, KUKGIT_SCHEMA_VERSION);
  assert.equal(verification.tables, exportA.manifest.totals.tables);
  assert.equal(verification.rows, exportA.manifest.totals.rows);
  assert.ok(verification.rows >= 8);

  const manifestRaw = fs.readFileSync(path.join(first, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifestRaw, canonicalJson(manifest));
  assert.equal(manifest.source.database, 'kukgit.db');
  assert.equal(manifest.exclusions.some((entry) => entry.includes('Bare Git repositories')), true);
  assert.doesNotMatch(manifestRaw, /secure-owner-password/);
  assert.doesNotMatch(manifestRaw, /a{64}/);

  const patRecord = manifest.files.tables.find((record) => record.name === 'personal_access_tokens');
  assert.ok(patRecord);
  assert.deepEqual(patRecord.sensitiveColumns.sort(), ['token_hash', 'token_prefix'].sort());
  const patRows = fs.readFileSync(path.join(first, patRecord.path), 'utf8');
  assert.match(patRows, /"token_hash":"a{64}"/);
});

test('verification rejects table tampering, manifest tampering and existing destinations', async (t) => {
  const context = setup(t);
  const bundle = path.join(context.dataDir, 'bundle');
  const result = await exportSafePostgresMigrationBundle(context.db, bundle, {
    createdAt: '2026-07-27T00:00:00.000Z',
    sourceDatabase: context.config.databasePath,
  });

  await assert.rejects(
    exportSafePostgresMigrationBundle(context.db, bundle),
    (error) => error.code === 'DB_BUNDLE_DESTINATION_EXISTS',
  );

  const usersRecord = result.manifest.files.tables.find((record) => record.name === 'users');
  fs.appendFileSync(path.join(bundle, usersRecord.path), '{"tampered":true}\n');
  await assert.rejects(
    verifySafePostgresMigrationBundle(bundle),
    (error) => error.code === 'DB_BUNDLE_CHECKSUM_MISMATCH',
  );

  const cleanBundle = path.join(context.dataDir, 'clean-bundle');
  await exportSafePostgresMigrationBundle(context.db, cleanBundle, {
    createdAt: '2026-07-27T00:00:00.000Z',
    sourceDatabase: context.config.databasePath,
  });
  const manifestPath = path.join(cleanBundle, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.totals.rows += 1;
  fs.writeFileSync(manifestPath, canonicalJson(manifest));
  await assert.rejects(
    verifySafePostgresMigrationBundle(cleanBundle),
    (error) => error.code === 'DB_BUNDLE_MANIFEST_CORRUPT',
  );
});

test('safe verification rejects symbolic-link substitution even when file bytes match', async (t) => {
  if (process.platform === 'win32') return t.skip('Symbolic-link permissions differ on Windows test runners.');
  const context = setup(t);
  const bundle = path.join(context.dataDir, 'symlink-bundle');
  const result = await exportSafePostgresMigrationBundle(context.db, bundle, {
    createdAt: '2026-07-27T00:00:00.000Z',
    sourceDatabase: context.config.databasePath,
  });
  const usersRecord = result.manifest.files.tables.find((record) => record.name === 'users');
  const tablePath = path.join(bundle, usersRecord.path);
  const externalCopy = path.join(context.dataDir, 'external-users.ndjson');
  fs.copyFileSync(tablePath, externalCopy);
  fs.rmSync(tablePath);
  fs.symlinkSync(externalCopy, tablePath);

  await assert.rejects(
    verifySafePostgresMigrationBundle(bundle),
    (error) => error.code === 'DB_BUNDLE_SYMLINK_UNSUPPORTED',
  );
});
