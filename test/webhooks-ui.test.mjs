import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Webhooks, from the browser's side.
 *
 * A webhook secret is what the receiving service checks a signature against.
 * KukGit stores it encrypted and will not reveal it again, so a value that
 * scrolls off the page is a secret nobody can configure and an endpoint that
 * silently rejects every delivery.
 *
 * The rest is about not doing something irreversible on a mis-click: rotating a
 * secret breaks the receiver until somebody updates it, and deleting a webhook
 * takes its delivery history with it.
 */

const ROUTE = '#/repo/kuklabs/demo/settings';
const SECRET = 'kgwhsec_LiveValueNobodyMaySeeTwice';

function hooks(overrides = {}) {
  return {
    canManage: true,
    availableEvents: ['ping', 'push', 'issues', 'pull_request', 'status', 'release'],
    webhooks: [
      { id: 'hook_1', url: 'https://ci.kuklabs.com/events', events: ['push'], active: true, updatedAt: '2026-08-01T00:00:00.000Z' },
    ],
    deliveries: [],
    ...overrides,
  };
}

function page(t, { data = hooks(), create, rotate } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash: ROUTE,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/webhooks/kuklabs/demo': { body: data },
      'POST /api/webhooks/kuklabs/demo': (request) => {
        sent.push({ to: 'create', body: JSON.parse(request.init.body) });
        return create ?? { status: 201, body: { webhook: { id: 'hook_2' }, secret: SECRET } };
      },
      'PATCH /api/webhooks/kuklabs/demo/hook_1': (request) => {
        sent.push({ to: 'patch', body: JSON.parse(request.init.body) });
        return rotate ?? { body: { secret: `${SECRET}-rotated` } };
      },
      'DELETE /api/webhooks/kuklabs/demo/hook_1': () => {
        sent.push({ to: 'delete' });
        return { body: { ok: true } };
      },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

async function create(browser, fill = () => {}) {
  const form = browser.document.querySelector('#kg-hook-create');
  form.querySelector('[name="url"]').value = 'https://deploy.kuklabs.com/hook';
  fill(form);
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();
  return form;
}

test('ping is not something anybody subscribes to', async (t) => {
  const browser = page(t);
  await importFresh('../public/webhooks-ui.js');
  await browser.settle();

  const values = browser.document.querySelectorAll('[name="event"]').map((input) => input.getAttribute('value'));
  // `ping` is what the Send ping button produces. Offering it as a subscription
  // is offering an event that never fires by itself.
  assert.ok(!values.includes('ping'), values.join(','));
  assert.ok(values.includes('push'));
});

test('creating a webhook sends the ticked events and the URL', async (t) => {
  const browser = page(t);
  await importFresh('../public/webhooks-ui.js');
  await browser.settle();

  await create(browser, (form) => {
    form.querySelector('[value="status"]').checked = false;
    form.querySelector('[value="release"]').checked = true;
  });

  assert.deepEqual(browser.sent, [{
    to: 'create',
    body: { url: 'https://deploy.kuklabs.com/hook', events: ['push', 'issues', 'pull_request', 'release'] },
  }]);
});

test('a blank secret field is left out, not sent as empty', async (t) => {
  const browser = page(t);
  await importFresh('../public/webhooks-ui.js');
  await browser.settle();

  await create(browser);
  // The server generates one when none is given. An empty string is a value,
  // and a webhook signed with the empty string is a webhook anybody can forge.
  assert.equal('secret' in browser.sent[0].body, false);
});

test('a secret somebody typed is sent as typed', async (t) => {
  const browser = page(t);
  await importFresh('../public/webhooks-ui.js');
  await browser.settle();

  await create(browser, (form) => { form.querySelector('[name="secret"]').value = 'a-secret-of-sufficient-length'; });
  assert.equal(browser.sent[0].body.secret, 'a-secret-of-sufficient-length');
});

test('no events selected is refused here, not at the server', async (t) => {
  const browser = page(t);
  await importFresh('../public/webhooks-ui.js');
  await browser.settle();

  await create(browser, (form) => {
    for (const input of form.querySelectorAll('[name="event"]')) input.checked = false;
  });

  // A webhook subscribed to nothing is an endpoint that never fires and a
  // support question about why.
  assert.deepEqual(browser.sent, []);
  assert.match(browser.html(), /Choose at least one webhook event/);
});

test('the secret is shown once, and the list never carries it', async (t) => {
  const browser = page(t);
  await importFresh('../public/webhooks-ui.js');
  await browser.settle();

  await create(browser);

  assert.equal(browser.document.querySelector('#kg-hook-secret-value')?.textContent, SECRET);
  assert.match(browser.html(), /will not reveal the plaintext again/);
  // The list is re-read after creation. A secret that came back in that payload
  // would be on the page on every visit, for a value the server keeps encrypted.
  assert.doesNotMatch(browser.document.querySelector('#kg-hook-list').innerHTML, /LiveValue/);
});

test('rotating asks first, and cancelling changes nothing', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/webhooks-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-hook-rotate').click();
  await browser.settle();

  assert.match(browser.confirmations.join(' '), /previous secret will stop validating/);
  // Rotating breaks the receiving service until somebody updates it there.
  assert.deepEqual(browser.sent, []);
});

test('a rotated secret is shown, once', async (t) => {
  const browser = page(t);
  await importFresh('../public/webhooks-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-hook-rotate').click();
  await browser.settle();

  assert.deepEqual(browser.sent.map((entry) => entry.to), ['patch']);
  assert.deepEqual(browser.sent[0].body, { rotateSecret: true });
  assert.equal(browser.document.querySelector('#kg-hook-secret-value')?.textContent, `${SECRET}-rotated`);
});

test('deleting a webhook asks first', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/webhooks-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-hook-delete').click();
  await browser.settle();
  assert.match(browser.confirmations.join(' '), /Delete this webhook and its delivery history/);
  assert.deepEqual(browser.sent, []);

  browser.confirmAnswer = true;
  browser.document.querySelector('.kg-hook-delete').click();
  await browser.settle();
  assert.deepEqual(browser.sent.map((entry) => entry.to), ['delete']);
});

test('a refused creation says why and leaves the form usable', async (t) => {
  const browser = page(t, {
    create: { status: 422, body: { error: { message: 'Payload URL must resolve to a public network.' } } },
  });
  await importFresh('../public/webhooks-ui.js');
  await browser.settle();

  const form = await create(browser);
  assert.match(browser.html(), /must resolve to a public network/);
  assert.equal(browser.document.querySelector('#kg-hook-secret-value'), null, 'no secret is shown');
  assert.equal(form.querySelector('button[type="submit"]').disabled, false);
});

test('a repository with no webhooks says so', async (t) => {
  const browser = page(t, { data: hooks({ webhooks: [] }) });
  await importFresh('../public/webhooks-ui.js');
  await browser.settle();

  assert.match(browser.html(), /No webhooks configured for this repository/);
  assert.match(browser.html(), /No webhook deliveries yet/);
});
