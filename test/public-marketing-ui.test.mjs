import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importFresh, installBrowser } from '../test-support/browser.mjs';
import { isMarketingRoute, renderMarketingRoute } from '../public/marketing-ui.js';

function publicPage(t, pathname = '/', routes = {}) {
  const browser = installBrowser({
    hash: '',
    html: '<div id="app"></div><div id="toast-root"></div>',
    routes: { '*': { status: 404, body: {} }, ...routes },
  });
  t.after(() => browser.restore());
  browser.location.pathname = pathname;
  return browser;
}

test('plain public paths belong to the marketing website while legacy app hashes remain compatible', () => {
  for (const path of ['/', '/features', '/security', '/pricing', '/docs']) {
    assert.equal(isMarketingRoute(path, ''), true, path);
  }
  assert.equal(isMarketingRoute('/', '#/'), false);
  assert.equal(isMarketingRoute('/', '#/repositories'), false);
  assert.equal(isMarketingRoute('/app', ''), false);
  assert.equal(isMarketingRoute('/login', ''), false);
});

test('the public home page renders the approved visual direction without fake version claims', (t) => {
  const browser = publicPage(t);
  renderMarketingRoute(browser.document.querySelector('#app'), '/');

  assert.ok(browser.document.querySelector('.marketing-site'));
  assert.ok(browser.document.querySelector('.mk-product-preview'));
  assert.match(browser.html(), /Git hosting and developer collaboration, built for clarity/);
  assert.match(browser.html(), /v0.2.0 · Private alpha/);
  assert.doesNotMatch(browser.html(), /KukGit 4\.0/);
  assert.doesNotMatch(browser.html(), /SOC 2|ISO 27001|AES-256|SAML & OIDC/);
  assert.ok(browser.document.querySelector('a[href="/login"]'));
  assert.ok(browser.document.querySelector('a[href="/app"]'));
});

test('a signed-out visitor sees the public home page after one session check', async (t) => {
  const browser = publicPage(t, '/', {
    '/api/auth/me': { body: { user: null } },
  });
  await importFresh('../public/app.js');
  await browser.settle();

  assert.ok(browser.document.querySelector('.marketing-site'));
  assert.equal(browser.document.querySelector('.app-shell'), null);
  assert.equal(browser.calls.filter((entry) => entry.path === '/api/auth/me').length, 1);
});

test('a signed-in visitor keeps the existing dashboard at the root route', async (t) => {
  const browser = publicPage(t, '/', {
    '/api/auth/me': {
      body: {
        user: { id: 'usr_1', email: 'amit@kuklabs.com', displayName: 'Amit' },
        organizations: [{ id: 'org_1', slug: 'kuklabs', name: 'Kuklabs', role: 'owner' }],
      },
    },
    '/api/dashboard': {
      body: {
        metrics: { repositories: 2, openIssues: 1, openPullRequests: 1, aiHealth: null },
        repositories: [],
        activity: [],
      },
    },
  });
  await importFresh('../public/app.js');
  await browser.settle();

  assert.ok(browser.document.querySelector('.app-shell'));
  assert.equal(browser.document.querySelector('.marketing-site'), null);
  assert.equal(browser.location.pathname, '/');
});

test('every public route has its own useful content and accurate boundary', (t) => {
  const browser = publicPage(t);
  const expectations = [
    ['/features', /Available in the current build/],
    ['/security', /explicit security boundaries/],
    ['/pricing', /Commercial pricing is not announced yet/],
    ['/docs', /Start with the workflow that exists today/],
  ];

  for (const [path, copy] of expectations) {
    browser.location.pathname = path;
    renderMarketingRoute(browser.document.querySelector('#app'), path);
    assert.match(browser.html(), copy, path);
    assert.ok(browser.document.querySelector('.mk-header'), path);
    assert.ok(browser.document.querySelector('.mk-footer'), path);
  }
});

test('the public design and authentication refinements load after the application styles', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/marketing.css', import.meta.url), 'utf8');
  const hero = fs.readFileSync(new URL('../public/brand-hero.js', import.meta.url), 'utf8');

  assert.ok(html.indexOf('/styles.css') < html.indexOf('/software-redesign.css'));
  assert.ok(html.indexOf('/software-redesign.css') < html.indexOf('/marketing.css'));
  assert.match(css, /\.login-hero > \.brand-lockup \.brand-logo\s*\{[^}]*width:\s*54px/s);
  assert.match(css, /\.login-card\s*\{[^}]*width:\s*min\(520px,\s*100%\)/s);
  assert.match(hero, /class="brand-lockup" href="\/"/);
  assert.match(hero, /KukGit v0\.2\.0 · Private alpha/);
});
