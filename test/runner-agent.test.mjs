import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createLogBuffer,
  executeJob,
  resolveRunScript,
  runStep,
  stepEnvironment,
} from '../src/runner-agent.mjs';

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-agent-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function collector() {
  const chunks = [];
  return { chunks, onOutput: (chunk) => chunks.push(chunk), text: () => chunks.map((chunk) => chunk.content).join('') };
}

// A client that records everything, so a test asserts on what the agent reported
// rather than on what it printed.
function fakeClient({ cancelAfter = Infinity, failLogs = 0 } = {}) {
  const state = { logs: [], heartbeats: 0, completed: null, logAttempts: 0 };
  return {
    state,
    async appendLogs(_token, chunks) {
      state.logAttempts += 1;
      if (state.logAttempts <= failLogs) throw new Error('network');
      state.logs.push(...chunks);
      return { accepted: chunks.length };
    },
    async heartbeat() {
      state.heartbeats += 1;
      return { cancelled: state.heartbeats > cancelAfter };
    },
    async complete(_token, status, reason) {
      state.completed = { status, reason };
      return { runStatus: status };
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
      commitSha: 'a'.repeat(40), event: 'push', fork: false,
      cloneUrl: 'http://127.0.0.1:8787/git/kuklabs/app.git', ...overrides.run,
    },
    secrets: overrides.secrets ?? {},
    token: 'job-token',
  };
}

test('a step script is executed as a file, never as a command string', async (t) => {
  const cwd = workspace(t);
  const output = collector();

  // If the script were assembled into a shell command, this would break out of
  // it. Executed as a file, it is just text the script itself contains.
  const result = await runStep({
    script: 'echo "safe: $(echo nested)"; echo \'; touch /tmp/kukgit-escape-marker\'',
    cwd,
    env: { PATH: process.env.PATH },
    timeoutMs: 10_000,
    onOutput: output.onOutput,
  });

  assert.equal(result.ok, true);
  assert.match(output.text(), /safe: nested/);
  assert.match(output.text(), /; touch \/tmp\/kukgit-escape-marker/);
  assert.equal(fs.existsSync('/tmp/kukgit-escape-marker'), false, 'nothing escaped the script');
});

test('a failing step reports its exit code and stops the job', async (t) => {
  const cwd = workspace(t);
  const failing = await runStep({
    script: 'echo before\nexit 3\necho after',
    cwd, env: { PATH: process.env.PATH }, timeoutMs: 10_000, onOutput: () => {},
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.code, 3);
  assert.match(failing.reason, /exited with code 3/);

  // `set -e` means a failing command in the middle stops the rest.
  const output = collector();
  const midway = await runStep({
    script: 'echo one\nfalse\necho two',
    cwd, env: { PATH: process.env.PATH }, timeoutMs: 10_000, onOutput: output.onOutput,
  });
  assert.equal(midway.ok, false);
  assert.match(output.text(), /one/);
  assert.doesNotMatch(output.text(), /two/);
});

test('a step that runs too long is killed and reported as a timeout', async (t) => {
  const cwd = workspace(t);
  const started = Date.now();
  const result = await runStep({
    script: 'sleep 30',
    cwd, env: { PATH: process.env.PATH }, timeoutMs: 1200, onOutput: () => {},
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /exceeded its .* timeout/);
  // A timeout that reports at thirty seconds is not a 1.2-second timeout. This
  // used to take the full sleep, because the step's orphaned children still
  // held its output pipes and `close` waits for the streams, not the process.
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started}ms`);
});

test('an aborted step is stopped and reported as cancelled, not failed', async (t) => {
  const cwd = workspace(t);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300).unref?.();

  const started = Date.now();
  const result = await runStep({
    script: 'sleep 30',
    cwd, env: { PATH: process.env.PATH }, timeoutMs: 30_000, signal: controller.signal, onOutput: () => {},
  });
  // The reason is in the assertion message because this test failed under load
  // with `cancelled` undefined, and every path that produces that carries a
  // different reason. It turned out to be the timeout at 30_000ms racing the
  // step's own late resolution at the same instant — which is the bug the
  // elapsed-time assertion below now holds shut.
  assert.equal(result.cancelled, true, `reason: ${result.reason}`);
  assert.equal(result.reason, 'cancelled');
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started}ms`);
});

