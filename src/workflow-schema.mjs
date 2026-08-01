import { httpError } from './security.mjs';
import { parseWorkflowYaml } from './workflow-yaml.mjs';

export const WORKFLOW_FORMAT = 'kukgit-workflow-v1';

export const WORKFLOW_LIMITS = {
  maxJobs: 50,
  maxStepsPerJob: 100,
  maxTotalSteps: 500,
  maxNameLength: 200,
  maxIdLength: 64,
  maxRunBytes: 64 * 1024,
  maxEnvEntries: 100,
  maxTimeoutMinutes: 360,
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV_PREFIXES = ['GITHUB_', 'KUKGIT_', 'RUNNER_', 'CI_KUKGIT'];
const ACTION_REFERENCE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(\/[A-Za-z0-9._/-]+)?@([A-Za-z0-9._/-]+)$/;
const SHELLS = new Set(['bash', 'sh']);
const PERMISSION_SCOPES = new Set(['contents', 'pull-requests', 'issues', 'statuses', 'packages', 'actions']);
const PERMISSION_LEVELS = new Set(['none', 'read', 'write']);

const EVENTS = new Set(['push', 'pull_request', 'tag', 'schedule', 'manual']);
const EVENT_FILTERS = {
  push: new Set(['branches', 'branches-ignore', 'paths', 'paths-ignore']),
  pull_request: new Set(['branches', 'branches-ignore', 'paths', 'paths-ignore', 'types']),
  tag: new Set(['tags', 'tags-ignore']),
  schedule: new Set(['cron']),
  manual: new Set(['inputs']),
};
const PULL_REQUEST_TYPES = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review', 'closed']);

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const CONTEXT_ROOTS = new Set(['github', 'env', 'secrets', 'job', 'jobs', 'steps', 'runner', 'matrix', 'needs', 'inputs', 'vars']);

// Fields that may be interpolated directly into a `run:` script.
//
// This is an allow-list, not a deny-list, and that is the whole point. The
// well-known CI shell-injection class comes from interpolating attacker-supplied
// event content — a pull-request title, a branch name from a fork — straight into
// a shell script, where it is code rather than data. A deny-list has to predict
// every such field, including ones added later. An allow-list fails closed on
// anything it has not been told is safe.
//
// Everything else is still usable — through `env:`, where the runner passes it as
// an environment variable and the shell never parses it as syntax.
const RUN_SAFE_GITHUB_FIELDS = new Set([
  'github.sha',
  'github.ref',
  'github.ref_name',
  'github.ref_type',
  'github.base_ref',
  'github.repository',
  'github.repository_owner',
  'github.repository_id',
  'github.workflow',
  'github.job',
  'github.run_id',
  'github.run_number',
  'github.run_attempt',
  'github.workspace',
  'github.event_name',
  'github.actor',
  'github.actor_id',
  'github.triggering_actor',
]);

function invalid(message, code = 'WORKFLOW_INVALID', path = '') {
  return httpError(400, path ? `${path}: ${message}` : message, code);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, path, { max = WORKFLOW_LIMITS.maxNameLength, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw invalid('must be a string.', 'WORKFLOW_INVALID', path);
  const text = value.trim();
  if (!allowEmpty && !text) throw invalid('must not be empty.', 'WORKFLOW_INVALID', path);
  if (text.length > max) throw invalid(`must be at most ${max} characters.`, 'WORKFLOW_INVALID', path);
  return text;
}

function requireIdentifier(value, path) {
  const text = requireString(value, path, { max: WORKFLOW_LIMITS.maxIdLength });
  if (!IDENTIFIER.test(text)) {
    throw invalid('must start with a letter or underscore and contain only letters, numbers, underscores and hyphens.', 'WORKFLOW_INVALID', path);
  }
  return text;
}

function requireInteger(value, path, { min, max }) {
  if (!Number.isInteger(value)) throw invalid('must be a whole number.', 'WORKFLOW_INVALID', path);
  if (value < min || value > max) throw invalid(`must be between ${min} and ${max}.`, 'WORKFLOW_INVALID', path);
  return value;
}

function requireBoolean(value, path) {
  if (typeof value !== 'boolean') throw invalid('must be true or false.', 'WORKFLOW_INVALID', path);
  return value;
}

function stringList(value, path, { max = 100 } = {}) {
  const items = Array.isArray(value) ? value : [value];
  if (!items.length) throw invalid('must list at least one value.', 'WORKFLOW_INVALID', path);
  if (items.length > max) throw invalid(`must list at most ${max} values.`, 'WORKFLOW_INVALID', path);
  return items.map((item, index) => requireString(item, `${path}[${index}]`));
}

function rejectUnknownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`unknown key '${key}'. Supported keys: ${[...allowed].sort().join(', ')}.`, 'WORKFLOW_UNKNOWN_KEY', path);
    }
  }
}

