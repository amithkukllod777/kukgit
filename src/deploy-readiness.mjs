import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

export const DEPLOY_READINESS = {
  minimumNode: [22, 5, 0],
  minimumKeyLength: 32,
  minimumFreeBytes: 5 * 1024 * 1024 * 1024,
};

/**
 * The independent keys an instance needs, and what each one protects.
 *
 * Named here rather than only in the documentation, because a checklist a person
 * reads is a checklist a person skips. Every one of these is a thing that
 * silently half-works when unset: features stay off, or start and fail on the
 * first request that needs them.
 */
export const REQUIRED_KEYS = [
  ['KUKGIT_AUTHKIT_ENCRYPTION_KEY', 'encrypts AuthKit access and refresh tokens at rest'],
  ['KUKGIT_SECRETS_ENCRYPTION_KEY', 'encrypts the secrets vault; a backup holds the ciphertext, not this'],
  ['KUKGIT_WEBHOOK_ENCRYPTION_KEY', 'encrypts webhook signing secrets'],
  ['KUKGIT_LFS_AUTH_KEY', 'signs the short-lived tokens Git LFS over SSH exchanges'],
  ['KUKGIT_EMAIL_PROVIDER_WEBHOOK_SECRET', 'verifies delivery events arriving from the mail provider'],
];

function check(id, status, message, fix = null) {
  return { id, status, message, fix };
}

function nodeVersion() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const [wantMajor, wantMinor] = DEPLOY_READINESS.minimumNode;
  const ok = major > wantMajor || (major === wantMajor && minor >= wantMinor);
  return ok
    ? check('node', 'pass', `Node ${process.versions.node}`)
    : check('node', 'fail', `Node ${process.versions.node} is too old; node:sqlite needs ${DEPLOY_READINESS.minimumNode.join('.')}+.`,
      `Install Node ${wantMajor}.${wantMinor} or newer. Nothing else here will work first.`);
}

function gitVersion() {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) {
    return check('git', 'fail', 'The git CLI was not found on PATH.', 'Install git. KukGit shells out to it for every repository operation.');
  }
  return check('git', 'pass', result.stdout.trim());
}

function environmentValue(name) {
  return String(process.env[name] ?? '').trim();
}

/**
 * Checks the keys exist, are long enough, and are **different from each other**.
 *
 * The last one is the check that does not exist anywhere else. The instructions
 * say "generate each one separately"; the way that goes wrong is somebody
 * running the generator once and pasting the same value five times, which looks
 * completely correct in an environment file. Every key is long, every key is
 * random, and one compromise opens all of them.
 */
function keyChecks(isProduction) {
  const results = [];
  const seen = new Map();
  for (const [name, purpose] of REQUIRED_KEYS) {
    const value = environmentValue(name);
    if (!value) {
      results.push(check(name, isProduction ? 'fail' : 'warn', `${name} is not set — ${purpose}.`,
        `KUKGIT_${name.replace(/^KUKGIT_/, '')}=$(openssl rand -base64 48)`));
      continue;
    }
    if (value.length < DEPLOY_READINESS.minimumKeyLength) {
      results.push(check(name, 'fail', `${name} is shorter than ${DEPLOY_READINESS.minimumKeyLength} characters.`,
        'Generate a new one: openssl rand -base64 48'));
      continue;
    }
    const fingerprint = crypto.createHash('sha256').update(value).digest('hex');
    if (seen.has(fingerprint)) {
      results.push(check(name, 'fail', `${name} is the same value as ${seen.get(fingerprint)}.`,
        'Generate each key separately. Reusing one means a single compromise opens more than one kind of stored material.'));
      continue;
    }
    seen.set(fingerprint, name);
    results.push(check(name, 'pass', `${name} is set and distinct.`));
  }
  return results;
}

