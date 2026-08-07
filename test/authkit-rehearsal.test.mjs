import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DRILL_CHECKS, runAuthKitRehearsal } from '../src/authkit-rehearsal.mjs';
import { createAuthKitSimulator } from '../src/authkit-simulator.mjs';

/**
 * The AuthKit rollout drill, and the simulator it runs against.
 *
 * Half of these tests are about the drill passing. The other half — the half
 * that matters — are about it *failing*: a drill that cannot fail is a green
 * light wired to nothing, and it would be worse than having none, because the
 * rollout checklist would be marked done on the strength of it.
 *
 * The simulator is tested separately for the behaviours that make it a
 * simulator rather than a mock: tokens that expire, refresh tokens that rotate
 * and cannot be replayed, and device sessions that can be revoked one at a
 * time.
 */

/* ------------------------------------------------------------- simulator */

async function simulator(t, options = {}) {
  const instance = createAuthKitSimulator({
    accounts: [{ email: 'founder@kuklabs.com', password: 'simulator-password', name: 'Founder' }],
    ...options,
  });
  const origin = await instance.listen();
  t.after(() => instance.close());
  const call = async (pathname, { method = 'GET', body, accessToken, product = 'kukgit' } = {}) => {
    const response = await fetch(`${origin}${pathname}`, {
      method,
      headers: {
        ...(product ? { 'X-Kuklabs-Product': product } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const signIn = () => call('/v1/auth/login', { method: 'POST', body: { identifier: 'founder@kuklabs.com', password: 'simulator-password' } });
  return { instance, origin, call, signIn };
}

test('the simulator announces the contract the rollout checklist names', async (t) => {
  const { call } = await simulator(t);
  const status = await call('/v1/auth/status');
  assert.equal(status.body.contract, 'kuklabs-authkit-rest/1');
});

test('a request without the product header is refused, and remembered', async (t) => {
  const { call, instance } = await simulator(t);
  const response = await call('/v1/auth/status', { product: null });
  assert.equal(response.status, 400);
  // Recorded rather than only refused: a bug that drops the header on one route
  // out of twelve should be findable afterwards, not only at the moment it
  // happens.
  assert.deepEqual(instance.state.missingProductHeader, ['GET /v1/auth/status']);
});

test('the access token carries the device-session id in its claims', async (t) => {
  const { signIn } = await simulator(t);
  const { body } = await signIn();
  const claims = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64url').toString('utf8'));
  // Production reads the id from the envelope when it is there and from the
  // claims when it is not. A stand-in that only ever filled the envelope would
  // leave the second path — the one signup uses — untested.
  assert.equal(claims.sid, body.sid);
  assert.match(body.access_token, /\.unsigned-simulator$/);
});

test('signup completes without an envelope sid, so the claims path is exercised', async (t) => {
  const { call } = await simulator(t);
  const signup = await call('/v1/auth/signup', { method: 'POST', body: { identifier: 'new@kuklabs.com', password: 'x' } });
  assert.equal(signup.status, 403);
  assert.equal(signup.body.status, 'otp_required');

  const verified = await call('/v1/auth/otp/verify', { method: 'POST', body: { identifier: 'new@kuklabs.com', code: '123456' } });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.sid, undefined);
  const claims = JSON.parse(Buffer.from(verified.body.access_token.split('.')[1], 'base64url').toString('utf8'));
  assert.match(claims.sid, /^sess_/);
});

test('an access token expires, and refreshing rotates both secrets', async (t) => {
  const { signIn, call, instance } = await simulator(t);
  const { body: first } = await signIn();
  instance.expireAccessTokens();
  assert.equal((await call('/v1/auth/me', { accessToken: first.access_token })).status, 401);

  const refreshed = await call('/v1/auth/token/refresh', { method: 'POST', body: { refresh_token: first.refresh_token } });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.body.access_token, first.access_token);
  assert.notEqual(refreshed.body.refresh_token, first.refresh_token);
  assert.equal((await call('/v1/auth/me', { accessToken: refreshed.body.access_token })).status, 200);
});

test('replaying a spent refresh token kills the whole device session', async (t) => {
  const { signIn, call, instance } = await simulator(t);
  const { body: first } = await signIn();
  await call('/v1/auth/token/refresh', { method: 'POST', body: { refresh_token: first.refresh_token } });

  // The token was valid once, so either it leaked or something is replaying it.
  // A provider that quietly issued a new pair would turn a theft into a
  // permanent one.
  const replay = await call('/v1/auth/token/refresh', { method: 'POST', body: { refresh_token: first.refresh_token } });
  assert.equal(replay.status, 401);
  assert.match(replay.body.message, /reuse/i);
  assert.deepEqual(instance.liveSessions(), []);
});

test('revoking one device session leaves the others alone', async (t) => {
  const { signIn, call, instance } = await simulator(t);
  const { body: laptop } = await signIn();
  const { body: phone } = await signIn();
  instance.revokeSession(laptop.sid);

  assert.equal((await call('/v1/auth/me', { accessToken: laptop.access_token })).status, 401);
  assert.equal((await call('/v1/auth/me', { accessToken: phone.access_token })).status, 200);
  const sessions = await call('/v1/auth/sessions', { accessToken: phone.access_token });
  assert.equal(sessions.body.sessions.length, 1);
  assert.equal(sessions.body.sessions[0].current, true);
});

test('going offline fails every route, including the ones that do not need a token', async (t) => {
  const { call, instance } = await simulator(t);
  instance.setOffline(true);
  assert.equal((await call('/v1/auth/status')).status, 503);
  instance.setOffline(false);
  assert.equal((await call('/v1/auth/status')).status, 200);
});

test('blocked product membership is a 403 with the status named', async (t) => {
  const { signIn, call, instance } = await simulator(t);
  const { body } = await signIn();
  instance.setProductAccess('blocked');
  const denied = await call('/v1/auth/products/kukgit/access', { accessToken: body.access_token });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.status, 'blocked');
  assert.equal(denied.body.access, false);
});

/* ----------------------------------------------------------------- drill */

test('the drill passes, and covers every check it declares', async () => {
  const { record } = await runAuthKitRehearsal({ operator: 'test suite' });

  assert.equal(record.result, 'passed', record.failures.join('; '));
  assert.equal(record.complete, true);
  assert.deepEqual(record.skipped, []);
  // A check that quietly stopped running would otherwise look like a check that
  // passed.
  assert.deepEqual(
    record.checks.map((check) => check.id).sort(),
    DRILL_CHECKS.map((check) => check.id).sort(),
  );
  for (const check of record.checks) assert.ok(check.description, `${check.id} lost its description`);
});

test('the record says which AuthKit it ran against, and does not claim more than that', async () => {
  const { record } = await runAuthKitRehearsal({});
  assert.equal(record.authkit.kind, 'simulator');
  // The whole reason the field exists. A simulator run must never be readable
  // six months later as a production sign-off.
  assert.equal(record.confidence, 'rehearsed');
  assert.notEqual(record.confidence, 'verified');
  assert.equal(record.authkit.contract, 'kuklabs-authkit-rest/1');
});

test('pointing it at a live AuthKit is refused rather than half-done', async () => {
  // It would create accounts and revoke real device sessions. Refusing is
  // honest; doing it partially and reporting a pass would not be.
  await assert.rejects(
    () => runAuthKitRehearsal({ authkitBaseUrl: 'https://auth.kuklabs.com' }),
    /not implemented yet/,
  );
});

test('the evidence record is JSON somebody can file', async () => {
  const { record } = await runAuthKitRehearsal({ operator: 'Amit' });
  const written = JSON.parse(JSON.stringify(record));
  assert.equal(written.format, 'kukgit-authkit-rehearsal/1');
  assert.equal(written.operator, 'Amit');
  assert.ok(Date.parse(written.startedAt) <= Date.parse(written.finishedAt));
  assert.ok(written.upstreamCalls > 0);
});

/* ------------------------------------------------- the drill can fail */

/**
 * Breaks one guarantee in a copy of a module, runs the drill, and puts the
 * module back.
 *
 * This is the only way to know a check is wired to anything. Every one of them
 * was written to fail before it was written to pass, and this keeps that true
 * for anybody who edits them later.
 */
async function runDrillWithBrokenSource(mutations) {
  const restore = [];
  for (const { file, replace } of mutations) {
    const url = new URL(`../${file}`, import.meta.url);
    const original = fs.readFileSync(url, 'utf8');
    const broken = replace(original);
    assert.notEqual(broken, original, `the mutation for ${file} matched nothing`);
    restore.push([url, original]);
    fs.writeFileSync(url, broken);
  }
  try {
    // A child process, not a cache-busted import. ESM caches by resolved URL,
    // so busting the entry module still resolves its *dependencies* to the
    // copies already loaded — and the mutation would have no effect while the
    // test claimed it did. That is the exact failure this whole section exists
    // to prevent, so it cannot be allowed here either.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import { runAuthKitRehearsal } from './src/authkit-rehearsal.mjs';"
      + " const { record } = await runAuthKitRehearsal({});"
      + " process.stdout.write('<<' + JSON.stringify(record) + '>>');",
    ], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, NODE_ENV: 'test' } });
    const match = /<<(.*)>>/s.exec(child.stdout ?? '');
    assert.ok(match, `the drill produced no record: ${child.stderr}`);
    return JSON.parse(match[1]);
  } finally {
    for (const [url, original] of restore) fs.writeFileSync(url, original);
  }
}

