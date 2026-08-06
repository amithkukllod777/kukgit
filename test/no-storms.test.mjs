import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Every module in `public/`, checked for the one defect that keeps recurring.
 *
 * Three separate modules have shipped the same bug: a mutation observer whose
 * callback fetches, whose result changes the DOM, which wakes the observer. In
 * a browser that reads as forty requests in six seconds and ends at the rate
 * limiter. None of them was caught by a test; all three were found by opening
 * the site and watching the network panel.
 *
 * Writing behaviour tests for all twenty-five modules would be the thorough
 * answer and is not what this is. This is the cheap one: import each module
 * into a page, change the DOM under it, and assert it does not spiral. It says
 * nothing about whether a module works — only that it does not do the specific
 * thing that has broken the live site three times.
 *
 * A module added later is covered without anybody remembering to add it here,
 * which matters more than the depth of any single case. It found two more the
 * day it was written — the collaboration panel and the repository access panel
 * both refetched and appended another error card on every DOM change when
 * their load failed, the second at a hundred and twenty requests and a hundred
 * and twenty identical cards.
 *
 * **What it does not catch.** Reintroducing the collaboration panel's
 * success-path storm — fetching the organization list before the render-key
 * guard — still passes here, because a generic payload does not reproduce the
 * exact render that drives that loop. `test/ui-behaviour.test.mjs` catches that
 * one. Between them all four known storms are covered; neither file covers them
 * alone, and this one is a net rather than a proof.
 */

const SHELL = `<div id="app"><div class="app-shell">
  <aside class="sidebar"><div class="sidebar-section">Manage</div><nav class="nav"></nav></aside>
  <header class="topbar"><div class="topbar-actions"></div></header>
  <main class="content">
    <section id="kg-collaboration-panel" data-org="kuklabs"></section>
    <article data-kg-org-card="kuklabs"></article>
  </main>
</div></div><div id="toast-root"></div>`;

/**
 * The question is growth, not a number.
 *
 * A threshold has to be wrong in one direction. Two calls it a storm when
 * `git-lfs-ui` legitimately settles at three; three lets the collaboration
 * panel's storm through. Neither number is about the defect — the defect is
 * that the count never stops rising.
 *
 * So the page is churned twice, with a settle after each, and what is asserted
 * is that the second round of churn produced no new requests. A module that
 * has finished stays finished however much the DOM moves under it; a module in
 * a loop adds another turn every round, whatever its count happened to reach.
 */
const SETTLED_MEANS_NO_NEW_REQUESTS = 0;

const MODULES = fs.readdirSync(new URL('../public/', import.meta.url))
  .filter((name) => name.endsWith('.js'))
  .sort();

/**
 * One body that satisfies most renderers.
 *
 * An empty `{}` is not the success case — a module whose payload is missing
 * throws on `.length`, the catch swallows it, and nothing renders. Nothing
 * rendering means nothing wakes the observer, and the sweep passes for the
 * wrong reason. It has to carry enough for the common shapes to render, or the
 * second world tests nothing the first does not.
 */
const ANYTHING = {
  organizations: [{ id: 'org_1', slug: 'kuklabs', name: 'Kuklabs', role: 'owner', plan: 'free' }],
  organization: { id: 'org_1', slug: 'kuklabs', name: 'Kuklabs', role: 'owner', plan: 'free' },
  canManage: true,
  members: [], invitations: [], teams: [], repositories: [], campaigns: [], grants: [], history: [],
  notifications: [], unreadCount: 0, keys: [], webhooks: [], runs: [], checks: [], threads: [],
  events: [], auditLogs: [], issues: [], pulls: [], pullRequests: [], backups: [], objects: [],
  metrics: { repositories: 0, openIssues: 0, openPullRequests: 0, aiReviews: 0 },
  activity: [], user: { id: 'usr_1', email: 'amith@kuklabs.com', displayName: 'Amith' },
};

const NOTHING = { '*': { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found.' } } } };
const EVERYTHING = { '*': { body: ANYTHING } };

/**
 * Where to stand, as well as what to answer.
 *
 * The first version of this swept one route and passed everything. Most of
 * `public/` does nothing at all off its own page — a repository panel on the
 * organizations list returns before it fetches — so a single route exercises a
 * handful of modules and reports the rest as clean.
 *
 * That blind spot hid a live bug: `repository-access-ui` on a repository
 * settings page whose load failed asked a hundred and twenty times and stacked
 * a hundred and twenty identical error cards. It passed the one-route sweep
 * without ever running.
 */
const SCENARIOS = [
  ['nothing is there', '#/organizations', NOTHING],
  ['everything answers', '#/organizations', EVERYTHING],
  ['a repository page that fails', '#/repo/kuklabs/demo/settings', NOTHING],
  ['a repository page that loads', '#/repo/kuklabs/demo/settings', EVERYTHING],
  ['a pull request page that fails', '#/repo/kuklabs/demo/pull/1', NOTHING],
  ['account settings that fail', '#/settings', NOTHING],
];

test('public/ is discovered rather than listed', async () => {
  // A module added later must be covered without anybody remembering to add it
  // to a list, which is the whole reason this sweep exists.
  assert.ok(MODULES.length >= 20, `${MODULES.length} modules found`);
  assert.ok(MODULES.includes('app.js'));
});

for (const [scenario, hash, routes] of SCENARIOS) {
  for (const name of MODULES) {
    test(`${name} does not spiral on ${scenario}`, async (t) => {
      const page = installBrowser({ hash, html: SHELL, routes });
      t.after(() => page.restore());

      await importFresh(`../public/${name}`);
      await page.settle(40);

      // Something else on the page redrawing, which is what wakes every
      // observer in `public/`. Wherever the module left the page: `app.js`
      // replaces the whole shell on load, so the element churned into has to be
      // found after it has run, not before.
      const churn = () => {
        const target = page.document.querySelector('.content')
          ?? page.document.querySelector('#app')
          ?? page.document.documentElement;
        for (let round = 0; round < 6; round += 1) {
          target.insertAdjacentHTML('beforeend', `<div class="kg-churn">${round}</div>`);
        }
      };

      // Forty rounds, not twelve. One cycle of the loop is observer → two
      // animation frames → fetch → render → observer, which is several ticks;
      // with a dozen the storm has only turned twice and reads as normal.
      churn();
      await page.settle(40);
      const settled = page.calls.length;

      churn();
      await page.settle(40);

      const added = page.calls.length - settled;
      const [path, count] = page.busiest();
      assert.equal(added, SETTLED_MEANS_NO_NEW_REQUESTS,
        `${name} asked ${added} more time${added === 1 ? '' : 's'} after settling — ${count}× ${path}`);
      assert.equal(page.looped, false, `${name} never settled`);
    });
  }
}
