import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * The front end, driven the way a visitor drives it.
 *
 * Every bug these cover was found by opening the site and watching the network
 * panel, not by the suite — a request sent forty-four times, a signed-out 401
 * remembered as "you are not an administrator", a panel attached twice. They
 * are all behaviours over time, which is why no amount of testing the rendering
 * functions in isolation caught them.
 */

const GIB = 1024 ** 3;

function usagePayload() {
  return {
    usage: {
      period: { id: '2026-08' },
      plan: { id: 'team', label: 'Team', recognised: true, stored: 'team' },
      storage: {
        gitBytes: 2 * GIB, lfsBytes: 0, artifactBytes: 0, cacheBytes: 0,
        lfsLinkedBytes: 0, lfsSavedBytes: 0, totalBytes: 2 * GIB,
        repositories: { active: 4, archived: 0, trashed: 0, total: 4 },
      },
      ci: { minutes: 12, jobs: 3, running: 0 },
      people: { seats: 5, externalCollaborators: 0 },
      limits: {
        storageBytes: { used: 2 * GIB, limit: 100 * GIB, over: false },
        repositories: { used: 4, limit: 500, over: false },
        seats: { used: 5, limit: 50, over: false },
        ciMinutesPerMonth: { used: 12, limit: 10_000, over: false },
        externalCollaborators: { used: 0, limit: 50, over: false },
      },
      exceeded: [],
    },
  };
}

const NOT_FOUND = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found.' } } };
const UNAUTHORIZED = { status: 401, body: { error: { code: 'AUTH_REQUIRED', message: 'Sign in to continue.' } } };
const FORBIDDEN = { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Not an instance administrator.' } } };

/** A signed-in page, roughly the shape `app.js` renders. */
function shell(inner = '') {
  return `
    <aside class="sidebar">
      <div class="sidebar-section">Manage</div>
      <nav class="nav"></nav>
    </aside>
    <main class="content">${inner}</main>
    <div id="toast-root"></div>`;
}

/** Something else on the page redrawing, which is what wakes every observer. */
function churn(browser, times = 6) {
  const content = browser.document.querySelector('.content');
  for (let round = 0; round < times; round += 1) {
    content.insertAdjacentHTML('beforeend', `<div class="kg-churn">${round}</div>`);
  }
}

test('a 404 review panel is asked for once, not once per DOM change', async (t) => {
  const browser = installBrowser({
    hash: '#/org/kuklabs',
    html: shell('<section id="kg-collaboration-panel" data-org="kuklabs"></section>'),
    routes: { '*': NOT_FOUND },
  });
  t.after(() => browser.restore());

  await importFresh('../public/external-access-reviews-ui.js');
  await browser.settle();
  churn(browser);
  await browser.settle();

  // Measured at forty-four in a real browser before the guard, ending at the
  // rate limiter with the whole page refused.
  assert.equal(browser.countPath('/api/external-access/kuklabs/reviews'), 1);
  assert.equal(browser.looped, false);
});

test('coming back to a page asks again, because the answer can have changed', async (t) => {
  const browser = installBrowser({
    hash: '#/org/kuklabs',
    html: shell('<section id="kg-collaboration-panel" data-org="kuklabs"></section>'),
    routes: { '*': NOT_FOUND },
  });
  t.after(() => browser.restore());

  await importFresh('../public/external-access-reviews-ui.js');
  await browser.settle();
  assert.equal(browser.countPath('/api/external-access/kuklabs/reviews'), 1);

  // Another organization is a different question, and gets asked.
  browser.document.querySelector('#kg-collaboration-panel').dataset.org = 'other';
  browser.navigate('#/org/other');
  await browser.settle();
  assert.equal(browser.countPath('/api/external-access/other/reviews'), 1);

  // And the same question, asked after leaving and returning, is asked again —
  // somebody who was refused at 10:00 may have been granted access at 10:01.
  // Remembering an answer forever is the mirror of asking forty times.
  browser.document.querySelector('#kg-collaboration-panel').dataset.org = 'kuklabs';
  browser.navigate('#/org/kuklabs');
  await browser.settle();
  assert.equal(browser.countPath('/api/external-access/kuklabs/reviews'), 2);
});

test('the review panel renders what the API returned', async (t) => {
  const browser = installBrowser({
    hash: '#/org/kuklabs',
    html: shell('<section id="kg-collaboration-panel" data-org="kuklabs"></section>'),
    routes: {
      '/api/external-access/kuklabs/reviews': {
        body: {
          campaigns: [{
            id: 'camp_1', name: 'Quarterly external access review', createdByName: 'Amith',
            totalItems: 3, pendingItems: 2, status: 'open', overdue: false, dueAt: '2026-09-01T00:00:00.000Z',
          }],
        },
      },
      '*': NOT_FOUND,
    },
  });
  t.after(() => browser.restore());

  await importFresh('../public/external-access-reviews-ui.js');
  await browser.settle();

  const panel = browser.document.querySelector('#kg-external-access-reviews');
  assert.ok(panel, 'the campaigns panel should be on the page');
  assert.match(panel.innerHTML, /Quarterly external access review/);
  assert.match(panel.innerHTML, /2 pending/);
  // The form default is the value the next request carries.
  assert.equal(panel.querySelector('[name="dueInDays"]').value, '14');
});

test('starting a review sends what the form says', async (t) => {
  const bodies = [];
  const browser = installBrowser({
    hash: '#/org/kuklabs',
    html: shell('<section id="kg-collaboration-panel" data-org="kuklabs"></section>'),
    routes: {
      'GET /api/external-access/kuklabs/reviews': { body: { campaigns: [] } },
      'POST /api/external-access/kuklabs/reviews': ({ init }) => {
        bodies.push(JSON.parse(init.body));
        return { body: { campaign: { id: 'camp_9', items: [] } } };
      },
      '*': NOT_FOUND,
    },
  });
  t.after(() => browser.restore());

  await importFresh('../public/external-access-reviews-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-create-access-review');
  form.querySelector('[name="name"]').value = 'Contractor sweep';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  assert.deepEqual(bodies, [{ name: 'Contractor sweep', dueInDays: 14 }]);
});

test('an organization card gets its usage once, however often the page redraws', async (t) => {
  const browser = installBrowser({
    hash: '#/',
    html: shell('<article data-kg-org-card="kuklabs"></article><article data-kg-org-card="acme"></article>'),
    routes: {
      '/api/orgs/kuklabs/usage': { body: usagePayload() },
      '/api/orgs/acme/usage': { body: usagePayload() },
      '*': NOT_FOUND,
    },
  });
  t.after(() => browser.restore());

  await importFresh('../public/usage-ui.js');
  await browser.settle();
  churn(browser);
  await browser.settle();

  const cards = browser.document.querySelectorAll('[data-kg-org-card]');
  assert.equal(cards.length, 2);
  for (const card of cards) assert.equal(card.querySelectorAll('.kg-usage').length, 1);
  // Attaching the panel changes the card, which wakes the observer that
  // attaches the panel. The mark is the only thing stopping that.
  assert.equal(browser.countPath('/api/orgs/kuklabs/usage'), 1);
  assert.equal(browser.countPath('/api/orgs/acme/usage'), 1);
  assert.equal(browser.looped, false);
});

test('a usage panel that fails to load does not take the page with it', async (t) => {
  const browser = installBrowser({
    hash: '#/',
    html: shell('<article data-kg-org-card="kuklabs"></article>'),
    routes: { '*': { status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } } },
  });
  t.after(() => browser.restore());

  await importFresh('../public/usage-ui.js');
  await browser.settle();
  churn(browser);
  await browser.settle();

  assert.equal(browser.document.querySelectorAll('.kg-usage').length, 0);
  assert.ok(browser.document.querySelector('[data-kg-org-card]'), 'the card itself survives');
  assert.equal(browser.looped, false);
});

