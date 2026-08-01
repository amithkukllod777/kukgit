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
 * Substitutes the repository-controlled fields a script is allowed to reference.
 *
 * The validator already refuses every other context inside `run:` — event
 * content, fork branch names and secrets must go through `env:`. So this map is
 * the complete set of things that can legitimately appear, and anything not in
 * it is left exactly as written rather than guessed at: a script that reaches
 * the runner with an unrecognised expression is a validator bug, and quietly
 * substituting something would hide it.
 */
export function resolveRunScript(script, { job, run }) {
  const values = new Map([
    ['github.sha', run.commitSha],
    ['github.ref', run.ref],
    ['github.ref_name', String(run.ref ?? '').replace(/^refs\/(heads|tags)\//, '')],
    ['github.ref_type', String(run.ref ?? '').startsWith('refs/tags/') ? 'tag' : 'branch'],
    ['github.repository', run.repository],
    ['github.repository_owner', String(run.repository ?? '').split('/')[0]],
    ['github.workflow', run.workflow ?? ''],
    ['github.job', job.key],
    ['github.run_id', run.id],
    ['github.event_name', run.event],
    ['github.workspace', run.workspace ?? ''],
  ]);
  return String(script).replace(/\$\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g,
    (whole, reference) => (values.has(reference) ? String(values.get(reference)) : whole));
}

/**
 * Resolves the same allow-list inside a built-in action's inputs.
 *
 * A cache key is normally composed from `${{ github.sha }}` or a ref name, so
 * the substitution has to happen somewhere. It is the same map `run:` scripts
 * get and nothing more — an input that reaches here with an unrecognised
 * expression is left as written, because a validator that let it through is a
 * bug and guessing at a value would hide it.
 */
export function resolveInputs(inputs, context) {
  const resolved = {};
  for (const [name, value] of Object.entries(inputs ?? {})) {
    resolved[name] = resolveRunScript(String(value ?? ''), context);
  }
  return resolved;
}

/**
 * Resolves a workspace-relative path from a workflow input.
 *
 * The check is on the resolved path rather than on the text, so `a/../../etc`
 * and a symlinked parent are both caught by the same comparison. A path that
 * escapes the workspace would let a workflow archive the runner's own files —
 * its configuration, its registration token, whatever else is on the machine.
 */
export function resolveWorkspacePath(workspace, relative, label = 'path') {
  const text = String(relative ?? '').trim();
  if (!text) throw new AgentError(`${label} is required.`, 'RUNNER_PATH_REQUIRED');
  const root = fs.realpathSync(workspace);
  const target = path.resolve(root, text);
  const within = target === root || target.startsWith(`${root}${path.sep}`);
  if (!within) throw new AgentError(`${label} must stay inside the workspace.`, 'RUNNER_PATH_ESCAPE');
  return target;
}

function runTar(args, { cwd, signal }) {
  return new Promise((resolve) => {
    // argv, never a command string. A path out of a workflow file reaching a
    // shell is the whole class of bug this avoids.
    const child = spawn('tar', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], shell: false, signal });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolve({ ok: false, reason: error.message }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, reason: stderr.trim() || `tar exited ${code}` }));
  });
}

/**
 * Packs a workspace path into a gzipped tar and returns the bytes.
 *
 * Paths are passed relative to a `-C` directory so nothing that looks like an
 * option can arrive from a workflow: `tar` sees `-C <dir> -- <name>`, and the
 * name is a single path component the caller already resolved.
 */
export async function archivePath(workspace, relative, { signal } = {}) {
  const target = resolveWorkspacePath(workspace, relative);
  if (!fs.existsSync(target)) return { found: false, content: null };
  const archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-pack-')), 'content.tar.gz');
  const result = await runTar(['-czf', archive, '-C', path.dirname(target), '--', path.basename(target)], { signal });
  try {
    if (!result.ok) throw new AgentError(`could not archive ${relative}: ${result.reason}`, 'RUNNER_ARCHIVE_FAILED');
    return { found: true, content: fs.readFileSync(archive) };
  } finally {
    fs.rmSync(path.dirname(archive), { recursive: true, force: true });
  }
}

/**
 * Unpacks a cache archive into the workspace.
 *
 * Unpacked into a staging directory first and copied in only once tar has
 * succeeded. Two reasons: a half-extracted archive never reaches a workspace a
 * build is about to compile, and the workspace is never the directory tar is
 * pointed at — so escaping into it takes escaping staging first, on top of
 * tar's own refusal of absolute and `..` members.
 */
