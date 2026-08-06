import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * The bulk import screen, from the browser's side.
 *
 * Two things it must get right. It spends money — every repository it pulls in
 * counts towards the organization's plan — so it previews before it acts and
 * asks before it starts. And it polls a running job, which is the shape that has
 * produced a request storm in five other modules here: a mutation observer whose
 * callback fetches, whose result changes the DOM, which wakes the observer.
 */

const ROUTE = '#/repositories';

function organizations() {
  return {
    organizations: [
      { id: 'org_1', slug: 'kuklabs', name: 'Kuklabs Inc.', role: 'owner' },
      { id: 'org_2', slug: 'readonly', name: 'Read Only', role: 'viewer' },
    ],
  };
}

function preview() {
  return {
    forge: 'github',
    owner: 'acme',
    authenticated: true,
    truncated: false,
    note: null,
    selected: [
      { name: 'alpha', slug: 'alpha', cloneUrl: 'https://github.com/acme/alpha.git', private: true },
      { name: 'beta', slug: 'beta', cloneUrl: 'https://github.com/acme/beta.git', private: false },
    ],
    skipped: [{ name: 'a-fork', slug: 'a-fork', reason: 'it is a fork' }],
  };
}

function job(overrides = {}) {
  return {
    id: 'impjob_1',
    forge: 'github',
    owner: 'acme',
    status: 'running',
    total: 2,
    counts: { pending: 1, importing: 1, imported: 0, failed: 0, skipped: 0 },
    items: [
      { id: 'i1', name: 'alpha', slug: 'alpha', status: 'importing', message: null },
      { id: 'i2', name: 'beta', slug: 'beta', status: 'pending', message: null },
    ],
    ...overrides,
  };
}

function page(t, { orgs = organizations(), previewBody, previewStatus, start } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash: ROUTE,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/orgs': { body: orgs },
      'POST /api/repository-imports/preview': (request) => {
        sent.push({ to: 'preview', body: JSON.parse(request.init.body) });
        return previewStatus ? { status: previewStatus, body: previewBody } : { body: previewBody ?? preview() };
      },
      'POST /api/repository-imports': (request) => {
        sent.push({ to: 'start', body: JSON.parse(request.init.body) });
        return start ?? { status: 202, body: { job: job() } };
      },
      'GET /api/repository-imports/impjob_1': () => {
        sent.push({ to: 'poll' });
        return { body: { job: job({ status: 'done', counts: { pending: 0, importing: 0, imported: 2, failed: 0, skipped: 0 } }) } };
      },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

async function fill(browser, values = {}) {
  const form = browser.document.querySelector('#kg-import-form');
  form.querySelector('[name="owner"]').value = values.owner ?? 'acme';
  if (values.accessToken) form.querySelector('[name="accessToken"]').value = values.accessToken;
  if (values.includeForks) form.querySelector('[name="includeForks"]').checked = true;
  browser.document.querySelector('#kg-import-preview').click();
  await browser.settle();
  return form;
}

test('only organizations the visitor could import into are offered', async (t) => {
  const browser = page(t);
  await importFresh('../public/repository-import-ui.js');
  await browser.settle();

  const options = browser.document.querySelectorAll('[name="orgSlug"] option').map((option) => option.getAttribute('value'));
  // A viewer cannot create repositories, so offering their organization here is
  // offering a 403 four steps later.
  assert.deepEqual(options, ['kuklabs']);
});

test('somebody who maintains nothing is shown nothing, and stops asking', async (t) => {
  const browser = page(t, { orgs: { organizations: [{ id: 'org_2', slug: 'readonly', name: 'Read Only', role: 'viewer' }] } });
  await importFresh('../public/repository-import-ui.js');
  await browser.settle();

  assert.equal(browser.document.querySelector('#kg-import-panel'), null);
  const before = browser.requests().length;
  browser.document.querySelector('.content').insertAdjacentHTML('beforeend', '<p>something else rendered</p>');
  await browser.settle();
  // The guard for "already rendered" tests for a panel, and this path renders
  // none — so without remembering the refusal the observer asks again for every
  // DOM change anything else on the page makes.
  assert.equal(browser.requests().length, before);
});

test('the preview asks the host and imports nothing', async (t) => {
  const browser = page(t);
  await importFresh('../public/repository-import-ui.js');
  await browser.settle();

  await fill(browser, { accessToken: 'github_pat_VALUE' });

  assert.deepEqual(browser.sent.map((entry) => entry.to), ['preview']);
  assert.equal(browser.sent[0].body.owner, 'acme');
  assert.equal(browser.sent[0].body.accessToken, 'github_pat_VALUE');
  assert.match(browser.html(), /2 to import/);
  assert.match(browser.html(), /1 skipped/);
  // The reason is shown, not swallowed. Somebody who expected three and sees
  // two needs the third accounted for.
  assert.match(browser.html(), /it is a fork/);
});

test('an unticked box is absent rather than false', async (t) => {
  const browser = page(t);
  await importFresh('../public/repository-import-ui.js');
  await browser.settle();
  await fill(browser, { includeForks: true });
  assert.equal(browser.sent[0].body.includeForks, true);
  assert.equal(browser.sent[0].body.includeArchived, false);
});

test('issues come across by default, and can be turned off', async (t) => {
  const browser = page(t);
  await importFresh('../public/repository-import-ui.js');
  await browser.settle();

  // On by default: for most repositories the conversation is the part that
  // cannot be reconstructed, and somebody who did not think about the box gets
  // the more complete migration.
  assert.equal(browser.document.querySelector('[name="includeIssues"]').checked, true);
  await fill(browser);
  assert.equal(browser.sent[0].body.includeIssues, true);

  browser.document.querySelector('[name="includeIssues"]').checked = false;
  browser.document.querySelector('#kg-import-preview').click();
  await browser.settle();
  assert.equal(browser.sent[1].body.includeIssues, false);
});

test('starting asks first, and cancelling imports nothing', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/repository-import-ui.js');
  await browser.settle();
  await fill(browser);

  browser.document.querySelector('#kg-import-start').click();
  await browser.settle();

  // Forty repositories arriving in an organization, each one billed, is not
  // something to do on a mis-click.
  assert.match(browser.confirmations.join(' '), /counts towards the plan/);
  assert.deepEqual(browser.sent.map((entry) => entry.to), ['preview']);
});