function baseUrlCheck(isProduction) {
  const value = environmentValue('KUKGIT_BASE_URL');
  if (!value) {
    return check('base_url', isProduction ? 'fail' : 'warn', 'KUKGIT_BASE_URL is not set.',
      'KUKGIT_BASE_URL=https://git.example.com — it is what every clone URL, cookie and redirect is built from.');
  }
  let url;
  try { url = new URL(value); } catch {
    return check('base_url', 'fail', `KUKGIT_BASE_URL is not a URL: ${value}`, 'Set an absolute URL including the scheme.');
  }
  if (isProduction && url.protocol !== 'https:') {
    return check('base_url', 'fail', 'KUKGIT_BASE_URL is not HTTPS.',
      'Terminate TLS in front of KukGit and set the https URL here. Git credentials travel over this.');
  }
  return check('base_url', 'pass', `Base URL ${url.origin}`);
}

/**
 * Which identity backend this instance runs on.
 *
 * Both are supported and neither is a warning by itself. KukGit owns its own
 * accounts; Kuklabs Account is an optional sign-in path. What is checked is
 * that whichever one is chosen has what it needs.
 */
function authModeCheck(isProduction) {
  const mode = environmentValue('KUKGIT_AUTH_MODE') || (isProduction ? 'authkit' : 'local');
  if (mode === 'authkit') {
    if (!environmentValue('KUKGIT_AUTHKIT_BASE_URL')) {
      return check('auth_mode', 'fail', 'Auth mode is authkit with no AuthKit URL set.',
        'KUKGIT_AUTHKIT_BASE_URL=<the Kuklabs Account base URL>');
    }
    return check('auth_mode', 'pass', 'Auth mode is authkit.');
  }
  if (mode !== 'local') {
    return check('auth_mode', 'fail', `Auth mode '${mode}' is not a mode.`, 'KUKGIT_AUTH_MODE=local or authkit');
  }
  if (!isProduction) return check('auth_mode', 'pass', 'Auth mode is local.');
  // Holding passwords means sending the mail that proves an address and resets
  // one. Without a way to send it, "verified email" is a claim nobody can act
  // on and a forgotten password is an account nobody can get back into.
  if (!emailIsDeliverable()) {
    return check('auth_mode', 'fail', 'KukGit holds the passwords here, and nothing is configured to send email.',
      'Set up Resend or SMTP — without it nobody can verify an address or reset a password.');
  }
  return check('auth_mode', 'pass', 'Auth mode is local, with email delivery configured.');
}

/**
 * Whether anything is set up to actually send a message.
 *
 * Both places are checked, and the second one is the one that matters. SMTP
 * lives in the environment, but **Resend is configured in the admin console** —
 * `email.resend` in `instance_settings` — which is where a running instance
 * normally has it. A version of this that read only the environment reported
 * "nothing is configured to send email" on an instance whose email worked
 * perfectly, and because this check blocks a deploy, that would have stopped a
 * healthy server from being upgraded. A pre-flight that fails on a working box
 * is one people learn to skip.
 *
 * The database is opened read-only and every failure means "cannot tell from
 * here", which falls through to the environment answer. A missing file is a
 * fresh install, where the environment really is the only signal.
 */
function emailIsDeliverable() {
  if (environmentValue('KUKGIT_RESEND_API_KEY') || environmentValue('KUKGIT_SMTP_HOST')) return true;
  return emailConfiguredInDatabase();
}

function emailConfiguredInDatabase() {
  const dataDir = path.resolve(environmentValue('KUKGIT_DATA_DIR') || path.join(process.cwd(), 'data'));
  const databasePath = environmentValue('KUKGIT_DATABASE_PATH') || path.join(dataDir, 'kukgit.db');
  let db;
  try {
    // Read-only, which also means a missing file throws rather than creating
    // one — a pre-flight check must not leave a database behind.
    db = new DatabaseSync(databasePath, { readOnly: true });
    // Both, matching `resendConfigured`: a key with nothing to send from fails
    // on the first message and looks like an outage rather than a setting
    // somebody never finished.
    const row = db.prepare(`
      SELECT COUNT(DISTINCT field) AS count FROM instance_settings
      WHERE integration = 'email.resend' AND field IN ('apiKey', 'fromAddress')
    `).get();
    return Number(row?.count ?? 0) >= 2;
  } catch {
    // No such table on a database from before the settings existed, a lock, a
    // permission problem. None of those is evidence that email is configured.
    return false;
  } finally {
    try { db?.close(); } catch { /* already gone */ }
  }
}