/**
 * Extracts every `${{ ... }}` expression, validating that each reads from a
 * known context. Returns the referenced paths so callers can decide where a
 * given reference is acceptable.
 */
export function workflowExpressions(text, path) {
  const found = [];
  for (const match of String(text).matchAll(EXPRESSION)) {
    const body = match[1].trim();
    if (!body) throw invalid('contains an empty ${{ }} expression.', 'WORKFLOW_EXPRESSION_INVALID', path);
    if (body.length > 500) throw invalid('contains an expression that is too long.', 'WORKFLOW_EXPRESSION_INVALID', path);
    // Nested interpolation would let one expression build another, which defeats
    // any static check performed here.
    if (body.includes('${{')) throw invalid('contains a nested ${{ }} expression.', 'WORKFLOW_EXPRESSION_INVALID', path);

    const references = [...body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_-]*)*)/g)]
      .map((reference) => ({ root: reference[1], full: reference[1] + reference[2] }))
      .filter((reference) => CONTEXT_ROOTS.has(reference.root));

    if (!references.length) {
      throw invalid(`expression '${body}' does not read any known context. Supported contexts: ${[...CONTEXT_ROOTS].sort().join(', ')}.`, 'WORKFLOW_EXPRESSION_INVALID', path);
    }
    for (const reference of references) found.push({ expression: body, ...reference });
  }
  return found;
}

// The rule that makes the difference between "a build ran your script" and "a
// pull-request title ran your script".
function assertRunExpressionsAreSafe(script, path) {
  for (const reference of workflowExpressions(script, path)) {
    if (reference.root === 'secrets') {
      throw invalid(
        `a secret may not be interpolated into a run script (${reference.full}). Pass it through env: instead, so the value is never part of the command text.`,
        'WORKFLOW_SECRET_IN_RUN', path,
      );
    }
    if (reference.root === 'github' && !RUN_SAFE_GITHUB_FIELDS.has(reference.full)) {
      throw invalid(
        `'${reference.full}' may not be interpolated into a run script because its value can be supplied by whoever triggered the workflow. Pass it through env: instead, so the shell receives it as data rather than as code.`,
        'WORKFLOW_UNTRUSTED_INTERPOLATION', path,
      );
    }
  }
}

function normalizeEnv(value, path) {
  if (value === null || value === undefined) return {};
  if (!isPlainObject(value)) throw invalid('must be a mapping of environment variables.', 'WORKFLOW_INVALID', path);
  const entries = Object.entries(value);
  if (entries.length > WORKFLOW_LIMITS.maxEnvEntries) {
    throw invalid(`must define at most ${WORKFLOW_LIMITS.maxEnvEntries} variables.`, 'WORKFLOW_INVALID', path);
  }
  const result = {};
  for (const [name, raw] of entries) {
    const entryPath = `${path}.${name}`;
    if (!ENV_NAME.test(name)) throw invalid('is not a valid environment variable name.', 'WORKFLOW_INVALID', entryPath);
    // Reserved prefixes are the runner's own namespace. Letting a workflow
    // overwrite them would let it lie to its own steps about where it is running.
    if (RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw invalid(`is reserved and cannot be set by a workflow (reserved prefixes: ${RESERVED_ENV_PREFIXES.join(', ')}).`, 'WORKFLOW_RESERVED_ENV', entryPath);
    }
    if (raw !== null && typeof raw === 'object') throw invalid('must be a string, number or boolean.', 'WORKFLOW_INVALID', entryPath);
    const text = raw === null ? '' : String(raw);
    if (text.length > 4096) throw invalid('value is too long.', 'WORKFLOW_INVALID', entryPath);
    workflowExpressions(text, entryPath);
    result[name] = text;
  }
  return result;
}

