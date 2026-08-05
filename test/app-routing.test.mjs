import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * `app.js` — the router, the shell, and who is allowed to see them.
 *
 * The largest file in `public/` and, until now, the least tested: what it does
 * was asserted only by reading its source. Two of the six bugs that reached the
 * live server were in here — credentials rendered into the sign-in page, and a
 * route that reset itself to `#/` before the panel it was supposed to show had
 * loaded.
 *
 * The route table is the interesting part. Every entry either renders something
 * or falls through to `navigate('#/')`, and an extension route — one another
 * module owns — has to fall through to *neither*, because sending it home is
 * exactly how the administration panel became unreachable.
 */

const USER = { id: 'usr_1', email: 'amith@kuklabs.com', displayName: 'Amith' };
const ORGANIZATIONS = [{ id: 'org_1', slug: 'kuklabs', name: 'Kuklabs', role: 'owner' }];

const DASHBOARD = {
  metrics: { repositories: 4, openIssues: 2, openPullRequests: 1, aiReviews: 0 },
  repositories: [],
  activity: [],
};

/**
 * Enough of the API for every route to render.
 *
 * A route whose payload is missing throws on `.length` and reports as a routing
 * failure, which is a test lying about what it found.
 */
function world(overrides = {}) {
  return {
    '/api/auth/me': { body: { user: USER, organizations: ORGANIZATIONS } },
    '/api/auth/sign-in-hints': { body: { demoAccount: null } },
    '/api/dashboard': { body: DASHBOARD },
    '/api/repos': { body: { repositories: [] } },
    '/api/issues': { body: { issues: [] } },
    '/api/pulls': { body: { pullRequests: [], pulls: [] } },
    '/api/orgs': { body: { organizations: ORGANIZATIONS } },
    '/api/audit': { body: { auditLogs: [] } },
    '*': { body: {} },
    ...overrides,
  };
}

function browser({ routes, ...options } = {}) {
  return installBrowser({
    hash: '#/',
    html: '<div id="app"></div><div id="toast-root"></div>',
    ...options,
    // After the spread, or `...options` puts the unmerged overrides back and
    // every request falls through to the stub's 404.
    routes: world(routes),
  });
}

test('a signed-in visitor gets the shell, not the sign-in page', async (t) => {
  const page = browser();
  t.after(() => page.restore());

  await importFresh('../public/app.js');
  await page.settle();

  assert.ok(page.document.querySelector('.app-shell'), 'the shell is rendered');
  assert.equal(page.document.querySelector('.login-page'), null);
  assert.match(page.html(), /Repositories/);
});

test('a signed-out visitor gets the sign-in page, and no credentials with it', async (t) => {
  const page = browser({ routes: { '/api/auth/me': { body: { user: null } } } });
  t.after(() => page.restore());

  await importFresh('../public/app.js');
  await page.settle();

  assert.ok(page.document.querySelector('.login-page'), 'the sign-in page is rendered');
  // A password shipped in the page is a password every visitor has. This was in
  // `renderLogin` for weeks because nothing read the file back.
  assert.doesNotMatch(page.html(), /KukGit@2026/);
  assert.doesNotMatch(page.html(), /admin@kuklabs\.local/);
});

test('a server that is not there says so, rather than an empty page', async (t) => {
  const page = browser({ routes: { '/api/auth/me': { status: 500, body: { error: { message: 'boom' } } } } });
  t.after(() => page.restore());

  await importFresh('../public/app.js');
  await page.settle();

  assert.match(page.html(), /KukGit server is unavailable/);
  assert.match(page.html(), /npm start/);
});

test('every route in the table renders instead of falling home', async (t) => {
  const page = browser();
  t.after(() => page.restore());

  await importFresh('../public/app.js');
  await page.settle();

  for (const route of ['#/repositories', '#/issues', '#/pulls', '#/ai', '#/organizations', '#/audit', '#/settings']) {
    page.navigate(route);
    await page.settle();
    // Falling through to `navigate('#/')` would put the hash back, and the
    // visitor would watch the address bar undo their click.
    assert.equal(page.location.hash, route, `${route} was sent home`);
  }
});

