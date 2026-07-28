import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { findRepo, openDatabase, orgAccess, seedCore, uid } from '../src/db.mjs';
import {
  createRuntimeReadService,
  registerRuntimeReadService,
  runtimeReadServiceFor,
  unregisterRuntimeReadService,
} from '../src/runtime-read-service.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-runtime-read-service-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  const seeded = seedCore(db, config);
  const repositoryId = uid('repo');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'runtime-demo', 'Runtime Demo', '', 'private', 'main', ?)
  `).run(repositoryId, seeded.orgId, seeded.userId);
  return { db, config, repositoryId, ...seeded };
}

function nextImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('runtime service preserves exact orgAccess and findRepo results', (t) => {
  const { db, userId, repositoryId } = setup(t);
  const service = registerRuntimeReadService(db, createRuntimeReadService({ sqlite: db }));
  t.after(async () => {
    await service.stop();
    unregisterRuntimeReadService(db, service);
  });

  const access = orgAccess(db, userId, 'kuklabs', 'viewer');
  assert.equal(access.slug, 'kuklabs');
  assert.equal(access.role, 'owner');

  const repository = findRepo(db, 'kuklabs', 'runtime-demo');
  assert.equal(repository.id, repositoryId);
  assert.equal(repository.org_slug, 'kuklabs');
  assert.equal(repository.org_name, 'Kuklabs Inc.');
  assert.equal(repository.organization_id, access.id);
  assert.equal(service.status().metrics.authoritativeReads, 2);
});

test('observer runs after authoritative return and cannot substitute result', async (t) => {
  const { db, userId } = setup(t);
  const events = [];
  let observed = false;
  const observer = {
    observe(event) {
      observed = true;
      events.push(event);
      return true;
    },
  };
  const service = registerRuntimeReadService(db, createRuntimeReadService({ sqlite: db, observer }));
  t.after(async () => {
    await service.stop();
    unregisterRuntimeReadService(db, service);
  });

  const result = orgAccess(db, userId, 'kuklabs');
  assert.equal(result.role, 'owner');
  assert.equal(observed, false);
  await nextImmediate();
  assert.equal(observed, true);
  assert.equal(events[0].id, 'organizations.access_by_slug_and_user');
  assert.deepEqual(events[0].parameters, ['kuklabs', userId]);
  assert.equal(events[0].authoritativeResult.role, 'owner');
});

test('observer throw and rejected promise never change SQLite result', async (t) => {
  const { db } = setup(t);
  let calls = 0;
  const observer = {
    observe() {
      calls += 1;
      if (calls === 1) throw new Error('observer failure');
      return Promise.reject(new Error('async observer failure'));
    },
  };
  const service = registerRuntimeReadService(db, createRuntimeReadService({ sqlite: db, observer }));
  t.after(async () => {
    await service.stop();
    unregisterRuntimeReadService(db, service);
  });

  assert.equal(findRepo(db, 'kuklabs', 'runtime-demo').slug, 'runtime-demo');
  assert.equal(findRepo(db, 'kuklabs', 'runtime-demo').slug, 'runtime-demo');
  await nextImmediate();
  await nextImmediate();
  assert.equal(service.status().metrics.observerErrors, 2);
  assert.equal(service.status().metrics.authoritativeReads, 2);
});

test('runtime registry fails closed on duplicate service and supports guarded unregister', async (t) => {
  const { db } = setup(t);
  const first = createRuntimeReadService({ sqlite: db });
  const second = createRuntimeReadService({ sqlite: db });
  registerRuntimeReadService(db, first);
  assert.equal(runtimeReadServiceFor(db), first);
  assert.throws(() => registerRuntimeReadService(db, second), /already registered/i);
  assert.equal(unregisterRuntimeReadService(db, second), false);
  assert.equal(unregisterRuntimeReadService(db, first), true);
  assert.equal(runtimeReadServiceFor(db), null);
  await first.stop();
  await second.stop();
});

test('unknown read IDs and stopped service fail without dynamic SQL fallback', async (t) => {
  const { db } = setup(t);
  const service = createRuntimeReadService({ sqlite: db });
  assert.throws(() => service.read('unknown.dynamic.operation', []), /unknown runtime read catalog/i);
  await service.stop();
  assert.throws(() => service.read('repositories.find_by_slug', ['kuklabs', 'runtime-demo']), /stopped/i);
});
