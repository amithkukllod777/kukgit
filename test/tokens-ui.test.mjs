import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Personal access tokens, from the browser's side.
 *
 * A token is a password for somebody's repositories. The screen that creates
 * one has two jobs beyond looking right: send exactly the scopes that were
 * ticked, and show the secret exactly once — the server keeps only a hash, so a
 * value that scrolls away is a token nobody can use and nobody can revoke
 * confidently either.
 *
 * Both are the kind of thing that reads correct in the source and is wrong in
 * the page.
 */

const TOKEN = 'kgp_LiveSecretValueNobodyMaySeeTwice';

function page(t, { tokens = [], create } = {}) {
  const calls = [];
  const browser = installBrowser({
    hash: '#/settings',
    html: `<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>`,
    routes: {
      'GET /api/settings/tokens': { body: { tokens } },
      'POST /api/settings/tokens': (request) => {
        calls.push(JSON.parse(request.init.body));
        return create ?? { status: 201, body: { token: { id: 'pat_1', name: 'Laptop', token: TOKEN, scopes: ['repo:read'] } } };
      },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.created = calls;
  return browser;
}

async function submit(browser) {
  const form = browser.document.querySelector('#kg-token-form');
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();
  return form;
}

test('the panel only appears on the settings page', async (t) => {
  const browser = page(t);
  browser.location.hash = '#/organizations';

  await importFresh('../public/tokens-ui.js');
  await browser.settle();

  assert.equal(browser.document.querySelector('#kg-token-panel'), null);
  assert.equal(browser.countPath('/api/settings/tokens'), 0);
});

test('creating a token sends the ticked scopes and nothing else', async (t) => {
  const browser = page(t);
  await importFresh('../public/tokens-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-token-form');
  form.querySelector('[name="name"]').value = 'Developer laptop';
  form.querySelector('[value="repo:write"]').checked = true;
  await submit(browser);

  // Read is ticked in the markup, write was ticked by hand. Sending the wrong
  // set is handing somebody push access they did not ask for, or refusing them
  // access they did.
  assert.deepEqual(browser.created, [{ name: 'Developer laptop', expiresInDays: 90, scopes: ['repo:read', 'repo:write'] }]);
});

test('unticking everything is refused here, not at the server', async (t) => {
  const browser = page(t);
  await importFresh('../public/tokens-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-token-form');
  form.querySelector('[name="name"]').value = 'Scopeless';
  form.querySelector('[value="repo:read"]').checked = false;
  await submit(browser);

  // A token with no scopes is a token that can do nothing. Creating one and
  // then discovering that is worse than being told before it exists.
  assert.deepEqual(browser.created, []);
  assert.match(browser.html(), /Choose repository read or repository write access/);
});

test('the secret is shown once, and the list never carries it', async (t) => {
  const browser = page(t, {
    tokens: [{ id: 'pat_1', name: 'Laptop', tokenPrefix: 'kgp_Live', scopes: ['repo:read'], createdAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-11-01T00:00:00.000Z' }],
  });
  await importFresh('../public/tokens-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-token-form');
  form.querySelector('[name="name"]').value = 'Laptop';
  await submit(browser);

  const secret = browser.document.querySelector('#kg-token-value');
  assert.equal(secret?.textContent, TOKEN, 'the value is shown');
  assert.match(browser.html(), /cannot reveal this value again/);

  // The list is re-read after creation. If the secret were in that payload — or
  // rendered from it — it would come back on every visit, and a value the
  // server only hashes would be sitting in the page forever.
  const list = browser.document.querySelector('#kg-token-list');
  assert.doesNotMatch(list.innerHTML, /LiveSecretValue/);
});

test('the form goes back to read-only after a token is made', async (t) => {
  const browser = page(t);
  await importFresh('../public/tokens-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-token-form');
  form.querySelector('[name="name"]').value = 'First';
  form.querySelector('[value="repo:write"]').checked = true;
  await submit(browser);

  // The next token somebody makes should not silently inherit write access
  // because the last one had it.
  assert.equal(form.querySelector('[value="repo:write"]').checked, false);
  assert.equal(form.querySelector('[value="repo:read"]').checked, true);
  assert.equal(form.querySelector('[name="expiresInDays"]').value, '90');
});

test('a refused creation says so and leaves the form usable', async (t) => {
  const browser = page(t, {
    create: { status: 422, body: { error: { code: 'TOKEN_NAME_TAKEN', message: 'A token with that name already exists.' } } },
  });
  await importFresh('../public/tokens-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-token-form');
  form.querySelector('[name="name"]').value = 'Laptop';
  await submit(browser);

  assert.match(browser.html(), /A token with that name already exists/);
  assert.equal(browser.document.querySelector('#kg-token-value'), null, 'no secret is shown');
  // A dead button after a rejected name is somebody reloading the page to try
  // a different one.
  assert.equal(browser.document.querySelector('#kg-token-create').disabled, false);
});

test('an empty list says what to do rather than nothing', async (t) => {
  const browser = page(t);
  await importFresh('../public/tokens-ui.js');
  await browser.settle();

  assert.match(browser.document.querySelector('#kg-token-list').innerHTML, /No personal access tokens yet/);
  assert.doesNotMatch(browser.html(), /Loading tokens…/);
});

test('the panel is attached once, however often the page redraws', async (t) => {
  const browser = page(t);
  await importFresh('../public/tokens-ui.js');
  await browser.settle();

  const content = browser.document.querySelector('.content');
  for (let round = 0; round < 6; round += 1) content.insertAdjacentHTML('beforeend', `<div>${round}</div>`);
  await browser.settle(40);

  assert.equal(browser.document.querySelectorAll('#kg-token-panel').length, 1);
  assert.ok(browser.countPath('/api/settings/tokens') <= 2, `asked ${browser.countPath('/api/settings/tokens')} times`);
  assert.equal(browser.looped, false);
});
