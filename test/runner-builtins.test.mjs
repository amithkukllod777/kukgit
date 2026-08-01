import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  archivePath,
  executeJob,
  extractArchive,
  resolveInputs,
  resolveWorkspacePath,
} from '../src/runner-agent.mjs';

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-builtin-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

// Records what the agent asked the instance to store, so a test asserts on the
// call rather than on what was printed.
function fakeClient({ cacheHits = {} } = {}) {
  const state = { logs: [], artifacts: [], savedCaches: [], restoreRequests: [], completed: null };
  return {
    state,
    text: () => state.logs.map((chunk) => chunk.content).join(''),
    async appendLogs(_token, chunks) { state.logs.push(...chunks); return { accepted: chunks.length }; },
    async heartbeat() { return { cancelled: false }; },
    async complete(_token, status, reason) { state.completed = { status, reason }; return { runStatus: status }; },
    async uploadArtifact(_token, options, content) {
      state.artifacts.push({ ...options, content });
      return { name: options.name, size: content.length, retentionDays: options.retentionDays ?? 30 };
    },
    async saveCache(_token, key, content) {
      state.savedCaches.push({ key, content });
      return { key, size: content.length, stored: true };
    },
    async restoreCache(_token, request) {
      state.restoreRequests.push(request);
      const hit = cacheHits[request.key]
        ?? request.restoreKeys.map((prefix) => cacheHits[prefix]).find(Boolean);
      return hit ?? null;
    },
  };
}

function jobFixture(steps, overrides = {}) {
  return {
    job: {
      id: 'job_1', key: 'build', name: 'Build', timeoutMinutes: 5,
      env: {}, permissions: {}, steps, ...overrides.job,
    },
    run: {
      id: 'run_1', repository: 'kuklabs/app', ref: 'refs/heads/main',
      commitSha: 'a'.repeat(40), event: 'push', fork: false, ...overrides.run,
    },
    secrets: overrides.secrets ?? {},
    token: 'job-token',
  };
}

const cacheStep = (inputs) => ({ type: 'uses', uses: { raw: 'kukgit/cache@v1', builtin: 'cache' }, with: inputs });
const artifactStep = (inputs) => ({ type: 'uses', uses: { raw: 'kukgit/upload-artifact@v1', builtin: 'upload-artifact' }, with: inputs });

test('a workflow path may not reach outside the workspace', (t) => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'build'));

  assert.equal(resolveWorkspacePath(root, 'build'), path.join(root, 'build'));
  assert.equal(resolveWorkspacePath(root, './build/../build'), path.join(root, 'build'));

  // A path that escaped would let a workflow archive the runner's own files —
  // its configuration, its registration token, whatever else is on the machine.
  for (const escape of ['../outside', '/etc/passwd', 'build/../../..']) {
    assert.throws(() => resolveWorkspacePath(root, escape), /inside the workspace/, escape);
  }
  assert.throws(() => resolveWorkspacePath(root, '  '), /required/);
});

