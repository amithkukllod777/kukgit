export const DRAIN_DEFAULTS = {
  // How long to keep serving after readiness starts failing. A load balancer
  // takes a few probe intervals to notice, and closing the socket before it has
  // is exactly what turns an invisible deploy into a burst of 502s.
  readinessDelayMs: 8000,
  // In-flight API requests. Generous, because the alternative to waiting is
  // cutting somebody off mid-response.
  requestDrainMs: 30_000,
  // Git transfers get their own, much longer budget. A clone of a large
  // repository legitimately takes minutes, and killing it at thirty seconds
  // wastes every byte already sent and leaves the client to start again.
  gitDrainMs: 300_000,
  // After every budget is spent, remaining sockets are closed rather than
  // waiting forever. A process that will not exit is worse than one connection
  // that ends badly.
  hardStopMs: 15_000,
};

/**
 * Tracks in-flight requests so a shutdown can wait for them.
 *
 * Git transfers are counted separately. They are the only requests that
 * routinely run for minutes, and giving every request the budget a clone needs
 * would make an ordinary rollout take five minutes to finish.
 */
export function createRequestTracker({ next, isGitRequest = defaultIsGitRequest } = {}) {
  let api = 0;
  let git = 0;
  const idleWaiters = new Set();

  const settle = () => {
    if (api + git === 0) {
      for (const waiter of idleWaiters) waiter();
      idleWaiters.clear();
    }
  };

  const tracker = async function trackRequest(req, res) {
    const isGit = isGitRequest(req);
    if (isGit) git += 1; else api += 1;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      if (isGit) git -= 1; else api -= 1;
      settle();
    };
    // `close` rather than `finish`: a client that disconnects mid-response never
    // fires `finish`, and a counter that only goes up blocks shutdown forever.
    res.once('close', done);
    res.once('finish', done);
    try {
      return await next(req, res);
    } catch (error) {
      done();
      throw error;
    }
  };

  tracker.inFlight = () => ({ api, git, total: api + git });
  tracker.whenIdle = (timeoutMs, { includeGit = true } = {}) => new Promise((resolve) => {
    const outstanding = () => (includeGit ? api + git : api);
    if (outstanding() === 0) return resolve({ drained: true, remaining: tracker.inFlight() });
    const timer = setTimeout(() => {
      idleWaiters.delete(check);
      resolve({ drained: false, remaining: tracker.inFlight() });
    }, timeoutMs);
    timer.unref?.();
    function check() {
      if (outstanding() !== 0) { idleWaiters.add(check); return; }
      clearTimeout(timer);
      resolve({ drained: true, remaining: tracker.inFlight() });
    }
    idleWaiters.add(check);
  });
  return tracker;
}

function defaultIsGitRequest(req) {
  const url = String(req.url || '');
  return url.startsWith('/git/') || url.includes('/info/lfs');
}

/**
 * Whether this instance is shutting down.
 *
 * Read by the readiness probe. Liveness deliberately does **not** consult it: a
 * failing liveness probe means "restart me", and an instance that is already
 * exiting does not need to be told.
 */
export function createDrainState() {
  let draining = false;
  let since = null;
  return {
    isDraining: () => draining,
    drainingSince: () => since,
    begin(now = Date.now()) {
      if (draining) return false;
      draining = true;
      since = now;
      return true;
    },
  };
}

/**
 * Stops serving in the order a load balancer can follow.
 *
 * The order is the whole point:
 *
 * 1. **Readiness starts failing.** Nothing else changes yet — the instance keeps
 *    serving everything it is given.
 * 2. **Wait.** The load balancer needs a few probe intervals to take this
 *    instance out of rotation. Skipping this step is what makes a rollout
 *    produce 502s: the socket closes while traffic is still being sent to it.
 * 3. **Stop accepting new connections**, and drop keep-alive connections that
 *    are between requests. An idle keep-alive holds the server open while
 *    carrying no work at all.
 * 4. **Wait for in-flight work**, API first and then Git, on separate budgets.
 * 5. **Close whatever is left.** A process that will not exit is worse than one
 *    connection that ends badly.
 */
export async function drainAndClose(server, {
  tracker,
  drainState,
  readinessDelayMs = DRAIN_DEFAULTS.readinessDelayMs,
  requestDrainMs = DRAIN_DEFAULTS.requestDrainMs,
  gitDrainMs = DRAIN_DEFAULTS.gitDrainMs,
  hardStopMs = DRAIN_DEFAULTS.hardStopMs,
  onStep = () => {},
  wait = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }),
} = {}) {
  const started = Date.now();
  drainState?.begin();
  onStep({ step: 'readiness_failing', inFlight: tracker?.inFlight() });

  if (readinessDelayMs > 0) await wait(readinessDelayMs);
  onStep({ step: 'closing_listener', inFlight: tracker?.inFlight() });

  const closed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections?.();

  let apiDrain = { drained: true, remaining: { api: 0, git: 0, total: 0 } };
  let gitDrain = apiDrain;
  if (tracker) {
    apiDrain = await tracker.whenIdle(requestDrainMs, { includeGit: false });
    onStep({ step: 'api_drained', drained: apiDrain.drained, inFlight: tracker.inFlight() });
    gitDrain = await tracker.whenIdle(gitDrainMs);
    onStep({ step: 'git_drained', drained: gitDrain.drained, inFlight: tracker.inFlight() });
  }

  const hardStop = setTimeout(() => {
    onStep({ step: 'forcing_close', inFlight: tracker?.inFlight() });
    server.closeAllConnections?.();
  }, hardStopMs);
  hardStop.unref?.();
  await closed;
  clearTimeout(hardStop);

  return {
    durationMs: Date.now() - started,
    apiDrained: apiDrain.drained,
    gitDrained: gitDrain.drained,
    remaining: tracker?.inFlight() ?? { api: 0, git: 0, total: 0 },
  };
}
