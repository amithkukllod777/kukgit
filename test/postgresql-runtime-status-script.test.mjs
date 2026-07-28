import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'postgresql-runtime-status.mjs');

test('runtime observer status CLI is valid and reports disabled boundary by default', () => {
  const check = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);

  const run = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      KUKGIT_POSTGRESQL_RUNTIME_SHADOW_ENABLED: 'false',
      KUKGIT_AUTH_MODE: 'local',
    },
  });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.enabled, false);
  assert.match(payload.boundary, /SQLite remains authoritative/);
});
