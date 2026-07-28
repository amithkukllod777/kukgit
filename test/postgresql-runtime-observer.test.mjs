import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import {
  createPostgresqlRuntimeObserver,
  loadPostgresqlRuntimeObserverConfig,
} from '../src/postgresql-runtime-observer.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-runtime-observer-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
  });
  const reportFingerprint = 'a'.repeat(64);
  const stage5ReportPath = path.join(dataDir, 'stage5-report.json');
  fs.writeFileSync(stage5ReportPath, JSON.stringify({
    format: 'kukgit-postgresql-shadow-read-report/1',
    status: 'verified',
    generatedAt: '2026-07-27T00:00:00.000Z',
    sourceFingerprint: 'b'.repeat(64),
    reportFingerprint,
  }), { mode: 0o600 });
  return {
    config,
    dataDir,
    reportFingerprint,
    stage5ReportPath,
    statePath: path.join(dataDir, 'runtime-shadow-state.json'),
  };
}

function observerConfig(setupValue, overrides = {}) {
  return {
    enabled: true,
    stage5ReportPath: setupValue.stage5ReportPath,
    statePath: setupValue.statePath,
    approval: setupValue.reportFingerprint,
    sampleRate: 1,
    samplingKey: 'runtime-observer-test-sampling-key-with-strong-entropy',
    maxQueue: 10,
    concurrency: 1,
    readTimeoutMs: 1000,
    circuitErrors: 3,
    circuitCooldownMs: 60000,
    ...overrides,
  };
}

async function waitUntil(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for observer state.');
}

function matchingAdapterFactory(expectedRole = 'owner', lifecycle = []) {
  return async () => ({
    async connect() {
      lifecycle.push('connect');
      return {
        serverVersionNumber: '160002',
        schema: 'kukgit_shadow',
        sslMode: 'disable',
        databaseUrl: 'postgresql://shadow:***@localhost:5432/kukgit',
      };
    },
    async beginReadOnly() { lifecycle.push('begin'); },
    async query(_sql, values) {
      lifecycle.push('query');
      return { rows: [{ id: 'org_1', slug: values[0], name: 'Kuklabs Inc.', plan: 'founder', role: expectedRole }] };
    },
    async rollback() { lifecycle.push('rollback'); },
    async close() { lifecycle.push('close'); },
  });
}

function event(role = 'owner') {
  return {
    id: 'organizations.access_by_slug_and_user',
    parameters: ['kuklabs', 'usr_private_value'],
    authoritativeResult: {
      id: 'org_1',
      slug: 'kuklabs',
      name: 'Kuklabs Inc.',
      plan: 'founder',
      role,
    },
    observedAt: '2026-07-27T01:00:00.000Z',
  };
}

test('runtime observer matches asynchronously and writes aggregate private evidence', async (t) => {
  const setupValue = setup(t);
  const lifecycle = [];
  const observer = createPostgresqlRuntimeObserver({
    config: setupValue.config,
    observerConfig: observerConfig(setupValue),
    adapterFactory: matchingAdapterFactory('owner', lifecycle),
  });
  assert.equal(observer.observe(event()), true);
  await waitUntil(() => observer.status().metrics.matched === 1);
  const status = observer.status();
  assert.equal(status.metrics.sampled, 1);
  assert.equal(status.metrics.matched, 1);
  assert.equal(status.metrics.errors, 0);
  assert.equal(fs.statSync(setupValue.statePath).mode & 0o777, 0o600);
  const evidence = fs.readFileSync(setupValue.statePath, 'utf8');
  assert.equal(evidence.includes('usr_private_value'), false);
  assert.equal(evidence.includes('owner@example.com'), false);
  assert.equal(evidence.includes('top-secret'), false);
  assert.equal(evidence.includes('sourceFingerprint'), true);
  await observer.stop({ drainMs: 1000 });
  assert.ok(lifecycle.includes('rollback'));
  assert.ok(lifecycle.includes('close'));
});

test('mismatch is recorded but only aggregate fingerprints enter evidence', async (t) => {
  const setupValue = setup(t);
  const observer = createPostgresqlRuntimeObserver({
    config: setupValue.config,
    observerConfig: observerConfig(setupValue),
    adapterFactory: matchingAdapterFactory('viewer'),
  });
  observer.observe(event('owner'));
  await waitUntil(() => observer.status().metrics.mismatched === 1);
  const last = observer.status().lastResult;
  assert.equal(last.status, 'mismatched');
  assert.match(last.sourceFingerprint, /^[0-9a-f]{64}$/);
  assert.match(last.targetFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(last).includes('owner'), false);
  assert.equal(JSON.stringify(last).includes('viewer'), false);
  await observer.stop({ drainMs: 1000 });
});

