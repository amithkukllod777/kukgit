import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import {
  normalizeWorkflow,
  resolveJobOrder,
  validateWorkflowFile,
  workflowExpressions,
  WORKFLOW_LIMITS,
} from '../src/workflow-schema.mjs';

const config = loadConfig({ nodeEnv: 'test', dataDir: '/tmp/kukgit-workflow-schema-test' });

function accept(source, overrides = {}) {
  return validateWorkflowFile(source, { config: { ...config, ...overrides } });
}

function reject(source, code, overrides = {}) {
  let thrown = null;
  try { validateWorkflowFile(source, { config: { ...config, ...overrides } }); }
  catch (error) { thrown = error; }
  assert.ok(thrown, `expected ${code} but the workflow was accepted`);
  assert.equal(thrown.code, code, `expected ${code}, got ${thrown.code}: ${thrown.message}`);
  return thrown;
}

const MINIMAL = [
  'on: push',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: echo hello',
].join('\n');

function withStep(step) {
  return ['on: push', 'jobs:', '  build:', '    runs-on: ubuntu-latest', '    steps:', ...step.split('\n').map((line) => `      ${line}`)].join('\n');
}

test('a minimal workflow normalizes to the shape the scheduler consumes', () => {
  const workflow = accept(MINIMAL);
  assert.equal(workflow.format, 'kukgit-workflow-v1');
  assert.deepEqual(Object.keys(workflow.on), ['push']);
  assert.deepEqual(workflow.jobOrder, ['build']);

  const [job] = workflow.jobs;
  assert.equal(job.id, 'build');
  assert.equal(job.name, 'build', 'a job without a name is identified by its id');
  assert.equal(job.timeoutMinutes, 60, 'a job inherits the configured default timeout');
  assert.deepEqual(job.needs, []);
  assert.equal(job.steps[0].type, 'run');
  assert.equal(job.steps[0].shell, 'bash');
});

test('an untrusted value cannot be interpolated into a run script', () => {
  // The classic CI shell-injection: a pull-request title becomes command text.
  const error = reject(withStep('- run: echo "${{ github.event.pull_request.title }}"'), 'WORKFLOW_UNTRUSTED_INTERPOLATION');
  assert.match(error.message, /jobs\.build\.steps\[0\]\.run/);
  assert.match(error.message, /Pass it through env:/);

  reject(withStep('- run: git checkout ${{ github.head_ref }}'), 'WORKFLOW_UNTRUSTED_INTERPOLATION');
  reject(withStep('- run: echo ${{ github.event.comment.body }}'), 'WORKFLOW_UNTRUSTED_INTERPOLATION');

  // The same value is fine as an environment variable, because the runner passes
  // it as data and the shell never parses it as syntax.
  const workflow = accept(withStep([
    '- env:',
    '    TITLE: ${{ github.event.pull_request.title }}',
    '  run: echo "$TITLE"',
  ].join('\n')));
  assert.equal(workflow.jobs[0].steps[0].env.TITLE, '${{ github.event.pull_request.title }}');
});

test('repository-controlled fields are usable in a run script', () => {
  const workflow = accept(withStep('- run: echo ${{ github.sha }} ${{ github.repository }} ${{ github.run_id }}'));
  assert.equal(workflow.jobs[0].steps[0].type, 'run');

  // The allow-list is what makes this safe: a field nobody has vouched for is
  // refused even though it looks harmless.
  reject(withStep('- run: echo ${{ github.some_future_field }}'), 'WORKFLOW_UNTRUSTED_INTERPOLATION');
});

test('a secret may not become part of a command line', () => {
  const error = reject(withStep('- run: curl -H "Authorization: ${{ secrets.API_TOKEN }}" https://example.test'), 'WORKFLOW_SECRET_IN_RUN');
  assert.match(error.message, /Pass it through env:/);

  const workflow = accept(withStep([
    '- env:',
    '    TOKEN: ${{ secrets.API_TOKEN }}',
    '  run: curl -H "Authorization: $TOKEN" https://example.test',
  ].join('\n')));
  assert.equal(workflow.jobs[0].steps[0].env.TOKEN, '${{ secrets.API_TOKEN }}');
});

