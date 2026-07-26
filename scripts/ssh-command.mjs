import { spawnSync } from 'node:child_process';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateRepositoryLifecycle } from '../src/repository-lifecycle.mjs';
import { authorizeSshCommand, migrateSshKeys } from '../src/ssh-keys.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const config = loadConfig();
const keyKind = argument('--key-kind');
const keyId = argument('--key-id');
const originalCommand = process.env.SSH_ORIGINAL_COMMAND || '';
const db = openDatabase(config);

try {
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateRepositoryLifecycle(db);
  migrateSshKeys(db);
  const authorization = authorizeSshCommand(db, config, { keyKind, keyId, originalCommand });
  db.close();

  const subcommand = authorization.command.service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
  const environment = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/home/git',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || 'C.UTF-8',
  };
  if (process.env.GIT_PROTOCOL && /^[A-Za-z0-9=:.\-]+$/.test(process.env.GIT_PROTOCOL)) {
    environment.GIT_PROTOCOL = process.env.GIT_PROTOCOL;
  }
  const result = spawnSync('git', [subcommand, authorization.gitDirectory], {
    stdio: 'inherit',
    env: environment,
    timeout: 30 * 60 * 1000,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} catch (error) {
  try { db.close(); } catch {}
  const message = Number(error.status) >= 500
    ? 'KukGit SSH service encountered an internal error.'
    : String(error.message || 'KukGit SSH command was rejected.');
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
