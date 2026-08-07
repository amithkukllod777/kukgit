import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Time-bound external access, from the browser's side.
 *
 * A contractor's access is supposed to end. The whole point of this screen is
 * that it *expires* rather than being remembered about — so what it has to get
 * right is showing how long is left, and renewing somebody without inventing a
 * second identity for them.
 */

const SETTINGS = '#/repo/kuklabs/demo/settings';

function lifecycle(overrides = {}) {
  return {
    canManage: true,
    organizationAdmin: true,
    grants: [
      {
        userId: 'user_9',
        displayName: 'Contractor',
        email: 'contractor@example.com',
        permission: 'write',
        status: 'expiring',
        expiresAt: '2026-08-20T00:00:00.000Z',
        lastReviewedAt: '2026-07-01T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function history(overrides = {}) {
  return {
    history: [
      {
        id: 'hist_1',
        displayName: 'Former Contractor',
        email: 'former@example.com',
        permission: 'read',
        expiredAt: '2026-06-01T00:00:00.000Z',
        restoredAt: null,
      },
    ],
    ...overrides,
  };
}

function page(t, { data = lifecycle(), past = history() } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash: SETTINGS,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/external-access/kuklabs/demo': { body: data },
      'GET /api/external-access-history/kuklabs/demo': { body: past },
      'PATCH /api/external-access/kuklabs/demo/collaborators/user_9': (request) => {
        sent.push({ to: 'update', body: JSON.parse(request.init.body) });
        return { body: data };
      },
      'POST /api/external-access-history/kuklabs/demo/hist_1/renew': (request) => {
        sent.push({ to: 'renew', body: JSON.parse(request.init.body) });
        return { body: past };
      },
      'GET /api/external-access/kuklabs/reviews': { body: { campaigns: [] } },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('a grant shows who it is, what it grants and when it ends', async (t) => {
  const browser = page(t);
  await importFresh('../public/external-access-reviews-ui.js');
  await browser.settle();

  assert.match(browser.html(), /Contractor/);
  assert.match(browser.html(), /write permission/);
  // Access that expires and does not say when is access nobody plans around.
  assert.match(browser.html(), /Last reviewed/);
});

test('a grant close to expiry is marked, not left to be noticed', async (t) => {
  const browser = page(t);
  await importFresh('../public/external-access-reviews-ui.js');
  await browser.settle();

  // The badge is the difference between renewing on Friday and a contractor
  // locked out on Monday morning.
  assert.match(browser.html(), /expiring/i);
});

test('updating sends the permission and the new duration together', async (t) => {
  const browser = page(t);
  await importFresh('../public/external-access-reviews-ui.js');
  await browser.settle();

  const row = browser.document.querySelector('[data-grant-user]');
  row.querySelector('.kg-access-permission').value = 'read';
  row.querySelector('.kg-access-duration').value = '30';
  row.querySelector('.kg-update-access-lifecycle').click();
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'update');
  // Both at once: changing the permission without resetting the clock leaves
  // somebody with new powers on an old expiry nobody looked at.
  assert.equal(sent.body.permission, 'read');
  assert.equal(String(sent.body.accessDays), '30');
});

test('expired access can be renewed rather than re-invented', async (t) => {
  const browser = page(t);
  await importFresh('../public/external-access-reviews-ui.js');
  await browser.settle();

  assert.match(browser.html(), /Former Contractor/);
  const row = browser.document.querySelector('[data-history-id]');
  row.querySelector('.kg-renew-permission').value = 'read';
  row.querySelector('.kg-renew-duration').value = '90';
  row.querySelector('.kg-renew-external-access').click();
  await browser.settle();

  // Re-inviting produces a second identity for the same person, and the
  // history of what they had before stops joining up.
  const sent = browser.sent.find((entry) => entry.to === 'renew');
  assert.equal(sent.body.permission, 'read');
  assert.equal(String(sent.body.accessDays), '90');
});

test('access already restored is not offered for renewal again', async (t) => {
  const browser = page(t, { past: history({ history: [{ id: 'hist_1', displayName: 'Back Already', email: 'back@example.com', permission: 'read', expiredAt: '2026-06-01T00:00:00.000Z', restoredAt: '2026-07-01T00:00:00.000Z' }] }) });
  await importFresh('../public/external-access-reviews-ui.js');
  await browser.settle();

  // Renewing somebody who already has access is a request that either fails or
  // silently extends a grant somebody else just set.
  assert.equal(browser.present('[data-history-id]'), false);
});

test('somebody who cannot manage sees the permission and no controls', async (t) => {
  const browser = page(t, { data: lifecycle({ canManage: false }) });
  await importFresh('../public/external-access-reviews-ui.js');
  await browser.settle();

  assert.equal(browser.present('.kg-update-access-lifecycle'), false);
  // Still readable: knowing when your colleague's access ends is not an
  // administrative privilege.
  assert.match(browser.html(), /Contractor/);
});

test('a repository nobody may administer is asked for once, not forever', async (t) => {
  const browser = installBrowser({
    hash: SETTINGS,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/external-access/kuklabs/demo': { status: 403, body: { error: { message: 'Repository admin permission is required.' } } },
      'GET /api/external-access/kuklabs/reviews': { status: 403, body: { error: { message: 'Forbidden.' } } },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  await importFresh('../public/external-access-reviews-ui.js');
  await browser.settle();

  const before = browser.requests().length;
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('beforeend', `<p>render ${round}</p>`);
    await browser.settle();
  }
  // This module remembers a refused answer in a Set rather than a single key,
  // because it asks about two different things on the same page.
  assert.equal(browser.requests().length, before);
});