function normalizeTriggers(value, path) {
  if (value === null || value === undefined) throw invalid("is required; a workflow must say when it runs.", 'WORKFLOW_INVALID', path);

  const raw = typeof value === 'string' || Array.isArray(value)
    ? Object.fromEntries(stringList(value, path, { max: EVENTS.size }).map((event) => [event, null]))
    : value;
  if (!isPlainObject(raw)) throw invalid('must be an event name, a list of event names, or a mapping.', 'WORKFLOW_INVALID', path);
  if (!Object.keys(raw).length) throw invalid('must name at least one event.', 'WORKFLOW_INVALID', path);

  const triggers = {};
  for (const [event, filters] of Object.entries(raw)) {
    const eventPath = `${path}.${event}`;
    if (!EVENTS.has(event)) {
      throw invalid(`unsupported event. Supported events: ${[...EVENTS].sort().join(', ')}.`, 'WORKFLOW_UNKNOWN_EVENT', eventPath);
    }
    if (filters === null || filters === undefined) { triggers[event] = {}; continue; }
    if (!isPlainObject(filters)) throw invalid('filters must be a mapping.', 'WORKFLOW_INVALID', eventPath);
    rejectUnknownKeys(filters, EVENT_FILTERS[event], eventPath);

    const normalized = {};
    for (const [name, filterValue] of Object.entries(filters)) {
      const filterPath = `${eventPath}.${name}`;
      if (name === 'cron') {
        normalized.cron = stringList(filterValue, filterPath, { max: 10 }).map((entry) => assertCron(entry, filterPath));
        continue;
      }
      if (name === 'types') {
        normalized.types = stringList(filterValue, filterPath, { max: PULL_REQUEST_TYPES.size }).map((type) => {
          if (!PULL_REQUEST_TYPES.has(type)) {
            throw invalid(`unsupported activity type '${type}'. Supported: ${[...PULL_REQUEST_TYPES].sort().join(', ')}.`, 'WORKFLOW_INVALID', filterPath);
          }
          return type;
        });
        continue;
      }
      if (name === 'inputs') {
        if (!isPlainObject(filterValue)) throw invalid('must be a mapping of input names.', 'WORKFLOW_INVALID', filterPath);
        normalized.inputs = Object.fromEntries(Object.entries(filterValue).map(([input, spec]) => {
          requireIdentifier(input, `${filterPath}.${input}`);
          return [input, isPlainObject(spec) ? spec : {}];
        }));
        continue;
      }
      normalized[name] = stringList(filterValue, filterPath);
    }
    triggers[event] = normalized;
  }

  if (triggers.schedule && !triggers.schedule.cron?.length) {
    throw invalid('requires at least one cron expression.', 'WORKFLOW_INVALID', `${path}.schedule`);
  }
  return triggers;
}

// Five fields, and no shorthand. A schedule that is silently misread runs at the
// wrong time forever, which is worse than a rejected file.
function assertCron(expression, path) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw invalid(`cron expression '${expression}' must have exactly five fields (minute hour day-of-month month day-of-week).`, 'WORKFLOW_INVALID', path);
  }
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  fields.forEach((field, index) => {
    const [min, max] = ranges[index];
    for (const part of field.split(',')) {
      const [range, step] = part.split('/');
      if (step !== undefined && !/^[1-9][0-9]*$/.test(step)) {
        throw invalid(`cron expression '${expression}' has an invalid step value.`, 'WORKFLOW_INVALID', path);
      }
      if (range === '*') continue;
      const bounds = range.split('-');
      if (bounds.length > 2) throw invalid(`cron expression '${expression}' has an invalid range.`, 'WORKFLOW_INVALID', path);
      for (const bound of bounds) {
        if (!/^[0-9]+$/.test(bound) || Number(bound) < min || Number(bound) > max) {
          throw invalid(`cron expression '${expression}' has a field outside ${min}-${max}.`, 'WORKFLOW_INVALID', path);
        }
      }
    }
  });
  return expression.trim();
}

function normalizePermissions(value, path) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw invalid('must be a mapping of scope to none, read or write.', 'WORKFLOW_INVALID', path);
  const result = {};
  for (const [scope, level] of Object.entries(value)) {
    const scopePath = `${path}.${scope}`;
    if (!PERMISSION_SCOPES.has(scope)) {
      throw invalid(`unknown permission scope. Supported: ${[...PERMISSION_SCOPES].sort().join(', ')}.`, 'WORKFLOW_INVALID', scopePath);
    }
    if (!PERMISSION_LEVELS.has(level)) {
      throw invalid('must be none, read or write.', 'WORKFLOW_INVALID', scopePath);
    }
    result[scope] = level;
  }
  return result;
}

