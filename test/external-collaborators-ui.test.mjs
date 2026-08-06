import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * External collaborators, from the browser's side.
 *
 * This is the screen that lets somebody outside the organization into exactly
 * one repository. Getting the boundary wrong in either direction is bad: too
 * wide and a contractor can read everything, too narrow and they cannot do the
 * work they were hired for. And the invitation link is a credential shown once.
 */

const SETTINGS = '#/repo/kuklabs/demo/settings';
const LINK = 'https://git.kuklabs.com/repo-invite/kgr_LiveTokenNobodyMaySeeTwice';

function access(overrides = {}) {
  return {
    repository: { orgSlug: 'kuklabs', slug: 'demo' },
    canManage: true,
    collaborators: [
      // `isExternal` is what marks somebody as a repository-only collaborator
      // rather than an organization member who also has access; the screen
      // filters on it, so a fixture without it lists nobody.
      { userId: 'user_9', displayName: 'Contractor', email: 'contractor@example.com', permission: 'write', isExternal: true, addedAt: '2026-08-01T00:00:00.000Z' },
    ],
    ...overrides,
  };
}

function invitations(overrides = {}) {
  return {
    canManage: true,
    invitations: [
      { id: 'rinv_1', email: 'client@example.com', permission: 'read', status: 'pending', expiresAt: '2026-09-01T00:00:00.000Z' },
    ],
    ...overrides,
  };
}

function page(t, { hash = SETTINGS, accessData = access(), inviteData = invitations(), create } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/repository-access/kuklabs/demo': { body: accessData },
      'GET /api/repository-invitations/kuklabs/demo': { body: inviteData },
      'POST /api/repository-invitations/kuklabs/demo': (request) => {
        sent.push({ to: 'invite', body: JSON.parse(request.init.body) });
        return create ?? { status: 201, body: { invitation: { id: 'rinv_2', acceptanceUrl: LINK } } };
      },
      'POST /api/repository-invitations/kuklabs/demo/rinv_1/resend': () => { sent.push({ to: 'resend' }); return { body: { invitation: { acceptanceUrl: LINK } } }; },
      'POST /api/repository-invitations/kuklabs/demo/rinv_1/revoke': () => { sent.push({ to: 'revoke' }); return { body: inviteData }; },
      'DELETE /api/repository-access/kuklabs/demo/collaborators/user_9': () => { sent.push({ to: 'remove' }); return { body: accessData }; },
      'DELETE /api/repository-invitations/kuklabs/demo/collaborators/user_9': () => { sent.push({ to: 'remove' }); return { body: accessData }; },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('the access boundary is stated on the screen, not assumed', async (t) => {
  const browser = page(t);
  await importFresh('../public/external-collaborators-ui.js');
  await browser.settle();

  // Somebody inviting a contractor needs to know what they are and are not
  // handing over, before they send it rather than after.
  assert.match(browser.html(), /repository access only|Acceptance grants repository access only/);
});

test('an invitation carries the permission and expiry that were chosen', async (t) => {
  const browser = page(t);
  await importFresh('../public/external-collaborators-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-create-repository-invitation');
  form.querySelector('[name="email"]').value = 'client@example.com';
  form.querySelector('[name="permission"]').value = 'write';
  form.querySelector('[name="expiresInDays"]').value = '7';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'invite');
  // An invitation that silently grants more than the screen said is how a
  // contractor ends up able to push to main.
  assert.equal(sent.body.permission, 'write');
  assert.equal(Number(sent.body.expiresInDays), 7);
});

test('the invitation link is shown once', async (t) => {
  const browser = page(t);
  await importFresh('../public/external-collaborators-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-create-repository-invitation');
  form.querySelector('[name="email"]').value = 'client@example.com';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  assert.equal(browser.document.querySelector('#kg-repository-invitation-url')?.textContent, LINK);
  assert.match(browser.html(), /One-time repository invitation link/);
});

test('resending revokes the old link, and says so before doing it', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/external-collaborators-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-resend-repo-invite')?.click();
  await browser.settle();

  // Somebody who has already forwarded the first link needs to know it is about
  // to stop working.
  assert.match(browser.confirmations.join(' '), /Revoke the old link/);
  assert.deepEqual(browser.sent, []);
});

test('revoking an invitation asks first', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/external-collaborators-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-revoke-repo-invite')?.click();
  await browser.settle();

  assert.match(browser.confirmations.join(' '), /Revoke this repository invitation link/);
  assert.deepEqual(browser.sent, []);
});

test('removing access names the person it is removing', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/external-collaborators-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-remove-external-collaborator')?.click();
  await browser.settle();

  // "Remove access?" with no name is a confirmation that cannot be checked
  // against what somebody meant to click.
  assert.match(browser.confirmations.join(' '), /Remove repository access for Contractor/);
  assert.deepEqual(browser.sent, []);
});

test('somebody who cannot manage access gets no invitation form', async (t) => {
  const browser = page(t, { accessData: access({ canManage: false }), inviteData: invitations({ canManage: false }) });
  await importFresh('../public/external-collaborators-ui.js');
  await browser.settle();

  assert.equal(browser.present('#kg-create-repository-invitation'), false);
});

test('a repository nobody may administer is asked for once, not forever', async (t) => {
  const browser = installBrowser({
    hash: SETTINGS,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/repository-access/kuklabs/demo': { status: 403, body: { error: { message: 'Repository admin permission is required.' } } },
      'GET /api/repository-invitations/kuklabs/demo': { status: 403, body: { error: { message: 'Forbidden.' } } },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  await importFresh('../public/external-collaborators-ui.js');
  await browser.settle();

  const before = browser.requests().length;
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('beforeend', `<p>render ${round}</p>`);
    await browser.settle();
  }
  // One of the five modules that had this defect. The fix is the reason the
  // count stops here.
  assert.equal(browser.requests().length, before);
});
