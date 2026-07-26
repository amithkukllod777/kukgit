import fs from 'node:fs';
import path from 'node:path';
import {
  exportPostgresMigrationBundle,
  verifyPostgresMigrationBundle,
} from './database-portability.mjs';
import { httpError } from './security.mjs';

function assertNoSymlinks(root) {
  const base = path.resolve(root);
  if (!fs.existsSync(base)) return;
  const rootStat = fs.lstatSync(base);
  if (rootStat.isSymbolicLink()) {
    throw httpError(400, 'Migration bundle root must not be a symbolic link.', 'DB_BUNDLE_SYMLINK_UNSUPPORTED');
  }
  if (!rootStat.isDirectory()) {
    throw httpError(400, 'Migration bundle root must be a directory.', 'DB_BUNDLE_ROOT_INVALID');
  }

  const stack = [base];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const relative = path.relative(base, absolute).split(path.sep).join('/');
        throw httpError(400, `Migration bundle path '${relative}' must not be a symbolic link.`, 'DB_BUNDLE_SYMLINK_UNSUPPORTED');
      }
      if (stat.isDirectory()) stack.push(absolute);
      else if (!stat.isFile()) {
        const relative = path.relative(base, absolute).split(path.sep).join('/');
        throw httpError(400, `Migration bundle path '${relative}' is not a regular file.`, 'DB_BUNDLE_FILE_TYPE_UNSUPPORTED');
      }
    }
  }
}

export async function verifySafePostgresMigrationBundle(bundleDir) {
  assertNoSymlinks(bundleDir);
  return verifyPostgresMigrationBundle(bundleDir);
}

export async function exportSafePostgresMigrationBundle(db, outputDir, options = {}) {
  const result = await exportPostgresMigrationBundle(db, outputDir, options);
  await verifySafePostgresMigrationBundle(result.outputDir);
  return result;
}
