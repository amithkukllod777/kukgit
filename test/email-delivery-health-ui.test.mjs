import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Email suppressions, from the browser's side.
 *
 * A suppression exists because a provider told us an address bounced or somebody
 * marked KukGit as spam. Lifting one starts sending to that address again — to a
 * mailbox that may not exist, or a person who asked us to stop — and doing that
 * enough times is how a sending domain's reputation goes. So the screen makes
 * somebody type the address and write down why, and neither is optional.
 */

const ROUTE = '#/instance-admin/email-health';

function suppressions(overrides = {}) {
  return {
    // The counters at the top of the screen come with the list, not from
    // counting it — a fixture without them renders an error where the page
    // should be.
    stats: { active: 1, hardBounces: 1, complaints: 0, softBounceSuppressions: 0 },
    suppressions: [
      {
        email: 'gone@example.com',
        provider: 'resend',
        providerEventId: 'evt_1',
        reason: 'hard_bounce',
        suppressedAt: '2026-08-01T00:00:00.000Z',
        expiresAt: null,
        softBounceCount: 0,
      },
    ],
    ...overrides,
  };
}

function page(t, { data = suppressions(), events = { events: [] }, unsuppress } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash: ROUTE,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/email-provider/admin/events': { body: events },
      'GET /api/email-provider/admin/suppressions': { body: data },
      // The address is percent-encoded into the path, so the route key is too.
      'POST /api/email-provider/admin/suppressions/gone%40example.com/unsuppress': (request) => {
        sent.push({ to: 'unsuppress', body: JSON.parse(request.init.body) });
        return unsuppress ?? { body: data };
      },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('a suppression is shown with its reason and where it came from', async (t) => {
  const browser = page(t);
  await importFresh('../public/email-delivery-health-ui.js');
  await browser.settle();

  assert.match(browser.html(), /gone@example\.com/);
  // "Suppressed" without the reason gives somebody no way to judge whether it
  // is safe to lift.
  assert.match(browser.html(), /hard_bounce/);
  assert.match(browser.html(), /resend/);
});

test('a suppression with no expiry says it needs a review, not "never"', async (t) => {
  const browser = page(t);
  await importFresh('../public/email-delivery-health-ui.js');
  await browser.settle();
  assert.match(browser.html(), /only after reviewed unsuppress/);
});

test('cancelling the address prompt changes nothing', async (t) => {
  const browser = page(t);
  browser.promptAnswers = [null];
  await importFresh('../public/email-delivery-health-ui.js');
  await browser.settle();

  browser.document.querySelector('[data-email-unsuppress]').click();
  await browser.settle();

  assert.match(browser.prompts.join(' '), /Type the exact email address/);
  assert.deepEqual(browser.sent, []);
});

test('cancelling the reason prompt changes nothing either', async (t) => {
  const browser = page(t);
  browser.promptAnswers = ['gone@example.com', null];
  await importFresh('../public/email-delivery-health-ui.js');
  await browser.settle();

  browser.document.querySelector('[data-email-unsuppress]').click();
  await browser.settle();

  // Somebody who typed the address and then thought better of it has not
  // agreed to anything.
  assert.match(browser.prompts.join(' '), /Document why delivery is safe to resume/);
  assert.deepEqual(browser.sent, []);
});

test('a completed review sends the typed address and the note', async (t) => {
  const browser = page(t);
  browser.promptAnswers = ['gone@example.com', 'Recipient confirmed the mailbox is back.'];
  await importFresh('../public/email-delivery-health-ui.js');
  await browser.settle();

  browser.document.querySelector('[data-email-unsuppress]').click();
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'unsuppress');
  assert.ok(sent, 'nothing was sent');
  // Both, and both as typed: the address proves somebody read which one they
  // were lifting, and the note is the record of why.
  assert.equal(sent.body.confirmEmail, 'gone@example.com');
  assert.match(sent.body.note, /Recipient confirmed/);
});

test('a refused unsuppress says why and gives the button back', async (t) => {
  const browser = page(t, { unsuppress: { status: 422, body: { error: { message: 'The note must be at least 3 characters.' } } } });
  browser.promptAnswers = ['gone@example.com', 'ok'];
  await importFresh('../public/email-delivery-health-ui.js');
  await browser.settle();

  browser.document.querySelector('[data-email-unsuppress]').click();
  await browser.settle();

  assert.match(browser.html(), /at least 3 characters/);
  assert.equal(browser.document.querySelector('[data-email-unsuppress]').disabled, false);
});

test('an instance with nothing suppressed says so', async (t) => {
  const browser = page(t, { data: suppressions({ suppressions: [], stats: { active: 0, hardBounces: 0, complaints: 0, softBounceSuppressions: 0 } }) });
  await importFresh('../public/email-delivery-health-ui.js');
  await browser.settle();
  // Named exactly. `/empty/i` also matches the loading placeholder's class
  // name, so it passed while the page was rendering an error.
  assert.match(browser.html(), /No matching email suppression/);
});

test('the screen renders nowhere but its own route', async (t) => {
  const browser = installBrowser({
    hash: '#/settings',
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: { '*': { status: 404, body: { error: { message: 'Not found.' } } } },
  });
  t.after(() => browser.restore());
  await importFresh('../public/email-delivery-health-ui.js');
  await browser.settle();

  // An instance-administrator screen that also loads on everybody's settings
  // page is a 403 per visit for every ordinary account.
  assert.deepEqual(browser.requests(), []);
});