test('untrusted values are permitted as action inputs, which are never command text', () => {
  const workflow = accept(withStep([
    '- uses: kukgit/comment@v1.0.0',
    '  with:',
    '    body: ${{ github.event.pull_request.title }}',
  ].join('\n')));
  assert.equal(workflow.jobs[0].steps[0].with.body, '${{ github.event.pull_request.title }}');
});

test('expressions must read a known context and cannot nest', () => {
  assert.deepEqual(
    workflowExpressions('${{ github.sha }}', 'x').map((entry) => entry.full),
    ['github.sha'],
  );
  assert.throws(() => workflowExpressions('${{ }}', 'x'), (error) => error.code === 'WORKFLOW_EXPRESSION_INVALID');
  assert.throws(() => workflowExpressions('${{ ${{ github.sha }} }}', 'x'), (error) => error.code === 'WORKFLOW_EXPRESSION_INVALID');
  assert.throws(() => workflowExpressions('${{ unknownContext.value }}', 'x'), (error) => error.code === 'WORKFLOW_EXPRESSION_INVALID');
});

test('an action reference must be pinned and well formed', () => {
  assert.equal(accept(withStep('- uses: kukgit/checkout@v1.2.0')).jobs[0].steps[0].uses.ref, 'v1.2.0');
  assert.equal(accept(withStep('- uses: kukgit/tools/setup@v2.0.0')).jobs[0].steps[0].uses.subpath, 'setup');

  // A moving reference means the code a build runs can change without this file
  // changing, which would make reviewing it meaningless.
  for (const ref of ['main', 'master', 'latest', 'HEAD']) {
    reject(withStep(`- uses: kukgit/checkout@${ref}`), 'WORKFLOW_USES_UNPINNED');
  }
  reject(withStep('- uses: not-a-reference'), 'WORKFLOW_USES_INVALID');
  reject(withStep('- uses: ./local-action'), 'WORKFLOW_USES_UNSUPPORTED');
  reject(withStep('- uses: docker://alpine:3'), 'WORKFLOW_USES_UNSUPPORTED');
});

test('an instance can restrict which action owners and runners are permitted', () => {
  const restricted = { workflow: { ...config.workflow, allowedActionOwners: ['kuklabs'], allowedRunners: ['kukgit-linux'] } };
  accept(['on: push', 'jobs:', '  a:', '    runs-on: kukgit-linux', '    steps:', '      - uses: kuklabs/checkout@v1'].join('\n'), restricted);

  const owner = reject(
    ['on: push', 'jobs:', '  a:', '    runs-on: kukgit-linux', '    steps:', '      - uses: someone-else/action@v1'].join('\n'),
    'WORKFLOW_USES_NOT_PERMITTED', restricted,
  );
  assert.match(owner.message, /Permitted owners: kuklabs/);
  const runner = reject(MINIMAL, 'WORKFLOW_RUNNER_UNKNOWN', restricted);
  assert.match(runner.message, /Available on this instance: kukgit-linux/);
});

test('a step defines exactly one of run or uses', () => {
  reject(withStep('- name: Nothing'), 'WORKFLOW_INVALID');
  reject(withStep([
    '- run: echo one',
    '  uses: kukgit/checkout@v1',
  ].join('\n')), 'WORKFLOW_INVALID');
  reject(withStep([
    '- run: echo one',
    '  with:',
    '    key: value',
  ].join('\n')), 'WORKFLOW_INVALID');
  reject(withStep([
    '- uses: kukgit/checkout@v1',
    '  shell: bash',
  ].join('\n')), 'WORKFLOW_INVALID');
});

test('a working directory cannot escape the workspace', () => {
  assert.equal(accept(withStep([
    '- run: npm test',
    '  working-directory: packages/api',
  ].join('\n'))).jobs[0].steps[0].workingDirectory, 'packages/api');

  // Single-quoted so the Windows drive path is not read as an escape sequence.
  for (const directory of ['/etc', '../outside', 'a/../../b', 'C:\\windows']) {
    reject(withStep(`- run: pwd\n  working-directory: '${directory}'`), 'WORKFLOW_PATH_INVALID');
  }
});

