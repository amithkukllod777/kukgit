import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Notifications, from the browser's side.
 *
 * Two things matter here. An unread count that is wrong makes the bell either
 * useless or a lie — and preferences are how somebody stops KukGit emailing
 * them, so an unticked box that arrives as "unspecified" rather than "off" is a
 * setting that does not take.
 */

const SETTINGS = '#/settings';

function inbox(overrides = {}) {
  return {
    unreadCount: 2,
    notifications: [
      { id: 'ntf_1', category: 'pull_request', title: 'Review requested', body: 'On #4', readAt: null, createdAt: '2026-08-06T09:00:00.000Z', url: '#/repo/kuklabs/demo/pulls' },
      { id: 'ntf_2', category: 'issue', title: 'Issue closed', body: '#7 was closed', readAt: '2026-08-05T09:00:00.000Z', createdAt: '2026-08-05T09:00:00.000Z', url: null },
    ],
    ...overrides,
  };
}

function preferences() {
  return {
    preferences: [
      { category: 'pull_request', inAppEnabled: true, emailEnabled: true },
      { category: 'issue', inAppEnabled: true, emailEnabled: false },
    ],
  };
}

function page(t, { hash = SETTINGS, data = inbox(), prefs = preferences(), save } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash,
    html: '<div id="app"><div class="app-shell"><header class="topbar"></header><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/notifications': { body: data },
      'GET /api/notifications/preferences': { body: prefs },
      'PUT /api/notifications/preferences': (request) => {
        sent.push({ to: 'save-preferences', body: JSON.parse(request.init.body) });
        return save ?? { body: prefs };
      },
      'POST /api/notifications/read-all': () => { sent.push({ to: 'read-all' }); return { body: inbox({ unreadCount: 0 }) }; },
      'POST /api/notifications/ntf_1/read': () => { sent.push({ to: 'read', id: 'ntf_1' }); return { body: { ok: true } }; },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('the preferences screen lists every category with both channels', async (t) => {
  const browser = page(t);
  await importFresh('../public/notifications-ui.js');
  await browser.settle();

  const rows = browser.document.querySelectorAll('[data-preference-category]');
  assert.equal(rows.length, 2);
  // In-app and email are separate decisions: somebody may want the bell and
  // not the inbox.
  assert.equal(browser.document.querySelectorAll('[name="inAppEnabled"]').length, 2);
  assert.equal(browser.document.querySelectorAll('[name="emailEnabled"]').length, 2);
});

test('the boxes start at what is actually stored', async (t) => {
  const browser = page(t);
  await importFresh('../public/notifications-ui.js');
  await browser.settle();

  const issueRow = browser.document.querySelectorAll('[data-preference-category]')
    .find((row) => row.dataset.preferenceCategory === 'issue');
  assert.equal(issueRow.querySelector('[name="inAppEnabled"]').checked, true);
  // A box that shows ticked for a setting that is off tells somebody they are
  // subscribed when they are not.
  assert.equal(issueRow.querySelector('[name="emailEnabled"]').checked, false);
});

test('an unticked box is sent as off, not left out', async (t) => {
  const browser = page(t);
  await importFresh('../public/notifications-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-notification-preferences-form');
  const row = browser.document.querySelectorAll('[data-preference-category]')
    .find((entry) => entry.dataset.preferenceCategory === 'pull_request');
  row.querySelector('[name="emailEnabled"]').checked = false;
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'save-preferences');
  const pullRequest = sent.body.preferences.find((entry) => entry.category === 'pull_request');
  // An unchecked box is absent from FormData. Reading the boxes per row rather
  // than from the form is what makes "off" reach the server at all — otherwise
  // turning email off does nothing and KukGit keeps writing to somebody who
  // asked it to stop.
  assert.equal(pullRequest.emailEnabled, false);
  assert.equal(pullRequest.inAppEnabled, true);
});

test('every category is sent, not only the ones that changed', async (t) => {
  const browser = page(t);
  await importFresh('../public/notifications-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-notification-preferences-form');
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'save-preferences');
  assert.deepEqual(sent.body.preferences.map((entry) => entry.category).sort(), ['issue', 'pull_request']);
});

test('a refused save says why and leaves the form usable', async (t) => {
  const browser = page(t, { save: { status: 422, body: { error: { message: 'Unknown notification category.' } } } });
  await importFresh('../public/notifications-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-notification-preferences-form');
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  assert.match(browser.html(), /Unknown notification category/);
  assert.equal(form.querySelector('button[type="submit"]').disabled, false);
});

test('preferences nobody may read are asked for once, not forever', async (t) => {
  const browser = installBrowser({
    hash: SETTINGS,
    html: '<div id="app"><div class="app-shell"><header class="topbar"></header><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/notifications': { status: 401, body: { error: { message: 'Sign in required.' } } },
      'GET /api/notifications/preferences': { status: 401, body: { error: { message: 'Sign in required.' } } },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  await importFresh('../public/notifications-ui.js');
  await browser.settle();

  const before = browser.requests().length;
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('beforeend', `<p>render ${round}</p>`);
    await browser.settle();
  }
  // This module was one of the five that had this defect. Growth, not a
  // threshold: the failure is a count that never stops rising.
  assert.equal(browser.requests().length, before);
});
