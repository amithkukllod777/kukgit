import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { POSTGRES_STEP, STEPS, comparable, workflowRunSteps } from '../scripts/ci.mjs';

/**
 * `npm run ci` and `.github/workflows/ci.yml` must not drift.
 *
 * A local runner that used to match the workflow is worse than no local runner:
 * it produces a green result that somebody trusts and that means something
 * different from what the workflow would have said. Since the workflow itself
 * has never executed on this repository, this is currently the only thing
 * keeping the two honest.
 */

const WORKFLOW = new URL('../.github/workflows/ci.yml', import.meta.url);

/** Steps `npm run ci` deliberately does not run, and why. */
const NOT_RUN_LOCALLY = new Map([
  // Deletes node_modules and reinstalls. Right for a fresh runner, wrong for
  // somebody checking their own working tree. What it exists to prove — that
  // the dependency loads — is checked directly instead.
  ['npm ci --ignore-scripts', 'reinstalls from scratch; the local runner checks that pg loads instead'],
]);

function localCommands() {
  return [...STEPS, POSTGRES_STEP].map((step) => comparable(step.command.join(' ')));
}

test('every command the workflow runs is run locally, or listed as not', async () => {
  const missing = [];
  for (const command of workflowRunSteps()) {
    if (NOT_RUN_LOCALLY.has(command)) continue;
    if (!localCommands().includes(comparable(command))) missing.push(command);
  }
  assert.deepEqual(missing, [], `the workflow runs commands \`npm run ci\` does not:\n  ${missing.join('\n  ')}`);
});

test('the workflow still runs the four things the local runner claims it does', async () => {
  const commands = workflowRunSteps().join('\n');
  // If somebody removes `npm test` from the workflow, `npm run ci` running it
  // is a local habit and not a description of CI. The claim in the script's
  // header would then be false.
  for (const expected of ['npm run doctor', 'npm run check', 'npm test']) {
    assert.match(commands, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('the PostgreSQL job is only skipped for the reason given', async () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  // The workflow supplies this as a service; a laptop with no PostgreSQL is not
  // a broken build, and the local runner says so out loud rather than passing
  // quietly.
  assert.equal(POSTGRES_STEP.needs, 'KUKGIT_TEST_POSTGRES_URL');
  assert.match(text, /KUKGIT_TEST_POSTGRES_URL/);
});

test('a run: block written as a literal is still read', async (t) => {
  const file = new URL('./fixtures-ci-parity.yml', import.meta.url);
  fs.writeFileSync(file, [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: one --flag',
    '      - name: two',
    '        run: |',
    '          two --flag',
    '      - uses: actions/checkout@v4',
    '      - run: three',
    '',
  ].join('\n'));
  t.after(() => fs.rmSync(file, { force: true }));

  // A parser that silently misses `run: |` would report perfect parity while
  // the workflow ran a step nobody had locally.
  assert.deepEqual(workflowRunSteps(file), ['one --flag', 'two --flag', 'three']);
});

test('the script is wired into package.json', async () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts.ci, 'node scripts/ci.mjs');
});
