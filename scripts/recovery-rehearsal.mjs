import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { listBackupSnapshots } from '../src/backups.mjs';
import { runRecoveryRehearsal } from '../src/recovery-rehearsal.mjs';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function resolveArchive(config, value) {
  if (value) {
    const candidate = path.resolve(value);
    if (fs.existsSync(candidate)) return candidate;
    const managed = path.join(config.backupsDir, path.basename(value));
    if (fs.existsSync(managed)) return managed;
    throw new Error(`Backup archive not found: ${value}`);
  }
  // No archive named: rehearse against the newest snapshot, which is the one a
  // real incident would reach for.
  const [latest] = listBackupSnapshots(config);
  if (!latest) throw new Error('No backup snapshots found. Run `npm run backup -- create` first.');
  return path.join(config.backupsDir, latest.filename);
}

function usage() {
  process.stdout.write(`KukGit production recovery rehearsal\n\n` +
    `  npm run rehearse -- [--archive <file>] [--target <empty-dir>] [--operator name]\n` +
    `                      [--evidence <file.json>] [--keep-target]\n\n` +
    `Restores a verified archive into a throwaway directory and proves the restored\n` +
    `instance is serviceable: every repository passes git fsck with its exact refs,\n` +
    `every Git LFS object matches its SHA-256, no credential is restored in the\n` +
    `clear, and the data-loss window against the live database is measured.\n\n` +
    `The live instance is never modified.\n`);
}

function summary(record) {
  const lines = [
    `archive          ${record.archive.filename} (${record.archive.backupId})`,
    `recovery time    ${record.recovery.recoveryTimeSeconds}s`,
    `data-loss window ${record.recovery.dataLossWindowSeconds}s since the snapshot`,
    `repositories     ${record.checks.repositories.passed}/${record.checks.repositories.checked} verified ` +
      `(${Object.entries(record.checks.repositories.coverage).map(([state, count]) => `${state}: ${count}`).join(', ') || 'none'})`,
    `git lfs          ${record.checks.lfs.verified}/${record.checks.lfs.checked} objects verified by SHA-256`,
    `credentials      ${record.checks.credentialsAtRest ? 'hashed and encrypted at rest' : 'FAILED'}`,
    `data loss        ${record.checks.dataLoss.identical ? 'none — live and restored databases match' : `${record.checks.dataLoss.rowsLost} rows across ${record.checks.dataLoss.changedTables.length} tables`}`,
    `automated result ${record.automatedResult.toUpperCase()}`,
  ];
  for (const failure of record.failures) lines.push(`  ! ${failure}`);
  lines.push('', 'Outstanding manual checks — the drill is not complete until these are signed off:');
  for (const check of record.manualChecks) lines.push(`  [ ] ${check.id}: ${check.description}`);
  return `${lines.join('\n')}\n`;
}

if (['help', '--help', '-h'].includes(process.argv[2])) {
  usage();
} else {
  const config = loadConfig();
  fs.mkdirSync(config.tempDir, { recursive: true, mode: 0o700 });
  const keepTarget = process.argv.includes('--keep-target');
  const target = argument('--target')
    ? path.resolve(argument('--target'))
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-rehearsal-')), 'restored');

  try {
    const archive = resolveArchive(config, argument('--archive'));
    const { record } = await runRecoveryRehearsal(config, {
      archivePath: archive,
      targetDir: target,
      operator: argument('--operator', process.env.USER || 'unknown'),
      keepTarget,
    });

    const evidencePath = path.resolve(argument('--evidence') || path.join(config.backupsDir, `rehearsal-${record.archive.backupId}.json`));
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(evidencePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });

    process.stdout.write(summary(record));
    process.stdout.write(`\nevidence         ${evidencePath}\n`);
    if (!keepTarget) process.stdout.write('restored copy    removed (pass --keep-target to inspect it)\n');
    else process.stdout.write(`restored copy    ${target}\n`);
    if (record.automatedResult !== 'passed') process.exitCode = 1;
  } catch (error) {
    if (!keepTarget) fs.rmSync(target, { recursive: true, force: true });
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  } finally {
    // The generated parent only ever holds the throwaway restore.
    if (!keepTarget && !argument('--target')) fs.rmSync(path.dirname(target), { recursive: true, force: true });
  }
}