test('runner-owned environment names cannot be overwritten', () => {
  for (const name of ['GITHUB_TOKEN', 'KUKGIT_SECRET', 'RUNNER_TEMP']) {
    reject(['on: push', 'env:', `  ${name}: x`, 'jobs:', '  a:', '    runs-on: x', '    steps:', '      - run: echo'].join('\n'), 'WORKFLOW_RESERVED_ENV');
  }
  reject(['on: push', 'env:', '  "not a name": x', 'jobs:', '  a:', '    runs-on: x', '    steps:', '      - run: echo'].join('\n'), 'WORKFLOW_INVALID');
});

test('job dependencies are ordered, and cycles are reported with their path', () => {
  const workflow = accept([
    'on: push',
    'jobs:',
    '  lint:',
    '    runs-on: x',
    '    steps: [{run: echo lint}]',
    '  test:',
    '    runs-on: x',
    '    steps: [{run: echo test}]',
    '  deploy:',
    '    needs: [lint, test]',
    '    runs-on: x',
    '    steps: [{run: echo deploy}]',
  ].join('\n'));
  assert.equal(workflow.jobOrder.at(-1), 'deploy');
  assert.ok(workflow.jobOrder.indexOf('lint') < workflow.jobOrder.indexOf('deploy'));

  const cycle = reject([
    'on: push',
    'jobs:',
    '  a:',
    '    needs: [c]',
    '    runs-on: x',
    '    steps: [{run: echo}]',
    '  b:',
    '    needs: [a]',
    '    runs-on: x',
    '    steps: [{run: echo}]',
    '  c:',
    '    needs: [b]',
    '    runs-on: x',
    '    steps: [{run: echo}]',
  ].join('\n'), 'WORKFLOW_DEPENDENCY_CYCLE');
  // The actual path, because "there is a cycle somewhere" is not actionable.
  assert.match(cycle.message, /a -> c -> b -> a/);

  reject([
    'on: push',
    'jobs:',
    '  a:',
    '    needs: [missing]',
    '    runs-on: x',
    '    steps: [{run: echo}]',
  ].join('\n'), 'WORKFLOW_UNKNOWN_DEPENDENCY');

  reject([
    'on: push',
    'jobs:',
    '  a:',
    '    needs: [a]',
    '    runs-on: x',
    '    steps: [{run: echo}]',
  ].join('\n'), 'WORKFLOW_DEPENDENCY_CYCLE');
});

test('triggers accept the short forms and validate their filters', () => {
  assert.deepEqual(Object.keys(accept(MINIMAL).on), ['push']);
  assert.deepEqual(Object.keys(accept(MINIMAL.replace('on: push', 'on: [push, pull_request]')).on).sort(), ['pull_request', 'push']);

  const scheduled = accept([
    'on:',
    '  schedule:',
    "    cron: ['0 3 * * 1-5', '*/15 * * * *']",
    'jobs:',
    '  a:',
    '    runs-on: x',
    '    steps: [{run: echo}]',
  ].join('\n'));
  assert.equal(scheduled.on.schedule.cron.length, 2);

  reject(MINIMAL.replace('on: push', 'on: deployment'), 'WORKFLOW_UNKNOWN_EVENT');
  reject(['on:', '  push:', '    tags: [v1]', 'jobs:', '  a:', '    runs-on: x', '    steps: [{run: echo}]'].join('\n'), 'WORKFLOW_UNKNOWN_KEY');

  // A schedule that is silently misread runs at the wrong time forever.
  for (const cron of ['0 3 * *', '99 3 * * *', '0 3 * * 9', '0 3 * * * *']) {
    reject(['on:', '  schedule:', `    cron: ['${cron}']`, 'jobs:', '  a:', '    runs-on: x', '    steps: [{run: echo}]'].join('\n'), 'WORKFLOW_INVALID');
  }
});