function normalizeWorkingDirectory(value, path) {
  const text = requireString(value, path, { max: 512 });
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) {
    throw invalid('must be relative to the workspace.', 'WORKFLOW_PATH_INVALID', path);
  }
  if (text.split(/[\\/]/).includes('..')) {
    throw invalid('must not escape the workspace.', 'WORKFLOW_PATH_INVALID', path);
  }
  return text;
}

/**
 * Actions the runner implements itself.
 *
 * These are not fetched, so there is no third-party code to pin or review — the
 * agent already on the machine is what runs. They are described here so a
 * workflow that misspells an input is told at validation time rather than
 * discovering it halfway through a build.
 */
export const BUILTIN_ACTIONS = {
  cache: {
    version: 'v1',
    required: ['key', 'path'],
    optional: ['restore-keys'],
  },
  'upload-artifact': {
    version: 'v1',
    required: ['name', 'path'],
    optional: ['retention-days', 'if-no-files-found'],
  },
};

const BUILTIN_OWNER = 'kukgit';

function normalizeUses(value, path, { allowedActionOwners }) {
  const text = requireString(value, path, { max: 300 });
  if (text.startsWith('./') || text.startsWith('docker://')) {
    throw invalid('local and container action references are not supported yet; use owner/name@ref.', 'WORKFLOW_USES_UNSUPPORTED', path);
  }
  const match = ACTION_REFERENCE.exec(text);
  if (!match) throw invalid("must be written as owner/name@ref.", 'WORKFLOW_USES_INVALID', path);
  const [, owner, name, subpath, ref] = match;

  // A moving ref means the code a build runs can change without the workflow
  // changing. Pinning is the only way a review of this file means anything.
  if (['main', 'master', 'latest', 'HEAD'].includes(ref)) {
    throw invalid(`'@${ref}' is a moving reference. Pin the action to a tag or commit so the code a build runs cannot change without this file changing.`, 'WORKFLOW_USES_UNPINNED', path);
  }

  // Only the exact built-in references are claimed, not the whole `kukgit`
  // namespace. Reserving an owner would break any real action published under
  // it, and the two names below are the only ones the agent implements.
  const builtin = owner.toLowerCase() === BUILTIN_OWNER && !subpath ? BUILTIN_ACTIONS[name.toLowerCase()] : null;
  if (builtin) {
    if (ref !== builtin.version) {
      throw invalid(`built-in action '${name}' is at '@${builtin.version}' on this instance.`, 'WORKFLOW_USES_INVALID', path);
    }
    // The owner allow-list governs code fetched from elsewhere. A built-in is
    // the agent itself, so an instance that permits no external owners still
    // gets caching and artifacts.
    return { raw: text, owner, name: name.toLowerCase(), subpath: null, ref, builtin: name.toLowerCase() };
  }

  if (allowedActionOwners?.length && !allowedActionOwners.includes(owner.toLowerCase())) {
    throw invalid(`actions from '${owner}' are not permitted on this instance. Permitted owners: ${allowedActionOwners.join(', ')}.`, 'WORKFLOW_USES_NOT_PERMITTED', path);
  }
  return { raw: text, owner, name, subpath: subpath ? subpath.slice(1) : null, ref, builtin: null };
}

/**
 * Checks a built-in action's inputs.
 *
 * Strict on both sides: a missing required input and an unrecognised one are
 * both errors. An unrecognised input on a real action is a typo the build would
 * ignore; on a built-in it would silently change nothing about what is cached or
 * uploaded, which is worse — a workflow that thinks it set `retention-days`
 * would keep the default and nobody would find out until an artifact expired.
 */
