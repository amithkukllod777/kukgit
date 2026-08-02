#!/usr/bin/env node
import process from 'node:process';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { migrateSecretScanning, findingSummary } from '../src/secret-scanning.mjs';
import { repositoriesToScan, scanCurrentTrees, scanFullHistory } from '../src/secret-backfill.mjs';

const USAGE = `KukGit secret scan backfill

  npm run scan                        every repository, current branch tips
  npm run scan -- --repo org/name     one repository
  npm run scan -- --history           every commit as well: slow, finds removed credentials

Push scanning only ever sees what a push introduced, so a credential committed
before scanning existed is invisible until the file is next touched. This finds
those.

Nothing is blocked and nothing is deleted. Findings land in the same list the
API serves, and the secret itself is never stored.
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }

const repoFlag = args.indexOf('--repo');
const target = repoFlag >= 0 ? String(args[repoFlag + 1] || '') : '';
const [orgSlug, repoSlug] = target.includes('/') ? target.split('/') : [null, null];
if (repoFlag >= 0 && !repoSlug) {
  console.error('--repo takes org/name');
  process.exit(1);
}
const full = args.includes('--history');

const config = loadConfig();
const db = openDatabase(config);
migrateSecretScanning(db);

try {
  const repositories = repositoriesToScan(db, { orgSlug, repoSlug });
  if (!repositories.length) { console.error('No matching repository.'); process.exit(1); }

  console.log(`Scanning ${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'}${full ? ', full history' : ', current branch tips'}\n`);
  let totalFindings = 0;
  const truncated = [];

  for (const repository of repositories) {
    const label = `${repository.orgSlug}/${repository.repoSlug}`;
    process.stderr.write(`  ${label} …`);
    const summary = full
      ? scanFullHistory(config, db, { repository })
      : scanCurrentTrees(config, db, { repository });
    process.stderr.write('\r');
    totalFindings += summary.findings;
    truncated.push(...(summary.truncated ?? []).map((entry) => ({ ...entry, repository: label })));

    const open = findingSummary(db, repository.id);
    console.log(`  ${label.padEnd(40)} ${String(summary.findings).padStart(4)} new   ${open.open} open (${open.blocking} blocking)`);
  }

  console.log(`\n${totalFindings} finding${totalFindings === 1 ? '' : 's'} recorded.`);
  if (truncated.length) {
    // A bounded scan reported as complete is worse than no scan: somebody then
    // believes the part it never reached is clean.
    console.log('\nNOT FULLY SCANNED — these refs were longer than the commit limit:');
    for (const entry of truncated) console.log(`  ${entry.repository} ${entry.ref} (first ${entry.limit} commits only)`);
  }
  if (totalFindings) {
    console.log('\nRotate every credential found. A scan is not a fix — the bytes are');
    console.log('already in every clone anybody took.');
  }
  process.exit(0);
} catch (error) {
  console.error(`\nscan failed: ${error.message}`);
  process.exit(1);
} finally {
  db.close();
}
