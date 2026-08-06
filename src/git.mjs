import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { assertBranch, assertSlug, httpError, safeRepoRelativePath, validateRemoteUrl } from './security.mjs';
import { importEnvironment, importHint, redactToken } from './repository-import.mjs';

function gitFailure(status, stdout, stderr, allowFailure) {
  if (status === 0 || allowFailure) return null;
  const detail = (stderr || stdout || 'Git command failed').trim();
  return httpError(400, detail.slice(0, 1000), 'GIT_ERROR');
}

function execGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
    timeout: options.timeout ?? 120000,
  });
  if (result.error) throw result.error;
  const failure = gitFailure(result.status, result.stdout, result.stderr, options.allowFailure);
  if (failure) throw failure;
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

// Non-blocking counterpart to execGit, for the operations that are slow enough
// to matter: a full clone, a fetch of an unknown remote, a merge.
//
// The read-only plumbing calls elsewhere in this module stay synchronous — they
// are single fast commands, and converting them would cascade `await` through
// twelve modules and seventeen test files for no measurable gain. What actually
// stalls the server is `withWorkingClone`, which clones an entire repository
// before it can commit or merge; on a large repository that blocks the event
// loop, and therefore every other request, for seconds.
function execGitAsync(args, options = {}) {
  const maxBuffer = options.maxBuffer ?? 20 * 1024 * 1024;
  const timeout = options.timeout ?? 120000;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let overflowed = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(httpError(504, 'Git command timed out.', 'GIT_TIMEOUT'));
    }, timeout);

    // Guard the same ceiling spawnSync enforces, so a runaway command cannot
    // grow the heap without bound.
    const collect = (stream, append) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        if (overflowed) return;
        const next = append(chunk);
        if (next > maxBuffer) {
          overflowed = true;
          child.kill('SIGKILL');
        }
      });
    };
    collect(child.stdout, (chunk) => (stdout += chunk).length);
    collect(child.stderr, (chunk) => (stderr += chunk).length);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (overflowed) {
        return reject(httpError(413, 'Git command produced too much output.', 'GIT_OUTPUT_TOO_LARGE'));
      }
      const failure = gitFailure(status, stdout, stderr, options.allowFailure);
      if (failure) return reject(failure);
      resolve({ stdout, stderr, status });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}

export function ensureGitAvailable() {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Git CLI is required but was not found.');
  return result.stdout.trim();
}

export function repoDiskPath(config, orgSlug, repoSlug) {
  assertSlug(orgSlug, 'organization slug');
  assertSlug(repoSlug, 'repository slug');
  return path.join(config.repositoriesDir, orgSlug, `${repoSlug}.git`);
}

