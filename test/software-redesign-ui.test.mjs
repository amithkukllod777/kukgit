import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

const USER = { id: 'usr_1', email: 'amit@kuklabs.com', displayName: 'Amit Kumar Kuklod' };
const ORGANIZATIONS = [{ id: 'org_1', slug: 'kuklabs', name: 'Kuklabs', role: 'owner' }];

function browser(hash = '#/', overrides = {}) {
  return installBrowser({
    hash,
    html: '<div id="app"></div><div id="toast-root"></div>',
    routes: {
      '/api/auth/me': { body: { user: USER, organizations: ORGANIZATIONS } },
      '/api/dashboard': { body: { metrics: { repositories: 1, openIssues: 2, openPulls: 3, aiHealth: 82 }, repositories: [], activity: [] } },
      '/api/repos': { body: { repositories: [] } },
      '/api/issues': { body: { issues: [] } },
      '/api/pulls': { body: { pullRequests: [] } },
      '/api/orgs': { body: { organizations: ORGANIZATIONS } },
      '/api/audit': { body: { auditLogs: [] } },
      '*': { body: {} },
      ...overrides,
    },
  });
}

test('the redesigned shell is light-first and keeps deliberate mobile navigation in the markup', async (t) => {
  const page = browser();
  t.after(() => page.restore());

  await importFresh('../public/app.js');
  await page.settle();

  assert.equal(page.document.documentElement.dataset.theme, 'light');
  assert.ok(page.document.querySelector('.workspace-switcher'));
  assert.ok(page.document.querySelector('.mobile-bottom-nav'));
  assert.ok(page.document.querySelector('#command-trigger'));
  assert.ok(page.document.querySelector('#theme-toggle'));
  assert.match(page.html(), /Good (morning|afternoon|evening), Amit/);
});

test('the theme switch changes the document theme without navigating', async (t) => {
  const page = browser();
  t.after(() => page.restore());

  await importFresh('../public/app.js');
  await page.settle();
  page.document.querySelector('#theme-toggle').click();

  assert.equal(page.document.documentElement.dataset.theme, 'dark');
  assert.equal(page.location.hash, '#/');
});

test('the command menu exposes the product routes and closes after navigation', async (t) => {
  const page = browser();
  t.after(() => page.restore());

  await importFresh('../public/app.js');
  await page.settle();
  page.document.querySelector('#command-trigger').click();

  const palette = page.document.querySelector('#command-palette');
  assert.ok(palette);
  assert.match(palette.innerHTML, /Organizations &amp; teams/);
  palette.querySelector('[data-command-route="#\/issues"]').click();
  await page.settle();

  assert.equal(page.location.hash, '#/issues');
  assert.equal(page.document.querySelector('#command-palette'), null);
});

test('account settings use section navigation instead of a wall of cards', async (t) => {
  const page = browser('#/settings');
  t.after(() => page.restore());

  await importFresh('../public/app.js');
  await page.settle();

  assert.ok(page.document.querySelector('.settings-layout'));
  assert.ok(page.document.querySelector('.settings-nav'));
  assert.ok(page.document.querySelector('#account-profile'));
  assert.ok(page.document.querySelector('#account-appearance'));
  assert.ok(page.document.querySelector('#settings-sign-out'));
});

test('repository settings collect feature panels under one left navigation', async (t) => {
  const page = browser('#/repo/kuklabs/demo/settings', {
    '/api/repos/kuklabs/demo': { body: { repository: { name: 'Demo', description: 'Test repository', visibility: 'private', defaultBranch: 'main', cloneUrl: 'http://example.test/git/kuklabs/demo.git', openIssues: 0, openPulls: 0 } } },
  });
  t.after(() => page.restore());

  await importFresh('../public/app.js');
  await page.settle();
  const latePanel = page.document.createElement('section');
  latePanel.id = 'kg-governance-panel';
  latePanel.className = 'card';
  page.document.querySelector('.content').append(latePanel);
  await page.settle();

  assert.ok(page.document.querySelector('.repo-settings-nav'));
  assert.equal(page.document.querySelector('#repo-settings-content #kg-governance-panel')?.id, 'kg-governance-panel');
});

test('the late redesign stylesheet is loaded after feature modules', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const feature = html.indexOf('/issue-thread-ui.js');
  const redesign = html.indexOf('/software-redesign.css');
  assert.ok(feature >= 0 && redesign > feature);
});
