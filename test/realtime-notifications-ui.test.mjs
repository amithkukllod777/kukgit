import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * The notification socket, from the browser's side.
 *
 * A socket that reconnects is a request storm waiting to happen: the failure
 * mode is a server that refuses the connection and a tab that asks again
 * immediately, forever, for as long as somebody leaves it open. So the tests
 * are about when it does *not* reconnect — closed deliberately, offline, or
 * after the view it belonged to is gone.
 */

function page(t, { shell = true, unreadCount = 0 } = {}) {
  const browser = installBrowser({
    hash: '#/',
    html: shell
      ? '<div id="app"><div class="app-shell"><header class="topbar"><button id="kg-notification-button"><span class="kg-notification-count">0</span></button></header><main class="content"></main></div></div><div id="toast-root"></div>'
      : '<div id="app"><main class="login-page"></main></div><div id="toast-root"></div>',
    routes: {
      'GET /api/notifications': { body: { unreadCount, notifications: [] } },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  return browser;
}

test('a socket is opened for a signed-in view, at the right URL', async (t) => {
  const browser = page(t);
  await importFresh('../public/realtime-notifications-ui.js');
  await browser.settle();

  assert.equal(browser.sockets.length, 1);
  assert.match(browser.sockets[0].url, /^wss?:\/\/.*\/api\/notifications\/socket$/);
});

test('the sign-in page opens no socket at all', async (t) => {
  const browser = page(t, { shell: false });
  await importFresh('../public/realtime-notifications-ui.js');
  await browser.settle();

  // Nobody is signed in, so the connection can only be refused — and then
  // retried, and refused again.
  assert.deepEqual(browser.sockets, []);
});

test('an offline browser does not open one either', async (t) => {
  const browser = page(t);
  globalThis.navigator.onLine = false;
  t.after(() => { globalThis.navigator.onLine = true; });

  await importFresh('../public/realtime-notifications-ui.js');
  await browser.settle();

  assert.deepEqual(browser.sockets, []);
});

test('opening asks the server to resynchronise', async (t) => {
  const browser = page(t);
  await importFresh('../public/realtime-notifications-ui.js');
  await browser.settle();

  browser.sockets[0].open();
  await browser.settle();

  // Anything that happened while the tab was disconnected is invisible until
  // it asks. A socket that opens and waits shows a stale count until the next
  // event, which may be tomorrow.
  assert.deepEqual(browser.sockets[0].sent.map((raw) => JSON.parse(raw).type), ['resync']);
});

test('a snapshot updates the unread count on the bell', async (t) => {
  const browser = page(t);
  await importFresh('../public/realtime-notifications-ui.js');
  await browser.settle();

  browser.sockets[0].open();
  browser.sockets[0].message({ type: 'notifications.snapshot', unreadCount: 4 });
  await browser.settle();

  assert.match(browser.html(), /4/);
});

test('a message that is not about notifications is ignored', async (t) => {
  const browser = page(t);
  await importFresh('../public/realtime-notifications-ui.js');
  await browser.settle();

  browser.sockets[0].open();
  browser.sockets[0].message({ type: 'something.else', unreadCount: 99 });
  await browser.settle();

  // A count taken from any message that happens to carry the field is a count
  // that changes for reasons nobody can explain.
  assert.equal(browser.html().includes('99'), false);
});

test('malformed JSON does not take the socket down', async (t) => {
  const browser = page(t);
  await importFresh('../public/realtime-notifications-ui.js');
  await browser.settle();

  const socket = browser.sockets[0];
  socket.open();
  socket.message('{ this is not json');
  await browser.settle();

  // An unhandled throw inside the message handler would leave the socket up
  // and the module broken, which is the hardest kind of failure to notice.
  assert.equal(socket.closed, null);
  assert.equal(browser.sockets.length, 1);
});

test('an error closes the socket rather than leaving it half-open', async (t) => {
  const browser = page(t);
  await importFresh('../public/realtime-notifications-ui.js');
  await browser.settle();

  const socket = browser.sockets[0];
  socket.open();
  socket.fail();
  await browser.settle();

  // A socket in an error state that is never closed never fires `close`, so
  // nothing ever reconnects and the tab is silently deaf.
  assert.ok(socket.closed, 'the socket was left open after an error');
});

test('a drop while offline does not start a reconnection loop', async (t) => {
  const browser = page(t);
  await importFresh('../public/realtime-notifications-ui.js');
  await browser.settle();

  browser.sockets[0].open();
  globalThis.navigator.onLine = false;
  t.after(() => { globalThis.navigator.onLine = true; });
  browser.sockets[0].drop();
  await browser.settle();

  // This is the storm: a laptop that closed its lid, a tab that reconnects
  // every second until it is opened again.
  assert.equal(browser.sockets.length, 1);
});

test('a drop after the view is gone does not reconnect', async (t) => {
  const browser = page(t);
  await importFresh('../public/realtime-notifications-ui.js');
  await browser.settle();

  browser.sockets[0].open();
  // Signed out: the shell is replaced by the login page.
  browser.document.querySelector('#app').innerHTML = '<main class="login-page"></main>';
  browser.sockets[0].drop();
  await browser.settle();

  assert.equal(browser.sockets.length, 1);
});
