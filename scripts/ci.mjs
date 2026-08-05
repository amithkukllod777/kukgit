#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Everything `.github/workflows/ci.yml` runs, runnable here.
 *
 * `ci.yml` has never executed. Every job GitHub has created for this repository
 * — three hundred and forty-nine of them — failed within two seconds with
 * `runner_id: 0`, no runner name, no steps and no logs: the runner was never
 * assigned. That is an account-level problem and no change to this repository
 * fixes it.
 *
 * The consequence is worse than a red badge. "CI is green" has never been a
 * statement anybody could make about KukGit, so `main` has been merged on the
 * strength of somebody running the suite by hand and saying it passed. That is
 * a claim, not a check.
 *
 * This makes it a check. One command, the same steps in the same order, the
 * same verdict — on a laptop, on the production host, or on a self-hosted
 * runner. `test/ci-parity.test.mjs` fails if the workflow grows a step this
 * does not run, so the two cannot drift apart quietly.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The steps, in the order the workflow runs them.
 *
 * `npm ci --ignore-scripts` is deliberately not one of them. It deletes
 * `node_modules` and reinstalls, which is right for a fresh runner and wrong
 * for somebody checking their own working tree before pushing. What is checked
 * instead is that the dependency it installs actually loads, which is the part
 * the workflow step exists to prove.
 */
const STEPS = [
  { name: 'git', command: ['git', '--version'] },
  {
    name: 'node-postgres loads',
    command: ['node', '-e', "import('pg').then((module) => { if (typeof (module.Client || module.default?.Client) !== 'function') process.exit(1) })"],
    // The workflow runs `npm ci` first, so `pg` is always there. Here it may
    // not be, and "you have not installed dependencies" is a different fact
    // from "the dependency is broken" — reporting the second when the first is
    // true sends somebody debugging node-postgres.
    installed: 'pg',
  },
  { name: 'licences', command: ['npm', 'run', 'deps'] },
  { name: 'advisories', command: ['npm', 'run', 'vulns'] },
  { name: 'doctor', command: ['npm', 'run', 'doctor'] },
  { name: 'syntax', command: ['npm', 'run', 'check'] },
  { name: 'tests', command: ['npm', 'test'] },
];

/**
 * The second job, which needs a PostgreSQL the workflow starts as a service.
 *
 * Skipped rather than failed when there is nowhere to connect: a laptop with no
 * PostgreSQL is not a broken build. Skipping is **reported**, because a suite
 * that quietly runs less than it says is how a green result stops meaning
 * anything.
 */
const POSTGRES_STEP = {
  name: 'PostgreSQL write compatibility',
  command: ['node', '--test', '--test-reporter=spec', 'test/runtime-write-postgresql.test.mjs'],
  needs: 'KUKGIT_TEST_POSTGRES_URL',
  reachable: true,
};

/**
 * Whether anything is listening where the URL says.
 *
 * "Nothing is at that address" is not a test result. Reporting it as a failed
 * compatibility test sends somebody debugging PostgreSQL transaction semantics
 * when what actually happened is that their development cluster died — which is
 * how this was found.
 */
export function canReach(url, { timeoutMs = 1500 } = {}) {
  let target;
  try { target = new URL(url); } catch { return false; }
  if (!target.hostname) return false;
  const probe = spawnSync(process.execPath, ['-e', `
    const net = require('node:net');
    const socket = net.connect(${Number(target.port) || 5432}, ${JSON.stringify(target.hostname)});
    socket.setTimeout(${timeoutMs});
    socket.on('connect', () => { socket.destroy(); process.exit(0); });
    socket.on('timeout', () => { socket.destroy(); process.exit(1); });
    socket.on('error', () => process.exit(1));
  `], { encoding: 'utf8' });
  return probe.status === 0;
}

function run(step, { quiet }) {
  const started = Date.now();
  const [command, ...args] = step.command;
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'test' },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = result.status === 0;
  if (!ok && quiet) {
    // The failing step's output, and only the failing step's. A summary that
    // says "tests failed" and makes somebody re-run to find out which one is a
    // summary that costs more than it saves.
    process.stdout.write(String(result.stdout ?? ''));
    process.stderr.write(String(result.stderr ?? ''));
  }
  return { ok, seconds, signal: result.signal, error: result.error };
}

