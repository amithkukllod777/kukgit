import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Creating the first organization, from the browser's side.
 *
 * This is the first screen a new account sees, and the slug it picks becomes
 * the prefix of every clone URL that organization will ever hand out. So the
 * screen has to say whether a slug is free *before* the form is submitted, and
 * must not submit one it already knows is taken.
 */

const ROUTE = '#/organizations';

function status(overrides = {}) {
  return {
    organizations: [],
    ownerCount: 0,
    ownerLimit: 3,
    canCreate: true,
    suggestedSlug: 'example-technologies',
    ...overrides,
  };
}

function page(t, { data = status(), slugs = {}, create } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash: ROUTE,
    html: '<div id="app"><div class="app-shell"><main class="content"><div class="page-actions"></div></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/onboarding/status': { body: data },
      'GET /api/repos': { body: { repositories: [] } },
      'POST /api/onboarding/organizations': (request) => {
        sent.push({ to: 'create', body: JSON.parse(request.init.body) });
        return create ?? { status: 201, body: { organization: { slug: 'example-technologies', name: 'Example Technologies' } } };
      },
      '*': (request) => {
        const match = /\/api\/onboarding\/organizations\/slug\/(.+)$/.exec(request.path);
        if (match) {
          sent.push({ to: 'slug', slug: decodeURIComponent(match[1]) });
          return { body: { available: slugs[decodeURIComponent(match[1])] ?? true } };
        }
        return { status: 404, body: { error: { message: 'Not found.' } } };
      },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('an account with no organization is shown the form, pre-filled with a suggestion', async (t) => {
  const browser = page(t);
  await importFresh('../public/organization-onboarding-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-organization-onboarding-form');
  assert.ok(form, 'no onboarding form');
  // A blank slug box on the first screen somebody ever sees is a blank they
  // have to invent a convention for.
  assert.equal(form.querySelector('[name="slug"]').getAttribute('value'), 'example-technologies');
});

test('the ownership limit is on the screen, and stops the button when reached', async (t) => {
  const browser = page(t, { data: status({ canCreate: false, ownerCount: 3, ownerLimit: 3 }) });
  await importFresh('../public/organization-onboarding-ui.js');
  await browser.settle();

  assert.match(browser.html(), /3 of 3 workspaces/);
  // A button that submits and then fails teaches somebody the limit by hitting
  // it; the disabled button with its reason on it does not.
  const button = browser.document.querySelector('#kg-organization-onboarding-form button[type="submit"]');
  assert.equal(button.disabled, true);
  assert.match(button.textContent, /ownership limit reached/i);
});

test('the slug is checked before anything is submitted', async (t) => {
  const browser = page(t);
  await importFresh('../public/organization-onboarding-ui.js');
  await browser.settle();

  // On render, not only on submit: knowing the URL is taken after filling in
  // five fields is knowing it too late.
  assert.equal(browser.sent.some((entry) => entry.to === 'slug'), true);
});

test('a slug that is taken is not submitted', async (t) => {
  const browser = page(t, { slugs: { 'example-technologies': false } });
  await importFresh('../public/organization-onboarding-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-organization-onboarding-form');
  form.querySelector('[name="name"]').value = 'Example Technologies';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  // The slug becomes the prefix of every clone URL this organization hands
  // out. Sending one the screen already knows is taken produces a 409 that
  // reads like a bug.
  assert.equal(browser.sent.some((entry) => entry.to === 'create'), false);
  assert.match(browser.html(), /available workspace URL/i);
});

test('an available slug is submitted with everything else on the form', async (t) => {
  const browser = page(t);
  await importFresh('../public/organization-onboarding-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-organization-onboarding-form');
  form.querySelector('[name="name"]').value = 'Example Technologies';
  form.querySelector('[name="description"]').value = 'Product code and infrastructure';
  form.querySelector('[name="companySize"]').value = '11-50';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'create');
  assert.equal(sent.body.name, 'Example Technologies');
  assert.equal(sent.body.slug, 'example-technologies');
  assert.equal(sent.body.companySize, '11-50');
});

test('a refused creation says why and gives the button back', async (t) => {
  const browser = page(t, { create: { status: 409, body: { error: { message: 'That workspace URL was taken a moment ago.' } } } });
  await importFresh('../public/organization-onboarding-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-organization-onboarding-form');
  form.querySelector('[name="name"]').value = 'Example Technologies';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  assert.match(browser.html(), /taken a moment ago/);
  // Two people can pick the same slug in the same second. The screen has to
  // survive losing that race.
  assert.equal(form.querySelector('button[type="submit"]').disabled, false);
});

test('an account that already owns an organization gets a button, not the whole screen', async (t) => {
  const browser = page(t, { data: status({ organizations: [{ slug: 'kuklabs', name: 'Kuklabs Inc.', role: 'owner' }], ownerCount: 1 }) });
  await importFresh('../public/organization-onboarding-ui.js');
  await browser.settle();

  // Taking over the organizations page with a setup wizard for somebody who is
  // already set up is taking away the page they came for.
  assert.equal(browser.present('#kg-organization-onboarding-form'), false);
  assert.equal(browser.present('#kg-create-organization-button'), true);
});

test('the sign-in page is left alone', async (t) => {
  const browser = installBrowser({
    hash: '#/',
    html: '<div id="app"><main class="login-page"><form class="login-card"><input name="email" /></form></main></div><div id="toast-root"></div>',
    routes: { '*': { status: 404, body: {} } },
  });
  t.after(() => browser.restore());
  await importFresh('../public/organization-onboarding-ui.js');
  await browser.settle();

  // Nobody is signed in, so there is no account to create an organization for
  // — and asking the server about one is a request that can only 401.
  assert.equal(browser.present('#kg-organization-onboarding-form'), false);
  assert.deepEqual(browser.requests(), []);
});
