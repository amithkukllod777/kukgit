import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createDrainState,
  createRequestTracker,
  drainAndClose,
} from '../src/graceful-shutdown.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// A server whose handler can be held open, so a test can have a request
// genuinely in flight while the shutdown runs.
async function serverWith(t, handler) {
  const tracker = createRequestTracker({ next: handler });
  const server = http.createServer(tracker);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, tracker, port: server.address().port };
}

test('an in-flight request finishes before the listener closes', async (t) => {
  const held = deferred();
  const { server, tracker, port } = await serverWith(t, async (req, res) => {
    if (req.url === '/slow') {
      await held.promise;
      res.writeHead(200); res.end('completed');
      return;
    }
    res.writeHead(200); res.end('fast');
  });

  const inFlight = fetch(`http://127.0.0.1:${port}/slow`);
  // Wait until the handler has actually been entered.
  while (tracker.inFlight().total === 0) await new Promise((r) => setTimeout(r, 5));

  const steps = [];
  const shutdown = drainAndClose(server, {
    tracker,
    readinessDelayMs: 0,
    requestDrainMs: 5000,
    gitDrainMs: 5000,
    onStep: ({ step }) => steps.push(step),
  });

  // Still running: cutting it off here is exactly what a rollout must not do.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(tracker.inFlight().total, 1);
  held.resolve();

  const response = await inFlight;
  assert.equal(await response.text(), 'completed');
  const result = await shutdown;
  assert.equal(result.apiDrained, true);
  assert.deepEqual(steps, ['readiness_failing', 'closing_listener', 'api_drained', 'git_drained']);
});

test('readiness fails before the listener closes, not after', async (t) => {
  const drainState = createDrainState();
  const { server, tracker, port } = await serverWith(t, (req, res) => {
    if (req.url === '/ready') {
      res.writeHead(drainState.isDraining() ? 503 : 200); res.end();
      return;
    }
    res.writeHead(200); res.end('ok');
  });

  const probe = async () => (await fetch(`http://127.0.0.1:${port}/ready`)).status;
  assert.equal(await probe(), 200);

  const shutdown = drainAndClose(server, {
    tracker, drainState, readinessDelayMs: 300, requestDrainMs: 1000, gitDrainMs: 1000,
  });

  // The window that makes a rollout invisible: not ready, but still serving. If
  // the socket closed first, the load balancer would still be sending traffic
  // into a closed port and the user would see a 502.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await probe(), 503);
  assert.equal((await fetch(`http://127.0.0.1:${port}/work`)).status, 200, 'still serving while not ready');

  await shutdown;
  await assert.rejects(fetch(`http://127.0.0.1:${port}/work`), 'the listener is closed once draining finishes');
});

test('a Git transfer gets a longer budget than an API request', async (t) => {
  const heldGit = deferred();
  const { server, tracker, port } = await serverWith(t, async (req, res) => {
    if (req.url.startsWith('/git/')) { await heldGit.promise; res.writeHead(200); res.end('pack'); return; }
    res.writeHead(200); res.end('api');
  });

  const clone = fetch(`http://127.0.0.1:${port}/git/kuklabs/app.git/info/refs`);
  while (tracker.inFlight().git === 0) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(tracker.inFlight(), { api: 0, git: 1, total: 1 });

  const steps = [];
  const shutdown = drainAndClose(server, {
    tracker,
    readinessDelayMs: 0,
    // The API budget expires immediately and the Git one does not. A clone of a
    // large repository takes minutes, and giving every request that budget would
    // make an ordinary rollout take minutes too.
    requestDrainMs: 20,
    gitDrainMs: 5000,
    onStep: ({ step, drained }) => steps.push(`${step}:${drained ?? ''}`),
  });

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(tracker.inFlight().git, 1, 'the transfer is still running after the API budget expired');
  heldGit.resolve();
  await clone;

  const result = await shutdown;
  assert.equal(result.gitDrained, true);
  assert.ok(steps.includes('api_drained:true'), 'no API requests were outstanding');
});

test('a client that disconnects mid-response does not block shutdown', async (t) => {
  const { server, tracker, port } = await serverWith(t, async (req, res) => {
    res.writeHead(200);
    res.write('partial');
    // Never ends. The client gives up first.
    await new Promise(() => {});
  });

  const controller = new AbortController();
  fetch(`http://127.0.0.1:${port}/hang`, { signal: controller.signal }).catch(() => {});
  while (tracker.inFlight().total === 0) await new Promise((r) => setTimeout(r, 5));
  controller.abort();

  // The counter is decremented on `close`, not only on `finish`. A response that
  // never finishes would otherwise leave the count above zero forever and the
  // process would wait out every budget on every shutdown.
  const result = await drainAndClose(server, {
    tracker, readinessDelayMs: 0, requestDrainMs: 3000, gitDrainMs: 3000, hardStopMs: 100,
  });
  assert.equal(result.apiDrained, true);
  assert.equal(tracker.inFlight().total, 0);
});

test('draining begins once and remembers when', () => {
  const state = createDrainState();
  assert.equal(state.isDraining(), false);
  assert.equal(state.drainingSince(), null);

  assert.equal(state.begin(1000), true);
  assert.equal(state.isDraining(), true);
  assert.equal(state.drainingSince(), 1000);

  // A second signal must not restart the clock, or a repeated SIGTERM would
  // extend the drain indefinitely.
  assert.equal(state.begin(9999), false);
  assert.equal(state.drainingSince(), 1000);
});
