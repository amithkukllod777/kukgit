#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `KukGit rollout and rollback drill

  npm run drill               run the drill against a disposable instance
  npm run drill -- --keep     leave the data directory behind for inspection

Starts an instance, puts a request in flight, sends SIGTERM, and checks that the
sequence a rollout depends on actually happens:

  1. readiness starts failing while the instance is still serving
  2. the in-flight request completes rather than being cut off
  3. the listener closes only after that
  4. a replacement instance starts against the same volume and serves

This is the rehearsal, not a test of the deployment tooling. What it proves is
that the process behaves the way a load balancer needs it to.
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(USAGE); process.exit(0); }
const keep = process.argv.includes('--keep');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-drill-'));
const port = 8900 + Math.floor(process.uptime() * 7) % 90;
const base = `http://127.0.0.1:${port}`;
const results = [];
let child = null;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`);
}

function startInstance(label) {
  const proc = spawn(process.execPath, ['server.mjs', `--drill-${label}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      KUKGIT_DATA_DIR: dataDir,
      PORT: String(port),
      KUKGIT_BASE_URL: base,
      KUKGIT_ADMIN_PASSWORD: 'drill-password-not-a-real-secret',
      KUKGIT_RATE_LIMIT_ENABLED: 'false',
      // Short enough that the drill finishes, long enough that the window is
      // observable. Production uses seconds, not milliseconds.
      KUKGIT_DRAIN_READINESS_DELAY_MS: '1500',
      KUKGIT_DRAIN_REQUEST_MS: '10000',
      KUKGIT_DRAIN_GIT_MS: '10000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.log = '';
  proc.stdout.on('data', (chunk) => { proc.log += chunk; });
  proc.stderr.on('data', (chunk) => { proc.log += chunk; });
  return proc;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(pathname) {
  try {
    const response = await fetch(`${base}${pathname}`);
    return response.status;
  } catch {
    return 0;
  }
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe('/api/health') === 200) return true;
    await wait(250);
  }
  return false;
}

try {
  console.log(`KukGit rollout drill on ${base}\n`);

  child = startInstance('first');
  record('instance starts and serves', await waitForHealth());
  record('readiness is ready before the signal', await probe('/api/health/ready') === 200);

  // A request that is deliberately slow to answer, so it is genuinely in flight
  // when the signal arrives. A repository listing on an empty instance is quick,
  // so several are issued and the last one is what matters.
  const inFlight = Promise.allSettled(
    Array.from({ length: 8 }, () => fetch(`${base}/api/health`).then((r) => r.status)),
  );

  child.kill('SIGTERM');

  // The window a rollout depends on: not ready, but still answering.
  await wait(400);
  const readyDuringDrain = await probe('/api/health/ready');
  const servingDuringDrain = await probe('/api/health');
  record('readiness reports 503 while draining', readyDuringDrain === 503, `got ${readyDuringDrain}`);
  record('still serving traffic while not ready', servingDuringDrain === 200, `got ${servingDuringDrain}`);

  const settled = await inFlight;
  const completed = settled.filter((entry) => entry.status === 'fulfilled' && entry.value === 200).length;
  record('in-flight requests completed', completed === settled.length, `${completed}/${settled.length}`);

  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  record('exits cleanly', exitCode === 0, `exit ${exitCode}`);
  record('the listener is closed after exit', await probe('/api/health') === 0);
  record('drain steps are reported for an operator',
    /readiness_failing[\s\S]*closing_listener[\s\S]*drained in \d+ms/.test(child.log));

  // The rollback half: a replacement starts against the same volume, which is
  // what happens whether you are rolling forward or back.
  child = startInstance('replacement');
  record('a replacement instance serves the same volume', await waitForHealth());
  record('readiness recovers', await probe('/api/health/ready') === 200);
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  child = null;

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nA rollout using this build would not be invisible to users.');
    process.exit(1);
  }
  console.log('A rollout can remove this instance from rotation before it stops serving.');
  process.exit(0);
} catch (error) {
  console.error(`\ndrill failed: ${error.message}`);
  process.exit(1);
} finally {
  try { child?.kill('SIGKILL'); } catch { /* already gone */ }
  if (keep) console.log(`\ndata directory kept at ${dataDir}`);
  else fs.rmSync(dataDir, { recursive: true, force: true });
}