export async function extractArchive(workspace, content, { signal } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-unpack-'));
  const archive = path.join(scratch, 'content.tar.gz');
  const staging = path.join(scratch, 'out');
  fs.mkdirSync(staging, { mode: 0o700 });
  fs.writeFileSync(archive, content, { mode: 0o600 });
  try {
    const result = await runTar(['-xzf', archive, '--no-same-owner', '-C', staging], { signal });
    if (!result.ok) throw new AgentError(`could not restore cache: ${result.reason}`, 'RUNNER_EXTRACT_FAILED');
    fs.cpSync(staging, fs.realpathSync(workspace), { recursive: true, force: true });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
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

  // Artifact and cache payloads are raw bytes rather than JSON. Base64 in a JSON
  // envelope would cost a third more memory on both sides for content that is
  // already compressed.
  const sendBytes = async (route, { token, content, headers = {} }) => {
    const response = await fetchImpl(url(route), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', ...headers },
      body: content,
    });
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
    uploadArtifact: (jobToken, { name, retentionDays = null }, content) => sendBytes('/api/workflow-jobs/self/artifacts', {
      token: jobToken,
      content,
      headers: { 'X-Artifact-Name': name, ...(retentionDays ? { 'X-Artifact-Retention-Days': String(retentionDays) } : {}) },
    }),
    saveCache: (jobToken, key, content) => sendBytes('/api/workflow-jobs/self/cache', {
      token: jobToken, content, headers: { 'X-Cache-Key': key },
    }),
    restoreCache: async (jobToken, { key, restoreKeys = [] }) => {
      const query = new URLSearchParams([['key', key], ...restoreKeys.map((prefix) => ['restoreKey', prefix])]);
      const response = await fetchImpl(url(`/api/workflow-jobs/self/cache?${query}`), {
        method: 'GET', headers: { Authorization: `Bearer ${jobToken}` },
      });
      // A miss is the ordinary case on a first build, not an error.
      if (response.status === 404) return null;
      if (!response.ok) {
        const text = await response.text();
        const payload = text ? JSON.parse(text) : null;
        throw new AgentError(payload?.error?.message || `request failed with ${response.status}`, payload?.error?.code || 'RUNNER_REQUEST_FAILED');
      }
      return {
        key: response.headers.get('x-cache-key'),
        ref: response.headers.get('x-cache-ref'),
        exact: response.headers.get('x-cache-exact') === 'true',
        content: Buffer.from(await response.arrayBuffer()),
      };
    },
  };
}

function stepLabel(step, index) {
  return step.name || (step.type === 'uses' ? `uses ${step.uses?.raw ?? 'action'}` : `step ${index + 1}`);
}

/**
 * Runs one built-in action.
 *
 * `cache` restores here and registers a save for after the job. Saving at the
 * end is what makes a cache a cache: the content it is meant to hold does not
 * exist yet when the step runs. It is skipped on an exact hit — the bytes under
 * that key are already the bytes we would write — and skipped when the job
 * failed, because a cache written from a broken build is one every later build
 * restores.
 */
async function runBuiltinStep(step, {
  client, token, workspace, context, report, signal, postActions,
}) {
  const inputs = resolveInputs(step.with, context);

  if (step.uses.builtin === 'cache') {
    const restoreKeys = String(inputs['restore-keys'] ?? '')
      .split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
    let hit = null;
    try {
      hit = await client.restoreCache(token, { key: inputs.key, restoreKeys });
    } catch (error) {
      // A cache is an optimisation. Failing the build because the cache service
      // was unreachable would turn a slow build into a broken one.
      report(`cache could not be restored (${error.message}); continuing without it\n`);
    }
    if (hit) {
      await extractArchive(workspace, hit.content, { signal });
      report(`cache restored from '${hit.key}' on ${hit.ref}${hit.exact ? '' : ' (prefix match)'}\n`);
    } else {
      report(`cache miss for '${inputs.key}'\n`);
    }
    if (!hit?.exact) postActions.push({ kind: 'cache', key: inputs.key, path: inputs.path });
    return { ok: true };
  }

  const packed = await archivePath(workspace, inputs.path, { signal });
  if (!packed.found) {
    const policy = inputs['if-no-files-found'] || 'warn';
    if (policy === 'error') return { ok: false, reason: `no files matched '${inputs.path}'` };
    if (policy === 'warn') report(`no files matched '${inputs.path}'; nothing was uploaded\n`);
    return { ok: true };
  }
  const stored = await client.uploadArtifact(token, {
    name: inputs.name, retentionDays: inputs['retention-days'],
  }, packed.content);
  report(`uploaded artifact '${stored.name}' (${stored.size} bytes, kept ${stored.retentionDays} days)\n`);
  return { ok: true };
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
  const postActions = [];
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

      if (step.type === 'uses' && step.uses?.builtin) {
        let outcome;
        try {
          outcome = await runBuiltinStep(step, {
            client,
            token,
            workspace: workspaceRoot,
            context: { job, run: { ...run, workspace: workspaceRoot } },
            report: (content) => buffer.push({ stream: 'system', stepIndex: index, content }),
            signal: controller.signal,
            postActions,
          });
        } catch (error) {
          outcome = { ok: false, reason: error.message };
        }
        if (outcome.ok) continue;
        if (step.continueOnError) {
          buffer.push({ stream: 'system', stepIndex: index, content: `${outcome.reason}; continuing because continue-on-error is set\n` });
          continue;
        }
        status = 'failure';
        reason = outcome.reason;
        break;
      }

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
        script: resolveRunScript(step.run, { job, run: { ...run, workspace: workspaceRoot } }),
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

    // Caches are written only by a job that succeeded. A cache saved from a
    // broken build is one every later build restores, so a single bad run would
    // keep costing until somebody noticed and cleared it by hand.
    if (status === 'success') {
      for (const action of postActions) {
        try {
          const packed = await archivePath(workspaceRoot, action.path, { signal: controller.signal });
          if (!packed.found) {
            buffer.push({ stream: 'system', content: `nothing at '${action.path}' to cache under '${action.key}'\n` });
            continue;
          }
          const saved = await client.saveCache(token, action.key, packed.content);
          buffer.push({
            stream: 'system',
            content: saved.stored
              ? `cache saved as '${action.key}' (${saved.size} bytes)\n`
              : `cache not saved: ${saved.reason}\n`,
          });
        } catch (error) {
          // The build already passed. Failing it now because the cache could not
          // be stored would report a false failure for work that succeeded.
          buffer.push({ stream: 'system', content: `cache could not be saved (${error.message})\n` });
        }
      }
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
