import crypto from 'node:crypto';

export const RUNTIME_WRITE_SCHEMA_VERSION = 1;

const MIGRATION_ID = 'runtime-write-foundation-v1';
const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS kukgit_schema_migrations (
    version INTEGER PRIMARY KEY,
    migration_id TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;
const POSTGRESQL_DDL = `
  CREATE TABLE IF NOT EXISTS kukgit_schema_migrations (
    version INTEGER PRIMARY KEY,
    migration_id TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

function normalized(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function checksum() {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: RUNTIME_WRITE_SCHEMA_VERSION,
    id: MIGRATION_ID,
    sqlite: normalized(SQLITE_DDL),
    postgresql: normalized(POSTGRESQL_DDL),
  })).digest('hex');
}

export function runtimeWriteMigrationDefinition() {
  return Object.freeze({
    version: RUNTIME_WRITE_SCHEMA_VERSION,
    id: MIGRATION_ID,
    checksum: checksum(),
    sqliteSql: normalized(SQLITE_DDL),
    postgresqlSql: normalized(POSTGRESQL_DDL),
  });
}

function migrationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function verifyRuntimeWriteMigrationRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Runtime write migration rows must be an array.');
  const expected = runtimeWriteMigrationDefinition();
  const normalizedRows = rows.map((row) => ({
    version: Number(row.version),
    id: String(row.migration_id ?? row.migrationId ?? ''),
    checksum: String(row.checksum || ''),
  })).sort((left, right) => left.version - right.version);

  const duplicateVersions = normalizedRows.filter((row, index) => index > 0 && row.version === normalizedRows[index - 1].version);
  if (duplicateVersions.length) throw migrationError('Runtime write migration history contains duplicate versions.', 'RUNTIME_WRITE_MIGRATION_DUPLICATE');
  const future = normalizedRows.find((row) => row.version > expected.version);
  if (future) throw migrationError('Runtime write migration history is newer than this KukGit build.', 'RUNTIME_WRITE_MIGRATION_FUTURE_VERSION');
  const row = normalizedRows.find((item) => item.version === expected.version);
  if (!row) return { ready: false, currentVersion: normalizedRows.at(-1)?.version ?? 0, expectedVersion: expected.version };
  if (row.id !== expected.id || row.checksum !== expected.checksum) {
    throw migrationError('Runtime write migration checksum does not match this KukGit build.', 'RUNTIME_WRITE_MIGRATION_CHECKSUM_MISMATCH');
  }
  return { ready: true, currentVersion: row.version, expectedVersion: expected.version, checksum: expected.checksum };
}

export function ensureSqliteRuntimeWriteMigrations(db) {
  if (typeof db?.exec !== 'function' || typeof db?.prepare !== 'function' || typeof db?.transaction !== 'function') {
    throw new Error('SQLite runtime write migration requires transaction-capable database access.');
  }
  const definition = runtimeWriteMigrationDefinition();
  const apply = db.transaction(() => {
    db.exec(definition.sqliteSql);
    const rows = db.prepare('SELECT version, migration_id, checksum FROM kukgit_schema_migrations ORDER BY version').all();
    const status = verifyRuntimeWriteMigrationRows(rows);
    if (!status.ready) {
      db.prepare(`
        INSERT INTO kukgit_schema_migrations (version, migration_id, checksum)
        VALUES (?, ?, ?)
      `).run(definition.version, definition.id, definition.checksum);
    }
    return verifyRuntimeWriteMigrationRows(
      db.prepare('SELECT version, migration_id, checksum FROM kukgit_schema_migrations ORDER BY version').all(),
    );
  });
  return apply();
}

export async function ensurePostgresqlRuntimeWriteMigrations(adapter) {
  for (const method of ['begin', 'commit', 'rollback', 'query']) {
    if (typeof adapter?.[method] !== 'function') throw new Error(`PostgreSQL migration adapter must implement ${method}().`);
  }
  const definition = runtimeWriteMigrationDefinition();
  await adapter.begin();
  try {
    await adapter.query(definition.postgresqlSql);
    const before = await adapter.query('SELECT version, migration_id, checksum FROM kukgit_schema_migrations ORDER BY version');
    const status = verifyRuntimeWriteMigrationRows(before.rows || []);
    if (!status.ready) {
      await adapter.query(
        'INSERT INTO kukgit_schema_migrations (version, migration_id, checksum) VALUES ($1, $2, $3)',
        [definition.version, definition.id, definition.checksum],
      );
    }
    const after = await adapter.query('SELECT version, migration_id, checksum FROM kukgit_schema_migrations ORDER BY version');
    const verified = verifyRuntimeWriteMigrationRows(after.rows || []);
    await adapter.commit();
    return verified;
  } catch (error) {
    try { await adapter.rollback(); } catch {}
    throw error;
  }
}