test('an unknown route goes home rather than showing nothing', async (t) => {
  const page = browser();
  t.after(() => page.restore());

  await importFresh('../public/app.js');
  await page.settle();

  page.navigate('#/no-such-page');
  await page.settle();
  assert.equal(page.location.hash, '#/');
});

test('a route another module owns is left alone', async (t) => {
  const page = browser();
  t.after(() => page.restore());

  await importFresh('../public/app.js');
  await page.settle();

  page.navigate('#/instance-admin');
  await page.settle();

  // This is the bug that made the administration panel unreachable: `app.js`
  // did not recognise the route, sent the visitor home, and the panel that was
  // about to render had nowhere to render into.
  assert.equal(page.location.hash, '#/instance-admin');
  assert.ok(page.document.querySelector('.app-shell'), 'the shell is still there for the other module to render into');
});

test('a page that fails to load offers a way back', async (t) => {
  const page = browser({ routes: { '/api/repos': { status: 500, body: { error: { message: 'the disk is full' } } } } });
  t.after(() => page.restore());

  await importFresh('../public/app.js');
  await page.settle();

  page.navigate('#/repositories');
  await page.settle();

  assert.match(page.html(), /Unable to load this page/);
  assert.match(page.html(), /the disk is full/);
  // A dead end with no way out is how somebody reloads, gets the same thing,
  // and gives up.
  assert.ok(page.document.querySelector('[data-route="#/"]'));
});

test('a 401 mid-session returns to sign-in rather than an error page', async (t) => {
  let signedIn = true;
  const page = browser({
    routes: {
      '/api/auth/me': () => ({ body: { user: signedIn ? USER : null, organizations: ORGANIZATIONS } }),
      '/api/repos': () => (signedIn
        ? { body: { repositories: [] } }
        : { status: 401, body: { error: { code: 'AUTH_REQUIRED', message: 'Sign in to continue.' } } }),
    },
  });
  t.after(() => page.restore());

  await importFresh('../public/app.js');
  await page.settle();

  // The session expires while they are reading.
  signedIn = false;
  page.navigate('#/repositories');
  await page.settle();

  // An expired session is not a page error. Showing "Unable to load this page"
  // to somebody who simply needs to sign in again sends them to support.
  assert.ok(page.document.querySelector('.login-page'), 'the sign-in page is shown');
  assert.doesNotMatch(page.html(), /Unable to load this page/);
});

test('clicking a route element navigates', async (t) => {
  const page = browser();
  t.after(() => page.restore());

  await importFresh('../public/app.js');
  await page.settle();

  const link = page.document.querySelector('[data-route="#/repositories"]');
  assert.ok(link, 'the shell offers a link to repositories');
  page.document.dispatchEvent({ type: 'click', target: link, bubbles: true });
  await page.settle();
  assert.equal(page.location.hash, '#/repositories');
});

test('navigating around does not ask the same question twice', async (t) => {
  const page = browser();
  t.after(() => page.restore());

  await importFresh('../public/app.js');
  await page.settle();
  page.clearCalls();

  page.navigate('#/repositories');
  await page.settle();
  page.navigate('#/organizations');
  await page.settle();

  const [path, count] = page.busiest();
  // Each page asks for its own data once. A router that re-fetched on every DOM
  // change is the storm this suite exists to catch.
  assert.ok(count <= 2, `${count} requests to ${path}`);
  assert.equal(page.looped, false);
});

test('the extension route list is what the other modules actually own', async () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const admin = fs.readFileSync(new URL('../public/instance-admin-ui.js', import.meta.url), 'utf8');
  // If `app.js` forgets a route another module renders, that module's page is
  // unreachable — and the failure looks like the module being broken.
  assert.match(app, /EXTENSION_ROUTES = new Set\(\['instance-admin'\]\)/);
  assert.match(admin, /segments\[0\] === 'instance-admin'/);
});