export function createBareRepository(config, orgSlug, repoSlug) {
  const target = repoDiskPath(config, orgSlug, repoSlug);
  if (fs.existsSync(target)) throw httpError(409, 'Repository already exists on disk.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  execGit(['init', '--bare', '--initial-branch=main', target]);
  execGit(['--git-dir', target, 'config', 'http.receivepack', 'true']);
  execGit(['--git-dir', target, 'config', 'receive.denyNonFastForwards', 'true']);
  execGit(['--git-dir', target, 'update-server-info']);
  return target;
}

export function deleteBareRepository(config, orgSlug, repoSlug) {
  const target = repoDiskPath(config, orgSlug, repoSlug);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

// Mirror import clones an entire remote repository over the network, so it is the
// single longest-running Git operation KukGit performs. It must not block.
//
// `credential`, when given, is an access token for a private repository. It goes
// through the environment rather than the URL or the command line; see
// repository-import.mjs for why each of those is worse.
export async function importMirror(config, orgSlug, repoSlug, remoteUrl, { credential = null } = {}) {
  const source = validateRemoteUrl(remoteUrl);
  const target = repoDiskPath(config, orgSlug, repoSlug);
  if (fs.existsSync(target)) throw httpError(409, 'Repository already exists on disk.');
  const env = importEnvironment(source, credential);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let result;
  try {
    result = await execGitAsync(['clone', '--mirror', source, target], { allowFailure: true, maxBuffer: 50 * 1024 * 1024, timeout: 180000, env });
  } catch (error) {
    // A timeout or output overflow leaves a partial clone behind; clear it so a
    // retry is not blocked by the "already exists on disk" guard above.
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
  if (result.status !== 0) {
    fs.rmSync(target, { recursive: true, force: true });
    const detail = redactToken((result.stderr || result.stdout).trim(), credential).slice(0, 700);
    const hint = importHint(result.stderr || result.stdout, { hadToken: Boolean(credential) });
    throw httpError(400, `Import failed: ${detail}${hint ? ` — ${hint}` : ''}`, 'IMPORT_FAILED');
  }
  await execGitAsync(['--git-dir', target, 'config', 'http.receivepack', 'true']);
  await execGitAsync(['--git-dir', target, 'update-server-info']);
  return target;
}

export function repositoryExists(config, orgSlug, repoSlug) {
  return fs.existsSync(repoDiskPath(config, orgSlug, repoSlug));
}

export function listBranches(config, orgSlug, repoSlug) {
  const gitDir = repoDiskPath(config, orgSlug, repoSlug);
  const format = '%(refname:short)%09%(objectname:short)%09%(committerdate:iso-strict)%09%(authorname)%09%(subject)';
  const result = execGit(['--git-dir', gitDir, 'for-each-ref', '--sort=-committerdate', `--format=${format}`, 'refs/heads/'], { allowFailure: true });
  if (result.status !== 0) return [];
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [name, sha, committedAt, author, subject] = line.split('\t');
    return { name, sha, committedAt, author, subject };
  });
}

export function resolveRef(config, orgSlug, repoSlug, ref = 'main') {
  assertBranch(ref);
  const gitDir = repoDiskPath(config, orgSlug, repoSlug);
  const result = execGit(['--git-dir', gitDir, 'rev-parse', '--verify', `${ref}^{commit}`], { allowFailure: true });
  if (result.status !== 0) throw httpError(404, `Branch or ref '${ref}' was not found.`, 'REF_NOT_FOUND');
  return result.stdout.trim();
}

export function listCommits(config, orgSlug, repoSlug, ref = 'main', limit = 30) {
  const gitDir = repoDiskPath(config, orgSlug, repoSlug);
  resolveRef(config, orgSlug, repoSlug, ref);
  const count = Math.max(1, Math.min(Number(limit) || 30, 100));
  const format = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e';
  const result = execGit(['--git-dir', gitDir, 'log', ref, `--max-count=${count}`, `--format=${format}`]);
  return result.stdout.split('\x1e').map((row) => row.trim()).filter(Boolean).map((row) => {
    const [sha, shortSha, author, email, committedAt, subject] = row.split('\x1f');
    return { sha, shortSha, author, email, committedAt, subject };
  });
}

export function listTree(config, orgSlug, repoSlug, ref = 'main', directory = '') {
  const gitDir = repoDiskPath(config, orgSlug, repoSlug);
  resolveRef(config, orgSlug, repoSlug, ref);
  const cleanDir = directory ? safeRepoRelativePath(directory) : '';
  const treeish = cleanDir ? `${ref}:${cleanDir}` : ref;
  const result = execGit(['--git-dir', gitDir, 'ls-tree', '-l', treeish], { allowFailure: true });
  if (result.status !== 0) throw httpError(404, 'Directory not found.', 'TREE_NOT_FOUND');
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const match = line.match(/^(\d+)\s+(blob|tree|commit)\s+([0-9a-f]+)\s+(-|\d+)\t(.+)$/);
    if (!match) return null;
    const [, mode, type, sha, sizeRaw, name] = match;
    return { mode, type, sha, size: sizeRaw === '-' ? null : Number(sizeRaw), name, path: cleanDir ? `${cleanDir}/${name}` : name };
  }).filter(Boolean).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : 1));
}

export function readBlob(config, orgSlug, repoSlug, ref = 'main', filePath) {
  const gitDir = repoDiskPath(config, orgSlug, repoSlug);
  resolveRef(config, orgSlug, repoSlug, ref);
  const cleanPath = safeRepoRelativePath(filePath);
  const size = Number(execGit(['--git-dir', gitDir, 'cat-file', '-s', `${ref}:${cleanPath}`]).stdout.trim());
  if (size > 1024 * 1024) throw httpError(413, 'This file is too large to display in the browser.');
  const type = execGit(['--git-dir', gitDir, 'cat-file', '-t', `${ref}:${cleanPath}`]).stdout.trim();
  if (type !== 'blob') throw httpError(400, 'Requested path is not a file.');
  const content = execGit(['--git-dir', gitDir, 'show', `${ref}:${cleanPath}`], { maxBuffer: 2 * 1024 * 1024 }).stdout;
  const isBinary = content.includes('\0');
  return { path: cleanPath, size, isBinary, content: isBinary ? '' : content };
}

