import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Archiving, transferring, trashing and purging a repository.
 *
 * Every control on this screen is destructive or close to it, and one of them
 * cannot be undone at all. The tests are about the things that stand between a
 * mis-click and a purged repository: the typed confirmation, the browser
 * confirm, and the order — archive first, then move.
 */

const SETTINGS = '#/repo/kuklabs/demo/settings';
const CONFIRMATION = 'kuklabs/demo';

function lifecycle(overrides = {}) {
  return {
    repository: { id: 'repo_1', orgSlug: 'kuklabs', slug: 'demo', name: 'Demo', archived: false },
    availableTransferOrganizations: [{ slug: 'kuklabs-labs', name: 'Kuklabs Labs', role: 'admin' }],
    confirmation: CONFIRMATION,
    retentionDays: 30,
    effectivePermission: 'admin',
    ...overrides,
  };
}

function trash(rows = []) {
  return { repositories: rows, retentionDays: 30 };
}

function page(t, { hash = SETTINGS, data = lifecycle(), trashRows = [], archive, transfer } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/repository-lifecycle/kuklabs/demo': { body: data },
      'GET /api/repository-lifecycle/trash': { body: trash(trashRows) },
      'POST /api/repository-lifecycle/kuklabs/demo/archive': () => { sent.push({ to: 'archive' }); return archive ?? { body: { repository: data.repository } }; },
      'DELETE /api/repository-lifecycle/kuklabs/demo/archive': () => { sent.push({ to: 'unarchive' }); return { body: { repository: data.repository } }; },
      'POST /api/repository-lifecycle/kuklabs/demo/transfer': (request) => {
        sent.push({ to: 'transfer', body: JSON.parse(request.init.body) });
        return transfer ?? { body: { repository: data.repository } };
      },
      'POST /api/repository-lifecycle/kuklabs/demo/trash': (request) => {
        sent.push({ to: 'trash', body: JSON.parse(request.init.body) });
        return { body: { repository: data.repository } };
      },
      'POST /api/repository-lifecycle/trash/repo_9/restore': (request) => {
        sent.push({ to: 'restore', body: JSON.parse(request.init.body) });
        return { body: { repository: {} } };
      },
      'DELETE /api/repository-lifecycle/trash/repo_9': (request) => {
        sent.push({ to: 'purge', body: JSON.parse(request.init.body) });
        return { body: { purged: true } };
      },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('transfer and trash are disabled until the repository is archived', async (t) => {
  const browser = page(t);
  await importFresh('../public/repository-lifecycle-ui.js');
  await browser.settle();

  // Moving live Git storage out from under people who are pushing to it is the
  // failure this ordering exists to prevent.
  assert.equal(browser.document.querySelector('#kg-life-transfer button').disabled, true);
  assert.equal(browser.document.querySelector('#kg-life-trash button').disabled, true);
});

test('once archived, they are available', async (t) => {
  const browser = page(t, { data: lifecycle({ repository: { id: 'repo_1', orgSlug: 'kuklabs', slug: 'demo', name: 'Demo', archived: true } }) });
  await importFresh('../public/repository-lifecycle-ui.js');
  await browser.settle();

  assert.equal(browser.document.querySelector('#kg-life-transfer button').disabled, false);
  assert.equal(browser.document.querySelector('#kg-life-trash button').disabled, false);
});

test('transferring asks first and names both ends', async (t) => {
  const browser = page(t, { data: lifecycle({ repository: { id: 'repo_1', orgSlug: 'kuklabs', slug: 'demo', name: 'Demo', archived: true } }) });
  browser.confirmAnswer = false;
  await importFresh('../public/repository-lifecycle-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-life-transfer');
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  // Which repository, and to where. A confirmation that says neither is a
  // confirmation nobody reads.
  assert.match(browser.confirmations.join(' '), /kuklabs\/demo/);
  assert.match(browser.confirmations.join(' '), /kuklabs-labs/);
  assert.deepEqual(browser.sent, []);
});

test('trashing sends the typed confirmation, not a guess', async (t) => {
  const browser = page(t, { data: lifecycle({ repository: { id: 'repo_1', orgSlug: 'kuklabs', slug: 'demo', name: 'Demo', archived: true } }) });
  await importFresh('../public/repository-lifecycle-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-life-trash');
  form.querySelector('[name="confirmation"]').value = CONFIRMATION;
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'trash');
  // Typed by a person, sent verbatim. Filling it in for them would make the
  // whole control pointless.
  assert.equal(sent.body.confirmation, CONFIRMATION);
  assert.match(browser.confirmations.join(' '), /Git and browser access will stop/);
});

