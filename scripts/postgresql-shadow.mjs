import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { buildSqliteManifest } from '../src/database-portability.mjs';
import { inventoryDatabaseRuntimeSurface, safeRuntimeSurfaceReport } from '../src/database-runtime-surface.mjs';
import { openDatabase } from '../src/db.mjs';
import { runPostgresqlShadowVerification } from '../src/postgresql-shadow-orchestrator.mjs';

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

function writeJson(target, payload) {
  const absolute = path.resolve(target);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, absolute);
  try { fs.chmodSync(absolute, 0o600); } catch {}
  return absolute;
}

function readJson(target) {
  return JSON.parse(fs.readFileSync(path.resolve(target), 'utf8'));
}

function enabled() {
  return flag('--enable') || String(process.env.KUKGIT_POSTGRESQL_SHADOW_ENABLED || '').toLowerCase() === 'true';
}

const command = process.argv[2] || 'status';
const config = loadConfig();
const outputDirectory = path.resolve(
  argument('--output-dir', process.env.KUKGIT_POSTGRESQL_SHADOW_OUTPUT_DIR || path.join(config.dataDir, 'database-migration', 'postgresql-shadow')),
);

if (command === 'surface') {
  const report = inventoryDatabaseRuntimeSurface([
    path.join(config.root, 'src'),
    path.join(config.root, 'scripts'),
  ]);
  const safe = safeRuntimeSurfaceReport(report);
  const output = writeJson(
    argument('--output', path.join(outputDirectory, 'database-runtime-surface.json')),
    safe,
  );
  print({
    command,
    output,
    fingerprint: safe.fingerprint,
    counts: safe.counts,
    boundary: 'Inventory only. No database read, write or runtime cutover was performed.',
  });
  process.exit(0);
}

if (command === 'status') {
  const statePath = path.join(outputDirectory, 'postgresql-shadow-state.json');
  const reportPath = path.join(outputDirectory, 'postgresql-shadow-report.json');
  const state = fs.existsSync(statePath) ? readJson(statePath) : null;
  const report = fs.existsSync(reportPath) ? readJson(reportPath) : null;
  print({
    command,
    enabled: enabled(),
    outputDirectory,
    state,
    report: report ? {
      format: report.format,
      status: report.status,
      generatedAt: report.generatedAt,
      sourceFingerprint: report.sourceFingerprint,
      reportFingerprint: report.reportFingerprint,
      summary: report.summary,
      connection: report.connection,
      boundary: report.boundary,
    } : null,
  });
  process.exit(state?.status === 'failed' || report?.status === 'failed' ? 2 : 0);
}

if (command !== 'verify') {
  fail('Commands: surface, verify, status.');
}

const confirmation = argument('--confirm');
const operator = argument('--operator');
if (!confirmation) fail('Use --confirm <exact-live-sqlite-fingerprint>.');
if (!operator) fail('Use --operator <verified-operator-identity>.');
if (!enabled()) fail('Set KUKGIT_POSTGRESQL_SHADOW_ENABLED=true or pass --enable.');

const idsValue = argument('--ids');
const ids = idsValue ? idsValue.split(',').map((value) => value.trim()).filter(Boolean) : null;
const sampleLimit = Number(argument('--sample-limit', process.env.KUKGIT_POSTGRESQL_SHADOW_SAMPLE_LIMIT || '10'));
const readTimeoutMs = Number(argument('--timeout-ms', process.env.KUKGIT_POSTGRESQL_SHADOW_READ_TIMEOUT_MS || '5000'));

const db = openDatabase(config);
try {
  const sourceManifest = buildSqliteManifest(db);
  const result = await runPostgresqlShadowVerification({
    sqlite: db,
    sourceManifest,
    confirmation,
    operator,
    outputDirectory,
    enabled: true,
    runtimeDriver: process.env.KUKGIT_DATABASE_DRIVER || 'sqlite',
    ids,
    sampleLimit,
    readTimeoutMs,
    onProgress: flag('--progress') ? async (event) => {
      process.stderr.write(`${JSON.stringify(event)}\n`);
    } : null,
  });
  print({ command, ...result });
  process.exitCode = result.status === 'verified' ? 0 : 2;
} finally {
  db.close();
}
