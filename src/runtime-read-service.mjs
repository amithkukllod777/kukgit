import { runSqliteRuntimeRead } from './postgresql-shadow-read.mjs';
import { runtimeReadSpec } from './runtime-read-catalog.mjs';

const SERVICES = new WeakMap();

function cloneObservation(parameters, authoritativeResult) {
  try {
    return structuredClone({ parameters, authoritativeResult });
  } catch {
    return {
      parameters: Array.isArray(parameters) ? [...parameters] : [],
      authoritativeResult,
    };
  }
}

export function createRuntimeReadService({ sqlite, observer = null } = {}) {
  if (typeof sqlite?.prepare !== 'function') throw new Error('Runtime read service requires a SQLite-compatible authoritative database.');
  if (observer && typeof observer.observe !== 'function') throw new Error('Runtime read observer must implement observe(event).');
  const metrics = {
    authoritativeReads: 0,
    observerScheduled: 0,
    observerRejected: 0,
    observerErrors: 0,
  };
  let stopped = false;

  function read(id, parameters = []) {
    if (stopped) throw new Error('Runtime read service is stopped.');
    const spec = runtimeReadSpec(id);
    const result = runSqliteRuntimeRead(sqlite, spec, parameters);
    metrics.authoritativeReads += 1;
    if (observer) {
      const snapshot = cloneObservation(parameters, result);
      metrics.observerScheduled += 1;
      queueMicrotask(() => {
        try {
          const accepted = observer.observe({
            id: spec.id,
            parameters: snapshot.parameters,
            authoritativeResult: snapshot.authoritativeResult,
            observedAt: new Date().toISOString(),
          });
          if (accepted === false) metrics.observerRejected += 1;
          Promise.resolve(accepted).catch(() => { metrics.observerErrors += 1; });
        } catch {
          metrics.observerErrors += 1;
        }
      });
    }
    return result;
  }

  async function stop(options = {}) {
    if (stopped) return;
    stopped = true;
    if (observer?.stop) {
      try { await observer.stop(options); }
      catch { metrics.observerErrors += 1; }
    }
  }

  return {
    read,
    stop,
    status() {
      return {
        stopped,
        observerEnabled: Boolean(observer),
        metrics: { ...metrics },
        observer: observer?.status ? observer.status() : null,
      };
    },
  };
}

export function registerRuntimeReadService(db, service) {
  if (!db || typeof db !== 'object') throw new Error('Runtime read database handle is required.');
  if (typeof service?.read !== 'function') throw new Error('Runtime read service must implement read(id, parameters).');
  const existing = SERVICES.get(db);
  if (existing && existing !== service) throw new Error('A runtime read service is already registered for this database.');
  SERVICES.set(db, service);
  return service;
}

export function unregisterRuntimeReadService(db, service = null) {
  const existing = SERVICES.get(db);
  if (!existing || (service && service !== existing)) return false;
  SERVICES.delete(db);
  return true;
}

export function runtimeReadServiceFor(db) {
  return SERVICES.get(db) || null;
}

export function runRuntimeRead(db, id, parameters = []) {
  const service = SERVICES.get(db);
  return service ? service.read(id, parameters) : runSqliteRuntimeRead(db, runtimeReadSpec(id), parameters);
}
