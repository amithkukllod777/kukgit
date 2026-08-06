import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Who can read and write a repository, from the browser's side.
 *
 * This screen grants and removes access. Two things about it are worth pinning:
 * it must send the permission that was chosen, and it must not offer controls
 * to somebody the server will refuse — a Remove button beside a name, shown to
 * a person who cannot remove anybody, is a support ticket with extra steps.
 *
 * The server decides, always. What is tested here is that the screen agrees
 * with what the server said rather than deciding for itself.
 */

const ROUTE = '#/repo/kuklabs/demo/settings';

function access(overrides = {}) {
  return {
    canManage: true,
    effectivePermission: 'admin',
    availablePermissions: ['read', 'triage', 'write', 'maintain', 'admin'],
    collaborators: [
      { userId: 'usr_2', displayName: 'Riya', email: 'riya@kuklabs.com', permission: 'write' },
    ],
    teamGrants: [
      { teamId: 'team_1', name: 'Platform', permission: 'maintain', memberCount: 4 },
    ],
    // The panel works out who can still be granted access by subtracting the
    // existing grants from the organization's members and teams, so both lists
    // have to be the full ones.
    members: [
      { id: 'usr_2', displayName: 'Riya', email: 'riya@kuklabs.com', organizationRole: 'maintainer' },
      { id: 'usr_3', displayName: 'Dev', email: 'dev@kuklabs.com', organizationRole: 'developer' },
    ],
    teams: [
      { id: 'team_1', name: 'Platform', memberCount: 4 },
      { id: 'team_2', name: 'Security', memberCount: 2 },
    ],
    permissionSources: [
      { type: 'organization', name: 'Kuklabs', role: 'owner', permission: 'admin' },
    ],
    ...overrides,
  };
}

function page(t, { data = access(), grant } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash: ROUTE,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/repository-access/kuklabs/demo': { body: data },
      'POST /api/repository-access/kuklabs/demo/collaborators': (request) => {
        sent.push({ to: 'collaborators', body: JSON.parse(request.init.body) });
        return grant ?? { status: 201, body: { ok: true } };
      },
      'POST /api/repository-access/kuklabs/demo/teams': (request) => {
        sent.push({ to: 'teams', body: JSON.parse(request.init.body) });
        return grant ?? { status: 201, body: { ok: true } };
      },
      'DELETE /api/repository-access/kuklabs/demo/collaborators/usr_2': () => {
        sent.push({ to: 'remove-collaborator' });
        return { body: { ok: true } };
      },
      'DELETE /api/repository-access/kuklabs/demo/teams/team_1': () => {
        sent.push({ to: 'remove-team' });
        return { body: { ok: true } };
      },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('the panel renders what the server said about access', async (t) => {
  const browser = page(t);
  await importFresh('../public/repository-access-ui.js');
  await browser.settle();

  const panel = browser.document.querySelector('#kg-repository-access-panel');
  assert.ok(panel, 'the panel is on the page');
  assert.match(panel.innerHTML, /Riya/);
  assert.match(panel.innerHTML, /Platform/);
  // The effective permission is the one number somebody comes to this page for.
  assert.match(panel.innerHTML, /admin/);
});

test('granting a collaborator sends the permission that was chosen', async (t) => {
  const browser = page(t);
  await importFresh('../public/repository-access-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-add-collaborator');
  form.querySelector('[name="permission"]').value = 'read';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  // Sending the default instead of the choice is handing somebody write access
  // to a repository when read was asked for.
  assert.deepEqual(browser.sent, [{ to: 'collaborators', body: { userId: 'usr_3', permission: 'read' } }]);
});

test('the permission the form starts on is write, deliberately', async (t) => {
  const browser = page(t);
  await importFresh('../public/repository-access-ui.js');
  await browser.settle();

  // Not admin. A form that defaults to the most powerful option grants it to
  // everybody who does not read the dropdown.
  assert.equal(browser.document.querySelector('#kg-add-collaborator [name="permission"]').value, 'write');
  assert.equal(browser.document.querySelector('#kg-add-team-grant [name="permission"]').value, 'write');
});

test('a team grant goes to the team endpoint with the team', async (t) => {
  const browser = page(t);
  await importFresh('../public/repository-access-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-add-team-grant');
  form.querySelector('[name="permission"]').value = 'maintain';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  assert.deepEqual(browser.sent, [{ to: 'teams', body: { teamId: 'team_2', permission: 'maintain' } }]);
});

test('somebody who cannot manage is offered nothing to press', async (t) => {
  const browser = page(t, { data: access({ canManage: false, effectivePermission: 'read' }) });
  await importFresh('../public/repository-access-ui.js');
  await browser.settle();

  const panel = browser.document.querySelector('#kg-repository-access-panel');
  // A Remove button beside a name, shown to somebody the server will refuse,
  // is a support ticket with extra steps.
  assert.equal(browser.document.querySelector('#kg-add-collaborator'), null);
  assert.equal(browser.document.querySelector('#kg-add-team-grant'), null);
  assert.equal(browser.document.querySelectorAll('.kg-remove-collaborator').length, 0);
  assert.equal(browser.document.querySelectorAll('.kg-remove-team-grant').length, 0);
  // And it says why, rather than looking broken.
  assert.match(panel.innerHTML, /Only users with effective Admin permission/);
});

test('removing access asks first, and cancelling means cancelled', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/repository-access-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-remove-collaborator').click();
  await browser.settle();

  assert.match(browser.confirmations.join(' '), /Remove the direct repository grant for Riya/);
  // Taking somebody's access away on a mis-click is not recoverable by undo.
  assert.deepEqual(browser.sent, []);
});

test('confirming a removal sends the delete', async (t) => {
  const browser = page(t);
  await importFresh('../public/repository-access-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-remove-collaborator').click();
  await browser.settle();
  assert.deepEqual(browser.sent.map((entry) => entry.to), ['remove-collaborator']);

  browser.document.querySelector('.kg-remove-team-grant').click();
  await browser.settle();
  assert.deepEqual(browser.sent.map((entry) => entry.to), ['remove-collaborator', 'remove-team']);
});

test('a refused grant says why and leaves the form usable', async (t) => {
  const browser = page(t, {
    grant: { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Only an organization admin may grant access.' } } },
  });
  await importFresh('../public/repository-access-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-add-collaborator');
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  assert.match(browser.html(), /Only an organization admin may grant access/);
  assert.equal(form.querySelector('button[type="submit"]').disabled, false);
});

test('the panel is not rendered off a repository settings page', async (t) => {
  const browser = page(t);
  browser.location.hash = '#/organizations';
  await importFresh('../public/repository-access-ui.js');
  await browser.settle();

  assert.equal(browser.document.querySelector('#kg-repository-access-panel'), null);
  assert.equal(browser.countPath('/api/repository-access/kuklabs/demo'), 0);
});

test('a refused load is shown once, not once per DOM change', async (t) => {
  const browser = page(t, { data: null });
  browser.location.hash = ROUTE;
  await importFresh('../public/repository-access-ui.js');
  await browser.settle(40);

  const content = browser.document.querySelector('.content');
  for (let round = 0; round < 6; round += 1) content.insertAdjacentHTML('beforeend', `<div>${round}</div>`);
  await browser.settle(40);

  // Measured at a hundred and twenty requests and a hundred and twenty
  // identical cards before the answer was remembered.
  assert.equal(browser.document.querySelectorAll('#kg-repository-access-error').length, 1);
  assert.ok(browser.countPath('/api/repository-access/kuklabs/demo') <= 2, `asked ${browser.countPath('/api/repository-access/kuklabs/demo')} times`);
});
