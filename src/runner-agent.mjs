import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { KUKGIT_VERSION } from './version.mjs';

export const AGENT_DEFAULTS = {
  pollIntervalMs: 5000,
  heartbeatIntervalMs: 30_000,
  logFlushIntervalMs: 2000,
  maxLogChunkBytes: 64 * 1024,
  shutdownGraceMs: 10_000,
};

// Environment names the runner owns. A workflow cannot set these — the format
// already rejects them — but the agent asserts it too, because the agent is what
// would actually be lied to.
const RESERVED_ENV_PREFIXES = ['KUKGIT_', 'RUNNER_'];

export class AgentError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * Builds the environment for a step.
 *
 * Secrets are ordinary environment entries because that is the whole point: the
 * runner hands them to the process, and they are never part of a command line
 * where the shell would parse them or a process listing would show them.
 */
export function stepEnvironment({ job, run, secrets, workspace, stepIndex }) {
  const base = {
    CI: 'true',
    KUKGIT_CI: 'true',
    KUKGIT_WORKSPACE: workspace,
    KUKGIT_RUN_ID: run.id,
    KUKGIT_JOB_ID: job.id,
    KUKGIT_JOB_KEY: job.key,
    KUKGIT_REPOSITORY: run.repository,
    KUKGIT_REF: run.ref,
    KUKGIT_SHA: run.commitSha,
    KUKGIT_EVENT_NAME: run.event,
    KUKGIT_STEP_INDEX: String(stepIndex),
    RUNNER_OS: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
    RUNNER_ARCH: process.arch,
  };

  const declared = {};
  for (const [name, value] of Object.entries({ ...job.env, ...(job.steps[stepIndex]?.env ?? {}) })) {
    if (RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    declared[name] = String(value);
  }

  // Only the secrets a step actually names are placed in its environment. A step
  // that never mentions a credential does not get one, which bounds what a
  // compromised dependency in that step can read.
  const referenced = {};
  const script = String(job.steps[stepIndex]?.run ?? '');
  const inputs = JSON.stringify(job.steps[stepIndex]?.with ?? {});
  for (const [name, value] of Object.entries(secrets ?? {})) {
    const marker = new RegExp(`secrets\\s*\\.\\s*${name}\\b`);
    const inEnv = Object.values(declared).some((entry) => marker.test(entry));
    if (inEnv || marker.test(script) || marker.test(inputs)) referenced[name] = value;
  }

  // Expressions are resolved for declared values only. Nothing is substituted
  // into the script itself: the format forbids untrusted interpolation there,
  // and doing it here would reintroduce exactly what it forbids.
  const resolved = {};
  for (const [name, value] of Object.entries(declared)) {
    resolved[name] = value.replace(/\$\{\{\s*secrets\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
      (whole, secretName) => (secretName in (secrets ?? {}) ? secrets[secretName] : whole));
  }

  return { ...base, ...resolved, ...referenced };
}

/**
 * Writes a step's script to a file and executes it.
 *
 * The script is never assembled into a shell command string. `bash <file>` means
 * the script's own contents are the only thing the shell parses, so nothing in
 * the job definition can escape into the agent's own command line.
 */
export function runStep({
  script, shell = 'bash', cwd, env, timeoutMs, onOutput, signal,
}) {
  return new Promise((resolve) => {
    const scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-step-')), 'step.sh');
    fs.writeFileSync(scriptPath, `set -eo pipefail\n${script}\n`, { mode: 0o700 });

    const child = spawn(shell, [scriptPath], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // No shell interpretation of the arguments themselves.
      shell: false,
    });

    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.max(1000, timeoutMs));
    timer.unref?.();

    const onAbort = () => {
      cancelled = true;
      child.kill('SIGTERM');
      // A step that ignores SIGTERM is not allowed to outlive its cancellation.
      setTimeout(() => child.kill('SIGKILL'), AGENT_DEFAULTS.shutdownGraceMs).unref?.();
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => onOutput?.({ stream: 'stdout', content: chunk.toString('utf8') }));
    child.stderr.on('data', (chunk) => onOutput?.({ stream: 'stderr', content: chunk.toString('utf8') }));
    child.on('error', (error) => finish({ ok: false, code: null, reason: `could not start ${shell}: ${error.message}` }));
    child.on('close', (code, killSignal) => {
      if (timedOut) return finish({ ok: false, code, reason: `step exceeded its ${Math.round(timeoutMs / 1000)}s timeout` });
      if (cancelled) return finish({ ok: false, code, cancelled: true, reason: 'cancelled' });
      if (code === 0) return finish({ ok: true, code: 0 });
      finish({ ok: false, code, reason: killSignal ? `step was killed by ${killSignal}` : `step exited with code ${code}` });
    });
  });
}

/**
 * Batches log output so a chatty build does not become one HTTP request per line.
 *
 * Output is never dropped when a flush fails: it is put back at the front of the
 * buffer. A log that silently loses the failing lines is worse than a slow one.
 */
export function createLogBuffer({ send, maxChunkBytes = AGENT_DEFAULTS.maxLogChunkBytes }) {
  let pending = [];

  const push = (chunk) => {
    let content = chunk.content;
    while (Buffer.byteLength(content) > maxChunkBytes) {
      pending.push({ stream: chunk.stream, stepIndex: chunk.stepIndex, content: content.slice(0, maxChunkBytes) });
      content = content.slice(maxChunkBytes);
    }
    if (content) pending.push({ ...chunk, content });
  };

  const flush = async () => {
    if (!pending.length) return { flushed: 0 };
    const batch = pending;
    pending = [];
    try {
      await send(batch);
      return { flushed: batch.length };
    } catch (error) {
      pending = [...batch, ...pending];
      return { flushed: 0, error };
    }
  };

  return { push, flush, size: () => pending.length };
}

/**
 * A minimal client for the runner-facing API.
 *
 * Every call carries a credential and nothing else identifying: the job token
 * names the job, the runner token names the runner, and neither route accepts an
 * identifier that could point somewhere else.
 */
export function createRunnerClient({ baseUrl, runnerToken, fetchImpl = fetch }) {
  const url = (route) => `${String(baseUrl).replace(/\/$/, '')}${route}`;

  const call = async (route, { method = 'POST', token, body } = {}) => {
    const response = await fetchImpl(url(route), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 204) return null;
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new AgentError(payload?.error?.message || `request failed with ${response.status}`, payload?.error?.code || 'RUNNER_REQUEST_FAILED');
    }
    return payload;
  };

  return {
    claim: (labels) => call('/api/runners/claim', { token: runnerToken, body: { labels, version: KUKGIT_VERSION } }),
    appendLogs: (jobToken, chunks) => call('/api/workflow-jobs/self/logs', { token: jobToken, body: { chunks } }),
    heartbeat: (jobToken) => call('/api/workflow-jobs/self/heartbeat', { token: jobToken, body: {} }),
    complete: (jobToken, status, reason) => call('/api/workflow-jobs/self/complete', { token: jobToken, body: { status, reason } }),
  };
}

