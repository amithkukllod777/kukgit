import { loadNodePostgresAdapterConfig } from './node-postgres-adapter.mjs';

function quoteIdentifier(value) {
  const identifier = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) || Buffer.byteLength(identifier, 'utf8') > 63) {
    throw new Error('PostgreSQL shadow schema identifier is invalid.');
  }
  return `"${identifier.replaceAll('"', '""')}"`;
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

function safeSqlState(error) {
  const code = String(error?.code || '');
  return /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function shadowError(operation, error, fallback = 'POSTGRESQL_SHADOW_ADAPTER_FAILED') {
  if (error?.code?.startsWith?.('POSTGRESQL_SHADOW_')) return error;
  const wrapped = new Error(`PostgreSQL shadow ${operation} failed.`);
  wrapped.code = fallback;
  const sqlState = safeSqlState(error);
  if (sqlState) wrapped.sqlState = sqlState;
  return wrapped;
}

export async function createNodePostgresShadowAdapter(configValue = {}, { pgModule = null } = {}) {
  const config = loadNodePostgresAdapterConfig(configValue);
  const module = pgModule || await import('pg');
  const Client = module.Client || module.default?.Client;
  if (typeof Client !== 'function') throw new Error('The pg package does not expose a Client constructor.');

  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: sslConfiguration(config),
    application_name: `${config.applicationName}-shadow`.slice(0, 63),
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    statement_timeout: config.statementTimeoutMillis,
    query_timeout: config.queryTimeoutMillis,
    lock_timeout: config.lockTimeoutMillis,
  });

  let connected = false;
  let transaction = false;
  let closed = false;
  let diagnostics = null;

  async function rawQuery(sql, values = [], operation = 'query') {
    if (!connected || closed) {
      const error = new Error('PostgreSQL shadow adapter is not connected.');
      error.code = 'POSTGRESQL_SHADOW_NOT_CONNECTED';
      throw error;
    }
    try {
      return await client.query(sql, values);
    } catch (error) {
      throw shadowError(operation, error);
    }
  }

  async function connect() {
    if (connected || closed) throw new Error('PostgreSQL shadow adapter connection state is invalid.');
    try {
      await client.connect();
      connected = true;
      const schemaResult = await rawQuery(
        `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists,
          has_schema_privilege(current_user, $1, 'USAGE') AS can_use`,
        [config.schema],
        'schema validation',
      );
      const schema = schemaResult.rows?.[0];
      if (!schema?.exists) {
        const error = new Error('Configured PostgreSQL shadow schema does not exist.');
        error.code = 'POSTGRESQL_SHADOW_SCHEMA_MISSING';
        throw error;
      }
      if (!schema.can_use) {
        const error = new Error('PostgreSQL shadow user requires USAGE on the configured schema.');
        error.code = 'POSTGRESQL_SHADOW_SCHEMA_FORBIDDEN';
        throw error;
      }
      const identity = await rawQuery(
        `SELECT current_setting('server_version_num') AS server_version_num`,
        [],
        'connection diagnostics',
      );
      diagnostics = {
        serverVersionNumber: String(identity.rows?.[0]?.server_version_num || ''),
        schema: config.schema,
        sslMode: config.sslMode,
        databaseUrl: config.redactedDatabaseUrl,
      };
      return { ...diagnostics };
    } catch (error) {
      if (connected) {
        try { await client.end(); } catch {}
      }
      connected = false;
      closed = true;
      throw shadowError('connection setup', error, 'POSTGRESQL_SHADOW_CONNECT_FAILED');
    }
  }

  async function beginReadOnly() {
    if (!connected || closed || transaction) throw new Error('PostgreSQL shadow transaction state is invalid.');
    await rawQuery('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', [], 'transaction begin');
    transaction = true;
    try {
      await rawQuery(`SET LOCAL search_path TO ${quoteIdentifier(config.schema)}, pg_catalog`, [], 'search path');
      await rawQuery(
        "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
        [`${config.idleTransactionTimeoutMillis}ms`],
        'transaction timeout',
      );
    } catch (error) {
      try { await rawQuery('ROLLBACK', [], 'begin rollback'); } catch {}
      transaction = false;
      throw error;
    }
  }

  async function query(sql, values = []) {
    if (!transaction) {
      const error = new Error('PostgreSQL shadow reads require an active read-only transaction.');
      error.code = 'POSTGRESQL_SHADOW_TRANSACTION_REQUIRED';
      throw error;
    }
    const statement = String(sql || '').trim();
    if (!/^SELECT\b/i.test(statement) || /;\s*\S/.test(statement) || /--|\/\*/.test(statement)) {
      const error = new Error('PostgreSQL shadow adapter accepts one parameterized SELECT statement only.');
      error.code = 'POSTGRESQL_SHADOW_SQL_REJECTED';
      throw error;
    }
    return rawQuery(statement, values, 'read query');
  }

  async function rollback() {
    if (!transaction) return;
    try { await rawQuery('ROLLBACK', [], 'transaction rollback'); }
    finally { transaction = false; }
  }

  async function close() {
    if (closed) return;
    if (transaction) {
      try { await rollback(); } catch {}
    }
    try { if (connected) await client.end(); }
    catch (error) { throw shadowError('connection close', error, 'POSTGRESQL_SHADOW_CLOSE_FAILED'); }
    finally { connected = false; closed = true; }
  }

  return {
    connect,
    beginReadOnly,
    query,
    rollback,
    close,
    diagnostics: () => diagnostics ? { ...diagnostics } : null,
    config: {
      schema: config.schema,
      sslMode: config.sslMode,
      databaseUrl: config.redactedDatabaseUrl,
    },
  };
}
