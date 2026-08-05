import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { freePort, serverBin } from '../scripts/postgres-dev.mjs';
import { POSTGRES_STEP, canReach } from '../scripts/ci.mjs';

/**
 * The launcher, tested for the parts that decide whether it is safe.
 *
 * Starting a cluster in a test would make the suite depend on PostgreSQL being
 * installed, which is the problem this script exists to solve. What is tested
 * here is the part that could do damage — which port it picks — and the part
 * that decides whether the whole thing is even possible.
 */

test('it never picks the port a real PostgreSQL is on', async () => {
  // A developer with a real database on 5432 must not get a disposable cluster
  // fighting it for the port, and must never get a test suite pointed at their
  // own data.
  assert.ok(freePort() >= 5433);
});

test('a port in use is stepped over', async (t) => {
  // Bound first, then asked from that port. Using 5433 here would make the
  // test fail on any machine that already has a development cluster up —
  // including the one this was written on.
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const taken = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  assert.ok(freePort(taken) > taken, `freePort(${taken}) returned the occupied port`);
});

test('a machine with no server binaries says so rather than half-starting', async () => {
  // `null` is the answer that produces "install postgresql-16". Anything else
  // and the script would run `initdb` from nowhere and report a confusing
  // spawn error.
  const found = serverBin();
  assert.ok(found === null || fs.existsSync(`${found}/initdb`));
});

test('the CI step and the launcher agree on the variable', async () => {
  // Two names for one thing is how a launcher prints an export that the suite
  // ignores.
  assert.equal(POSTGRES_STEP.needs, 'KUKGIT_TEST_POSTGRES_URL');
  const script = fs.readFileSync(new URL('../scripts/postgres-dev.mjs', import.meta.url), 'utf8');
  assert.match(script, /KUKGIT_TEST_POSTGRES_URL=/);
});

test('the skip message says how to stop skipping', async () => {
  const script = fs.readFileSync(new URL('../scripts/ci.mjs', import.meta.url), 'utf8');
  // This step skipped for months. A skip somebody does not know how to resolve
  // is a skip that stays.
  assert.match(script, /npm run postgres:dev/);
});

test('"nothing is listening there" is told apart from "the test failed"', async (t) => {
  assert.equal(canReach('postgresql://kukgit@127.0.0.1:59999/nothing'), false);
  assert.equal(canReach('not a url'), false);
  assert.equal(canReach(''), false);

  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(canReach(`postgresql://kukgit@127.0.0.1:${server.address().port}/anything`), true);
});

test('a database that is set and absent stops the run before the tests', async () => {
  const script = fs.readFileSync(new URL('../scripts/ci.mjs', import.meta.url), 'utf8');
  // `npm test` runs the PostgreSQL file too, so an unreachable database set in
  // the environment fails that step and the summary says "tests" — which sends
  // somebody reading test output when their development cluster has died. That
  // is how this was found.
  assert.match(script, /nothing is listening there/);
  assert.match(script, /npm run postgres:dev/);
});

test('the launcher checks the URL it prints', async () => {
  const script = fs.readFileSync(new URL('../scripts/postgres-dev.mjs', import.meta.url), 'utf8');
  // A cluster reachable on its Unix socket and not on 127.0.0.1 starts, creates
  // the database, prints a URL, and then refuses every connection made with it.
  assert.match(script, /if \(!reachable\(port\)\)/);
});

test('both scripts are wired into package.json', async () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts['postgres:dev'], 'node scripts/postgres-dev.mjs');
  assert.equal(manifest.scripts.ci, 'node scripts/ci.mjs');
});