function assertBuiltinInputs(step, path) {
  const spec = BUILTIN_ACTIONS[step.uses.builtin];
  const allowed = new Set([...spec.required, ...spec.optional]);
  for (const name of Object.keys(step.with)) {
    if (!allowed.has(name)) {
      throw invalid(`'${name}' is not an input of ${step.uses.raw}. Inputs: ${[...allowed].sort().join(', ')}.`, 'WORKFLOW_INVALID', `${path}.with.${name}`);
    }
  }
  for (const name of spec.required) {
    if (!step.with[name]) throw invalid(`${step.uses.raw} requires '${name}'.`, 'WORKFLOW_INVALID', `${path}.with`);
  }
  for (const [name, text] of Object.entries(step.with)) {
    for (const reference of workflowExpressions(text, `${path}.with.${name}`)) {
      // A secret in a cache key or an artifact name would be written to the
      // database as ordinary metadata, where it is readable by anyone who can
      // read the repository. Other actions may take a secret as an input; these
      // two turn their inputs into stored identifiers.
      if (reference.root === 'secrets') {
        throw invalid(`a secret may not be used in '${name}' — this input becomes stored metadata that anyone with repository read can see.`, 'WORKFLOW_SECRET_IN_METADATA', `${path}.with.${name}`);
      }
    }
  }
}

const STEP_KEYS = new Set([
  'name', 'id', 'if', 'uses', 'with', 'run', 'shell',
  'working-directory', 'env', 'continue-on-error', 'timeout-minutes',
]);

function normalizeStep(raw, path, index, options, seenStepIds) {
  if (!isPlainObject(raw)) throw invalid('must be a mapping.', 'WORKFLOW_INVALID', path);
  rejectUnknownKeys(raw, STEP_KEYS, path);

  const hasRun = Object.hasOwn(raw, 'run');
  const hasUses = Object.hasOwn(raw, 'uses');
  if (hasRun && hasUses) throw invalid('must define either run or uses, not both.', 'WORKFLOW_INVALID', path);
  if (!hasRun && !hasUses) throw invalid('must define either run or uses.', 'WORKFLOW_INVALID', path);

  const step = { index, name: null, id: null, if: null, env: {}, continueOnError: false, timeoutMinutes: null };
  if (raw.name !== undefined && raw.name !== null) step.name = requireString(raw.name, `${path}.name`);
  if (raw.id !== undefined && raw.id !== null) {
    step.id = requireIdentifier(raw.id, `${path}.id`);
    if (seenStepIds.has(step.id)) throw invalid(`duplicate step id '${step.id}' within the job.`, 'WORKFLOW_DUPLICATE_ID', path);
    seenStepIds.add(step.id);
  }
  if (raw.if !== undefined && raw.if !== null) {
    step.if = requireString(raw.if, `${path}.if`, { max: 1000 });
    workflowExpressions(step.if, `${path}.if`);
  }
  step.env = normalizeEnv(raw.env, `${path}.env`);
  if (raw['continue-on-error'] !== undefined) step.continueOnError = requireBoolean(raw['continue-on-error'], `${path}.continue-on-error`);
  if (raw['timeout-minutes'] !== undefined) {
    step.timeoutMinutes = requireInteger(raw['timeout-minutes'], `${path}.timeout-minutes`, { min: 1, max: options.maxTimeoutMinutes });
  }

  if (hasRun) {
    const script = requireString(raw.run, `${path}.run`, { max: WORKFLOW_LIMITS.maxRunBytes });
    assertRunExpressionsAreSafe(script, `${path}.run`);
    step.type = 'run';
    step.run = script;
    step.shell = raw.shell === undefined || raw.shell === null ? 'bash' : requireString(raw.shell, `${path}.shell`, { max: 20 });
    if (!SHELLS.has(step.shell)) {
      throw invalid(`unsupported shell. Supported: ${[...SHELLS].sort().join(', ')}.`, 'WORKFLOW_INVALID', `${path}.shell`);
    }
    step.workingDirectory = raw['working-directory'] === undefined || raw['working-directory'] === null
      ? null
      : normalizeWorkingDirectory(raw['working-directory'], `${path}.working-directory`);
    if (raw.with !== undefined) throw invalid('with is only valid on a step that uses an action.', 'WORKFLOW_INVALID', `${path}.with`);
    return step;
  }

  step.type = 'uses';
  step.uses = normalizeUses(raw.uses, `${path}.uses`, options);
  if (raw.shell !== undefined) throw invalid('shell is only valid on a run step.', 'WORKFLOW_INVALID', `${path}.shell`);
  if (raw['working-directory'] !== undefined) throw invalid('working-directory is only valid on a run step.', 'WORKFLOW_INVALID', `${path}.working-directory`);
  step.with = {};
  if (raw.with !== undefined && raw.with !== null) {
    if (!isPlainObject(raw.with)) throw invalid('must be a mapping of input names.', 'WORKFLOW_INVALID', `${path}.with`);
    for (const [name, inputValue] of Object.entries(raw.with)) {
      const inputPath = `${path}.with.${name}`;
      if (!ENV_NAME.test(name.replaceAll('-', '_'))) throw invalid('is not a valid input name.', 'WORKFLOW_INVALID', inputPath);
      if (inputValue !== null && typeof inputValue === 'object') throw invalid('must be a string, number or boolean.', 'WORKFLOW_INVALID', inputPath);
      const text = inputValue === null ? '' : String(inputValue);
      // Action inputs are passed as arguments, never assembled into a command
      // string, so untrusted values are permitted here.
      workflowExpressions(text, inputPath);
      step.with[name] = text;
    }
  }
  if (step.uses.builtin) assertBuiltinInputs(step, path);
  return step;
}

