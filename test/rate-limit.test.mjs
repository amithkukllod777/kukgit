import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../src/config.mjs';
import { runWithRequestIdentity } from '../src/identity-context.mjs';
import {
  clientAddress,
  createRateLimitGuard,
  createTokenBucketStore,
  surfaceForRequest,
} from '../src/rate-limit.mjs';

function configWith(overrides = {}) {
  return loadConfig({ nodeEnv: 'test', baseUrl: 'http://127.0.0.1:8787', ...overrides });
}

// A store with a clock we control, so refill behaviour is asserted deterministically
// rather than by sleeping.
function controllableStore() {
  let clock = 0;
  const store = createTokenBucketStore({ now: () => clock });
  return { store, advance: (ms) => { clock += ms; }, set: (ms) => { clock = ms; } };
}

test('the token bucket spends a burst then holds the caller to the sustained rate', () => {
  const { store, advance } = controllableStore();
  const perMinute = 60;
  const refillPerMs = perMinute / 60000; // one token per second
  const burst = 5;

  for (let i = 0; i < burst; i += 1) {
    assert.equal(store.take('k', burst, refillPerMs).allowed, true, `burst token ${i + 1}`);
  }

  // Burst spent: the next request is refused and told when to come back.
  const refused = store.take('k', burst, refillPerMs);
  assert.equal(refused.allowed, false);
  assert.equal(refused.remaining, 0);
  assert.ok(refused.retryAfterSeconds >= 1);

  // One second of refill buys exactly one more request, not a fresh burst.
  advance(1000);
  assert.equal(store.take('k', burst, refillPerMs).allowed, true);
  assert.equal(store.take('k', burst, refillPerMs).allowed, false);
});

test('refill is capped at the burst size, so idling does not bank an unlimited allowance', () => {
  const { store, advance } = controllableStore();
  const refillPerMs = 60 / 60000;
  const burst = 5;

  store.take('k', burst, refillPerMs);
  advance(60 * 60 * 1000); // idle for an hour

  for (let i = 0; i < burst; i += 1) {
    assert.equal(store.take('k', burst, refillPerMs).allowed, true, `token ${i + 1} after idling`);
  }
  assert.equal(store.take('k', burst, refillPerMs).allowed, false, 'no more than one burst is banked');
});

test('buckets are keyed independently and idle ones are swept', () => {
  const { store, advance } = controllableStore();
  const refillPerMs = 60 / 60000;

  store.take('a', 1, refillPerMs);
  store.take('b', 1, refillPerMs);
  assert.equal(store.take('a', 1, refillPerMs).allowed, false);
  assert.equal(store.take('b', 1, refillPerMs).allowed, false, 'b has its own bucket');
  assert.equal(store.size(), 2);

  advance(11 * 60 * 1000);
  store.sweep();
  assert.equal(store.size(), 0, 'idle buckets are evicted');
});

test('surfaces are classified so the abusable paths get their own budget', () => {
  assert.equal(surfaceForRequest('POST', '/api/auth/login'), 'auth');
  assert.equal(surfaceForRequest('POST', '/api/auth/otp/request'), 'auth');
  assert.equal(surfaceForRequest('POST', '/api/auth/google'), 'auth');
  // Logout is not a brute-force surface; it should not share the tight auth budget.
  assert.equal(surfaceForRequest('POST', '/api/auth/logout'), 'api');

  assert.equal(surfaceForRequest('GET', '/git/kuklabs/demo.git/info/refs'), 'git');
  assert.equal(surfaceForRequest('POST', '/api/collaboration/orgs/kuklabs/invitations'), 'invitation');
  assert.equal(surfaceForRequest('POST', '/api/repository-invitations/kuklabs/demo'), 'invitation');
  assert.equal(surfaceForRequest('POST', '/api/webhooks/kuklabs/demo'), 'webhook');

  // Reads of an invitation or webhook list are ordinary API traffic.
  assert.equal(surfaceForRequest('GET', '/api/webhooks/kuklabs/demo'), 'api');
  // Static assets and the health check are not limited at all.
  assert.equal(surfaceForRequest('GET', '/'), null);
  assert.equal(surfaceForRequest('GET', '/styles.css'), null);
});

test('X-Forwarded-For is ignored unless a trusted proxy is configured', () => {
  const req = {
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    socket: { remoteAddress: '10.0.0.5' },
  };
  // Default: the header is attacker-controlled, so the socket address wins.
  // Honouring it by default would let a caller mint a new identity per request.
  assert.equal(clientAddress(req, { trustProxy: false }), '10.0.0.5');
  assert.equal(clientAddress(req, { trustProxy: true }), '203.0.113.9');
  assert.equal(clientAddress({ headers: {}, socket: {} }, { trustProxy: true }), 'unknown');
});