test('cancelling a step kills the work it started, not only the shell', async (t) => {
  const cwd = workspace(t);
  const controller = new AbortController();
  const pidFile = path.join(cwd, 'child.pid');
  setTimeout(() => controller.abort(), 500).unref?.();

  const result = await runStep({
    // A background child, which is what a real step does: a dev server, a
    // database, a watcher. Killing the shell leaves it running.
    script: 'sleep 30 & echo $! > child.pid; wait',
    cwd, env: { PATH: process.env.PATH }, timeoutMs: 30_000, signal: controller.signal, onOutput: () => {},
  });
  assert.equal(result.cancelled, true, `reason: ${result.reason}`);

  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(Number.isInteger(pid) && pid > 0);

  // "Not running" rather than "no such pid". When the shell dies first the
  // child is re-parented to pid 1, and in a container pid 1 is often not an
  // init that reaps — so a killed process sits as a zombie and signal 0 still
  // finds it. A zombie has exited, which is the thing being asserted.
  let stopped = false;
  for (let attempt = 0; attempt < 20 && !stopped; attempt += 1) {
    try {
      process.kill(pid, 0);
      const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      stopped = state === '' || state.startsWith('Z');
    } catch { stopped = true; }
    if (!stopped) await new Promise((done) => setTimeout(done, 100));
  }
  // A cancelled deployment whose deploy command is still running is a
  // deployment nobody can stop.
  assert.ok(stopped, "the step's child outlived its cancellation");
});

