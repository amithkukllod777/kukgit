import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REQUIRED_KEYS, deployReadiness } from '../src/deploy-readiness.mjs';

const KUKGIT_KEYS = [
  'KUKGIT_DATA_DIR', 'KUKGIT_BACKUPS_DIR', 'KUKGIT_BASE_URL', 'KUKGIT_AUTH_MODE',
  'KUKGIT_ADMIN_PASSWORD', 'KUKGIT_DEV_GIT_TOKEN', 'KUKGIT_RATE_LIMIT_ENABLED',
  'KUKGIT_TRUST_PROXY', 'NODE_ENV', ...REQUIRED_KEYS.map(([name]) => name),
];

/**
 * The check reads `process.env`, so a test has to own it for the duration.
 * Restored afterwards, because a leaked `NODE_ENV=production` would quietly
 * change how every later test in the same process behaves.
 */
function environment(t, values) {
  const saved = new Map(KUKGIT_KEYS.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of KUKGIT_KEYS) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

function productionEnvironment(t, dataDir, overrides = {}) {
  const keys = Object.fromEntries(REQUIRED_KEYS.map(([name], index) => [name, `${'k'.repeat(40)}-distinct-${index}`]));
  environment(t, {
    NODE_ENV: 'production',
    KUKGIT_BASE_URL: 'https://git.example.com',
    KUKGIT_AUTH_MODE: 'authkit',
    KUKGIT_DATA_DIR: dataDir,
    KUKGIT_BACKUPS_DIR: path.join(path.dirname(dataDir), 'backups'),
    KUKGIT_TRUST_PROXY: 'true',
    ...keys,
    ...overrides,
  });
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-deploy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { mode: 0o750 });
  return { root, dataDir };
}

function find(report, id) {
  return report.checks.find((entry) => entry.id === id);
}

test('a correctly configured production box passes', async (t) => {
  const { root, dataDir } = workspace(t);
  productionEnvironment(t, dataDir);

  const report = await deployReadiness({ repositoryRoot: path.join(root, 'checkout'), port: 0 });
  assert.equal(report.mode, 'production');
  assert.equal(report.ready, true, JSON.stringify(report.checks.filter((entry) => entry.status === 'fail'), null, 2));
  assert.equal(report.failed, 0);
});

test('reusing one key for several purposes is caught', async (t) => {
  const { root, dataDir } = workspace(t);
  const same = 'the-same-long-random-looking-value-pasted-everywhere';
  productionEnvironment(t, dataDir, Object.fromEntries(REQUIRED_KEYS.map(([name]) => [name, same])));

  const report = await deployReadiness({ repositoryRoot: path.join(root, 'checkout'), port: 0 });
  // The way "generate each one separately" goes wrong is somebody running the
  // generator once and pasting the result five times. Every key is long, every
  // key is random, and one compromise opens all of them — which looks entirely
  // correct in an environment file and is checked nowhere else.
  assert.equal(report.ready, false);
  const duplicates = report.checks.filter((entry) => entry.status === 'fail' && /is the same value as/.test(entry.message));
  assert.equal(duplicates.length, REQUIRED_KEYS.length - 1);
  assert.match(duplicates[0].fix, /Generate each key separately/);
});

test('a data directory inside the source checkout fails', async (t) => {
  const { root } = workspace(t);
  const checkout = path.join(root, 'checkout');
  const inside = path.join(checkout, 'data');
  fs.mkdirSync(inside, { recursive: true, mode: 0o750 });
  productionEnvironment(t, inside);

  const report = await deployReadiness({ repositoryRoot: checkout, port: 0 });
  // The mistake that loses everything: convenient, works perfectly, and then the
  // first clean-checkout deploy takes the repositories, the LFS objects and the
  // database together.
  const location = find(report, 'data_dir_location');
  assert.equal(location.status, 'fail');
  assert.match(location.fix, /delete every repository/);
  assert.equal(report.ready, false);
});

test('a world-accessible data directory fails', async (t) => {
  const { root, dataDir } = workspace(t);
  fs.chmodSync(dataDir, 0o755);
  productionEnvironment(t, dataDir);

  const report = await deployReadiness({ repositoryRoot: path.join(root, 'checkout'), port: 0 });
  assert.equal(find(report, 'data_dir').status, 'fail');
  assert.match(find(report, 'data_dir').fix, /chmod 750/);
});

test('production refuses plain HTTP and a non-AuthKit identity', async (t) => {
  const { root, dataDir } = workspace(t);
  productionEnvironment(t, dataDir, { KUKGIT_BASE_URL: 'http://git.example.com', KUKGIT_AUTH_MODE: 'local' });

  const report = await deployReadiness({ repositoryRoot: path.join(root, 'checkout'), port: 0 });
  assert.equal(find(report, 'base_url').status, 'fail');
  // Production identity is One Kuklabs Account. This is the check that keeps a
  // "temporary" local password backend from becoming the production one.
  assert.equal(find(report, 'auth_mode').status, 'fail');
});

test('the development Git token is a failure until production, because it grants admin everywhere', async (t) => {
  const { root, dataDir } = workspace(t);
  productionEnvironment(t, dataDir, { NODE_ENV: 'development' });

  const report = await deployReadiness({ repositoryRoot: path.join(root, 'checkout'), port: 0 });
  const token = find(report, 'dev_git_token');
  assert.equal(token.status, 'fail');
  assert.match(token.message, /admin on every repository/);

  productionEnvironment(t, dataDir);
  assert.equal(find(await deployReadiness({ repositoryRoot: path.join(root, 'checkout'), port: 0 }), 'dev_git_token').status, 'pass');
});

test('backups inside the volume they protect are a warning, not a pass', async (t) => {
  const { root, dataDir } = workspace(t);
  productionEnvironment(t, dataDir, { KUKGIT_BACKUPS_DIR: path.join(dataDir, 'backups') });

  const report = await deployReadiness({ repositoryRoot: path.join(root, 'checkout'), port: 0 });
  const backups = find(report, 'backups');
  assert.equal(backups.status, 'warn');
  assert.match(backups.message, /inside the data directory/);
  // A warning rather than a failure: it is wrong, and it is not a reason to
  // block an internal trial from starting.
  assert.equal(report.ready, true);
});

test('every failure carries the line that fixes it', async (t) => {
  const { root } = workspace(t);
  environment(t, { NODE_ENV: 'production' });

  const report = await deployReadiness({ repositoryRoot: path.join(root, 'checkout'), port: 0 });
  assert.ok(report.failed > 0);
  // A checklist that reports a problem without saying what to do about it just
  // moves the work to whoever is reading it at 2am.
  for (const entry of report.checks.filter((check) => check.status === 'fail')) {
    assert.ok(entry.fix && entry.fix.length > 10, `${entry.id} has no fix`);
  }
});
