import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * The deploy script, checked for the parts that decide whether it is safe.
 *
 * It is not run here — it restarts a systemd service and talks to a live
 * database, and a test that did either would be a test that took the machine
 * down. What is tested is the order it does things in, which is the part that
 * decides whether a bad release is a bad minute or a bad night.
 */

const SCRIPT = new URL('../scripts/deploy.sh', import.meta.url);
const source = fs.readFileSync(SCRIPT, 'utf8');

test('it is executable, and wired into package.json', async () => {
  assert.ok(fs.statSync(SCRIPT).mode & 0o111, 'scripts/deploy.sh is not executable');
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts.deploy, './scripts/deploy.sh');
});

test('it is valid shell', async () => {
  // A syntax error in a deploy script is discovered at the worst possible
  // moment, by somebody who is already deploying.
  execFileSync('bash', ['-n', SCRIPT.pathname]);
});

test('it stops on the first failure rather than carrying on', async () => {
  // Without `-e` a failed `npm ci` is followed by a restart, and the service
  // comes back on a half-installed tree.
  assert.match(source, /^set -euo pipefail$/m);
});

test('it backs up before restarting, not after', async () => {
  const backup = source.indexOf('Backing up before the restart');
  const restart = source.indexOf('Restarting ${SERVICE}');
  assert.ok(backup > 0 && restart > 0);
  // A deploy that has to be rolled back needs the database as it was before the
  // new code touched it. A backup taken afterwards is a backup of the problem.
  assert.ok(backup < restart, 'the backup happens after the restart');
});

test('it checks before it backs up, and backs up before it changes anything live', async () => {
  const order = ['Fetching ${REF}', 'Installing production dependencies', 'Checking the deployment', 'Backing up before the restart', 'Restarting ${SERVICE}', 'Waiting for ${HEALTH_URL}'];
  const positions = order.map((step) => source.indexOf(step));
  assert.ok(positions.every((position) => position > 0), 'a step is missing');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'the steps are out of order');
});

test('a failed health check rolls the code back', async () => {
  const health = source.indexOf('did not answer within');
  assert.ok(health > 0);
  const after = source.slice(health);
  // A server that is down has to be up before anybody debugs why.
  assert.match(after, /git checkout --detach "\$\{PREVIOUS\}"/);
  assert.match(after, /systemctl restart/);
});

test('it says out loud that the schema is not rolled back', async () => {
  // Migrations are forward-only. Rolling the code back leaves the newer schema
  // in place, which is survivable for an additive change and not for anything
  // else — and somebody reading a rollback message at 2am will not remember
  // that unless it is in the message.
  assert.match(source, /SCHEMA WAS NOT ROLLED BACK/);
  assert.match(source, /IT DOES NOT MIGRATE DOWN/);
});

test('it refuses to deploy a dirty working tree', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-deploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@kuklabs.com');
  git('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/deploy.sh'));
  fs.chmodSync(path.join(dir, 'scripts/deploy.sh'), 0o755);
  git('add', '-A');
  git('commit', '-qm', 'initial');
  fs.writeFileSync(path.join(dir, 'debugging.txt'), 'left behind on the server\n');

  const result = spawnSync('./scripts/deploy.sh', ['--dry-run'], { cwd: dir, encoding: 'utf8' });

  // A deploy that quietly includes an edit made on the server is a deploy
  // nobody can reproduce — and somebody's console.log ends up in production.
  assert.equal(result.status, 1);
  assert.match(result.stderr, /uncommitted changes/);
  assert.match(result.stderr, /nobody can reproduce/);
});

test('a dry run changes nothing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-deploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@kuklabs.com');
  git('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/deploy.sh'));
  fs.chmodSync(path.join(dir, 'scripts/deploy.sh'), 0o755);
  git('add', '-A');
  git('commit', '-qm', 'initial');
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  const result = spawnSync('./scripts/deploy.sh', ['HEAD~0', '--dry-run'], { cwd: dir, encoding: 'utf8' });

  // Nothing to deploy, and it says so rather than restarting anything.
  assert.match(`${result.stdout}${result.stderr}`, /Nothing to deploy|Dry run finished/);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), before);
});

test('the guide explains it', async () => {
  const guide = fs.readFileSync(new URL('../docs/DEPLOYMENT.md', import.meta.url), 'utf8');
  // A script nobody knows about is a script that gets reinvented by hand at the
  // worst moment, which is what happened before it existed.
  assert.match(guide, /scripts\/deploy\.sh/);
  assert.match(guide, /does not migrate down/i);
});

test('the check reads the service environment, not the deploying shell', async () => {
  // The first real use ran the check bare, and it reported no base URL, no
  // founder password and a data directory inside the checkout — none of which
  // was true of the running service. A check reading the wrong environment is
  // worse than no check, because its output looks like findings.
  assert.match(source, /KUKGIT_ENV_FILE/);
  assert.match(source, /set -a; \. "\$\{KUKGIT_ENV_FILE\}"; set \+a/);
});

test('the port already being in use does not stop a deploy', async () => {
  // The process holding the port is the one about to be restarted. Treating
  // that as a failure means the script can never deploy to a running server —
  // which is every server it exists for.
  assert.match(source, /entry\.id !== "port"/);
  assert.match(source, /--json/);
});

test('the backup is asked for by name', async () => {
  // `npm run backup` with no subcommand prints its usage and exits zero. The
  // first real use took no backup at all and said nothing about it.
  assert.match(source, /npm run --silent backup -- create/);
  assert.doesNotMatch(source, /run npm run --silent backup$/m);
});