const JOB_KEYS = new Set(['name', 'runs-on', 'needs', 'if', 'env', 'permissions', 'timeout-minutes', 'steps']);

function normalizeJob(id, raw, path, options) {
  if (!isPlainObject(raw)) throw invalid('must be a mapping.', 'WORKFLOW_INVALID', path);
  rejectUnknownKeys(raw, JOB_KEYS, path);

  const runsOn = requireString(raw['runs-on'], `${path}.runs-on`, { max: 64 });
  if (options.allowedRunners.length && !options.allowedRunners.includes(runsOn)) {
    throw invalid(`unknown runner label. Available on this instance: ${options.allowedRunners.join(', ')}.`, 'WORKFLOW_RUNNER_UNKNOWN', `${path}.runs-on`);
  }

  const steps = raw.steps;
  if (!Array.isArray(steps) || !steps.length) throw invalid('must define at least one step.', 'WORKFLOW_INVALID', `${path}.steps`);
  if (steps.length > WORKFLOW_LIMITS.maxStepsPerJob) {
    throw invalid(`must define at most ${WORKFLOW_LIMITS.maxStepsPerJob} steps.`, 'WORKFLOW_TOO_LARGE', `${path}.steps`);
  }

  const seenStepIds = new Set();
  const job = {
    id,
    name: raw.name === undefined || raw.name === null ? id : requireString(raw.name, `${path}.name`),
    runsOn,
    needs: raw.needs === undefined || raw.needs === null ? [] : stringList(raw.needs, `${path}.needs`, { max: WORKFLOW_LIMITS.maxJobs }),
    if: null,
    env: normalizeEnv(raw.env, `${path}.env`),
    permissions: normalizePermissions(raw.permissions, `${path}.permissions`),
    timeoutMinutes: raw['timeout-minutes'] === undefined || raw['timeout-minutes'] === null
      ? options.defaultTimeoutMinutes
      : requireInteger(raw['timeout-minutes'], `${path}.timeout-minutes`, { min: 1, max: options.maxTimeoutMinutes }),
    steps: steps.map((step, index) => normalizeStep(step, `${path}.steps[${index}]`, index, options, seenStepIds)),
  };
  if (raw.if !== undefined && raw.if !== null) {
    job.if = requireString(raw.if, `${path}.if`, { max: 1000 });
    workflowExpressions(job.if, `${path}.if`);
  }
  if (new Set(job.needs).size !== job.needs.length) {
    throw invalid('lists the same dependency more than once.', 'WORKFLOW_INVALID', `${path}.needs`);
  }
  return job;
}

/**
 * Orders jobs so every dependency runs before its dependants, rejecting cycles.
 *
 * A cycle is reported with the actual path through the graph, because "there is
 * a cycle somewhere in 30 jobs" is not something anyone can act on.
 */
export function resolveJobOrder(jobs) {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  for (const job of jobs) {
    for (const dependency of job.needs) {
      if (!byId.has(dependency)) {
        throw invalid(`depends on '${dependency}', which is not a job in this workflow.`, 'WORKFLOW_UNKNOWN_DEPENDENCY', `jobs.${job.id}.needs`);
      }
      if (dependency === job.id) {
        throw invalid('depends on itself.', 'WORKFLOW_DEPENDENCY_CYCLE', `jobs.${job.id}.needs`);
      }
    }
  }

  const order = [];
  const state = new Map();
  const stack = [];

  const visit = (id) => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      throw invalid(`dependency cycle: ${cycle.join(' -> ')}.`, 'WORKFLOW_DEPENDENCY_CYCLE', 'jobs');
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dependency of byId.get(id).needs) visit(dependency);
    stack.pop();
    state.set(id, 'done');
    order.push(id);
  };

  for (const job of jobs) visit(job.id);
  return order;
}