/**
 * The development Git token grants **admin on every repository**.
 *
 * It is refused when `NODE_ENV=production`, so this is not a production hole —
 * but an internal trial instance is exactly where somebody runs without
 * `NODE_ENV` set, and the default value is published in this repository.
 */
function developmentTokenCheck(isProduction) {
  const value = environmentValue('KUKGIT_DEV_GIT_TOKEN');
  if (isProduction) return check('dev_git_token', 'pass', 'Production: the development Git token is refused.');
  if (!value || value === 'kukgit-dev-token-change-me') {
    return check('dev_git_token', 'fail', 'The development Git token is still the published default, and it grants admin on every repository.',
      'Set NODE_ENV=production, or set KUKGIT_DEV_GIT_TOKEN to something private.');
  }
  return check('dev_git_token', 'warn', 'A custom development Git token is set. It still grants admin on every repository.',
    'Set NODE_ENV=production once real work is on this instance.');
}

function adminPasswordCheck(isProduction, authMode) {
  const value = environmentValue('KUKGIT_ADMIN_PASSWORD');
  if (authMode === 'authkit') return check('admin_password', 'pass', 'AuthKit mode: the local founder password is unused.');
  if (!value || value === 'KukGit@2026') {
    return check('admin_password', isProduction ? 'fail' : 'warn', 'The founder password is unset or still the published default.',
      'KUKGIT_ADMIN_PASSWORD=<something long and private>');
  }
  return check('admin_password', 'pass', 'A founder password is set.');
}

/**
 * The data directory: writable, private, and **not inside a git checkout**.
 *
 * That last one is the mistake that loses everything. A data directory under the
 * deployment checkout looks convenient and works perfectly until the first
 * deploy that does a clean checkout, at which point every repository, every LFS
 * object and the database are gone together.
 */
function dataDirectoryChecks(repositoryRoot) {
  const results = [];
  const dataDir = path.resolve(environmentValue('KUKGIT_DATA_DIR') || path.join(repositoryRoot, 'data'));

  if (!fs.existsSync(dataDir)) {
    results.push(check('data_dir', 'warn', `${dataDir} does not exist yet; it will be created on first start.`));
  } else {
    try {
      fs.accessSync(dataDir, fs.constants.W_OK);
      const mode = fs.statSync(dataDir).mode & 0o777;
      results.push(mode & 0o007
        ? check('data_dir', 'fail', `${dataDir} is world-accessible (mode ${mode.toString(8)}).`, `chmod 750 ${dataDir}`)
        : check('data_dir', 'pass', `${dataDir} is writable and not world-accessible.`));
    } catch {
      results.push(check('data_dir', 'fail', `${dataDir} is not writable by this user.`, `chown the directory to the user running KukGit.`));
    }
  }

  const inCheckout = dataDir === repositoryRoot || dataDir.startsWith(`${repositoryRoot}${path.sep}`);
  results.push(inCheckout
    ? check('data_dir_location', 'fail', `${dataDir} is inside the source checkout.`,
      'KUKGIT_DATA_DIR=/var/lib/kukgit — a deploy that checks out cleanly will otherwise delete every repository, every LFS object and the database together.')
    : check('data_dir_location', 'pass', 'The data directory is outside the source checkout.'));

  return results;
}

function diskCheck(target) {
  try {
    const stat = fs.statfsSync(fs.existsSync(target) ? target : path.dirname(target));
    const free = stat.bavail * stat.bsize;
    const gigabytes = (free / 1024 ** 3).toFixed(1);
    return free < DEPLOY_READINESS.minimumFreeBytes
      ? check('disk', 'warn', `${gigabytes} GiB free where the data directory lives.`,
        'Git repositories and LFS objects only grow. Size the volume before the first import, not after.')
      : check('disk', 'pass', `${gigabytes} GiB free.`);
  } catch (error) {
    return check('disk', 'warn', `Could not measure free space: ${error.message}`);
  }
}

