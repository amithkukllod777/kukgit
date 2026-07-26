import fs from 'node:fs';
import path from 'node:path';
import { audit, openDatabase } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import {
  createVerifiedBackup,
  getMaintenanceState,
  listBackupSnapshots,
  pruneBackupSnapshots,
  restoreBackupArchive,
  setMaintenanceState,
  verifyBackupArchive,
} from '../src/backups.mjs';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function numberArgument(name, fallback) {
  const raw = argument(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number.`);
  return value;
}

function archivePath(config, value) {
  if (!value) throw new Error('--archive is required.');
  const candidate = path.resolve(value);
  if (fs.existsSync(candidate)) return candidate;
  const managed = path.join(config.backupsDir, path.basename(value));
  if (fs.existsSync(managed)) return managed;
  throw new Error(`Backup archive not found: ${value}`);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  process.stdout.write(`KukGit backup administration\n\n` +
    `  npm run backup -- create\n` +
    `  npm run backup -- list\n` +
    `  npm run backup -- verify --archive <file>\n` +
    `  npm run backup -- restore --archive <file> --target <empty-dir> [--dry-run]\n` +
    `  npm run backup -- prune [--keep 14] [--days 30]\n` +
    `  npm run backup -- maintenance <on|off|status> [--reason text]\n`);
}

const command = process.argv[2];
const config = loadConfig();
fs.mkdirSync(config.tempDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(config.backupsDir, { recursive: true, mode: 0o700 });

try {
  if (!command || ['help', '--help', '-h'].includes(command)) {
    usage();
  } else if (command === 'create') {
    const db = openDatabase(config);
    try {
      const backup = await createVerifiedBackup(config, db);
      audit(db, {
        action: 'backup.created_cli',
        targetType: 'backup',
        targetId: backup.backupId,
        metadata: { filename: backup.filename, archiveSha256: backup.archiveSha256, totals: backup.totals },
      });
      print(backup);
    } finally {
      db.close();
    }
  } else if (command === 'list') {
    print({ backups: listBackupSnapshots(config), policy: { retentionCount: config.backupRetentionCount, retentionDays: config.backupRetentionDays } });
  } else if (command === 'verify') {
    print(await verifyBackupArchive(config, archivePath(config, argument('--archive'))));
  } else if (command === 'restore') {
    const target = argument('--target');
    if (!target) throw new Error('--target is required. Restore only writes to a missing or empty directory.');
    print(await restoreBackupArchive(config, archivePath(config, argument('--archive')), path.resolve(target), { dryRun: process.argv.includes('--dry-run') }));
  } else if (command === 'prune') {
    print(pruneBackupSnapshots(config, {
      keep: numberArgument('--keep', config.backupRetentionCount),
      days: numberArgument('--days', config.backupRetentionDays),
    }));
  } else if (command === 'maintenance') {
    const action = process.argv[3] || 'status';
    if (action === 'status') print(getMaintenanceState(config));
    else if (action === 'on') print(setMaintenanceState(config, true, { reason: argument('--reason', 'KukGit maintenance in progress.'), actor: 'backup-cli' }));
    else if (action === 'off') print(setMaintenanceState(config, false));
    else throw new Error('Maintenance action must be on, off or status.');
  } else {
    throw new Error(`Unknown backup command '${command}'.`);
  }
} catch (error) {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
}