test('the drill fails when a centrally revoked session leaves the cookie behind', async () => {
  // The bug this drill actually found. Before the fix, KukGit deleted the
  // bridge and answered 401 but never cleared `kukgit_session`, so the browser
  // kept sending a cookie that resolved to nothing.
  const record = await runDrillWithBrokenSource([{
    file: 'src/authkit-identity.mjs',
    replace: (source) => source.replace(
      "const headers = status === 401 ? { 'Set-Cookie': clearAuthKitSessionCookie(config) } : {};",
      'const headers = {};',
    ),
  }]);
  assert.equal(record.result, 'failed');
  assert.ok(record.failures.some((failure) => failure.startsWith('authkit.device_revocation')), record.failures.join('; '));
});

test('the drill fails when an AuthKit outage stops failing closed', async () => {
  // The wrong fix somebody reaches for during a real outage: keep serving the
  // people who were already signed in. Both places that refuse have to be
  // broken, because either one alone still refuses.
  const record = await runDrillWithBrokenSource([
    {
      file: 'src/authkit-identity.mjs',
      replace: (source) => source.replace(
        "  if (!me.response.ok) throw httpError(503, 'Kuklabs Account validation failed.', 'AUTHKIT_VALIDATION_FAILED');",
        "  if (!me.response.ok) return { mode: 'authkit', user: db.prepare('SELECT id, email, display_name AS displayName, kuklabs_user_id AS kuklabsUserId FROM users WHERE id = ?').get(session.userId), session: { tokenHash: session.tokenHash, authkitSid: session.authkitSid } };",
      ),
    },
    {
      file: 'src/authkit-session-guard.mjs',
      replace: (source) => source.replace(
        `      if (!response.ok) {
        return sendJson(res, 503, {
          error: { code: 'AUTHKIT_SESSION_CHECK_FAILED', message: 'Kuklabs Account session validation is temporarily unavailable.' },
        });
      }`,
        '      if (!response.ok) return next(req, res);',
      ),
    },
  ]);
  assert.equal(record.result, 'failed');
  assert.ok(record.failures.some((failure) => failure.startsWith('authkit.fails_closed')), record.failures.join('; '));
});

