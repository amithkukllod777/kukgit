#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import {
  buildPostgresDdl,
  exportPostgresMigrationBundle,
  inspectSqliteSchema,
  validateSchemaForPostgres,
  verifyPostgresMigrationBundle,
} from '../src/database-portability.mjs';
import {
  currentSchemaVersion,
  migrateApplicationSchema,
  migratePostSeedSchema,
} from '../src/migrations.mjs';

function usage() {
  console.log(`KukGit PostgreSQL migration foundation

Usage:
  npm run db:postgres -- inventory
  npm run db:postgres -- preflight
  npm run db:postgres -- export --out <directory> [--created-at <ISO timestamp>]
  npm run db:postgres -- verify --bundle <directory>
  npm run db:postgres -- ddl --out <file.sql>

Commands:
  inventory   Inspect the migrated SQLite schema and print table/row metadata.
  preflight   Validate automatic PostgreSQL compatibility and import order.
  export      Create a deterministic checksummed migration bundle directory.
  verify      Verify a previously exported migration bundle.
  ddl         Generate PostgreSQL DDL from the current migrated SQLite schema.

Important:
  The export command is for metadata only. Bare Git repositories, Git LFS
  objects and verified backups remain in their configured storage locations.
  Run production exports in maintenance mode after creating a verified backup.
`);
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function safeTimestamp(value = new Date().toISOString()) {
  return value.replace(/[:.]/g, '-');
}

function openMigratedDatabase() {
  const config = loadConfig();
  const db = openDatabase(config);
  migrateApplicationSchema(db);
  migratePostSeedSchema(db);
  return { config, db };
}

function inventorySummary(schema) {
  return {
    schemaVersion: schema.schemaVersion,
    sourceEngine: schema.sourceEngine,
    tables: schema.tables.length,
    rows: schema.tables.reduce((sum, table) => sum + table.rowCount, 0),
    importOrder: schema.importOrder,
    dependencyCycles: schema.dependencyCycles,
    tableSummary: schema.importOrder.map((name) => {
      const table = schema.tables.find((candidate) => candidate.name === name);
      return {
        name: table.name,
        rows: table.rowCount,
        columns: table.columns.length,
        foreignKeys: table.foreignKeys.length,
        indexes: table.indexes.length,
        sensitiveColumns: table.sensitiveColumns,
      };
    }),
  };
}

async function inventory() {
  const { db } = openMigratedDatabase();
  try {
    const schema = inspectSqliteSchema(db);
    console.log(JSON.stringify(inventorySummary(schema), null, 2));
  } finally {
    db.close();
  }
}

async function preflight() {
  const { db } = openMigratedDatabase();
  try {
    const schema = inspectSqliteSchema(db);
    const validation = validateSchemaForPostgres(schema);
    const summary = {
      ...inventorySummary(schema),
      compatible: validation.compatible,
      errors: validation.errors,
      warnings: validation.warnings,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!validation.compatible) process.exitCode = 2;
  } finally {
    db.close();
  }
}

async function exportBundle(args) {
  const { config, db } = openMigratedDatabase();
  const createdAt = option(args, '--created-at') || new Date().toISOString();
  const requested = option(args, '--out');
  const outputDir = path.resolve(requested || path.join(
    config.dataDir,
    'postgres-migrations',
    `kukgit-${safeTimestamp(createdAt)}`,
  ));
  try {
    const result = await exportPostgresMigrationBundle(db, outputDir, {
      createdAt,
      sourceDatabase: config.databasePath,
    });
    const verification = await verifyPostgresMigrationBundle(result.outputDir);
    console.log(JSON.stringify({
      created: true,
      outputDir: result.outputDir,
      manifestSha256: result.manifestSha256,
      schemaVersion: verification.schemaVersion,
      tables: verification.tables,
      rows: verification.rows,
      warnings: verification.warnings,
      exclusions: result.manifest.exclusions,
    }, null, 2));
  } finally {
    db.close();
  }
}

async function verifyBundle(args) {
  const bundle = option(args, '--bundle') || option(args, '--out');
  if (!bundle) throw new Error('verify requires --bundle <directory>.');
  const result = await verifyPostgresMigrationBundle(path.resolve(bundle));
  console.log(JSON.stringify(result, null, 2));
}

async function generateDdl(args) {
  const output = option(args, '--out');
  if (!output) throw new Error('ddl requires --out <file.sql>.');
  const destination = path.resolve(output);
  if (fs.existsSync(destination)) throw new Error(`DDL destination already exists: ${destination}`);
  const { db } = openMigratedDatabase();
  try {
    const schema = inspectSqliteSchema(db);
    const ddl = buildPostgresDdl(schema);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, ddl, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({
      created: true,
      output: destination,
      schemaVersion: currentSchemaVersion(db),
      tables: schema.tables.length,
    }, null, 2));
  } finally {
    db.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  if (command === 'help' || command === '--help' || command === '-h') return usage();
  if (command === 'inventory') return inventory();
  if (command === 'preflight') return preflight();
  if (command === 'export') return exportBundle(args.slice(1));
  if (command === 'verify') return verifyBundle(args.slice(1));
  if (command === 'ddl') return generateDdl(args.slice(1));
  throw new Error(`Unknown command '${command}'. Run with --help for usage.`);
}

main().catch((error) => {
  console.error(`KukGit PostgreSQL migration: ${error.message}`);
  if (error.code) console.error(`Code: ${error.code}`);
  process.exitCode = 1;
});