test('the confirmation box starts empty and is not pre-filled', async (t) => {
  const browser = page(t, { data: lifecycle({ repository: { id: 'repo_1', orgSlug: 'kuklabs', slug: 'demo', name: 'Demo', archived: true } }) });
  await importFresh('../public/repository-lifecycle-ui.js');
  await browser.settle();

  const input = browser.document.querySelector('#kg-life-trash [name="confirmation"]');
  // A placeholder shows what to type; a value types it for you.
  assert.equal(input.value ?? '', '');
  assert.equal(input.getAttribute('placeholder'), CONFIRMATION);
});

test('archiving does not need a typed confirmation, because it is reversible', async (t) => {
  const browser = page(t);
  await importFresh('../public/repository-lifecycle-ui.js');
  await browser.settle();

  browser.document.querySelector('#kg-life-archive').click();
  await browser.settle();

  // Ceremony belongs where it buys something. Asking somebody to type a slug to
  // make a repository read-only teaches them to type slugs without reading.
  assert.deepEqual(browser.sent.map((entry) => entry.to), ['archive']);
});

test('purging is offered only to an owner, and asks in the strongest terms', async (t) => {
  const rows = [{ id: 'repo_9', originalOrgSlug: 'kuklabs', originalSlug: 'gone', name: 'Gone', role: 'owner', deletedAt: '2026-08-01T00:00:00.000Z', purgeAfter: '2026-09-01T00:00:00.000Z' }];
  const browser = page(t, { hash: '#/settings', trashRows: rows });
  browser.confirmAnswer = false;
  await importFresh('../public/repository-lifecycle-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-life-purge').click();
  await browser.settle();

  assert.match(browser.confirmations.join(' '), /cannot be undone/);
  assert.deepEqual(browser.sent, []);
});

test('an admin who is not an owner is offered restore and not purge', async (t) => {
  const rows = [{ id: 'repo_9', originalOrgSlug: 'kuklabs', originalSlug: 'gone', name: 'Gone', role: 'admin', deletedAt: '2026-08-01T00:00:00.000Z', purgeAfter: '2026-09-01T00:00:00.000Z' }];
  const browser = page(t, { hash: '#/settings', trashRows: rows });
  await importFresh('../public/repository-lifecycle-ui.js');
  await browser.settle();

  assert.equal(browser.present('.kg-life-purge'), false);
  assert.equal(browser.present('.kg-life-restore'), true);
});

test('restoring sends the typed confirmation for that row', async (t) => {
  const rows = [{ id: 'repo_9', originalOrgSlug: 'kuklabs', originalSlug: 'gone', name: 'Gone', role: 'owner', deletedAt: '2026-08-01T00:00:00.000Z', purgeAfter: '2026-09-01T00:00:00.000Z' }];
  const browser = page(t, { hash: '#/settings', trashRows: rows });
  await importFresh('../public/repository-lifecycle-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-trash-actions [name="confirmation"]').value = 'kuklabs/gone';
  browser.document.querySelector('.kg-life-restore').click();
  await browser.settle();

  assert.equal(browser.sent.find((entry) => entry.to === 'restore').body.confirmation, 'kuklabs/gone');
});

test('a repository nobody may administer is asked for once, not forever', async (t) => {
  const browser = installBrowser({
    hash: SETTINGS,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/repository-lifecycle/kuklabs/demo': { status: 403, body: { error: { message: 'Repository admin permission is required.' } } },
      'GET /api/repository-lifecycle/trash': { status: 403, body: { error: { message: 'Forbidden.' } } },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  await importFresh('../public/repository-lifecycle-ui.js');
  await browser.settle();

  const before = browser.requests().length;
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('beforeend', `<p>render ${round}</p>`);
    await browser.settle();
  }
  assert.equal(browser.requests().length, before);
});