test('the drill fails when the product header stops being sent', async () => {
  const record = await runDrillWithBrokenSource([{
    file: 'src/authkit-identity.mjs',
    replace: (source) => source.replace("'X-Kuklabs-Product': config.authkitProductId,", "'X-Not-The-Product-Header': config.authkitProductId,"),
  }]);
  assert.equal(record.result, 'failed');
  assert.ok(record.failures.some((failure) => failure.startsWith('authkit.product_header')), record.failures.join('; '));
});

test('the drill fails when an outage signs everybody out', async () => {
  // The half that is easy to break while fixing the other half. Clearing the
  // cookie on a 503 empties every browser on a healthy instance because one
  // dependency was briefly unreachable.
  const record = await runDrillWithBrokenSource([{
    file: 'src/authkit-identity.mjs',
    replace: (source) => source.replace(
      "const headers = status === 401 ? { 'Set-Cookie': clearAuthKitSessionCookie(config) } : {};",
      "const headers = { 'Set-Cookie': clearAuthKitSessionCookie(config) };",
    ),
  }]);
  assert.equal(record.result, 'failed');
  assert.ok(record.failures.some((failure) => failure.startsWith('authkit.outage_keeps_cookie')), record.failures.join('; '));
});

/* ----------------------------------------- feeding the recovery checklist */

/**
 * The manual checklist a recovery rehearsal would produce with this evidence.
 *
 * `runRecoveryRehearsal` needs a verified archive and a restore target, neither
 * of which this test has. The fold is exported so it can be asked directly
 * rather than reconstructed.
 */
async function recoveryChecksWith(evidencePath) {
  const { MANUAL_CHECKS, applyAuthKitEvidence } = await import('../src/recovery-rehearsal.mjs');
  return applyAuthKitEvidence(MANUAL_CHECKS, evidencePath);
}

test('drill evidence marks the recovery checks rehearsed, and never verified', async (t) => {
  const { MANUAL_CHECKS } = await import('../src/recovery-rehearsal.mjs');
  const { record } = await runAuthKitRehearsal({});
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-drill-evidence-')), 'authkit.json');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify(record));

  const applied = await recoveryChecksWith(file);
  const login = applied.find((check) => check.id === 'authkit.login');
  assert.equal(login.status, 'rehearsed');
  assert.equal(login.evidence.authkit, 'simulator');
  // The line that must never move on its own. A stand-in cannot sign off a
  // production check, however many times it passes.
  assert.notEqual(login.status, 'verified');

  // A check the drill does not cover is untouched.
  const ssh = applied.find((check) => check.id === 'git.ssh_authorization');
  assert.equal(ssh.status, 'outstanding');
  assert.equal(ssh.evidence, undefined);

  assert.ok(MANUAL_CHECKS.some((check) => check.id === 'authkit.device_revocation'));
});

test('a failed or unrecognised evidence file changes nothing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-drill-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const failed = path.join(dir, 'failed.json');
  fs.writeFileSync(failed, JSON.stringify({
    format: 'kukgit-authkit-rehearsal/1',
    result: 'failed',
    confidence: 'rehearsed',
    checks: [{ id: 'authkit.login', ok: true }],
  }));
  const nonsense = path.join(dir, 'nonsense.json');
  fs.writeFileSync(nonsense, 'not json at all');

  for (const file of [failed, nonsense, path.join(dir, 'missing.json')]) {
    const applied = await recoveryChecksWith(file);
    assert.equal(applied.find((check) => check.id === 'authkit.login').status, 'outstanding', `${file} was trusted`);
  }
});