test('unknown keys are refused rather than ignored', () => {
  // Silently ignoring a misspelled key is how a workflow ends up not doing what
  // its author plainly wrote.
  const error = reject(MINIMAL.replace('on: push', 'on: push\nrun-name: Release'), 'WORKFLOW_UNKNOWN_KEY');
  assert.match(error.message, /Supported keys:/);
  reject(withStep('- run: echo\n  timout-minutes: 5'), 'WORKFLOW_UNKNOWN_KEY');
  reject(['on: push', 'jobs:', '  a:', '    runs-on: x', '    container: alpine', '    steps: [{run: echo}]'].join('\n'), 'WORKFLOW_UNKNOWN_KEY');
});

test('identifiers, duplicate step ids and permissions are validated', () => {
  reject(['on: push', 'jobs:', '  "not an id":', '    runs-on: x', '    steps: [{run: echo}]'].join('\n'), 'WORKFLOW_INVALID');
  reject(withStep([
    '- id: one',
    '  run: echo a',
    '- id: one',
    '  run: echo b',
  ].join('\n')), 'WORKFLOW_DUPLICATE_ID');

  assert.deepEqual(
    accept(['on: push', 'jobs:', '  a:', '    runs-on: x', '    permissions:', '      contents: read', '    steps: [{run: echo}]'].join('\n')).jobs[0].permissions,
    { contents: 'read' },
  );
  reject(['on: push', 'jobs:', '  a:', '    runs-on: x', '    permissions:', '      everything: write', '    steps: [{run: echo}]'].join('\n'), 'WORKFLOW_INVALID');
  reject(['on: push', 'jobs:', '  a:', '    runs-on: x', '    permissions:', '      contents: admin', '    steps: [{run: echo}]'].join('\n'), 'WORKFLOW_INVALID');
});

test('size limits bound what one file can schedule', () => {
  const manyJobs = ['on: push', 'jobs:'];
  for (let index = 0; index <= WORKFLOW_LIMITS.maxJobs; index += 1) {
    manyJobs.push(`  job${index}:`, '    runs-on: x', '    steps: [{run: echo}]');
  }
  reject(manyJobs.join('\n'), 'WORKFLOW_TOO_LARGE');

  const manySteps = ['on: push', 'jobs:', '  a:', '    runs-on: x', '    steps:'];
  for (let index = 0; index <= WORKFLOW_LIMITS.maxStepsPerJob; index += 1) manySteps.push('      - run: echo');
  reject(manySteps.join('\n'), 'WORKFLOW_TOO_LARGE');

  reject(withStep('- run: echo\n  timeout-minutes: 100000'), 'WORKFLOW_INVALID');
});

test('a workflow must say when it runs and what it runs', () => {
  reject(['jobs:', '  a:', '    runs-on: x', '    steps: [{run: echo}]'].join('\n'), 'WORKFLOW_INVALID');
  reject('on: push\njobs: {}', 'WORKFLOW_INVALID');
  reject(['on: push', 'jobs:', '  a:', '    runs-on: x', '    steps: []'].join('\n'), 'WORKFLOW_INVALID');
  reject(['on: push', 'jobs:', '  a:', '    steps: [{run: echo}]'].join('\n'), 'WORKFLOW_INVALID');
});

test('errors name the file and the exact path inside it', () => {
  let thrown = null;
  try {
    validateWorkflowFile(withStep('- run: echo ${{ github.event.issue.body }}'), {
      config, path: '.kukgit/workflows/ci.yml',
    });
  } catch (error) { thrown = error; }
  assert.ok(thrown);
  assert.match(thrown.message, /^\.kukgit\/workflows\/ci\.yml: jobs\.build\.steps\[0\]\.run:/);
});

test('resolveJobOrder is deterministic for independent jobs', () => {
  const jobs = [{ id: 'c', needs: [] }, { id: 'a', needs: [] }, { id: 'b', needs: ['a'] }];
  assert.deepEqual(resolveJobOrder(jobs), ['c', 'a', 'b']);
  assert.deepEqual(resolveJobOrder(jobs), resolveJobOrder(jobs));
});

test('normalizeWorkflow rejects a document that is not a mapping', () => {
  assert.throws(() => normalizeWorkflow(['a'], config), (error) => error.code === 'WORKFLOW_INVALID');
  assert.throws(() => normalizeWorkflow(null, config), (error) => error.code === 'WORKFLOW_INVALID');
});
