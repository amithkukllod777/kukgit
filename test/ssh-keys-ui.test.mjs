import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * SSH keys, from the browser's side.
 *
 * A public key is how somebody's laptop proves it may push. Adding one grants
 * access and removing one takes it away, so the screen has to ask before it
 * revokes and must not lose a key somebody pasted because the request failed.
 */

const SETTINGS = '#/settings';
const REPO_SETTINGS = '#/repo/kuklabs/demo/settings';
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyValueHere amit@laptop';

function userKeys(overrides = {}) {
  return {
    keys: [
      { id: 'key_1', title: 'Laptop', fingerprint: 'SHA256:abcdef', algorithm: 'ssh-ed25519', createdAt: '2026-08-01T00:00:00.000Z', lastUsedAt: null },
    ],
    cloneUrlExample: 'git@git.kuklabs.com:kuklabs/demo.git',
    ...overrides,
  };
}

function deployKeys(overrides = {}) {
  return {
    canManage: true,
    keys: [
      { id: 'dkey_1', title: 'CI', fingerprint: 'SHA256:123456', readOnly: true, createdAt: '2026-08-01T00:00:00.000Z' },
    ],
    ...overrides,
  };
}

function page(t, { hash = SETTINGS, user = userKeys(), deploy = deployKeys(), addUser, addDeploy } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/ssh-keys': { body: user },
      'POST /api/ssh-keys': (request) => {
        sent.push({ to: 'add-user', body: JSON.parse(request.init.body) });
        return addUser ?? { status: 201, body: userKeys() };
      },
      'DELETE /api/ssh-keys/key_1': () => { sent.push({ to: 'revoke-user' }); return { body: userKeys({ keys: [] }) }; },
      'GET /api/ssh-keys/kuklabs/demo/deploy-keys': { body: deploy },
      'POST /api/ssh-keys/kuklabs/demo/deploy-keys': (request) => {
        sent.push({ to: 'add-deploy', body: JSON.parse(request.init.body) });
        return addDeploy ?? { status: 201, body: deployKeys() };
      },
      'DELETE /api/ssh-keys/kuklabs/demo/deploy-keys/dkey_1': () => { sent.push({ to: 'revoke-deploy' }); return { body: deployKeys({ keys: [] }) }; },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('a personal key is listed by fingerprint, never by its full value', async (t) => {
  const browser = page(t);
  await importFresh('../public/ssh-keys-ui.js');
  await browser.settle();

  assert.match(browser.html(), /SHA256:abcdef/);
  assert.match(browser.html(), /Laptop/);
});

test('adding a key sends the title and the key as typed', async (t) => {
  const browser = page(t);
  await importFresh('../public/ssh-keys-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-user-ssh-form');
  form.querySelector('[name="title"]').value = 'Work laptop';
  form.querySelector('[name="publicKey"]').value = KEY;
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'add-user');
  assert.equal(sent.body.title, 'Work laptop');
  // Whitespace and comment intact: a key the server normalizes differently from
  // the one the caller pasted is a key whose fingerprint does not match theirs.
  assert.equal(sent.body.publicKey, KEY);
});

test('revoking a personal key asks first, and cancelling keeps it', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/ssh-keys-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-ssh-revoke, [data-ssh-key]')?.click();
  const button = browser.document.querySelectorAll('button').find((node) => /revoke/i.test(node.textContent));
  button?.click();
  await browser.settle();

  assert.match(browser.confirmations.join(' '), /Revoke this SSH key/);
  // Removing a key takes somebody's push access away. Doing it on a mis-click
  // is a laptop that stops working with no explanation.
  assert.equal(browser.sent.some((entry) => entry.to === 'revoke-user'), false);
});

test('a refused key says why and leaves what was pasted', async (t) => {
  const browser = page(t, {
    addUser: { status: 422, body: { error: { message: 'That key is already registered to another account.' } } },
  });
  await importFresh('../public/ssh-keys-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-user-ssh-form');
  form.querySelector('[name="title"]').value = 'Work laptop';
  form.querySelector('[name="publicKey"]').value = KEY;
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  assert.match(browser.html(), /already registered/);
  // Clearing the box on failure means somebody has to go back to their machine
  // and copy the key again.
  assert.equal(form.querySelector('[name="publicKey"]').value, KEY);
});

test('there is no deploy key panel outside a repository', async (t) => {
  // Two browsers in one test would install their globals over each other; each
  // page gets its own test.
  const browser = page(t);
  await importFresh('../public/ssh-keys-ui.js');
  await browser.settle();
  assert.equal(browser.present('#kg-deploy-ssh-panel'), false);
});

test('a repository settings page has one', async (t) => {
  const browser = page(t, { hash: REPO_SETTINGS });
  await importFresh('../public/ssh-keys-ui.js');
  await browser.settle();
  assert.ok(browser.document.querySelector('#kg-deploy-ssh-panel'), 'no deploy key panel on a repository');
});

test('a deploy key is added read-only unless push is asked for', async (t) => {
  const browser = page(t, { hash: REPO_SETTINGS });
  await importFresh('../public/ssh-keys-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-deploy-key-form');
  form.querySelector('[name="title"]').value = 'CI runner';
  form.querySelector('[name="publicKey"]').value = KEY;
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  // A deploy key that can push is a key that can rewrite history from a build
  // machine. The unticked box has to mean read-only, not "unspecified".
  assert.equal(browser.sent.find((entry) => entry.to === 'add-deploy').body.canWrite, false);
});

test('ticking push sends it', async (t) => {
  const browser = page(t, { hash: REPO_SETTINGS });
  await importFresh('../public/ssh-keys-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-deploy-key-form');
  form.querySelector('[name="title"]').value = 'CI runner';
  form.querySelector('[name="publicKey"]').value = KEY;
  form.querySelector('[name="canWrite"]').checked = true;
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  assert.equal(browser.sent.find((entry) => entry.to === 'add-deploy').body.canWrite, true);
});

test('a repository nobody may configure is asked for once, not forever', async (t) => {
  const browser = installBrowser({
    hash: REPO_SETTINGS,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/ssh-keys': { status: 403, body: { error: { message: 'Forbidden.' } } },
      'GET /api/ssh-keys/kuklabs/demo/deploy-keys': { status: 403, body: { error: { message: 'Forbidden.' } } },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  await importFresh('../public/ssh-keys-ui.js');
  await browser.settle();

  const before = browser.requests().length;
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('beforeend', `<p>render ${round}</p>`);
    await browser.settle();
  }
  // The "already rendered" guard tests for a panel, and a refusal renders none.
  // Growth, not a threshold: the defect is a count that never stops rising.
  assert.equal(browser.requests().length, before);
});
