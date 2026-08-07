import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * The runner installer, checked for the parts that decide whether it is safe.
 *
 * It is not run here: it creates a system user and writes a systemd unit, and a
 * test that did either would be a test that changed the machine it ran on. What
 * is tested is what it refuses, what order it checks things in, and what it puts
 * in the unit file — because a runner executes other people's code, and every
 * restriction on it comes from outside the build.
 */

const SCRIPT = new URL('../scripts/runner-install.sh', import.meta.url);
const source = fs.readFileSync(SCRIPT, 'utf8');

test('it is executable and wired into package.json', async () => {
  assert.ok(fs.statSync(SCRIPT).mode & 0o111, 'scripts/runner-install.sh is not executable');
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts['runner:install'], './scripts/runner-install.sh');
});

test('it is valid shell', async () => {
  execFileSync('bash', ['-n', SCRIPT.pathname]);
});

test('it stops on the first failure', async () => {
  assert.match(source, /^set -euo pipefail$/m);
});

test('the runner never runs as root', async () => {
  // A build is somebody else's code. Running it as root is handing the machine
  // over to whoever can open a pull request.
  assert.match(source, /--system --create-home --shell \/usr\/sbin\/nologin/);
  assert.match(source, /must not be root/);
  assert.match(source, /User=\$\{RUNNER_USER\}/);
});

test('the unit carries the restrictions systemd can enforce', async () => {
  // None of these make a build safe; together they make it survivable.
  for (const directive of [
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=strict',
    'ProtectHome=true',
    'PrivateDevices=true',
    'RestrictSUIDSGID=true',
  ]) {
    assert.match(source, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing ${directive}`);
  }
  // And it must still be able to write its own workspace, or every job fails.
  assert.match(source, /ReadWritePaths=\/home\/\$\{RUNNER_USER\}/);
});

test('the unit file is not world-readable, because the token is in it', async () => {
  // Anybody who can read it can register a runner and be handed other
  // people's build jobs.
  assert.match(source, /chmod 600 "\$\{UNIT\}"/);
});

test('a personal access token pasted by mistake is refused', async () => {
  // It would be sent to the runner endpoint on every poll, forever, from a
  // unit file — and a PAT is not scoped to one repository's builds.
  const result = spawnSync(SCRIPT.pathname, ['--url', 'https://git.kuklabs.com', '--token', 'kgp_personal_access_token'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not look like a runner token/);
  assert.match(result.stderr, /Do not paste a personal access token/);
});

test('missing arguments are refused before anything is created', async () => {
  const result = spawnSync(SCRIPT.pathname, ['--url', 'https://git.kuklabs.com'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Both --url and --token are required/);
  assert.match(result.stderr, /Settings -> Runners/);
});

test('an unknown option is an error, not a silently ignored typo', async () => {
  const result = spawnSync(SCRIPT.pathname, ['--urll', 'https://git.kuklabs.com'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option/);
});

test('a dry run changes nothing', async () => {
  const result = spawnSync(SCRIPT.pathname, ['--check'], { encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  // It says what it would do, including the unit it would write, and creates
  // no user and no service.
  assert.match(output, /would write|would run|Check finished/);
  assert.ok(!fs.existsSync('/etc/systemd/system/kukgit-runner.service'), 'a dry run installed a unit');
});

test('it checks the instance is reachable before creating a user', async () => {
  const reachable = source.indexOf('Checking ${KUKGIT_URL}');
  const user = source.indexOf('Runner user: ${RUNNER_USER}');
  assert.ok(reachable > 0 && user > 0);
  // A typo in the URL should be found before the machine has a new account and
  // a service on it.
  assert.ok(reachable < user, 'the user is created before the URL is checked');
});

test('it says out loud that a runner has no sandbox', async () => {
  // Somebody installing this on a machine that also runs something valuable
  // needs to know before, not after.
  assert.match(source, /There is no sandbox/);
  assert.match(source, /willing to rebuild|mind losing/);
});

test('the guide explains it', async () => {
  const guide = fs.readFileSync(new URL('../docs/SELF_HOSTED_RUNNERS.md', import.meta.url), 'utf8');
  assert.match(guide, /runner-install\.sh/);
  assert.match(guide, /no sandbox/i);
});
