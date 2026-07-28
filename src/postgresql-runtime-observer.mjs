import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createNodePostgresShadowAdapter } from './node-postgres-shadow-adapter.mjs';
import { compareRuntimeReadResults, runPostgresqlRuntimeRead } from './postgresql-shadow-read.mjs';
import { runtimeReadSpec } from './runtime-read-catalog.mjs';

const STATE_FORMAT = 'kukgit-postgresql-runtime-observer-state/1';

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function boundedRate(value, fallback = 0.05) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error('PostgreSQL runtime shadow sample rate must be between 0 and 1.');
  return number;
}

function safeCode(error, fallback) {
  const code = String(error?.code || '');
  return /^[A-Z0-9_]{3,100}$/.test(code) ? code : fallback;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return JSON.stringify({ $binary: Buffer.from(value).toString('base64') });
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'bigint') return JSON.stringify({ $bigint: value.toString() });
  return JSON.stringify(value);
}

function writeAtomic(target, payload) {
  const absolute = path.resolve(target);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, absolute);
  try { fs.chmodSync(absolute, 0o600); } catch {}
  return absolute;
}

function loadStage5Approval(reportPath, approval) {
  const target = path.resolve(reportPath);
  const report = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (report?.format !== 'kukgit-postgresql-shadow-read-report/1' || report.status !== 'verified') {
    throw new Error('A verified Stage 5 PostgreSQL shadow report is required.');
  }
  const expected = String(approval || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(expected) || report.reportFingerprint !== expected) {
    throw new Error('Exact Stage 5 report fingerprint approval is required.');
  }
  return {
    reportFingerprint: report.reportFingerprint,
    sourceFingerprint: report.sourceFingerprint || null,
    generatedAt: report.generatedAt || null,
    reportFile: path.basename(target),
  };
}

export function loadPostgresqlRuntimeObserverConfig(config, overrides = {}) {
  const enabled = booleanValue(
    overrides.enabled ?? process.env.KUKGIT_POSTGRESQL_RUNTIME_SHADOW_ENABLED,
    false,
  );
  const dataDir = path.resolve(config?.dataDir || process.cwd());
  const stage5ReportPath = path.resolve(
    overrides.stage5ReportPath ?? process.env.KUKGIT_POSTGRESQL_RUNTIME_SHADOW_STAGE5_REPORT ?? path.join(dataDir, 'database-migration', 'postgresql-shadow', 'postgresql-shadow-report.json'),
  );
  const statePath = path.resolve(
    overrides.statePath ?? process.env.KUKGIT_POSTGRESQL_RUNTIME_SHADOW_STATE_PATH ?? path.join(dataDir, 'database-migration', 'postgresql-runtime-shadow-state.json'),
  );
  const resolved = {
    enabled,
    stage5ReportPath,
    statePath,
    approval: String(overrides.approval ?? process.env.KUKGIT_POSTGRESQL_RUNTIME_SHADOW_APPROVAL ?? '').trim(),
    sampleRate: boundedRate(overrides.sampleRate ?? process.env.KUKGIT_POSTGRESQL_RUNTIME_SHADOW_SAMPLE_RATE, 0.05),
    samplingKey: String(overrides.samplingKey ?? process.env.KUKGIT_POSTGRESQL_RUNTIME_SHADOW_SAMPLING_KEY ?? '').trim(),
    maxQueue: boundedInteger(overrides.maxQueue ?? process.env.KUKGIT_POSTGRESQL_RUNTIME_SHADOW_MAX_QUEUE, 500, 1, 10000, 'PostgreSQL runtime shadow max queue'),
    concurrency: boundedInteger(overrides.concurrency ?? process.env.KUKGIT_POSTGRESQL_RUNTIME_SHADOW_CONCURRENCY, 1, 1, 4, 'PostgreSQL runtime shadow concurrency'),
    readTimeoutMs: boundedInteger(overrides.readTimeoutMs ?? process.env.KUKGIT_POSTGRESQL_RUNTIME_SHADOW_READ_TIMEOUT_MS, 1500, 100, 60000, 'PostgreSQL runtime shadow read timeout'),
    circuitErrors: boundedInteger(overrides.circuitErrors ?? process.env.KUKGIT_POSTGRESQL_RUNTIME_SHADOW_CIRCUIT_ERRORS, 5, 1, 100, 'PostgreSQL runtime shadow circuit error threshold'),
    circuitCooldownMs: boundedInteger(overrides.circuitCooldownMs ?? process.env.KUKGIT_POSTGRESQL_RUNTIME_SHADOW_CIRCUIT_COOLDOWN_MS, 60000, 1000, 3600000, 'PostgreSQL runtime shadow circuit cooldown'),
  };
  if (enabled) {
    if (resolved.samplingKey.length < 32) throw new Error('KUKGIT_POSTGRESQL_RUNTIME_SHADOW_SAMPLING_KEY must contain at least 32 characters.');
    if (resolved.statePath === resolved.stage5ReportPath) throw new Error('Runtime shadow state path cannot equal the Stage 5 report path.');
  }
  return resolved;
}