function workflowOptions(config = {}) {
  const workflow = config.workflow || {};
  return {
    allowedRunners: Array.isArray(workflow.allowedRunners) ? workflow.allowedRunners : [],
    allowedActionOwners: (Array.isArray(workflow.allowedActionOwners) ? workflow.allowedActionOwners : []).map((owner) => String(owner).toLowerCase()),
    maxTimeoutMinutes: Number(workflow.maxTimeoutMinutes) || WORKFLOW_LIMITS.maxTimeoutMinutes,
    defaultTimeoutMinutes: Number(workflow.defaultTimeoutMinutes) || 60,
    maxJobs: Number(workflow.maxJobs) || WORKFLOW_LIMITS.maxJobs,
  };
}

const WORKFLOW_KEYS = new Set(['name', 'on', 'env', 'permissions', 'concurrency', 'jobs']);

/**
 * Validates a parsed workflow document and returns the normalized form the
 * scheduler and runner consume. Every failure is a structured 400 naming the
 * exact path in the file.
 */
export function normalizeWorkflow(document, config = {}) {
  const options = workflowOptions(config);
  if (!isPlainObject(document)) throw invalid('a workflow file must contain a mapping at the top level.', 'WORKFLOW_INVALID');
  rejectUnknownKeys(document, WORKFLOW_KEYS, 'workflow');

  const rawJobs = document.jobs;
  if (!isPlainObject(rawJobs) || !Object.keys(rawJobs).length) {
    throw invalid('must define at least one job.', 'WORKFLOW_INVALID', 'jobs');
  }
  const jobIds = Object.keys(rawJobs);
  if (jobIds.length > options.maxJobs) {
    throw invalid(`must define at most ${options.maxJobs} jobs.`, 'WORKFLOW_TOO_LARGE', 'jobs');
  }

  const workflow = {
    format: WORKFLOW_FORMAT,
    name: document.name === undefined || document.name === null ? null : requireString(document.name, 'name'),
    on: normalizeTriggers(document.on, 'on'),
    env: normalizeEnv(document.env, 'env'),
    permissions: normalizePermissions(document.permissions, 'permissions'),
    concurrency: null,
    jobs: [],
  };

  if (document.concurrency !== undefined && document.concurrency !== null) {
    const raw = typeof document.concurrency === 'string' ? { group: document.concurrency } : document.concurrency;
    if (!isPlainObject(raw)) throw invalid('must be a group name or a mapping.', 'WORKFLOW_INVALID', 'concurrency');
    rejectUnknownKeys(raw, new Set(['group', 'cancel-in-progress']), 'concurrency');
    const group = requireString(raw.group, 'concurrency.group');
    workflowExpressions(group, 'concurrency.group');
    workflow.concurrency = {
      group,
      cancelInProgress: raw['cancel-in-progress'] === undefined ? false : requireBoolean(raw['cancel-in-progress'], 'concurrency.cancel-in-progress'),
    };
  }

  for (const id of jobIds) {
    requireIdentifier(id, `jobs.${id}`);
    workflow.jobs.push(normalizeJob(id, rawJobs[id], `jobs.${id}`, options));
  }

  const totalSteps = workflow.jobs.reduce((sum, job) => sum + job.steps.length, 0);
  if (totalSteps > WORKFLOW_LIMITS.maxTotalSteps) {
    throw invalid(`must define at most ${WORKFLOW_LIMITS.maxTotalSteps} steps in total.`, 'WORKFLOW_TOO_LARGE', 'jobs');
  }

  workflow.jobOrder = resolveJobOrder(workflow.jobs);
  return workflow;
}

/**
 * Parses and validates a workflow file in one step.
 *
 * `path` is only used to make error messages point at the right file.
 */
export function validateWorkflowFile(source, { config = {}, path = '' } = {}) {
  let document;
  try {
    document = parseWorkflowYaml(source);
  } catch (error) {
    if (path && error?.message) error.message = `${path}: ${error.message}`;
    throw error;
  }
  try {
    return normalizeWorkflow(document, config);
  } catch (error) {
    if (path && error?.message) error.message = `${path}: ${error.message}`;
    throw error;
  }
}
