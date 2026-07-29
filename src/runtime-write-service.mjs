import { runtimeWriteSpec, validateRuntimeWriteParameters } from './runtime-write-catalog.mjs';

const SERVICES = new WeakMap();
const STANDARD_CODES = new Set([
  'RUNTIME_WRITE_CANCELLED',
  'RUNTIME_WRITE_CONFLICT',
  'RUNTIME_WRITE_FOREIGN_KEY',
  'RUNTIME_WRITE_CHECK_FAILED',
  'RUNTIME_WRITE_RETRYABLE',
  'RUNTIME_WRITE_RESULT_MISMATCH',
  'RUNTIME_WRITE_FAILED',
]);

function writeError(message, code, { backend = null, sqlState = null, cause = null } = {}) {
  const error = new Error(message);
  error.code = code;
  if (backend) error.backend = backend;
  if (sqlState) error.sqlState = sqlState;
  if (cause) error.cause = cause;
  return error;
}

function cancellationError(backend) {
  return writeError('Runtime metadata write was cancelled.', 'RUNTIME_WRITE_CANCELLED', { backend });
}

export function normalizeRuntimeWriteError(error, backend = 'unknown') {
  if (STANDARD_CODES.has(error?.code)) return error;
  const sqlState = /^[0-9A-Z]{5}$/.test(String(error?.sqlState || error?.code || ''))
    ? String(error.sqlState || error.code)
    : null;
  const sqliteCode = String(error?.code || '');

  if (sqlState === '23505' || sqliteCode.includes('SQLITE_CONSTRAINT_UNIQUE') || sqliteCode.includes('SQLITE_CONSTRAINT_PRIMARYKEY')) {
    return writeError('Runtime metadata write conflicts with existing data.', 'RUNTIME_WRITE_CONFLICT', { backend, sqlState, cause: error });
  }
  if (sqlState === '23503' || sqliteCode.includes('SQLITE_CONSTRAINT_FOREIGNKEY')) {
    return writeError('Runtime metadata write references missing or protected data.', 'RUNTIME_WRITE_FOREIGN_KEY', { backend, sqlState, cause: error });
  }
  if (sqlState === '23514' || sqliteCode.includes('SQLITE_CONSTRAINT_CHECK')) {
    return writeError('Runtime metadata write violates a data constraint.', 'RUNTIME_WRITE_CHECK_FAILED', { backend, sqlState, cause: error });
  }
  if (sqlState === '57014') return cancellationError(backend);
  if (['40001', '40P01', '55P03'].includes(sqlState)) {
    return writeError('Runtime metadata write can be retried safely.', 'RUNTIME_WRITE_RETRYABLE', { backend, sqlState, cause: error });
  }
  return writeError('Runtime metadata write failed.', 'RUNTIME_WRITE_FAILED', { backend, sqlState, cause: error });
}

function assertNotAborted(signal, backend) {
  if (signal?.aborted) throw cancellationError(backend);
}

function normalizedResult(spec, result, backend) {
  const changes = Number(result?.changes ?? result?.rowCount ?? 0);
  if (!Number.isSafeInteger(changes) || changes < 0) {
    throw writeError('Runtime metadata write returned an invalid result.', 'RUNTIME_WRITE_RESULT_MISMATCH', { backend });
  }
  if (changes !== spec.expectedChanges) {
    throw writeError('Runtime metadata write affected an unexpected number of rows.', 'RUNTIME_WRITE_RESULT_MISMATCH', { backend });
  }
  const output = { id: spec.id, backend, changes };
  if (result?.lastInsertRowid !== undefined && result?.lastInsertRowid !== null) {
    output.lastInsertRowid = String(result.lastInsertRowid);
  }
  return output;
}

export function runSqliteRuntimeWrite(sqlite, specValue, parameters = [], { signal = null } = {}) {
  if (typeof sqlite?.prepare !== 'function') throw new Error('SQLite runtime write requires a SQLite-compatible database.');
  const spec = typeof specValue === 'string' ? runtimeWriteSpec(specValue) : specValue;
  validateRuntimeWriteParameters(spec, parameters);
  assertNotAborted(signal, 'sqlite');
  try {
    const result = sqlite.prepare(spec.sqliteSql).run(...parameters);
    assertNotAborted(signal, 'sqlite');
    return normalizedResult(spec, result, 'sqlite');
  } catch (error) {
    throw normalizeRuntimeWriteError(error, 'sqlite');
  }
}

function sqliteTransaction(sqlite, work, { signal = null } = {}) {
  if (typeof work !== 'function') throw new TypeError('Runtime write transaction work must be a function.');
  assertNotAborted(signal, 'sqlite');
  const execute = sqlite.transaction((callback) => {
    const transaction = Object.freeze({
      backend: 'sqlite',
      write(id, parameters = [], options = {}) {
        return runSqliteRuntimeWrite(sqlite, id, parameters, { signal: options.signal ?? signal });
      },
    });
    const result = callback(transaction);
    if (result && typeof result.then === 'function') {
      throw new TypeError('SQLite runtime write transactions must remain synchronous.');
    }
    assertNotAborted(signal, 'sqlite');
    return result;
  });
  try {
    return execute(work);
  } catch (error) {
    throw normalizeRuntimeWriteError(error, 'sqlite');
  }
}