function main() {
  const quiet = !process.argv.includes('--verbose');
  const results = [];
  let failed = null;

  // Before anything runs, because `npm test` runs the PostgreSQL file too. An
  // unreachable database set in the environment makes that step fail, and the
  // summary then says "tests" — which sends somebody reading test output when
  // the answer is that their development cluster died.
  const databaseUrl = process.env[POSTGRES_STEP.needs];
  if (databaseUrl && !canReach(databaseUrl)) {
    console.error([
      `${POSTGRES_STEP.needs} is set to ${databaseUrl}, and nothing is listening there.`,
      '',
      'Start one with `npm run postgres:dev`, or unset the variable to skip the',
      'PostgreSQL steps. Running with it set would fail the whole suite for a',
      'reason that has nothing to do with the code.',
    ].join('\n'));
    process.exitCode = 1;
    return;
  }

  for (const step of [...STEPS, POSTGRES_STEP]) {
    if (step.needs && !process.env[step.needs]) {
      // With the command that fixes it. A skip somebody does not know how to
      // resolve is a skip that stays there, and this one stayed for months.
      results.push({ name: step.name, state: 'skipped', why: `${step.needs} is not set — npm run postgres:dev` });
      continue;
    }
    if (step.installed && !fs.existsSync(path.join(root, 'node_modules', step.installed))) {
      results.push({ name: step.name, state: 'skipped', why: `${step.installed} is not installed — run npm install` });
      continue;
    }
    if (step.reachable && !canReach(process.env[step.needs])) {
      results.push({ name: step.name, state: 'skipped', why: `nothing is listening at ${process.env[step.needs]}` });
      continue;
    }
    if (!quiet) console.log(`\n── ${step.name} ──`);
    const outcome = run(step, { quiet });
    results.push({ name: step.name, state: outcome.ok ? 'ok' : 'failed', seconds: outcome.seconds });
    if (!outcome.ok) { failed = step.name; break; }
  }

  console.log('');
  for (const result of results) {
    const mark = result.state === 'ok' ? '✓' : result.state === 'skipped' ? '–' : '✗';
    const detail = result.state === 'skipped' ? result.why : `${result.seconds}s`;
    console.log(`${mark} ${result.name.padEnd(32)} ${detail}`);
  }

  const skipped = results.filter((result) => result.state === 'skipped');
  if (skipped.length) {
    console.log(`\n${skipped.length} step${skipped.length === 1 ? '' : 's'} skipped. This is not a full CI pass.`);
  }
  if (failed) {
    console.log(`\nFailed at: ${failed}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nAll ${results.length - skipped.length} steps passed.`);
}

/** The workflow's `run:` commands, for the parity test. */
export function workflowRunSteps(file = path.join(root, '.github/workflows/ci.yml')) {
  const text = fs.readFileSync(file, 'utf8');
  const commands = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    // The block form first: `run: |` also matches the inline pattern, and
    // taking it as an inline command records the literal "|" as a step.
    if (/^\s*(?:- )?run:\s*[|>][-+]?\s*$/.test(lines[index])) {
      const indent = (/^(\s*)/.exec(lines[index + 1] ?? '') ?? ['', ''])[1].length;
      const body = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        if (line.trim() && (/^(\s*)/.exec(line))[1].length < indent) break;
        body.push(line.trim());
      }
      commands.push(body.join(' ').trim());
      continue;
    }
    const inline = /^\s*(?:- )?run:\s*(\S.*)$/.exec(lines[index]);
    if (inline) commands.push(inline[1].trim());
  }
  return commands;
}

/**
 * A command, comparable.
 *
 * The workflow writes shell as a YAML string and this script writes it as an
 * argv array, so the same command differs by quoting alone. Comparing them
 * literally reports a difference that is not one, and a parity test that cries
 * wolf gets an exception added to it rather than being fixed.
 */
export function comparable(command) {
  return String(command).replace(/["']/g, '').replace(/\s+/g, ' ').trim();
}

export { STEPS, POSTGRES_STEP };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
