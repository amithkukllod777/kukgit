import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  IMPORT_CREDENTIAL_USERNAME,
  importCredentialConfig,
  importEnvironment,
  importHint,
  normalizeImportToken,
  redactToken,
} from '../src/repository-import.mjs';
import { importMirror } from '../src/git.mjs';

/**
 * Importing a repository somebody else is hosting, with a token.
 *
 * The tests that matter here are not about whether the clone works — Git does
 * that. They are about where the token ends up: not in the URL, not in the
 * command line, not in the clone's config, not in an error message.
 */

test('a blank token is no token, not an empty one', async () => {
  for (const value of [undefined, null, '', '   ']) {
    assert.equal(normalizeImportToken(value), null);
  }
  // An empty string is a value. Authenticating as the empty password is a
  // request that fails in a way nobody can read.
  assert.deepEqual(importCredentialConfig('https://github.com/a/b.git', ''), []);
});

test('a token with a newline in it is refused', async () => {
  // `extraHeader` is written into the request verbatim. CRLF does not extend
  // the Authorization header, it ends it — and everything after it becomes
  // headers somebody else wrote.
  assert.throws(() => normalizeImportToken('good\r\nX-Injected: yes'), /not allowed in a request header/);
  assert.throws(() => normalizeImportToken('good\nX-Injected: yes'), /not allowed in a request header/);
  assert.throws(() => normalizeImportToken('tab\there'), /not allowed in a request header/);
  assert.throws(() => normalizeImportToken(`x${'y'.repeat(600)}`), /too long/);
});

test('a real token becomes a scoped header, not a global one', async () => {
  const pairs = importCredentialConfig('https://github.com/kuklabs/private.git', 'github_pat_11ABCDEF');
  const keys = pairs.map(([key]) => key);

  // Scoped to the URL being cloned. `http.extraHeader` on its own would attach
  // the token to every request Git makes, including one it was redirected to.
  assert.ok(keys.includes('http.https://github.com/kuklabs/private.git.extraHeader'), keys.join(', '));
  assert.ok(!keys.includes('http.extraHeader'), 'the header is not scoped to the URL');

  const header = pairs.find(([key]) => key.endsWith('.extraHeader'))[1];
  const encoded = header.replace('Authorization: Basic ', '');
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), `${IMPORT_CREDENTIAL_USERNAME}:github_pat_11ABCDEF`);
});

test('any credential helper the machine has is turned off', async () => {
  const pairs = importCredentialConfig('https://github.com/a/b.git', 'token-value-here');
  const helper = pairs.find(([key]) => key === 'credential.helper');
  // An empty helper is not "unconfigured", it is "none" — it clears whatever the
  // machine has set globally, so nothing writes the token to disk on our behalf.
  assert.ok(helper, 'the credential helper is not cleared');
  assert.equal(helper[1], '');
});

test('a token cannot be used with an SSH URL, and says so', async () => {
  // There is no header on an SSH transport. Ignoring the token quietly would
  // produce a clone that fails for a reason invisible from the form.
  assert.throws(
    () => importCredentialConfig('git@github.com:kuklabs/private.git', 'token-value-here'),
    /only be used with an HTTPS repository URL/,
  );
  assert.throws(() => importCredentialConfig('ssh://git@github.com/a/b.git', 'token-value-here'), /deploy key/);
});

test('the token travels in the environment, and the environment only', async () => {
  const env = importEnvironment('https://github.com/kuklabs/private.git', 'github_pat_SECRETVALUE');

  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/kuklabs/private.git.extraHeader');
  assert.match(env.GIT_CONFIG_VALUE_0, /^Authorization: Basic /);
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.helper');
  assert.equal(env.GIT_CONFIG_VALUE_1, '');

  // /proc/<pid>/cmdline is world-readable; /proc/<pid>/environ is not. Passing
  // the token as an argument would put it where any user on the box can read it.
  // It is in the environment, base64 inside the header, and it is nowhere else:
  // the caller builds no arguments from this.
  const decoded = Buffer.from(env.GIT_CONFIG_VALUE_0.replace('Authorization: Basic ', ''), 'base64').toString('utf8');
  assert.equal(decoded, `${IMPORT_CREDENTIAL_USERNAME}:github_pat_SECRETVALUE`);
  assert.deepEqual(Object.keys(env).filter((key) => !key.startsWith('GIT_')), []);
});

