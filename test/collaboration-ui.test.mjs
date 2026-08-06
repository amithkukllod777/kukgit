import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Teams and invitations, from the browser's side.
 *
 * An invitation link is a credential: whoever holds it joins the organization.
 * It is shown once and never again, so the screen has to display it and must
 * not put it anywhere that survives — and revoking one, or removing somebody
 * from a team, has to be a deliberate act rather than a mis-click.
 */

const ROUTE = '#/organizations';
const ACCEPTANCE = 'https://git.kuklabs.com/invite/kgi_LiveTokenNobodyMaySeeTwice';

function organizations() {
  return { organizations: [{ id: 'org_1', slug: 'kuklabs', name: 'Kuklabs Inc.', role: 'owner' }] };
}

function collaboration(overrides = {}) {
  return {
    organization: { id: 'org_1', slug: 'kuklabs', name: 'Kuklabs Inc.' },
    canManage: true,
    members: [
      { id: 'user_1', displayName: 'Amit', email: 'amit@kuklabs.com', organizationRole: 'owner' },
      { id: 'user_2', displayName: 'Priya', email: 'priya@kuklabs.com', organizationRole: 'developer' },
    ],
    teams: [
      {
        id: 'team_1',
        name: 'Platform',
        slug: 'platform',
        description: 'Owns the platform',
        members: [{ id: 'user_2', displayName: 'Priya', email: 'priya@kuklabs.com', teamRole: 'member', organizationRole: 'developer' }],
      },
    ],
    invitations: [
      { id: 'inv_1', email: 'new@example.com', role: 'developer', status: 'pending', expiresAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' },
    ],
    ...overrides,
  };
}

function page(t, { data = collaboration(), invite } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash: ROUTE,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/orgs': { body: organizations() },
      'GET /api/collaboration/orgs/kuklabs': { body: data },
      'POST /api/collaboration/orgs/kuklabs/invitations': (request) => {
        sent.push({ to: 'invite', body: JSON.parse(request.init.body) });
        return invite ?? { status: 201, body: { invitation: { id: 'inv_2', acceptanceUrl: ACCEPTANCE } } };
      },
      'DELETE /api/collaboration/orgs/kuklabs/invitations/inv_1': () => { sent.push({ to: 'revoke-invitation' }); return { body: data }; },
      'POST /api/collaboration/orgs/kuklabs/teams': (request) => {
        sent.push({ to: 'create-team', body: JSON.parse(request.init.body) });
        return { status: 201, body: data };
      },
      'DELETE /api/collaboration/orgs/kuklabs/teams/team_1': () => { sent.push({ to: 'delete-team' }); return { body: data }; },
      'POST /api/collaboration/orgs/kuklabs/teams/team_1/members': (request) => {
        sent.push({ to: 'add-member', body: JSON.parse(request.init.body) });
        return { body: data };
      },
      'DELETE /api/collaboration/orgs/kuklabs/teams/team_1/members/user_2': () => { sent.push({ to: 'remove-member' }); return { body: data }; },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('members, teams and pending invitations are on the page', async (t) => {
  const browser = page(t);
  await importFresh('../public/collaboration-ui.js');
  await browser.settle();

  assert.match(browser.html(), /Platform/);
  assert.match(browser.html(), /new@example\.com/);
  assert.match(browser.html(), /Priya/);
});

test('an invitation link is shown once, and the list never carries it', async (t) => {
  const browser = page(t);
  await importFresh('../public/collaboration-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-create-invitation');
  form.querySelector('[name="email"]').value = 'new@example.com';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  assert.equal(browser.document.querySelector('#kg-invitation-url')?.textContent, ACCEPTANCE);
  assert.match(browser.html(), /shown only in this response/);
  // The link is a credential. Anything that re-renders the list from the server
  // must not bring it back, because the server does not have it to give.
  assert.equal(browser.document.querySelector('#kg-invitation-list').innerHTML.includes('LiveToken'), false);
});

test('an invitation carries the role and expiry that were chosen', async (t) => {
  const browser = page(t);
  await importFresh('../public/collaboration-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-create-invitation');
  form.querySelector('[name="email"]').value = 'new@example.com';
  form.querySelector('[name="role"]').value = 'maintainer';
  form.querySelector('[name="expiresInDays"]').value = '7';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'invite');
  // An invitation that quietly grants a different role than the one on screen
  // is how somebody ends up an owner.
  assert.equal(sent.body.role, 'maintainer');
  assert.equal(Number(sent.body.expiresInDays), 7);
});

test('revoking an invitation asks first', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/collaboration-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-revoke-invite').click();
  await browser.settle();

  assert.match(browser.confirmations.join(' '), /Revoke this pending invitation/);
  assert.deepEqual(browser.sent, []);
});

test('removing somebody from a team asks first', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/collaboration-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-remove-team-member')?.click();
  await browser.settle();

  assert.match(browser.confirmations.join(' '), /Remove this member from the team/);
  assert.deepEqual(browser.sent, []);
});

test('deleting a team asks, and says what it does not affect', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/collaboration-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-delete-team')?.click();
  await browser.settle();

  // Somebody deleting a team needs to know their colleagues are not being
  // removed from the organization along with it.
  assert.match(browser.confirmations.join(' '), /Organization membership will not be affected/);
  assert.deepEqual(browser.sent, []);
});

test('somebody who cannot manage the organization gets no forms', async (t) => {
  const browser = page(t, { data: collaboration({ canManage: false }) });
  await importFresh('../public/collaboration-ui.js');
  await browser.settle();

  assert.equal(browser.present('#kg-create-invitation'), false);
  assert.equal(browser.present('#kg-create-team'), false);
  // The teams are still visible — seeing who you work with is not a management
  // privilege.
  assert.match(browser.html(), /Platform/);
});

test('a failed load is not retried on every render', async (t) => {
  const browser = installBrowser({
    hash: ROUTE,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/orgs': { status: 500, body: { error: { message: 'Something went wrong.' } } },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  await importFresh('../public/collaboration-ui.js');
  await browser.settle();

  const before = browser.requests().length;
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('beforeend', `<p>render ${round}</p>`);
    await browser.settle();
  }
  // Showing the failure is itself a DOM change, which wakes the observer. This
  // is the loop that once appended forty copies of the same error.
  assert.equal(browser.requests().length, before);
  assert.equal(browser.document.querySelectorAll('#kg-collaboration-error').length, 1);
});

test('an already-rendered panel is not re-fetched on every DOM change', async (t) => {
  const browser = page(t);
  await importFresh('../public/collaboration-ui.js');
  await browser.settle();

  const before = browser.requests().length;
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('beforeend', `<p>render ${round}</p>`);
    await browser.settle();
  }
  // The guard runs before the fetch, not after it: asking first and skipping
  // the render afterwards is still a request per DOM change.
  assert.equal(browser.requests().length, before);
});
