import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateRepositoryLifecycle } from '../src/repository-lifecycle.mjs';
import { migrateSshKeys } from '../src/ssh-keys.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function shellToken(value) {
  const token = String(value);
  if (!/^[A-Za-z0-9_./:@+\-]+$/.test(token)) throw new Error('Unsafe SSH command path configuration.');
  return token;
}

const fingerprint = String(argument('--fingerprint') || '').trim();
if (!/^SHA256:[A-Za-z0-9+/]+$/.test(fingerprint)) process.exit(0);

const config = loadConfig();
const db = openDatabase(config);
try {
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateRepositoryLifecycle(db);
  migrateSshKeys(db);
  let key = db.prepare(`
    SELECT id, public_key AS publicKey, 'user' AS kind
    FROM user_ssh_keys WHERE fingerprint = ? AND revoked_at IS NULL
  `).get(fingerprint);
  if (!key) {
    key = db.prepare(`
      SELECT id, public_key AS publicKey, 'deploy' AS kind
      FROM repository_deploy_keys WHERE fingerprint = ? AND revoked_at IS NULL
    `).get(fingerprint);
  }
  if (!key) process.exit(0);
  const command = `${shellToken(config.nodeBinary)} ${shellToken(config.sshCommandScript)} --key-kind ${key.kind} --key-id ${key.id}`;
  const options = [
    'restrict',
    'no-port-forwarding',
    'no-agent-forwarding',
    'no-X11-forwarding',
    'no-pty',
    `command="${command}"`,
  ].join(',');
  process.stdout.write(`${options} ${key.publicKey} kukgit:${key.id}\n`);
} finally {
  db.close();
}