test('a signed-out 401 is not remembered as "you are not an administrator"', async (t) => {
  let signedIn = false;
  const browser = installBrowser({
    hash: '#/',
    html: shell(),
    routes: {
      '/api/instance-admin/status': () => (signedIn
        ? { body: { instance: { organizations: 1, users: 1 } } }
        : UNAUTHORIZED),
      '*': NOT_FOUND,
    },
  });
  t.after(() => browser.restore());

  await importFresh('../public/instance-admin-ui.js');
  await browser.settle();
  assert.equal(browser.document.querySelector('[data-kg-admin-nav]'), null, 'no link before signing in');

  // Signing in is a new answer to the same question. Caching the 401 is what
  // hid the administration panel from the instance owner on his own server.
  signedIn = true;
  churn(browser);
  await browser.settle();
  assert.ok(browser.document.querySelector('[data-kg-admin-nav]'), 'the link appears once the session exists');
});

test('a 403 is an answer, and is not asked again on every redraw', async (t) => {
  const browser = installBrowser({
    hash: '#/',
    html: shell(),
    routes: { '/api/instance-admin/status': FORBIDDEN, '*': NOT_FOUND },
  });
  t.after(() => browser.restore());

  await importFresh('../public/instance-admin-ui.js');
  await browser.settle();
  churn(browser, 10);
  await browser.settle();

  assert.equal(browser.document.querySelector('[data-kg-admin-nav]'), null);
  // A member who is not an operator sees this page all day. Asking once is the
  // difference between a quiet page and a request per keystroke.
  assert.equal(browser.countPath('/api/instance-admin/status'), 1);
});

test('the admin shell is not asked for on the sign-in page', async (t) => {
  const browser = installBrowser({
    hash: '#/',
    // No "Manage" section: nobody is signed in, so there is nothing to ask about.
    html: '<div class="content"><form id="sign-in"></form></div><div id="toast-root"></div>',
    routes: { '*': UNAUTHORIZED },
  });
  t.after(() => browser.restore());

  await importFresh('../public/instance-admin-ui.js');
  await browser.settle();
  churn(browser);
  await browser.settle();

  assert.equal(browser.countPath('/api/instance-admin/status'), 0);
});

test('the sign-in page carries no credentials in its markup', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  // A password shipped in the page is a password every visitor has. This was in
  // `renderLogin` for weeks because nothing read the file back.
  assert.doesNotMatch(source, /KukGit@2026/);
  assert.doesNotMatch(source, /value="admin@kuklabs\.local"/);
});
