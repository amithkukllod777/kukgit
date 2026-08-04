import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * A fresh copy of the module per test. It caches the answer in module state on
 * purpose, so two tests sharing one copy would test the cache rather than the
 * decision.
 */
let copy = 0;
async function freshModule() {
  copy += 1;
  return import(`../public/instance-admin-ui.js?copy=${copy}`);
}

function stubFetch(t, replies) {
  const calls = [];
  const saved = globalThis.fetch;
  t.after(() => { globalThis.fetch = saved; });
  globalThis.fetch = async (path) => {
    calls.push(path);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body ?? {},
    };
  };
  return calls;
}

test('signed out is not an answer, so signing in asks again', async (t) => {
  // The bug this replaces: the first ask happens as the module loads, on the
  // sign-in page. Recording that 401 as "not an admin" meant the founder signed
  // in and the Instance Admin link never appeared — nothing asked again, and
  // signing in does not reload the page.
  const { loadKgAdminStatus } = await freshModule();
  const calls = stubFetch(t, [
    { status: 401, body: { error: { message: 'Sign in required.' } } },
    { status: 200, body: { instanceAdmin: true, email: 'amith@kuklabs.com' } },
  ]);

  assert.equal(await loadKgAdminStatus(), false);
  assert.deepEqual(await loadKgAdminStatus(), { instanceAdmin: true, email: 'amith@kuklabs.com' });
  assert.equal(calls.length, 2);
});

test('a signed-in refusal is an answer, and is not asked twice', async (t) => {
  // 403 comes from a real session about a real user. Asking again on every DOM
  // change would be a request per mutation for everyone who is not an operator.
  const { loadKgAdminStatus } = await freshModule();
  const calls = stubFetch(t, [{ status: 403, body: { error: { code: 'INSTANCE_ADMIN_REQUIRED' } } }]);

  assert.equal(await loadKgAdminStatus(), false);
  assert.equal(await loadKgAdminStatus(), false);
  assert.equal(calls.length, 1);
});

test('a positive answer is remembered', async (t) => {
  const { loadKgAdminStatus } = await freshModule();
  const calls = stubFetch(t, [{ status: 200, body: { instanceAdmin: true, email: 'amith@kuklabs.com' } }]);

  assert.deepEqual(await loadKgAdminStatus(), { instanceAdmin: true, email: 'amith@kuklabs.com' });
  await loadKgAdminStatus();
  assert.equal(calls.length, 1);
});

test('callers arriving together share one request', async (t) => {
  // The observer fires on every DOM change, so "together" is the normal case.
  const { loadKgAdminStatus } = await freshModule();
  const calls = stubFetch(t, [{ status: 200, body: { instanceAdmin: true } }]);

  const answers = await Promise.all([loadKgAdminStatus(), loadKgAdminStatus(), loadKgAdminStatus()]);
  assert.equal(calls.length, 1);
  for (const answer of answers) assert.deepEqual(answer, { instanceAdmin: true });
});

test('the signed-in shell is what gates asking at all', async (t) => {
  const { kgAdminShellReady } = await freshModule();
  const saved = globalThis.document;
  t.after(() => {
    if (saved === undefined) delete globalThis.document;
    else globalThis.document = saved;
  });

  const sections = (...labels) => ({ querySelectorAll: () => labels.map((text) => ({ textContent: text })) });
  globalThis.document = sections();
  assert.equal(kgAdminShellReady(), false, 'the sign-in page has no sidebar');
  globalThis.document = sections('Workspace');
  assert.equal(kgAdminShellReady(), false);
  globalThis.document = sections('Workspace', '  Manage  ');
  assert.equal(kgAdminShellReady(), true);
});