function rateLimitCheck(isProduction) {
  const enabled = environmentValue('KUKGIT_RATE_LIMIT_ENABLED');
  const trustProxy = environmentValue('KUKGIT_TRUST_PROXY');
  if (isProduction && enabled === 'false') {
    return check('rate_limit', 'fail', 'Rate limiting is switched off in production.',
      'Unset KUKGIT_RATE_LIMIT_ENABLED. It is the brute-force and abuse-flood control.');
  }
  if (isProduction && trustProxy !== 'true') {
    // Behind a proxy every request arrives from the proxy's address, so one
    // bucket holds the whole internet and the limiter protects nobody.
    return check('rate_limit', 'warn', 'KUKGIT_TRUST_PROXY is not set. Behind a reverse proxy every caller shares one rate-limit bucket.',
      'Set KUKGIT_TRUST_PROXY=true only if a proxy you control sets X-Forwarded-For.');
  }
  return check('rate_limit', 'pass', 'Rate limiting is on.');
}

function portCheck(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve(error.code === 'EADDRINUSE'
      ? check('port', 'fail', `Port ${port} is already in use.`, 'Stop whatever holds it, or set PORT.')
      : check('port', 'warn', `Could not bind port ${port}: ${error.message}`)));
    server.once('listening', () => server.close(() => resolve(check('port', 'pass', `Port ${port} is free.`))));
    server.listen(port, '127.0.0.1');
  });
}

function backupCheck() {
  const dir = environmentValue('KUKGIT_BACKUPS_DIR');
  if (!dir) {
    return check('backups', 'warn', 'KUKGIT_BACKUPS_DIR is unset; backups land beside the data directory.',
      'Point it at different storage. A backup on the volume it protects is not a backup.');
  }
  const dataDir = path.resolve(environmentValue('KUKGIT_DATA_DIR') || 'data');
  return path.resolve(dir).startsWith(dataDir)
    ? check('backups', 'warn', 'Backups are written inside the data directory they protect.',
      'A lost volume takes the backups with it. Point KUKGIT_BACKUPS_DIR at separate storage.')
    : check('backups', 'pass', `Backups go to ${path.resolve(dir)}.`);
}

/**
 * Everything a box needs before KukGit is worth starting on it.
 *
 * Every failure carries the command or the line that fixes it. A checklist that
 * reports a problem without saying what to do about it just moves the work.
 */
export async function deployReadiness({ repositoryRoot = process.cwd(), port = Number(process.env.PORT) || 8787 } = {}) {
  const isProduction = environmentValue('NODE_ENV') === 'production';
  const authMode = environmentValue('KUKGIT_AUTH_MODE') || 'local';
  const dataDir = path.resolve(environmentValue('KUKGIT_DATA_DIR') || path.join(repositoryRoot, 'data'));

  const checks = [
    nodeVersion(),
    gitVersion(),
    baseUrlCheck(isProduction),
    authModeCheck(isProduction),
    adminPasswordCheck(isProduction, authMode),
    developmentTokenCheck(isProduction),
    ...keyChecks(isProduction),
    ...dataDirectoryChecks(repositoryRoot),
    diskCheck(dataDir),
    backupCheck(),
    rateLimitCheck(isProduction),
    await portCheck(port),
  ];

  const failed = checks.filter((entry) => entry.status === 'fail');
  const warned = checks.filter((entry) => entry.status === 'warn');
  return {
    mode: isProduction ? 'production' : 'development',
    host: os.hostname(),
    checks,
    failed: failed.length,
    warned: warned.length,
    passed: checks.length - failed.length - warned.length,
    // Ready means nothing failed. Warnings are deliberately not fatal: most of
    // them are correct choices for an internal trial and wrong for real users,
    // and a check that blocks on both stops being read.
    ready: failed.length === 0,
  };
}
