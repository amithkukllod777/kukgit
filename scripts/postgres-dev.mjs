#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A disposable PostgreSQL, so the one gated test stops being permanently gated.
 *
 * `test/runtime-write-postgresql.test.mjs` is the only proof that the
 * PostgreSQL write path behaves the same as SQLite on constraints and
 * transactions — and it has spent most of its life skipping, because
 * `KUKGIT_TEST_POSTGRES_URL` was never set anywhere. A test that skips
 * everywhere is a test nobody has run, and it reads in the output exactly like
 * a test that passed.
 *
 * The workflow starts PostgreSQL as a service container. This starts one from
 * whatever `postgresql-16` is already on the machine, on a port nothing else is
 * using, in a directory it will delete. It is a **development** cluster: trust
 * authentication, no password, listening on localhost. It must never be pointed
 * at anything that matters, and `stop` removes the data directory entirely.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(os.tmpdir(), 'kukgit-postgres-dev.json');
const DATABASE = 'kukgit_stage7';
const USER = 'kukgit';

/**
 * Where the server binaries are.
 *
 * Debian and Ubuntu keep them out of `PATH` on purpose, so that a machine with
 * three clusters does not silently use the wrong one. Newest first, because a
 * machine with 15 and 16 installed should be tested against 16.
 */
function serverBin() {
  const onPath = spawnSync('which', ['initdb'], { encoding: 'utf8' });
  if (onPath.status === 0) return path.dirname(onPath.stdout.trim());
  const versions = ['/usr/lib/postgresql', '/usr/local/lib/postgresql', '/opt/homebrew/opt'];
  for (const base of versions) {
    if (!fs.existsSync(base)) continue;
    const entries = fs.readdirSync(base).sort().reverse();
    for (const entry of entries) {
      const candidate = path.join(base, entry, 'bin');
      if (fs.existsSync(path.join(candidate, 'initdb'))) return candidate;
    }
  }
  return null;
}

/**
 * A port nothing is listening on.
 *
 * Not 5432. A developer with a real PostgreSQL there would otherwise get a
 * disposable cluster refusing to start, or worse, a test suite pointed at their
 * own database.
 */
function freePort(start = 5433) {
  for (let port = start; port < start + 40; port += 1) {
    const probe = spawnSync('node', ['-e', `
      const net = require('node:net');
      const server = net.createServer();
      server.once('error', () => process.exit(1));
      server.listen(${port}, '127.0.0.1', () => server.close(() => process.exit(0)));
    `], { encoding: 'utf8' });
    if (probe.status === 0) return port;
  }
  return null;
}

/**
 * `initdb` and `pg_ctl` refuse to run as root, so as root they run as postgres.
 *
 * Which also means the data directory has to be somewhere that user can write —
 * not a per-session scratch directory owned by somebody else, which is where
 * this first failed.
 */
function asServerUser(command, args, { bin, cwd = root }) {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (!asRoot) return spawnSync(path.join(bin, command), args, { cwd, encoding: 'utf8' });
  const quoted = args.map((argument) => `'${String(argument).replace(/'/g, `'\\''`)}'`).join(' ');
  return spawnSync('su', ['postgres', '-c', `${path.join(bin, command)} ${quoted}`], { cwd, encoding: 'utf8' });
}

function start() {
  const bin = serverBin();
  if (!bin) {
    console.error('No PostgreSQL server binaries found. Install postgresql-16, or set KUKGIT_TEST_POSTGRES_URL yourself.');
    process.exitCode = 1;
    return;
  }
  if (fs.existsSync(STATE)) {
    const existing = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    console.log(`Already running.\n\nexport KUKGIT_TEST_POSTGRES_URL=${existing.url}`);
    return;
  }

  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const dataDir = path.join(asRoot ? '/var/tmp' : os.tmpdir(), `kukgit-pg-${process.pid}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  if (asRoot) spawnSync('chown', ['postgres:postgres', dataDir]);

  const port = freePort();
  if (!port) { console.error('No free port between 5433 and 5472.'); process.exitCode = 1; return; }

  const init = asServerUser('initdb', ['-D', dataDir, '-U', USER, '--auth=trust'], { bin });
  if (init.status !== 0) {
    console.error(init.stderr || init.stdout);
    process.exitCode = 1;
    return;
  }
  // `-k /tmp` because the default socket directory may not exist, and a
  // cluster that starts but cannot be reached is the least useful outcome.
  const up = asServerUser('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k /tmp -h 127.0.0.1`, '-l', path.join(dataDir, 'log'), '-w', 'start'], { bin });
  if (up.status !== 0) {
    console.error(up.stderr || up.stdout);
    process.exitCode = 1;
    return;
  }

  const url = `postgresql://${USER}@127.0.0.1:${port}/${DATABASE}`;
  const created = asServerUser('createdb', ['-h', '/tmp', '-p', String(port), '-U', USER, DATABASE], { bin });
  if (created.status !== 0) {
    console.error(created.stderr || created.stdout);
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(STATE, JSON.stringify({ dataDir, port, url, bin }, null, 2));
  console.log([
    `PostgreSQL ${port} started for development only — trust authentication, localhost, disposable.`,
    '',
    `export KUKGIT_TEST_POSTGRES_URL=${url}`,
    'npm run ci',
    '',
    'npm run postgres:dev stop   # removes the cluster and its data',
  ].join('\n'));
}

function stop() {
  if (!fs.existsSync(STATE)) { console.log('Nothing to stop.'); return; }
  const { dataDir, bin } = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  asServerUser('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop'], { bin });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(STATE, { force: true });
  console.log('Stopped, and the data directory is gone.');
}

const action = process.argv[2] ?? 'start';
if (action === 'stop') stop();
else if (action === 'start') start();
else {
  console.error(`Unknown action "${action}". Use start or stop.`);
  process.exitCode = 1;
}

export { serverBin, freePort, STATE };
