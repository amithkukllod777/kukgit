import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateRepositoryLifecycle } from '../src/repository-lifecycle.mjs';
import { generateAuthorizedKeys, migrateSshKeys } from '../src/ssh-keys.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const config = loadConfig();
const db = openDatabase(config);
try {
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateRepositoryLifecycle(db);
  migrateSshKeys(db);
  const content = generateAuthorizedKeys(db, config);
  if (process.argv.includes('--stdout')) {
    process.stdout.write(content);
  } else {
    const destination = path.resolve(argument('--output') || config.authorizedKeysPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
    console.log(`KukGit authorized_keys updated: ${destination}`);
  }
} finally {
  db.close();
}
