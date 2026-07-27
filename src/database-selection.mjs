import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DRIVER_VALUES = new Set(['sqlite', 'postgresql']);
const MARKER_FORMAT = 'kukgit-postgresql-cutover/1';

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

export function normalizeDatabaseDriver(value) {
  const driver = String(value || 'sqlite').trim().toLowerCase();
  if (!DRIVER_VALUES.has(driver)) throw new Error('KUKGIT_DATABASE_DRIVER must be sqlite or postgresql.');
  return driver;
}

export function parsePostgresqlUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('KUKGIT_DATABASE_URL is required for PostgreSQL.');
  let url;
  try { url = new URL(value); }
  catch { throw new Error('KUKGIT_DATABASE_URL is not a valid URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('KUKGIT_DATABASE_URL must use postgres:// or postgresql://.');
  if (!url.hostname) throw new Error('KUKGIT_DATABASE_URL must include a hostname.');
  if (!url.pathname || url.pathname === '/') throw new Error('KUKGIT_DATABASE_URL must include a database name.');
  return url;
}

export function redactPostgresqlUrl(raw) {
  const url = parsePostgresqlUrl(raw);
  if (url.username) url.username = '***';
  if (url.password) url.password = '***';
  for (const key of [...url.searchParams.keys()]) {
    if (/(password|token|secret|key|credential)/i.test(key)) url.searchParams.set(key, '***');
  }
  return url.toString();
}

export function loadDatabaseSelection(overrides = {}) {
  const driver = normalizeDatabaseDriver(overrides.driver ?? process.env.KUKGIT_DATABASE_DRIVER ?? 'sqlite');
  const databaseUrl = String(overrides.databaseUrl ?? process.env.KUKGIT_DATABASE_URL ?? '');
  const readinessMarkerPath = path.resolve(
    overrides.readinessMarkerPath
      ?? process.env.KUKGIT_POSTGRESQL_READINESS_MARKER
      ?? path.join(overrides.dataDir ?? process.env.KUKGIT_DATA_DIR ?? './data', 'postgresql-readiness.json'),
  );
  const requireVerifiedCutover = booleanValue(
    overrides.requireVerifiedCutover ?? process.env.KUKGIT_POSTGRESQL_REQUIRE_VERIFIED_CUTOVER,
    true,
  );
  if (driver === 'postgresql') parsePostgresqlUrl(databaseUrl);
  return {
    driver,
    databaseUrl,
    redactedDatabaseUrl: driver === 'postgresql' ? redactPostgresqlUrl(databaseUrl) : null,
    readinessMarkerPath,
    requireVerifiedCutover,
  };
}

export function readPostgresqlReadinessMarker(markerPath) {
  const target = path.resolve(markerPath);
  if (!fs.existsSync(target)) return null;
  const marker = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (marker.format !== MARKER_FORMAT) throw new Error('Unsupported PostgreSQL readiness marker format.');
  return marker;
}

export function createPostgresqlReadinessMarker({
  markerPath,
  sourceManifest,
  target,
  verification,
  operator = null,
}) {
  if (!sourceManifest?.fingerprint) throw new Error('Source database manifest fingerprint is required.');
  if (!verification?.valid) throw new Error('A valid PostgreSQL import verification result is required.');
  if (!target?.schemaFingerprint || !target?.rowFingerprint) throw new Error('PostgreSQL target fingerprints are required.');
  const pathName = path.resolve(markerPath);
  fs.mkdirSync(path.dirname(pathName), { recursive: true });
  const marker = {
    format: MARKER_FORMAT,
    status: 'verified',
    createdAt: new Date().toISOString(),
    source: {
      engine: 'sqlite',
      manifestFingerprint: sourceManifest.fingerprint,
      tableCount: sourceManifest.tableCount,
      totalRows: sourceManifest.totalRows,
    },
    target: {
      engine: 'postgresql',
      host: target.host,
      database: target.database,
      schema: target.schema || 'public',
      schemaFingerprint: target.schemaFingerprint,
      rowFingerprint: target.rowFingerprint,
    },
    verification: {
      valid: true,
      foreignKeyFailures: Number(verification.foreignKeyFailures || 0),
      missingTables: Number(verification.missingTables || 0),
      rowCountDifferences: Number(verification.rowCountDifferences || 0),
      checksumDifferences: Number(verification.checksumDifferences || 0),
    },
    operator,
  };
  const withoutChecksum = JSON.stringify(marker);
  marker.markerChecksum = crypto.createHash('sha256').update(withoutChecksum).digest('hex');
  const temporary = `${pathName}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, pathName);
  try { fs.chmodSync(pathName, 0o600); } catch {}
  return marker;
}

export function validatePostgresqlReadiness(selection, expectedSourceFingerprint = null) {
  if (selection.driver !== 'postgresql') return { ready: true, driver: 'sqlite', marker: null };
  if (!selection.requireVerifiedCutover) {
    return { ready: true, driver: 'postgresql', marker: null, bypassed: true };
  }
  const marker = readPostgresqlReadinessMarker(selection.readinessMarkerPath);
  if (!marker || marker.status !== 'verified') {
    return { ready: false, driver: 'postgresql', reason: 'POSTGRESQL_CUTOVER_NOT_VERIFIED', marker: marker || null };
  }
  const { markerChecksum, ...withoutChecksum } = marker;
  const actualChecksum = crypto.createHash('sha256').update(JSON.stringify(withoutChecksum)).digest('hex');
  if (!markerChecksum || markerChecksum !== actualChecksum) {
    return { ready: false, driver: 'postgresql', reason: 'POSTGRESQL_MARKER_CHECKSUM_INVALID', marker };
  }
  if (expectedSourceFingerprint && marker.source?.manifestFingerprint !== expectedSourceFingerprint) {
    return { ready: false, driver: 'postgresql', reason: 'POSTGRESQL_SOURCE_FINGERPRINT_MISMATCH', marker };
  }
  return { ready: true, driver: 'postgresql', marker };
}

export function assertPostgresqlCutoverReady(selection, expectedSourceFingerprint = null) {
  const status = validatePostgresqlReadiness(selection, expectedSourceFingerprint);
  if (!status.ready) {
    const error = new Error(`PostgreSQL cutover is not ready: ${status.reason}`);
    error.code = status.reason;
    throw error;
  }
  return status;
}

export const POSTGRESQL_READINESS_MARKER_FORMAT = MARKER_FORMAT;
