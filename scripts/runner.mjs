import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AGENT_DEFAULTS, createRunnerClient, executeJob } from '../src/runner-agent.mjs';
import { KUKGIT_VERSION } from '../src/version.mjs';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function usage() {
  process.stdout.write(`KukGit self-hosted runner ${KUKGIT_VERSION}\n\n` +
    `  npm run runner -- --url https://git.example.com --token kgr_...\n\n` +
    `Options:\n` +
    `  --url <base-url>       KukGit instance (or KUKGIT_URL)\n` +
    `  --token <kgr_...>      Runner token from Settings → Runners (or KUKGIT_RUNNER_TOKEN)\n` +
    `  --labels a,b           Claim only for these labels; defaults to every registered label\n` +
    `  --work <dir>           Workspace root (default: a temporary directory)\n` +
    `  --poll <seconds>       Idle poll interval (default 5)\n` +
    `  --once                 Run one job and exit\n\n` +
    `This runner executes jobs on THIS machine with the privileges of the user\n` +
    `running it. There is no sandbox. Run it only for repositories whose code you\n` +
    `already trust, on a machine you are willing to lose.\n`);
}

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

// Clones the repository at the exact commit the run was created for. A shallow
// fetch of one commit rather than a full clone: a runner needs the tree that was
// built, not the history.
function prepareWorkspace({ credential }) {
  return async ({ workspace, run, onOutput }) => {
    const git = (args) => new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk) => onOutput({ stream: 'stdout', content: chunk.toString('utf8') }));
      child.stderr.on('data', (chunk) => onOutput({ stream: 'stderr', content: chunk.toString('utf8') }));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args[0]} exited with ${code}`))));
    });

    await git(['init', '--quiet']);
    // The credential goes in a header argument, not in the URL: a URL with a
    // token in it ends up in the remote config, in reflogs and in error output.
    await git([
      '-c', `http.extraHeader=Authorization: Bearer ${credential}`,
      'fetch', '--depth', '1', run.cloneUrl, run.commitSha,
    ]);
    await git(['checkout', '--quiet', 'FETCH_HEAD']);
  };
}

const baseUrl = argument('--url', process.env.KUKGIT_URL || '');
const runnerToken = argument('--token', process.env.KUKGIT_RUNNER_TOKEN || '');

if (['help', '--help', '-h'].includes(process.argv[2]) || !baseUrl || !runnerToken) {
  usage();
  if (!baseUrl || !runnerToken) {
    process.stderr.write('\n--url and --token are required.\n');
    process.exitCode = 1;
  }
} else {
  const labels = argument('--labels') ? String(argument('--labels')).split(',').map((label) => label.trim()).filter(Boolean) : null;
  const pollMs = Math.max(1000, Number(argument('--poll', 5)) * 1000 || AGENT_DEFAULTS.pollIntervalMs);
  const workRoot = argument('--work') ? path.resolve(argument('--work')) : null;
  const once = process.argv.includes('--once');
  const client = createRunnerClient({ baseUrl, runnerToken });

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (stopping) process.exit(1);
      stopping = true;
      log('shutting down after the current job');
    });
  }

  log(`connecting to ${baseUrl}`);
  log('no sandbox: jobs run as this user, on this machine');

  while (!stopping) {
    let claimed = null;
    try {
      claimed = await client.claim(labels);
    } catch (error) {
      log(`claim failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    if (!claimed) {
      if (once) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    const workspace = workRoot
      ? path.join(workRoot, claimed.run.id)
      : fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-job-'));
    log(`claimed ${claimed.run.repository} ${claimed.job.key} (${claimed.run.id})`);

    try {
      const result = await executeJob(client, claimed, {
        workspaceRoot: workspace,
        prepareWorkspace: prepareWorkspace({ credential: claimed.token }),
      });
      log(`${claimed.job.key}: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`);
    } finally {
      // The workspace held a checkout of the repository and whatever the build
      // wrote. It is removed unless an operator asked to keep it.
      if (!workRoot) fs.rmSync(workspace, { recursive: true, force: true });
    }

    if (once) break;
  }

  log('stopped');
}