test('a step already cancelled before it starts does not run', async (t) => {
  const cwd = workspace(t);
  const controller = new AbortController();
  // Aborted before `runStep` is even called. An already-aborted signal fires no
  // event, so a listener alone never sees it — and this is not hypothetical:
  // under load, cancellation lands in the window between the caller checking the
  // signal and the step attaching to it. This test was written after that
  // window made an unrelated test fail once, at thirty seconds, in CI-like load.
  controller.abort();

  const started = Date.now();
  const result = await runStep({
    script: 'sleep 30',
    cwd, env: { PATH: process.env.PATH }, timeoutMs: 30_000, signal: controller.signal, onOutput: () => {},
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.reason, 'cancelled');
  assert.ok(Date.now() - started < 15_000, 'it must not wait out the step timeout');
});

test('a step receives only the secrets it names', () => {
  const claimed = jobFixture([
    { type: 'run', run: 'deploy --token "$DEPLOY"', env: { DEPLOY: '${{ secrets.DEPLOY_TOKEN }}' } },
    { type: 'run', run: 'echo unrelated' },
  ], { secrets: { DEPLOY_TOKEN: 'deploy-value', UNUSED_TOKEN: 'unused-value' } });

  const first = stepEnvironment({ ...claimed, workspace: '/w', stepIndex: 0 });
  // The expression in a declared value is resolved, because the runner hands the
  // value to the process rather than to a shell.
  assert.equal(first.DEPLOY, 'deploy-value');
  assert.equal(first.DEPLOY_TOKEN, 'deploy-value');
  // A credential the step never mentions is not in its environment at all, which
  // bounds what a compromised dependency in that step can read.
  assert.equal(first.UNUSED_TOKEN, undefined);

  const second = stepEnvironment({ ...claimed, workspace: '/w', stepIndex: 1 });
  assert.equal(second.DEPLOY_TOKEN, undefined);
  assert.equal(second.UNUSED_TOKEN, undefined);
});

test('runner-owned environment names cannot be overwritten by a job', () => {
  const claimed = jobFixture([{ type: 'run', run: 'env' }], {
    job: { env: { KUKGIT_REPOSITORY: 'attacker/repo', RUNNER_OS: 'Fake', SAFE: 'kept' } },
  });
  const env = stepEnvironment({ ...claimed, workspace: '/w', stepIndex: 0 });

  // A job that could set these could lie to its own steps about where it runs.
  assert.equal(env.KUKGIT_REPOSITORY, 'kuklabs/app');
  assert.equal(env.RUNNER_OS, process.platform === 'linux' ? 'Linux' : env.RUNNER_OS);
  assert.equal(env.SAFE, 'kept');
  assert.equal(env.CI, 'true');
});

test('log output is batched, split and never dropped when a flush fails', async () => {
  const sent = [];
  let failNext = true;
  const buffer = createLogBuffer({
    maxChunkBytes: 10,
    send: async (chunks) => {
      if (failNext) { failNext = false; throw new Error('network'); }
      sent.push(...chunks);
    },
  });

  buffer.push({ stream: 'stdout', content: 'abcdefghijklmnopqrstuvwxy' });
  assert.equal(buffer.size(), 3, 'an oversized chunk is split rather than rejected');

  const failed = await buffer.flush();
  assert.equal(failed.flushed, 0);
  // Losing the failing lines would be worse than a slow log.
  assert.equal(buffer.size(), 3, 'nothing was dropped');

  const succeeded = await buffer.flush();
  assert.equal(succeeded.flushed, 3);
  assert.equal(sent.map((chunk) => chunk.content).join(''), 'abcdefghijklmnopqrstuvwxy');
  assert.equal(buffer.size(), 0);
});

test('a job runs its steps in order and reports success', async (t) => {
  const client = fakeClient();
  const result = await executeJob(client, jobFixture([
    { type: 'run', run: 'echo first' },
    { type: 'run', run: 'echo second' },
  ]), { workspaceRoot: workspace(t) });

  assert.equal(result.status, 'success');
  assert.deepEqual(client.state.completed, { status: 'success', reason: null });
  const text = client.state.logs.map((chunk) => chunk.content).join('');
  assert.ok(text.indexOf('first') < text.indexOf('second'), 'steps run in order');
  // Everything buffered is flushed before completing, because completing
  // destroys the token and anything left would have nowhere to go.
  assert.equal(client.state.logs.length > 0, true);
  assert.match(text, /=== success/);
});

test('a failing step stops the job and the failure reason is reported', async (t) => {
  const client = fakeClient();
  const result = await executeJob(client, jobFixture([
    { type: 'run', run: 'echo one' },
    { type: 'run', run: 'exit 7' },
    { type: 'run', run: 'echo never' },
  ]), { workspaceRoot: workspace(t) });

  assert.equal(result.status, 'failure');
  assert.match(client.state.completed.reason, /exited with code 7/);
  assert.doesNotMatch(client.state.logs.map((chunk) => chunk.content).join(''), /never/);
});

test('continue-on-error keeps the job going and still reports success', async (t) => {
  const client = fakeClient();
  const result = await executeJob(client, jobFixture([
    { type: 'run', run: 'exit 1', continueOnError: true },
    { type: 'run', run: 'echo reached' },
  ]), { workspaceRoot: workspace(t) });

  assert.equal(result.status, 'success');
  const text = client.state.logs.map((chunk) => chunk.content).join('');
  assert.match(text, /continuing because continue-on-error is set/);
  assert.match(text, /reached/);
});

test('a step that only uses an action is reported as skipped, not passed', async (t) => {
  const client = fakeClient();
  const result = await executeJob(client, jobFixture([
    { type: 'uses', uses: { raw: 'kukgit/checkout@v1' } },
    { type: 'run', run: 'echo after' },
  ]), { workspaceRoot: workspace(t) });

  assert.equal(result.status, 'success');
  // Pretending an unimplemented step ran would make a build look green that
  // never happened.
  assert.match(client.state.logs.map((chunk) => chunk.content).join(''), /does not execute actions yet/);
});

test('a job whose workspace preparation fails is a runner error, not a silent pass', async (t) => {
  const client = fakeClient();
  const result = await executeJob(client, jobFixture([{ type: 'run', run: 'echo unreachable' }]), {
    workspaceRoot: workspace(t),
    prepareWorkspace: async () => { throw new Error('clone refused'); },
  });

  assert.equal(result.status, 'failure');
  assert.match(client.state.completed.reason, /runner error: clone refused/);
});

test('a job that exceeds its own timeout stops before the next step', async (t) => {
  const client = fakeClient();
  let clock = 0;
  const result = await executeJob(client, jobFixture([
    { type: 'run', run: 'echo one' },
    { type: 'run', run: 'echo two' },
  ], { job: { timeoutMinutes: 1 } }), {
    workspaceRoot: workspace(t),
    // The deadline passes between the two steps.
    now: () => { clock += 40_000; return clock; },
  });

  assert.equal(result.status, 'failure');
  assert.match(client.state.completed.reason, /exceeded its 1 minute timeout/);
});

test('a run script receives the repository-controlled fields it is allowed to name', () => {
  const context = {
    job: { key: 'build' },
    run: {
      commitSha: 'abc123', ref: 'refs/heads/main', repository: 'kuklabs/app',
      id: 'run_1', event: 'push', workflow: 'CI', workspace: '/w',
    },
  };

  assert.equal(
    resolveRunScript('echo ${{ github.sha }} on ${{ github.ref_name }} in ${{ github.repository }}', context),
    'echo abc123 on main in kuklabs/app',
  );
  assert.equal(resolveRunScript('echo ${{ github.ref_type }}', context), 'echo branch');
  assert.equal(resolveRunScript('echo ${{ github.repository_owner }}', context), 'echo kuklabs');

  // Anything the validator would have rejected is left exactly as written. A
  // script reaching the runner with an unrecognised expression is a validator
  // bug, and substituting something would hide it.
  assert.equal(resolveRunScript('echo ${{ matrix.os }}', context), 'echo ${{ matrix.os }}');
  assert.equal(resolveRunScript('echo ${{ secrets.TOKEN }}', context), 'echo ${{ secrets.TOKEN }}');
  assert.equal(resolveRunScript('echo ${{ github.event.issue.title }}', context), 'echo ${{ github.event.issue.title }}');

  const tag = { ...context, run: { ...context.run, ref: 'refs/tags/v1.0.0' } };
  assert.equal(resolveRunScript('echo ${{ github.ref_name }} ${{ github.ref_type }}', tag), 'echo v1.0.0 tag');
});

test('a job substitutes allowed fields before the script is written to disk', async (t) => {
  const client = fakeClient();
  const result = await executeJob(client, jobFixture([
    { type: 'run', run: 'echo "commit ${{ github.sha }}"' },
  ]), { workspaceRoot: workspace(t) });

  assert.equal(result.status, 'success', 'an unsubstituted expression would be a bash syntax error');
  assert.match(client.state.logs.map((chunk) => chunk.content).join(''), new RegExp(`commit ${'a'.repeat(40)}`));
});
