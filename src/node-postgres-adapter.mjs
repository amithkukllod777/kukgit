import crypto from 'node:crypto';
import fs from 'node:fs';
import { parsePostgresqlUrl, redactPostgresqlUrl } from './database-selection.mjs';

const SSL_MODES = new Set(['verify-full', 'require', 'disable']);
const CONNECTION_SSL_OPTIONS = new Set(['sslmode', 'sslcert', 'sslkey', 'sslrootcert']);

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function boundedInteger(value, fallback, min, max, name) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function validateIdentifier(value, name = 'PostgreSQL identifier') {
  const identifier = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) || Buffer.byteLength(identifier, 'utf8') > 63) {
    throw new Error(`${name} is invalid or exceeds PostgreSQL's 63-byte limit.`);
  }
  return identifier;
}

function quoteIdentifier(value) {
  const identifier = validateIdentifier(value);
  return `"${identifier.replaceAll('"', '""')}"`;
}

function optionalFile(filePath, name) {
  const target = String(filePath || '').trim();
  if (!target) return null;
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw new Error(`${name} must be a non-empty file up to 1 MB.`);
  return fs.readFileSync(target);
}

function safeSqlState(error) {
  const code = String(error?.code || '');
  return /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function adapterError(operation, error, code = 'POSTGRESQL_ADAPTER_OPERATION_FAILED') {
  const sqlState = safeSqlState(error);
  const wrapped = new Error(`PostgreSQL ${operation} failed${sqlState ? ` (SQLSTATE ${sqlState})` : ''}.`);
  wrapped.code = code;
  if (sqlState) wrapped.sqlState = sqlState;
  return wrapped;
}

function sslConfiguration(config) {
  if (config.sslMode === 'disable') return false;
  return {
    rejectUnauthorized: config.sslMode === 'verify-full',
    ...(config.sslCa ? { ca: config.sslCa } : {}),
    ...(config.sslCert ? { cert: config.sslCert } : {}),
    ...(config.sslKey ? { key: config.sslKey } : {}),
  };
}

export function loadNodePostgresAdapterConfig(overrides = {}) {
  const databaseUrl = String(overrides.databaseUrl ?? process.env.KUKGIT_DATABASE_URL ?? '').trim();
  const parsedUrl = parsePostgresqlUrl(databaseUrl);
  for (const key of parsedUrl.searchParams.keys()) {
    if (CONNECTION_SSL_OPTIONS.has(key.toLowerCase())) {
      throw new Error(`KUKGIT_DATABASE_URL must not contain ${key}; configure TLS through KukGit PostgreSQL settings.`);
    }
  }
  const schema = validateIdentifier(
    overrides.schema ?? process.env.KUKGIT_POSTGRESQL_SCHEMA ?? 'kukgit_migration',
    'KUKGIT_POSTGRESQL_SCHEMA',
  );
  if (schema === 'information_schema' || schema.startsWith('pg_')) {
    throw new Error('KUKGIT_POSTGRESQL_SCHEMA cannot use a PostgreSQL system schema.');
  }
  const allowPublicSchema = booleanValue(
    overrides.allowPublicSchema ?? process.env.KUKGIT_POSTGRESQL_ALLOW_PUBLIC_SCHEMA,
    false,
  );
  if (schema === 'public' && !allowPublicSchema) {
    throw new Error('The public schema is blocked by default. Use a dedicated empty migration schema.');
  }

  const sslMode = String(overrides.sslMode ?? process.env.KUKGIT_POSTGRESQL_SSL_MODE ?? 'verify-full').trim().toLowerCase();
  if (!SSL_MODES.has(sslMode)) throw new Error('KUKGIT_POSTGRESQL_SSL_MODE must be verify-full, require or disable.');
  const allowUnverifiedTls = booleanValue(
    overrides.allowUnverifiedTls ?? process.env.KUKGIT_POSTGRESQL_ALLOW_UNVERIFIED_TLS,
    false,
  );
  const allowInsecure = booleanValue(
    overrides.allowInsecure ?? process.env.KUKGIT_POSTGRESQL_ALLOW_INSECURE,
    false,
  );
  if (sslMode === 'require' && !allowUnverifiedTls) {
    throw new Error('TLS without certificate verification requires KUKGIT_POSTGRESQL_ALLOW_UNVERIFIED_TLS=true.');
  }
  if (sslMode === 'disable' && !allowInsecure) {
    throw new Error('Unencrypted PostgreSQL requires KUKGIT_POSTGRESQL_ALLOW_INSECURE=true.');
  }

  const sslCa = optionalFile(overrides.sslCaPath ?? process.env.KUKGIT_POSTGRESQL_SSL_CA, 'PostgreSQL CA certificate');
  const sslCert = optionalFile(overrides.sslCertPath ?? process.env.KUKGIT_POSTGRESQL_SSL_CERT, 'PostgreSQL client certificate');
  const sslKey = optionalFile(overrides.sslKeyPath ?? process.env.KUKGIT_POSTGRESQL_SSL_KEY, 'PostgreSQL client key');
  if ((sslCert && !sslKey) || (!sslCert && sslKey)) {
    throw new Error('PostgreSQL client certificate and key must be configured together.');
  }

  return {
    databaseUrl,
    redactedDatabaseUrl: redactPostgresqlUrl(databaseUrl),
    schema,
    sslMode,
    sslCa,
    sslCert,
    sslKey,
    applicationName: String(overrides.applicationName ?? process.env.KUKGIT_POSTGRESQL_APPLICATION_NAME ?? 'kukgit-migration').slice(0, 63),
    connectionTimeoutMillis: boundedInteger(overrides.connectionTimeoutMillis ?? process.env.KUKGIT_POSTGRESQL_CONNECTION_TIMEOUT_MS, 10000, 1000, 120000, 'KUKGIT_POSTGRESQL_CONNECTION_TIMEOUT_MS'),
    statementTimeoutMillis: boundedInteger(overrides.statementTimeoutMillis ?? process.env.KUKGIT_POSTGRESQL_STATEMENT_TIMEOUT_MS, 120000, 1000, 3600000, 'KUKGIT_POSTGRESQL_STATEMENT_TIMEOUT_MS'),
    queryTimeoutMillis: boundedInteger(overrides.queryTimeoutMillis ?? process.env.KUKGIT_POSTGRESQL_QUERY_TIMEOUT_MS, 130000, 1000, 3600000, 'KUKGIT_POSTGRESQL_QUERY_TIMEOUT_MS'),
    lockTimeoutMillis: boundedInteger(overrides.lockTimeoutMillis ?? process.env.KUKGIT_POSTGRESQL_LOCK_TIMEOUT_MS, 5000, 100, 300000, 'KUKGIT_POSTGRESQL_LOCK_TIMEOUT_MS'),
    idleTransactionTimeoutMillis: boundedInteger(overrides.idleTransactionTimeoutMillis ?? process.env.KUKGIT_POSTGRESQL_IDLE_TRANSACTION_TIMEOUT_MS, 60000, 1000, 3600000, 'KUKGIT_POSTGRESQL_IDLE_TRANSACTION_TIMEOUT_MS'),
  };
}

export async function createNodePostgresAdapter(config, { pgModule = null } = {}) {
  const resolved = config?.databaseUrl ? config : loadNodePostgresAdapterConfig(config || {});
  const module = pgModule || await import('pg');
  const Client = module.Client || module.default?.Client;
  if (typeof Client !== 'function') throw new Error('The pg package does not expose a Client constructor.');

  const client = new Client({
    connectionString: resolved.databaseUrl,
    ssl: sslConfiguration(resolved),
    application_name: resolved.applicationName,
    connectionTimeoutMillis: resolved.connectionTimeoutMillis,
    statement_timeout: resolved.statementTimeoutMillis,
    query_timeout: resolved.queryTimeoutMillis,
    lock_timeout: resolved.lockTimeoutMillis,
  });

  const lockKey = `kukgit-metadata-import:${resolved.schema}`;
  let connected = false;
  let transaction = false;
  let migrationLock = false;
  let closed = false;
  let diagnostics = null;

  async function rawQuery(sql, values = [], operation = 'query') {
    if (!connected || closed) throw new Error('PostgreSQL adapter is not connected.');
    try {
      return await client.query(sql, values);
    } catch (error) {
      throw adapterError(operation, error);
    }
  }

  async function connect() {
    if (connected || closed) throw new Error('PostgreSQL adapter connection state is invalid.');
    try {
      await client.connect();
      connected = true;
      const schemaResult = await rawQuery(
        `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists,
          has_schema_privilege(current_user, $1, 'USAGE') AS can_use,
          has_schema_privilege(current_user, $1, 'CREATE') AS can_create`,
        [resolved.schema],
        'schema validation',
      );
      const schemaRow = schemaResult.rows?.[0];
      if (!schemaRow?.exists) throw new Error('Configured PostgreSQL migration schema does not exist.');
      if (!schemaRow.can_use || !schemaRow.can_create) throw new Error('PostgreSQL user requires USAGE and CREATE on the migration schema.');

      const lockResult = await rawQuery(
        'SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked',
        [lockKey],
        'migration lock',
      );
      migrationLock = Boolean(lockResult.rows?.[0]?.locked);
      if (!migrationLock) throw new Error('Another KukGit PostgreSQL migration holds the schema lock.');

      const identity = await rawQuery(
        `SELECT current_database() AS database,
          current_user AS user,
          current_setting('server_version_num') AS server_version_num`,
        [],
        'connection diagnostics',
      );
      diagnostics = {
        database: String(identity.rows?.[0]?.database || ''),
        user: String(identity.rows?.[0]?.user || ''),
        serverVersionNumber: String(identity.rows?.[0]?.server_version_num || ''),
        schema: resolved.schema,
        sslMode: resolved.sslMode,
        databaseUrl: resolved.redactedDatabaseUrl,
      };
      return diagnostics;
    } catch (error) {
      if (connected) {
        try { await client.end(); } catch {}
      }
      connected = false;
      closed = true;
      if (error?.code?.startsWith?.('POSTGRESQL_')) throw error;
      throw adapterError('connection setup', error, 'POSTGRESQL_ADAPTER_CONNECT_FAILED');
    }
  }

  async function close() {
    if (closed) return;
    if (transaction) {
      try { await rawQuery('ROLLBACK', [], 'close rollback'); } catch {}
      transaction = false;
    }
    if (migrationLock) {
      try { await rawQuery('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [lockKey], 'migration unlock'); } catch {}
      migrationLock = false;
    }
    try { if (connected) await client.end(); }
    catch (error) { throw adapterError('connection close', error, 'POSTGRESQL_ADAPTER_CLOSE_FAILED'); }
    finally { connected = false; closed = true; }
  }

  async function begin() {
    if (transaction) throw new Error('PostgreSQL migration transaction is already active.');
    await rawQuery('BEGIN ISOLATION LEVEL SERIALIZABLE', [], 'transaction begin');
    transaction = true;
    try {
      await rawQuery(`SET LOCAL search_path TO ${quoteIdentifier(resolved.schema)}, pg_catalog`, [], 'search path');
      await rawQuery(
        "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
        [`${resolved.idleTransactionTimeoutMillis}ms`],
        'transaction timeout',
      );
    } catch (error) {
      try { await rawQuery('ROLLBACK', [], 'begin rollback'); } catch {}
      transaction = false;
      throw error;
    }
  }

  async function commit() {
    if (!transaction) throw new Error('PostgreSQL migration transaction is not active.');
    await rawQuery('COMMIT', [], 'transaction commit');
    transaction = false;
  }

  async function rollback() {
    if (!transaction) return;
    try { await rawQuery('ROLLBACK', [], 'transaction rollback'); }
    finally { transaction = false; }
  }

  async function query(sql, values = []) {
    if (!transaction) throw new Error('PostgreSQL migration queries require an active transaction.');
    return rawQuery(sql, values, 'migration query');
  }

  async function listUserTables() {
    const result = await rawQuery(
      `SELECT table_name AS name
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [resolved.schema],
      'table inventory',
    );
    return (result.rows || []).map((row) => row.name);
  }

  async function* scanTable(tableName, columns, { batchSize = 1000, signal = null } = {}) {
    if (!transaction) throw new Error('PostgreSQL target scans require an active transaction.');
    const table = quoteIdentifier(tableName);
    const selectedColumns = columns.map(quoteIdentifier);
    if (!selectedColumns.length) throw new Error('PostgreSQL target scan requires at least one column.');
    const size = Number(batchSize);
    if (!Number.isInteger(size) || size < 1 || size > 10000) throw new Error('PostgreSQL cursor batch size is invalid.');
    const cursor = quoteIdentifier(`kgcur_${crypto.randomBytes(12).toString('hex')}`);
    let declared = false;
    try {
      await rawQuery(
        `DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ${selectedColumns.join(', ')} FROM ${quoteIdentifier(resolved.schema)}.${table}`,
        [],
        'cursor declaration',
      );
      declared = true;
      while (true) {
        if (signal?.aborted) {
          const error = new Error('PostgreSQL target scan was cancelled.');
          error.code = 'POSTGRESQL_IMPORT_CANCELLED';
          throw error;
        }
        const result = await rawQuery(`FETCH FORWARD ${size} FROM ${cursor}`, [], 'cursor fetch');
        const rows = result.rows || [];
        if (!rows.length) break;
        yield rows;
      }
    } finally {
      if (declared && transaction) {
        try { await rawQuery(`CLOSE ${cursor}`, [], 'cursor close'); } catch {}
      }
    }
  }

  return {
    connect,
    close,
    begin,
    commit,
    rollback,
    query,
    listUserTables,
    scanTable,
    diagnostics: () => diagnostics ? { ...diagnostics } : null,
    config: {
      schema: resolved.schema,
      sslMode: resolved.sslMode,
      databaseUrl: resolved.redactedDatabaseUrl,
    },
  };
}