export function createBranch(config, orgSlug, repoSlug, name, fromRef = 'main') {
  assertBranch(name);
  assertBranch(fromRef);
  const gitDir = repoDiskPath(config, orgSlug, repoSlug);
  const sha = resolveRef(config, orgSlug, repoSlug, fromRef);
  const existing = execGit(['--git-dir', gitDir, 'show-ref', '--verify', `refs/heads/${name}`], { allowFailure: true });
  if (existing.status === 0) throw httpError(409, 'Branch already exists.');
  execGit(['--git-dir', gitDir, 'update-ref', `refs/heads/${name}`, sha]);
  return { name, sha, fromRef };
}

async function withWorkingClone(config, orgSlug, repoSlug, callback) {
  fs.mkdirSync(config.tempDir, { recursive: true });
  const temp = fs.mkdtempSync(path.join(config.tempDir, 'work-'));
  try {
    const origin = repoDiskPath(config, orgSlug, repoSlug);
    // The clone dominates the cost of every browser commit and merge. Running it
    // through execGitAsync is the whole point of this path being async.
    await execGitAsync(['clone', origin, temp]);
    await execGitAsync(['config', 'user.name', 'KukGit'], { cwd: temp });
    await execGitAsync(['config', 'user.email', 'noreply@kuklabs.com'], { cwd: temp });
    return await callback(temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export async function commitFile(config, orgSlug, repoSlug, { branch, filePath, content, message, authorName, authorEmail }) {
  assertBranch(branch);
  const cleanPath = safeRepoRelativePath(filePath);
  if (String(content).length > 1024 * 1024) throw httpError(413, 'File content exceeds the 1 MB web editor limit.');
  return withWorkingClone(config, orgSlug, repoSlug, async (cwd) => {
    await execGitAsync(['checkout', branch], { cwd });
    const target = path.join(cwd, ...cleanPath.split('/'));
    const relative = path.relative(cwd, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw httpError(400, 'Invalid file path.');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(content), 'utf8');
    await execGitAsync(['add', '--', cleanPath], { cwd });
    const status = (await execGitAsync(['status', '--porcelain'], { cwd })).stdout.trim();
    if (!status) throw httpError(409, 'No file changes were detected.');
    await execGitAsync(['commit', '-m', String(message || `Update ${cleanPath}`)], {
      cwd,
      env: {
        GIT_AUTHOR_NAME: authorName || 'KukGit User',
        GIT_AUTHOR_EMAIL: authorEmail || 'noreply@kuklabs.com',
        GIT_COMMITTER_NAME: authorName || 'KukGit User',
        GIT_COMMITTER_EMAIL: authorEmail || 'noreply@kuklabs.com',
      },
    });
    await execGitAsync(['push', 'origin', branch], { cwd });
    const sha = (await execGitAsync(['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    return { sha, shortSha: sha.slice(0, 7), branch, path: cleanPath };
  });
}

export function compareBranches(config, orgSlug, repoSlug, baseBranch, headBranch) {
  assertBranch(baseBranch);
  assertBranch(headBranch);
  const gitDir = repoDiskPath(config, orgSlug, repoSlug);
  resolveRef(config, orgSlug, repoSlug, baseBranch);
  resolveRef(config, orgSlug, repoSlug, headBranch);
  const status = execGit(['--git-dir', gitDir, 'diff', '--name-status', `${baseBranch}...${headBranch}`]).stdout;
  const stat = execGit(['--git-dir', gitDir, 'diff', '--stat', `${baseBranch}...${headBranch}`]).stdout.trim();
  const files = status.trim().split('\n').filter(Boolean).map((line) => {
    const [change, ...parts] = line.split('\t');
    return { change, path: parts.at(-1), previousPath: parts.length > 1 ? parts[0] : null };
  });
  const ahead = Number(execGit(['--git-dir', gitDir, 'rev-list', '--count', `${baseBranch}..${headBranch}`]).stdout.trim() || 0);
  const behind = Number(execGit(['--git-dir', gitDir, 'rev-list', '--count', `${headBranch}..${baseBranch}`]).stdout.trim() || 0);
  return { files, stat, ahead, behind };
}

export async function mergeBranches(config, orgSlug, repoSlug, { baseBranch, headBranch, title, authorName, authorEmail }) {
  assertBranch(baseBranch);
  assertBranch(headBranch);
  if (baseBranch === headBranch) throw httpError(400, 'Base and head branches must be different.');
  return withWorkingClone(config, orgSlug, repoSlug, async (cwd) => {
    await execGitAsync(['checkout', baseBranch], { cwd });
    const remoteHead = `origin/${headBranch}`;
    const remoteHeadExists = await execGitAsync(['show-ref', '--verify', `refs/remotes/${remoteHead}`], { cwd, allowFailure: true });
    if (remoteHeadExists.status !== 0) {
      throw httpError(404, `Pull request head branch '${headBranch}' was not found in the repository clone.`, 'HEAD_BRANCH_NOT_FOUND');
    }
    const result = await execGitAsync(['merge', '--no-ff', remoteHead, '-m', title || `Merge ${headBranch} into ${baseBranch}`], {
      cwd,
      allowFailure: true,
      env: {
        GIT_AUTHOR_NAME: authorName || 'KukGit User',
        GIT_AUTHOR_EMAIL: authorEmail || 'noreply@kuklabs.com',
        GIT_COMMITTER_NAME: authorName || 'KukGit User',
        GIT_COMMITTER_EMAIL: authorEmail || 'noreply@kuklabs.com',
      },
    });
    if (result.status !== 0) {
      await execGitAsync(['merge', '--abort'], { cwd, allowFailure: true });
      throw httpError(409, 'Merge conflict detected. Resolve it locally and push the result.', 'MERGE_CONFLICT');
    }
    await execGitAsync(['push', 'origin', baseBranch], { cwd });
    const sha = (await execGitAsync(['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    return { sha, shortSha: sha.slice(0, 7), baseBranch, headBranch };
  });
}

export async function createDemoCommit(config, orgSlug, repoSlug) {
  return withWorkingClone(config, orgSlug, repoSlug, async (cwd) => {
    const current = (await execGitAsync(['branch', '--show-current'], { cwd })).stdout.trim();
    if (!current) await execGitAsync(['checkout', '-b', 'main'], { cwd });
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'README.md'), `# KukGit Demo\n\nThis repository is hosted on **KukGit**.\n\n- Real bare Git repository\n- Browser code explorer\n- Issues and pull requests\n- Repository health analysis\n`, 'utf8');
    fs.writeFileSync(path.join(cwd, 'src', 'hello.js'), `export function hello(name = 'developer') {\n  return \`Welcome to KukGit, \${name}!\`;\n}\n`, 'utf8');
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'kukgit-demo', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
    fs.writeFileSync(path.join(cwd, '.github', 'workflows', 'ci.yml'), `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: npm test\n`, 'utf8');
    await execGitAsync(['add', '.'], { cwd });
    await execGitAsync(['commit', '-m', 'Initial KukGit demo repository'], { cwd });
    await execGitAsync(['push', 'origin', 'main'], { cwd });
    return (await execGitAsync(['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  });
}

export function walkRepositoryFiles(config, orgSlug, repoSlug, ref = 'main') {
  const gitDir = repoDiskPath(config, orgSlug, repoSlug);
  resolveRef(config, orgSlug, repoSlug, ref);
  const output = execGit(['--git-dir', gitDir, 'ls-tree', '-r', '-l', ref], { maxBuffer: 20 * 1024 * 1024 }).stdout;
  return output.trim().split('\n').filter(Boolean).map((line) => {
    const match = line.match(/^(\d+)\s+blob\s+([0-9a-f]+)\s+(\d+)\t(.+)$/);
    return match ? { mode: match[1], sha: match[2], size: Number(match[3]), path: match[4] } : null;
  }).filter(Boolean);
}

export function readBlobBySha(config, orgSlug, repoSlug, sha, maxBytes = 262144) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw httpError(400, 'Invalid Git object SHA.');
  const gitDir = repoDiskPath(config, orgSlug, repoSlug);
  const size = Number(execGit(['--git-dir', gitDir, 'cat-file', '-s', sha]).stdout.trim());
  if (size > maxBytes) return null;
  const content = execGit(['--git-dir', gitDir, 'cat-file', '-p', sha], { maxBuffer: maxBytes + 1024 }).stdout;
  if (content.includes('\0')) return null;
  return content;
}

export function spawnGitHttpBackend({ env }) {
  return spawn('git', ['http-backend'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
}