test('only the ticked repositories are sent', async (t) => {
  const browser = page(t);
  await importFresh('../public/repository-import-ui.js');
  await browser.settle();
  await fill(browser);

  browser.document.querySelector('[name="repository"][value="beta"]').checked = false;
  browser.document.querySelector('#kg-import-start').click();
  await browser.settle();

  const start = browser.sent.find((entry) => entry.to === 'start');
  assert.deepEqual(start.body.slugs, ['alpha']);
});

test('nothing ticked is refused here rather than at the server', async (t) => {
  const browser = page(t);
  await importFresh('../public/repository-import-ui.js');
  await browser.settle();
  await fill(browser);

  for (const input of browser.document.querySelectorAll('[name="repository"]')) input.checked = false;
  browser.document.querySelector('#kg-import-start').click();
  await browser.settle();

  assert.equal(browser.sent.some((entry) => entry.to === 'start'), false);
  assert.match(browser.html(), /Tick at least one repository/);
});

test('a refused preview says why and leaves the form usable', async (t) => {
  const browser = page(t, {
    previewStatus: 401,
    previewBody: { error: { code: 'FORGE_UNAUTHORIZED', message: 'GitHub rejected the access token.' } },
  });
  await importFresh('../public/repository-import-ui.js');
  await browser.settle();
  await fill(browser, { accessToken: 'expired-token' });

  assert.match(browser.html(), /GitHub rejected the access token/);
  assert.equal(browser.document.querySelector('#kg-import-preview').disabled, false);
});

test('a running job is polled, and the polling stops when it finishes', async (t) => {
  const browser = page(t);
  await importFresh('../public/repository-import-ui.js');
  await browser.settle();
  await fill(browser);
  browser.document.querySelector('#kg-import-start').click();
  await browser.settle();

  assert.equal(browser.sent.filter((entry) => entry.to === 'start').length, 1);
  await browser.advanceTimers(2100);
  await browser.settle();
  assert.equal(browser.sent.filter((entry) => entry.to === 'poll').length, 1);
  assert.match(browser.html(), /2 imported/);

  // The job came back done. Carrying on polling a finished job is a request
  // every two seconds for as long as the tab is open.
  await browser.advanceTimers(6000);
  await browser.settle();
  assert.equal(browser.sent.filter((entry) => entry.to === 'poll').length, 1);
});

test('the panel does not ask again every time the page changes', async (t) => {
  const browser = page(t);
  await importFresh('../public/repository-import-ui.js');
  await browser.settle();

  const before = browser.requests().length;
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('beforeend', `<p>render ${round}</p>`);
    await browser.settle();
  }
  // Growth, not a threshold: the defect this guards against is a count that
  // never stops rising, and any fixed number is either too tight or too loose.
  assert.equal(browser.requests().length, before);
});