function shouldSample(config, id, parameters) {
  if (config.sampleRate <= 0) return false;
  if (config.sampleRate >= 1) return true;
  const digest = crypto.createHmac('sha256', config.samplingKey)
    .update(id)
    .update('\0')
    .update(stableJson(parameters))
    .digest();
  return digest.readUInt32BE(0) / 0x100000000 < config.sampleRate;
}

function emptyMetrics() {
  return {
    observed: 0,
    sampled: 0,
    notSampled: 0,
    matched: 0,
    mismatched: 0,
    errors: 0,
    droppedQueue: 0,
    droppedCircuit: 0,
  };
}

function operationMetrics(state, id) {
  state.operations[id] ||= emptyMetrics();
  return state.operations[id];
}

export function createPostgresqlRuntimeObserver({
  config,
  observerConfig = null,
  adapterConfig = null,
  adapterFactory = createNodePostgresShadowAdapter,
  pgModule = null,
  now = () => Date.now(),
} = {}) {
  const resolved = observerConfig?.enabled !== undefined
    ? loadPostgresqlRuntimeObserverConfig(config, observerConfig)
    : loadPostgresqlRuntimeObserverConfig(config);
  if (!resolved.enabled) return null;
  const approval = loadStage5Approval(resolved.stage5ReportPath, resolved.approval);
  const queue = [];
  const workers = [];
  const state = {
    format: STATE_FORMAT,
    status: 'running',
    startedAt: new Date(now()).toISOString(),
    updatedAt: new Date(now()).toISOString(),
    approvedStage5: approval,
    policy: {
      sampleRate: resolved.sampleRate,
      maxQueue: resolved.maxQueue,
      concurrency: resolved.concurrency,
      readTimeoutMs: resolved.readTimeoutMs,
      circuitErrors: resolved.circuitErrors,
      circuitCooldownMs: resolved.circuitCooldownMs,
    },
    metrics: emptyMetrics(),
    operations: {},
    circuit: { state: 'closed', consecutiveErrors: 0, openUntil: null },
    queueDepth: 0,
    activeWorkers: 0,
    lastResult: null,
    boundary: 'SQLite remains authoritative. PostgreSQL observations never block or replace request results and perform no writes or cutover.',
  };
  let accepting = true;
  let scheduled = false;
  let stopped = false;

  function persist() {
    state.updatedAt = new Date(now()).toISOString();
    state.queueDepth = queue.length;
    writeAtomic(resolved.statePath, state);
  }

  function circuitOpen() {
    const until = state.circuit.openUntil ? new Date(state.circuit.openUntil).getTime() : 0;
    if (state.circuit.state === 'open' && until <= now()) {
      state.circuit = { state: 'half_open', consecutiveErrors: state.circuit.consecutiveErrors, openUntil: null };
      persist();
      return false;
    }
    return state.circuit.state === 'open';
  }

  function recordMetric(id, key) {
    state.metrics[key] += 1;
    operationMetrics(state, id)[key] += 1;
  }

  function observe(event) {
    if (!accepting || stopped) return false;
    const spec = runtimeReadSpec(event?.id);
    if (!Array.isArray(event?.parameters) || event.parameters.length !== spec.parameters.length) return false;
    recordMetric(spec.id, 'observed');
    if (!shouldSample(resolved, spec.id, event.parameters)) {
      recordMetric(spec.id, 'notSampled');
      return false;
    }
    if (circuitOpen()) {
      recordMetric(spec.id, 'droppedCircuit');
      persist();
      return false;
    }
    if (queue.length >= resolved.maxQueue) {
      recordMetric(spec.id, 'droppedQueue');
      persist();
      return false;
    }
    queue.push({
      id: spec.id,
      parameters: event.parameters,
      authoritativeResult: event.authoritativeResult,
      observedAt: event.observedAt || new Date(now()).toISOString(),
    });
    recordMetric(spec.id, 'sampled');
    persist();
    schedule();
    return true;
  }

  async function closeWorker(worker) {
    if (!worker.adapter) return;
    try { await worker.adapter.close(); } catch {}
    worker.adapter = null;
  }

  async function ensureAdapter(worker) {
    if (worker.adapter) return worker.adapter;
    const adapter = await adapterFactory(adapterConfig || {}, { pgModule });
    await adapter.connect();
    worker.adapter = adapter;
    return adapter;
  }

  async function processJob(worker, job) {
    let adapter;
    let transaction = false;
    try {
      adapter = await ensureAdapter(worker);
      await adapter.beginReadOnly();
      transaction = true;
      const spec = runtimeReadSpec(job.id);
      const targetResult = await runPostgresqlRuntimeRead(adapter, spec, job.parameters, {
        timeoutMs: resolved.readTimeoutMs,
      });
      const comparison = compareRuntimeReadResults(spec, job.authoritativeResult, targetResult);
      await adapter.rollback();
      transaction = false;
      const key = comparison.valid ? 'matched' : 'mismatched';
      recordMetric(job.id, key);
      state.circuit = { state: 'closed', consecutiveErrors: 0, openUntil: null };
      state.lastResult = {
        operation: job.id,
        status: comparison.valid ? 'matched' : 'mismatched',
        observedAt: job.observedAt,
        completedAt: new Date(now()).toISOString(),
        sourceRowCount: comparison.sourceRowCount,
        targetRowCount: comparison.targetRowCount,
        sourceFingerprint: comparison.sourceFingerprint,
        targetFingerprint: comparison.targetFingerprint,
      };
    } catch (error) {
      if (transaction && adapter) {
        try { await adapter.rollback(); } catch {}
      }
      await closeWorker(worker);
      recordMetric(job.id, 'errors');
      const consecutiveErrors = state.circuit.consecutiveErrors + 1;
      state.circuit = consecutiveErrors >= resolved.circuitErrors
        ? {
            state: 'open',
            consecutiveErrors,
            openUntil: new Date(now() + resolved.circuitCooldownMs).toISOString(),
          }
        : { state: 'closed', consecutiveErrors, openUntil: null };
      state.lastResult = {
        operation: job.id,
        status: 'error',
        observedAt: job.observedAt,
        completedAt: new Date(now()).toISOString(),
        error: { code: safeCode(error, 'POSTGRESQL_RUNTIME_SHADOW_FAILED') },
      };
    } finally {
      persist();
    }
  }

  async function workerLoop(worker) {
    if (worker.running || stopped) return;
    worker.running = true;
    state.activeWorkers += 1;
    persist();
    try {
      while (!stopped) {
        const job = queue.shift();
        if (!job) break;
        await processJob(worker, job);
      }
    } finally {
      worker.running = false;
      state.activeWorkers -= 1;
      persist();
    }
  }

  function schedule() {
    if (scheduled || stopped) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      for (const worker of workers) void workerLoop(worker);
    });
  }

  for (let index = 0; index < resolved.concurrency; index += 1) {
    workers.push({ id: index + 1, adapter: null, running: false });
  }
  persist();

  async function stop({ drainMs = 5000 } = {}) {
    if (stopped) return;
    accepting = false;
    const timeout = Math.max(0, Math.min(Number(drainMs) || 0, 60000));
    const deadline = now() + timeout;
    while ((queue.length || workers.some((worker) => worker.running)) && now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (queue.length) {
      for (const job of queue.splice(0)) recordMetric(job.id, 'droppedQueue');
    }
    stopped = true;
    await Promise.all(workers.map(closeWorker));
    state.status = 'stopped';
    persist();
  }

  return {
    observe,
    stop,
    status() {
      return structuredClone({
        ...state,
        queueDepth: queue.length,
        activeWorkers: workers.filter((worker) => worker.running).length,
        statePath: resolved.statePath,
      });
    },
  };
}

export const POSTGRESQL_RUNTIME_OBSERVER_STATE_FORMAT = STATE_FORMAT;