// Drives the guard through a real server so headers and the 429 body are asserted
// as a client would see them.
function guardServer(t, config, { identity = null } = {}) {
  const guard = createRateLimitGuard({
    config,
    next: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return true;
    },
  });
  t.after(() => guard.stop());
  const server = http.createServer((req, res) => {
    if (identity) return runWithRequestIdentity(identity, () => guard(req, res));
    return guard(req, res);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('an exhausted surface answers 429 with Retry-After and RateLimit headers', async (t) => {
  const config = configWith({ rateLimitAuthPerMinute: 60, rateLimitAuthBurst: 2 });
  const port = await guardServer(t, config);
  const url = `http://127.0.0.1:${port}/api/auth/login`;

  const first = await fetch(url, { method: 'POST' });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('ratelimit-limit'), '60');
  assert.equal(first.headers.get('ratelimit-remaining'), '1');

  assert.equal((await fetch(url, { method: 'POST' })).status, 200);

  const refused = await fetch(url, { method: 'POST' });
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  assert.equal(refused.headers.get('ratelimit-remaining'), '0');
  const body = await refused.json();
  assert.equal(body.error.code, 'RATE_LIMITED');
  assert.equal(body.error.surface, 'auth');
});

test('surfaces do not share a budget', async (t) => {
  const config = configWith({
    rateLimitAuthPerMinute: 60, rateLimitAuthBurst: 1,
    rateLimitApiPerMinute: 600, rateLimitApiBurst: 50,
  });
  const port = await guardServer(t, config);

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST' })).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST' })).status, 429);

  // Exhausting auth must not lock the caller out of the rest of the product.
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/dashboard`)).status, 200);
});

test('unlimited surfaces and a disabled limiter pass straight through', async (t) => {
  const port = await guardServer(t, configWith({ rateLimitAuthPerMinute: 60, rateLimitAuthBurst: 1 }));
  // Static assets carry no surface, so no amount of them is limited.
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await fetch(`http://127.0.0.1:${port}/styles.css`)).status, 200);
  }

  const offPort = await guardServer(t, configWith({ rateLimitEnabled: false, rateLimitAuthBurst: 1 }));
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await fetch(`http://127.0.0.1:${offPort}/api/auth/login`, { method: 'POST' })).status, 200);
  }
});

test('an authenticated caller is limited as a person, not as an address', async (t) => {
  const config = configWith({ rateLimitApiPerMinute: 600, rateLimitApiBurst: 1 });

  const alicePort = await guardServer(t, config, {
    identity: { mode: 'authkit', user: { id: 'usr_alice' } },
  });
  assert.equal((await fetch(`http://127.0.0.1:${alicePort}/api/dashboard`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${alicePort}/api/dashboard`)).status, 429);

  // A different account from the same address keeps its own allowance, so one
  // abusive user cannot throttle everyone behind a shared egress address.
  const bobPort = await guardServer(t, config, {
    identity: { mode: 'authkit', user: { id: 'usr_bob' } },
  });
  assert.equal((await fetch(`http://127.0.0.1:${bobPort}/api/dashboard`)).status, 200);
});

test('distinct credentials on Git HTTP get distinct buckets and the secret never enters the key', async (t) => {
  const config = configWith({ rateLimitGitPerMinute: 60, rateLimitGitBurst: 1 });
  const guard = createRateLimitGuard({
    config,
    next: (req, res) => { res.writeHead(200); res.end('ok'); return true; },
  });
  t.after(() => guard.stop());
  const server = http.createServer((req, res) => guard(req, res));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

  const clone = (token) => fetch(`http://127.0.0.1:${port}/git/kuklabs/demo.git/info/refs`, {
    headers: { Authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}` },
  });

  assert.equal((await clone('kgp_first')).status, 200);
  assert.equal((await clone('kgp_first')).status, 429, 'the same token shares one bucket');
  assert.equal((await clone('kgp_second')).status, 200, 'a different token has its own bucket');

  // The bucket keys are derived from a hash; no credential material is retained.
  const keys = [...guard.store.keys?.() ?? []];
  for (const key of keys) {
    assert.ok(!key.includes('kgp_'), 'token plaintext must never appear in a key');
  }
});