test('a wrong token fails instead of hanging', async () => {
  const env = importEnvironment('https://github.com/a/b.git', 'wrong-token-value');
  // Without these Git asks for a password, finds no terminal, and blocks until
  // the timeout — so a refusal takes three minutes and is reported as a timeout.
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_ASKPASS, '');
});

test('a public import sets nothing, but still cannot be prompted', async () => {
  const env = importEnvironment('https://github.com/openai/openai.git', null);
  assert.equal('GIT_CONFIG_COUNT' in env, false);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('a token is taken out of anything shown to a person', async () => {
  const secret = 'github_pat_11ABCDEFGH';
  const message = `fatal: could not read from https://${secret}@github.com/a/b.git`;
  assert.equal(redactToken(message, secret).includes(secret), false);
  assert.match(redactToken(message, secret), /«redacted»/);
  // A short string is not treated as a secret: redacting "abc" would blank out
  // arbitrary words in an error message and make it unreadable.
  assert.equal(redactToken('the abc failed', 'abc'), 'the abc failed');
  assert.equal(redactToken('nothing to hide', null), 'nothing to hide');
});

test('"repository not found" is translated for somebody who has not supplied a token', async () => {
  // GitHub answers the same way for a private repository and one that does not
  // exist, on purpose. Repeating that verbatim sends people hunting for a typo
  // in a URL that is correct.
  assert.match(importHint('ERROR: Repository not found.', { hadToken: false }), /If this repository is private/);
  assert.match(importHint('remote: Not Found', { hadToken: true }), /token was rejected/);
  assert.match(importHint('fatal: Authentication failed for ...', { hadToken: true }), /expired/);
  assert.equal(importHint('fatal: unable to access: Could not resolve host: nope.invalid', { hadToken: false }), null);
});

test('Git accepts the configuration, and the clone does not keep it', async (t) => {
  // This is the test the rest of the module rests on. Every decision above
  // assumes `GIT_CONFIG_COUNT` reaches Git as configuration and then evaporates
  // — if instead it were written into the clone's own config file, the token
  // would live on disk for the repository's whole life, in a file nobody thinks
  // to look at. So: run a real clone with a real token set, and read the config
  // of what comes out.
  //
  // A local repository stands in for the remote. The transport is not what is
  // being tested; where the token ends up afterwards is.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '--bare', '-q', '--initial-branch=main', origin]);
  execFileSync('git', ['init', '-q', '--initial-branch=main', work]);
  fs.writeFileSync(path.join(work, 'README.md'), '# imported\n');
  const author = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@kuklabs.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@kuklabs.com' };
  const git = (...args) => execFileSync('git', args, { cwd: work, stdio: 'pipe', env: { ...process.env, ...author } });
  git('add', '-A');
  git('commit', '-qm', 'first');
  git('push', '-q', origin, 'main');

  const secret = 'github_pat_SECRETVALUEHERE';
  const env = importEnvironment('https://github.com/kuklabs/private.git', secret);
  const target = path.join(root, 'imported.git');
  execFileSync('git', ['clone', '--mirror', '-q', origin, target], { env: { ...process.env, ...env }, stdio: 'pipe' });

  const refs = execFileSync('git', ['--git-dir', target, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' });
  assert.match(refs, /refs\/heads\/main/);

  // Nothing from the environment is in the clone's config file.
  const config = fs.readFileSync(path.join(target, 'config'), 'utf8');
  assert.equal(config.includes(secret), false, 'the token was written into the clone config');
  assert.equal(config.toLowerCase().includes('extraheader'), false);
  // And the remote URL — which does persist — never carried a credential.
  const stored = execFileSync('git', ['--git-dir', target, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' });
  assert.equal(stored.includes('@'), false, stored);
});

test('a local path is still refused, token or not', async (t) => {
  // The credential work must not have widened what an import may reach. A
  // `file://` URL would read the server's own disk, which is the whole reason
  // validateRemoteUrl exists.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { repositoriesDir: path.join(root, 'repositories') };

  await assert.rejects(
    () => importMirror(config, 'kuklabs', 'gone', `file://${path.join(root, 'origin')}`, { credential: 'token-value-here' }),
    /Only HTTPS and SSH/,
  );
  assert.equal(fs.existsSync(path.join(config.repositoriesDir, 'kuklabs', 'gone.git')), false);
});
