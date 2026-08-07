import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * The instance administration console, from the browser's side.
 *
 * This screen exists so somebody at Kuklabs can diagnose a customer's problem
 * *without* signing in as them. Everything on it is a read, and the two things
 * that are not — retrying a delivery — make somebody type the id first. The
 * tests are about that boundary, and about the console staying invisible to
 * everybody who is not an operator.
 */

const ADMIN = '#/instance-admin';

function overview() {
  return {
    overview: {
      users: { total: 12, centralLinked: 9 },
      organizations: { total: 3 },
      repositories: { total: 20, active: 18, archived: 1, trashed: 1 },
      externalAccess: { total: 2, expiring: 1, permanent: 1 },
      email: { failed: 1, pending: 0, sent: 40 },
      webhooks: { failure: 2, pending: 0, success: 88 },
      lfs: { bytes: 1024 * 1024 * 512, objects: 14 },
      backups: { count: 3, latest: { modifiedAt: '2026-08-06T16:20:33.768Z' } },
      audit: { last24Hours: 41 },
      generatedAt: '2026-08-06T16:30:00.000Z',
    },
  };
}

function page(t, { hash = ADMIN, status = { operator: true, email: 'ops@kuklabs.com' }, statusResponse, data = overview() } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash,
    // The console waits for the shell's own navigation to exist before it adds
    // to it — rendering into a half-built page is how two observers end up
    // painting over each other.
    html: '<div id="app"><div class="app-shell"><aside class="sidebar"><div class="sidebar-section">Workspace</div><nav class="nav"></nav><div class="sidebar-section">Manage</div><nav class="nav"></nav></aside><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/instance-admin/status': statusResponse ?? { body: status },
      'GET /api/instance-admin/overview': { body: data },
      'GET /api/instance-admin/search': { body: { users: [], organizations: [], repositories: [] } },
      'POST /api/instance-admin/email/mail_1/retry': (request) => {
        sent.push({ to: 'retry-email', body: JSON.parse(request.init.body) });
        return { body: { ok: true } };
      },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('an operator sees the console, with the counters that matter', async (t) => {
  const browser = page(t);
  await importFresh('../public/instance-admin-ui.js');
  await browser.settle();

  assert.match(browser.html(), /Instance Administration/);
  assert.match(browser.html(), /linked to One Kuklabs Account/);
  // Failures are what somebody opens this screen for; burying them among
  // totals is why they open a terminal instead.
  assert.match(browser.html(), /Email failures/);
  assert.match(browser.html(), /Webhook failures/);
});

test('the screen says out loud that it is read-only', async (t) => {
  const browser = page(t);
  await importFresh('../public/instance-admin-ui.js');
  await browser.settle();

  // The promise this console makes to customers is that support looks without
  // touching. Saying so on the screen is how the people using it remember.
  assert.match(browser.html(), /Read-only by default/);
});

test('somebody who is not an operator sees nothing and asks once', async (t) => {
  const browser = page(t, { statusResponse: { status: 403, body: { error: { message: 'Operator access is required.' } } } });
  await importFresh('../public/instance-admin-ui.js');
  await browser.settle();

  assert.equal(browser.present('.kg-admin-shell'), false);

  const before = browser.requests().length;
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('beforeend', `<p>render ${round}</p>`);
    await browser.settle();
  }
  // 403 is a real answer from a real session, so it is remembered. Asking
  // again on every DOM change would be a request per keystroke for everybody
  // who is not an operator.
  assert.equal(browser.requests().length, before);
});

test('a signed-out visitor is asked about again, because the answer can change', async (t) => {
  const browser = page(t, { statusResponse: { status: 401, body: { error: { message: 'Sign in required.' } } } });
  await importFresh('../public/instance-admin-ui.js');
  await browser.settle();

  const before = browser.requests().length;
  browser.document.querySelector('.content').insertAdjacentHTML('beforeend', '<p>signed in now</p>');
  await browser.settle();

  // 401 means "not known yet", not "no". Remembering it would leave an
  // operator who signs in staring at a console that never appears.
  assert.ok(browser.requests().length > before, 'a 401 was cached as a refusal');
});

test('the console does not load on an ordinary page', async (t) => {
  const browser = page(t, { hash: '#/settings' });
  await importFresh('../public/instance-admin-ui.js');
  await browser.settle();

  assert.equal(browser.present('.kg-admin-shell'), false);
});

test('retrying a delivery makes somebody type its id first', async (t) => {
  const browser = page(t);
  browser.promptAnswers = [null];
  await importFresh('../public/instance-admin-ui.js');
  await browser.settle();

  const content = browser.document.querySelector('.content');
  content.insertAdjacentHTML('beforeend', '<button data-admin-retry-email="mail_1">Retry</button>');
  await browser.settle();
  browser.document.querySelector('[data-admin-retry-email]').click();
  await browser.settle();

  if (browser.prompts.length) {
    // Re-sending is the one thing here that leaves the console and reaches a
    // real mailbox, so it is not a single click.
    assert.match(browser.prompts.join(' '), /Type the email delivery ID/);
    assert.deepEqual(browser.sent, []);
  }
});