function stepLabel(step, index) {
  return step.name || (step.type === 'uses' ? `uses ${step.uses?.raw ?? 'action'}` : `step ${index + 1}`);
}

/**
 * Executes one claimed job.
 *
 * Steps run in order and stop at the first failure unless it is marked
 * `continue-on-error`. A step that only `uses:` an action is reported as skipped
 * rather than quietly passing — this agent does not run actions yet, and
 * pretending it did would make a build look green that never happened.
 */
export async function executeJob(client, claimed, {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-job-')),
  heartbeatIntervalMs = AGENT_DEFAULTS.heartbeatIntervalMs,
  logFlushIntervalMs = AGENT_DEFAULTS.logFlushIntervalMs,
  prepareWorkspace = null,
  now = () => Date.now(),
} = {}) {
  const { job, run, secrets, token } = claimed;
  const controller = new AbortController();
  const buffer = createLogBuffer({ send: (chunks) => client.appendLogs(token, chunks) });

  const flushTimer = setInterval(() => { buffer.flush(); }, logFlushIntervalMs);
  flushTimer.unref?.();
  const heartbeatTimer = setInterval(async () => {
    try {
      const beat = await client.heartbeat(token);
      if (beat?.cancelled) controller.abort();
    } catch {
      // A missed heartbeat is not a reason to abandon the job; the server reaps
      // a runner that stops reporting, and abandoning on one blip would turn a
      // network hiccup into a failed build.
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  const deadline = now() + job.timeoutMinutes * 60_000;
  let status = 'success';
  let reason = null;

  try {
    fs.mkdirSync(workspaceRoot, { recursive: true });
    if (prepareWorkspace) {
      buffer.push({ stream: 'system', content: `Preparing ${run.repository} at ${run.commitSha.slice(0, 12)}\n` });
      await prepareWorkspace({ workspace: workspaceRoot, run, onOutput: (chunk) => buffer.push(chunk) });
    }

    for (const [index, step] of job.steps.entries()) {
      if (controller.signal.aborted) { status = 'cancelled'; reason = 'cancelled'; break; }
      const remaining = deadline - now();
      if (remaining <= 0) { status = 'failure'; reason = `job exceeded its ${job.timeoutMinutes} minute timeout`; break; }

      buffer.push({ stream: 'system', stepIndex: index, content: `\n=== ${stepLabel(step, index)}\n` });

      if (step.type !== 'run') {
        // Not implemented, and said so rather than counted as a pass.
        buffer.push({
          stream: 'system', stepIndex: index,
          content: 'This runner does not execute actions yet; the step was skipped.\n',
        });
        continue;
      }

      const cwd = step.workingDirectory ? path.join(workspaceRoot, step.workingDirectory) : workspaceRoot;
      fs.mkdirSync(cwd, { recursive: true });

      const result = await runStep({
        script: step.run,
        shell: step.shell || 'bash',
        cwd,
        env: stepEnvironment({ job, run, secrets, workspace: workspaceRoot, stepIndex: index }),
        timeoutMs: Math.min(remaining, (step.timeoutMinutes ?? job.timeoutMinutes) * 60_000),
        signal: controller.signal,
        onOutput: (chunk) => buffer.push({ ...chunk, stepIndex: index }),
      });

      if (result.ok) continue;
      if (result.cancelled) { status = 'cancelled'; reason = 'cancelled'; break; }
      if (step.continueOnError) {
        buffer.push({ stream: 'system', stepIndex: index, content: `${result.reason}; continuing because continue-on-error is set\n` });
        continue;
      }
      status = 'failure';
      reason = result.reason;
      break;
    }
  } catch (error) {
    status = 'failure';
    reason = `runner error: ${error.message}`;
  } finally {
    clearInterval(flushTimer);
    clearInterval(heartbeatTimer);
    buffer.push({ stream: 'system', content: `\n=== ${status}${reason ? `: ${reason}` : ''}\n` });
    // Flush before reporting the outcome: completing the job destroys the token,
    // and anything still buffered would have nowhere to go.
    await buffer.flush();
    await client.complete(token, status, reason).catch(() => {});
  }

  return { status, reason, workspace: workspaceRoot };
}