test('a directory round-trips through archive and extract', async (t) => {
  const source = workspace(t);
  fs.mkdirSync(path.join(source, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(source, 'node_modules/pkg/index.js'), 'module.exports = 1;');

  const packed = await archivePath(source, 'node_modules');
  assert.equal(packed.found, true);

  const target = workspace(t);
  await extractArchive(target, packed.content);
  assert.equal(fs.readFileSync(path.join(target, 'node_modules/pkg/index.js'), 'utf8'), 'module.exports = 1;');

  // A path that is not there is reported, not thrown: an artifact step whose
  // output was never produced is a normal outcome the workflow chooses how to
  // treat.
  assert.deepEqual(await archivePath(source, 'never-built'), { found: false, content: null });
});

test('inputs resolve the same allow-list a run script gets, and nothing more', () => {
  const context = {
    job: { key: 'build' },
    run: { id: 'run_1', repository: 'kuklabs/app', ref: 'refs/heads/main', commitSha: 'abc123', event: 'push' },
  };
  const resolved = resolveInputs({
    key: 'npm-${{ github.ref_name }}-${{ github.sha }}',
    path: 'node_modules',
    unknown: '${{ secrets.TOKEN }}',
  }, context);

  assert.equal(resolved.key, 'npm-main-abc123');
  assert.equal(resolved.path, 'node_modules');
  // The validator refuses a secret in a built-in input; if one arrives anyway it
  // is left as written rather than substituted, so the bug is visible.
  assert.equal(resolved.unknown, '${{ secrets.TOKEN }}');
});

test('an artifact step uploads what the build produced', async (t) => {
  const root = workspace(t);
  const client = fakeClient();

  const result = await executeJob(client, jobFixture([
    { type: 'run', run: 'mkdir -p reports && echo passed > reports/summary.txt' },
    artifactStep({ name: 'test-reports', path: 'reports', 'retention-days': '7' }),
  ]), { workspaceRoot: root });

  assert.equal(result.status, 'success');
  assert.equal(client.state.artifacts.length, 1);
  assert.equal(client.state.artifacts[0].name, 'test-reports');
  assert.equal(client.state.artifacts[0].retentionDays, '7');
  assert.ok(client.state.artifacts[0].content.length > 0);
  assert.match(client.text(), /uploaded artifact 'test-reports'/);
});

test('a missing artifact path warns by default and fails only when asked to', async (t) => {
  const warned = fakeClient();
  const warnResult = await executeJob(warned, jobFixture([
    artifactStep({ name: 'reports', path: 'never-produced' }),
  ]), { workspaceRoot: workspace(t) });
  assert.equal(warnResult.status, 'success');
  assert.equal(warned.state.artifacts.length, 0);
  assert.match(warned.text(), /no files matched 'never-produced'/);

  const strict = fakeClient();
  const strictResult = await executeJob(strict, jobFixture([
    artifactStep({ name: 'reports', path: 'never-produced', 'if-no-files-found': 'error' }),
  ]), { workspaceRoot: workspace(t) });
  assert.equal(strictResult.status, 'failure');
  assert.match(strictResult.reason, /no files matched/);
});

test('a cache miss restores nothing and saves after the job succeeds', async (t) => {
  const root = workspace(t);
  const client = fakeClient();

  const result = await executeJob(client, jobFixture([
    cacheStep({ key: 'npm-${{ github.sha }}', path: 'node_modules', 'restore-keys': 'npm-\nnpm-legacy-' }),
    { type: 'run', run: 'mkdir -p node_modules && echo installed > node_modules/marker' },
  ]), { workspaceRoot: root });

  assert.equal(result.status, 'success');
  assert.deepEqual(client.state.restoreRequests, [{
    key: `npm-${'a'.repeat(40)}`, restoreKeys: ['npm-', 'npm-legacy-'],
  }]);
  // Saving happens after the job, because the content the cache is meant to
  // hold does not exist when the step runs.
  assert.equal(client.state.savedCaches.length, 1);
  assert.equal(client.state.savedCaches[0].key, `npm-${'a'.repeat(40)}`);
  assert.match(client.text(), /cache miss/);
  assert.match(client.text(), /cache saved as/);
});

test('an exact cache hit is restored and not written back', async (t) => {
  const source = workspace(t);
  fs.mkdirSync(path.join(source, 'node_modules'));
  fs.writeFileSync(path.join(source, 'node_modules/marker'), 'from an earlier build');
  const packed = await archivePath(source, 'node_modules');

  const root = workspace(t);
  const client = fakeClient({
    cacheHits: { 'npm-lock': { key: 'npm-lock', ref: 'refs/heads/main', exact: true, content: packed.content } },
  });

  const result = await executeJob(client, jobFixture([
    cacheStep({ key: 'npm-lock', path: 'node_modules' }),
    { type: 'run', run: 'cat node_modules/marker' },
  ]), { workspaceRoot: root });

  assert.equal(result.status, 'success');
  assert.match(client.text(), /from an earlier build/, 'the restored content is on disk for the next step');
  // The bytes under that key are already the bytes we would write.
  assert.equal(client.state.savedCaches.length, 0);
});

test('a prefix hit is restored and still written back under the exact key', async (t) => {
  const source = workspace(t);
  fs.mkdirSync(path.join(source, 'deps'));
  fs.writeFileSync(path.join(source, 'deps/old'), 'stale');
  const packed = await archivePath(source, 'deps');

  const client = fakeClient({
    cacheHits: { 'npm-': { key: 'npm-older', ref: 'refs/heads/main', exact: false, content: packed.content } },
  });
  const result = await executeJob(client, jobFixture([
    cacheStep({ key: 'npm-exact', path: 'deps', 'restore-keys': 'npm-' }),
    { type: 'run', run: 'echo fresh >> deps/old' },
  ]), { workspaceRoot: workspace(t) });

  assert.equal(result.status, 'success');
  assert.match(client.text(), /prefix match/);
  assert.equal(client.state.savedCaches.length, 1);
  assert.equal(client.state.savedCaches[0].key, 'npm-exact');
});

test('a failed job saves no cache', async (t) => {
  const client = fakeClient();
  const result = await executeJob(client, jobFixture([
    cacheStep({ key: 'npm-lock', path: 'node_modules' }),
    { type: 'run', run: 'mkdir -p node_modules && echo half-built > node_modules/marker && exit 1' },
  ]), { workspaceRoot: workspace(t) });

  assert.equal(result.status, 'failure');
  // A cache written from a broken build is one every later build restores, so a
  // single bad run would keep costing until somebody cleared it by hand.
  assert.equal(client.state.savedCaches.length, 0);
});

test('a build is not failed by a cache service that is unreachable', async (t) => {
  const client = fakeClient();
  client.restoreCache = async () => { throw new Error('connection refused'); };
  client.saveCache = async () => { throw new Error('connection refused'); };

  const result = await executeJob(client, jobFixture([
    cacheStep({ key: 'npm-lock', path: 'node_modules' }),
    { type: 'run', run: 'mkdir -p node_modules && echo built > node_modules/marker' },
  ]), { workspaceRoot: workspace(t) });

  // A cache is an optimisation. Failing the build because the cache service was
  // down would turn a slow build into a broken one.
  assert.equal(result.status, 'success');
  assert.match(client.text(), /cache could not be restored/);
  assert.match(client.text(), /cache could not be saved/);
});

test('an artifact path that escapes the workspace fails the step', async (t) => {
  const client = fakeClient();
  const result = await executeJob(client, jobFixture([
    artifactStep({ name: 'exfiltrated', path: '../../etc' }),
  ]), { workspaceRoot: workspace(t) });

  assert.equal(result.status, 'failure');
  assert.match(result.reason, /inside the workspace/);
  assert.equal(client.state.artifacts.length, 0);
});