export function createRuntimeWriteService({ sqlite } = {}) {
  if (typeof sqlite?.prepare !== 'function' || typeof sqlite?.transaction !== 'function') {
    throw new Error('Runtime write service requires a SQLite database with transaction support.');
  }
  const metrics = { writes: 0, transactions: 0, rollbacks: 0, errors: 0 };
  let stopped = false;

  function write(id, parameters = [], options = {}) {
    if (stopped) throw new Error('Runtime write service is stopped.');
    try {
      const result = runSqliteRuntimeWrite(sqlite, id, parameters, options);
      metrics.writes += 1;
      return result;
    } catch (error) {
      metrics.errors += 1;
      throw error;
    }
  }

  function transaction(work, options = {}) {
    if (stopped) throw new Error('Runtime write service is stopped.');
    try {
      const result = sqliteTransaction(sqlite, (tx) => {
        const wrapped = Object.freeze({
          ...tx,
          write(id, parameters = [], writeOptions = {}) {
            const output = tx.write(id, parameters, writeOptions);
            metrics.writes += 1;
            return output;
          },
        });
        return work(wrapped);
      }, options);
      metrics.transactions += 1;
      return result;
    } catch (error) {
      metrics.rollbacks += 1;
      metrics.errors += 1;
      throw error;
    }
  }

  return {
    backend: 'sqlite',
    write,
    transaction,
    stop() { stopped = true; },
    status() { return { backend: 'sqlite', stopped, metrics: { ...metrics } }; },
  };
}

async function runPostgresqlWrite(adapter, specValue, parameters, { signal = null } = {}) {
  const spec = typeof specValue === 'string' ? runtimeWriteSpec(specValue) : specValue;
  validateRuntimeWriteParameters(spec, parameters);
  assertNotAborted(signal, 'postgresql');
  try {
    const result = await adapter.query(spec.postgresqlSql, parameters);
    assertNotAborted(signal, 'postgresql');
    return normalizedResult(spec, result, 'postgresql');
  } catch (error) {
    throw normalizeRuntimeWriteError(error, 'postgresql');
  }
}

export function createPostgresqlCompatibilityWriteService({ adapter } = {}) {
  for (const method of ['begin', 'commit', 'rollback', 'query']) {
    if (typeof adapter?.[method] !== 'function') throw new Error(`PostgreSQL write adapter must implement ${method}().`);
  }
  const metrics = { writes: 0, transactions: 0, rollbacks: 0, errors: 0 };
  let stopped = false;
  let active = false;

  async function transaction(work, { signal = null } = {}) {
    if (stopped) throw new Error('PostgreSQL compatibility write service is stopped.');
    if (active) throw new Error('Nested PostgreSQL compatibility write transactions are not allowed.');
    if (typeof work !== 'function') throw new TypeError('Runtime write transaction work must be a function.');
    assertNotAborted(signal, 'postgresql');
    active = true;
    try {
      await adapter.begin();
      const tx = Object.freeze({
        backend: 'postgresql',
        async write(id, parameters = [], options = {}) {
          const result = await runPostgresqlWrite(adapter, id, parameters, { signal: options.signal ?? signal });
          metrics.writes += 1;
          return result;
        },
      });
      const result = await work(tx);
      assertNotAborted(signal, 'postgresql');
      await adapter.commit();
      metrics.transactions += 1;
      return result;
    } catch (error) {
      try { await adapter.rollback(); } catch {}
      metrics.rollbacks += 1;
      metrics.errors += 1;
      throw normalizeRuntimeWriteError(error, 'postgresql');
    } finally {
      active = false;
    }
  }

  async function write(id, parameters = [], options = {}) {
    return transaction((tx) => tx.write(id, parameters, options), options);
  }

  return {
    backend: 'postgresql',
    write,
    transaction,
    stop() { stopped = true; },
    status() { return { backend: 'postgresql', stopped, active, metrics: { ...metrics } }; },
  };
}

export function registerRuntimeWriteService(db, service) {
  if (!db || typeof db !== 'object') throw new Error('Runtime write database handle is required.');
  if (typeof service?.write !== 'function' || typeof service?.transaction !== 'function') {
    throw new Error('Runtime write service must implement write() and transaction().');
  }
  const existing = SERVICES.get(db);
  if (existing && existing !== service) throw new Error('A runtime write service is already registered for this database.');
  SERVICES.set(db, service);
  return service;
}

export function unregisterRuntimeWriteService(db, service = null) {
  const existing = SERVICES.get(db);
  if (!existing || (service && service !== existing)) return false;
  SERVICES.delete(db);
  return true;
}

export function runtimeWriteServiceFor(db) {
  return SERVICES.get(db) || null;
}

export function runRuntimeWrite(db, id, parameters = [], options = {}) {
  const service = SERVICES.get(db);
  return service ? service.write(id, parameters, options) : runSqliteRuntimeWrite(db, id, parameters, options);
}