test('sample rate zero records observation without opening PostgreSQL', async (t) => {
  const setupValue = setup(t);
  let adapters = 0;
  const observer = createPostgresqlRuntimeObserver({
    config: setupValue.config,
    observerConfig: observerConfig(setupValue, { sampleRate: 0 }),
    adapterFactory: async () => { adapters += 1; throw new Error('must not connect'); },
  });
  assert.equal(observer.observe(event()), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observer.status().metrics.notSampled, 1);
  assert.equal(adapters, 0);
  await observer.stop({ drainMs: 0 });
});

test('adapter errors open circuit and later observations are dropped safely', async (t) => {
  const setupValue = setup(t);
  let closes = 0;
  const observer = createPostgresqlRuntimeObserver({
    config: setupValue.config,
    observerConfig: observerConfig(setupValue, { circuitErrors: 1, circuitCooldownMs: 60000 }),
    adapterFactory: async () => ({
      async connect() { return {}; },
      async beginReadOnly() {},
      async query() {
        const error = new Error('contains private row and credentials');
        error.code = 'POSTGRESQL_TEST_FAILURE';
        throw error;
      },
      async rollback() {},
      async close() { closes += 1; },
    }),
  });
  assert.equal(observer.observe(event()), true);
  await waitUntil(() => observer.status().metrics.errors === 1);
  assert.equal(observer.status().circuit.state, 'open');
  assert.equal(observer.observe(event()), false);
  assert.equal(observer.status().metrics.droppedCircuit, 1);
  const evidence = fs.readFileSync(setupValue.statePath, 'utf8');
  assert.equal(evidence.includes('private row'), false);
  assert.equal(evidence.includes('credentials'), false);
  assert.equal(evidence.includes('POSTGRESQL_TEST_FAILURE'), true);
  await observer.stop({ drainMs: 1000 });
  assert.ok(closes >= 1);
});

test('bounded queue drops overload without changing accepted work', async (t) => {
  const setupValue = setup(t);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const observer = createPostgresqlRuntimeObserver({
    config: setupValue.config,
    observerConfig: observerConfig(setupValue, { maxQueue: 1, concurrency: 1 }),
    adapterFactory: async () => ({
      async connect() { return {}; },
      async beginReadOnly() {},
      async query(_sql, values) {
        await blocked;
        return { rows: [{ id: 'org_1', slug: values[0], name: 'Kuklabs Inc.', plan: 'founder', role: 'owner' }] };
      },
      async rollback() {},
      async close() {},
    }),
  });
  assert.equal(observer.observe(event()), true);
  await waitUntil(() => observer.status().activeWorkers === 1);
  assert.equal(observer.observe(event()), true);
  assert.equal(observer.observe(event()), false);
  assert.equal(observer.status().metrics.droppedQueue, 1);
  release();
  await waitUntil(() => observer.status().metrics.matched === 2);
  await observer.stop({ drainMs: 1000 });
});

test('approval, report, key and state-path validation fail closed', (t) => {
  const setupValue = setup(t);
  assert.throws(
    () => createPostgresqlRuntimeObserver({
      config: setupValue.config,
      observerConfig: observerConfig(setupValue, { approval: 'c'.repeat(64) }),
      adapterFactory: matchingAdapterFactory(),
    }),
    /exact Stage 5 report fingerprint/i,
  );
  assert.throws(
    () => loadPostgresqlRuntimeObserverConfig(setupValue.config, observerConfig(setupValue, { samplingKey: 'short' })),
    /sampling[_ ]key/i,
  );
  assert.throws(
    () => loadPostgresqlRuntimeObserverConfig(setupValue.config, observerConfig(setupValue, { statePath: setupValue.stage5ReportPath })),
    /cannot equal/i,
  );
  fs.writeFileSync(setupValue.stage5ReportPath, JSON.stringify({ format: 'wrong', status: 'verified', reportFingerprint: setupValue.reportFingerprint }));
  assert.throws(
    () => createPostgresqlRuntimeObserver({
      config: setupValue.config,
      observerConfig: observerConfig(setupValue),
      adapterFactory: matchingAdapterFactory(),
    }),
    /verified Stage 5/i,
  );
});
