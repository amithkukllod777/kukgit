import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { loadPostgresqlRuntimeObserverConfig } from '../src/postgresql-runtime-observer.mjs';

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const config = loadConfig();
const observer = loadPostgresqlRuntimeObserverConfig(config);
if (!observer.enabled) {
  print({
    format: 'kukgit-postgresql-runtime-observer-status/1',
    enabled: false,
    boundary: 'SQLite remains authoritative. PostgreSQL runtime observation is disabled.',
  });
  process.exit(0);
}

if (!fs.existsSync(observer.statePath)) {
  print({
    format: 'kukgit-postgresql-runtime-observer-status/1',
    enabled: true,
    state: 'not_started',
    statePath: observer.statePath,
    boundary: 'SQLite remains authoritative. No runtime observation evidence exists yet.',
  });
  process.exit(2);
}

const state = JSON.parse(fs.readFileSync(observer.statePath, 'utf8'));
if (state?.format !== 'kukgit-postgresql-runtime-observer-state/1') {
  throw new Error('Runtime shadow state file has an unsupported format.');
}

print({
  format: 'kukgit-postgresql-runtime-observer-status/1',
  enabled: true,
  statePath: observer.statePath,
  status: state.status,
  startedAt: state.startedAt,
  updatedAt: state.updatedAt,
  approvedStage5: state.approvedStage5,
  policy: state.policy,
  metrics: state.metrics,
  operations: state.operations,
  circuit: state.circuit,
  queueDepth: state.queueDepth,
  activeWorkers: state.activeWorkers,
  lastResult: state.lastResult,
  boundary: state.boundary,
});

process.exit(state.status === 'stopped' || state.circuit?.state === 'closed' ? 0 : 2);
