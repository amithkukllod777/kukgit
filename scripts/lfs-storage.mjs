#!/usr/bin/env node
import process from 'node:process';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import {
  migrateLfsObjectsToBucket,
  planLfsStorageMigration,
  reclaimVolumeAfterMigration,
  verifyBucketHoldsEveryObject,
} from '../src/lfs-storage-migration.mjs';

const USAGE = `KukGit Git LFS storage migration

  npm run lfs:storage -- plan            what would move, and what is wrong before it does
  npm run lfs:storage -- copy [--limit N] copy objects to the bucket; nothing is deleted
  npm run lfs:storage -- verify           confirm the bucket holds every recorded object
  npm run lfs:storage -- reclaim --confirm delete local copies the bucket demonstrably holds

Run them in that order. \`copy\` is resumable: run it again for what is left.
Set KUKGIT_OBJECT_STORAGE_* first — see docs/OBJECT_STORAGE.md.
`;

function bytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = Number(value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

const [command = 'plan', ...rest] = process.argv.slice(2);
if (['-h', '--help', 'help'].includes(command)) { console.log(USAGE); process.exit(0); }

const limitFlag = rest.indexOf('--limit');
const limit = limitFlag >= 0 ? Number(rest[limitFlag + 1]) : undefined;
const confirm = rest.includes('--confirm');

const config = loadConfig();
const db = openDatabase(config);

try {
  if (command === 'plan') {
    const plan = await planLfsStorageMigration(config, db);
    console.log(`objects recorded : ${plan.total} (${bytes(plan.totalBytes)})`);
    console.log(`already in bucket: ${plan.alreadyPresent.length}`);
    console.log(`to copy          : ${plan.pending.length} (${bytes(plan.pending.reduce((sum, o) => sum + o.size, 0))})`);
    if (plan.missing.length) {
      // Not a migration problem. The database says these exist and the volume
      // disagrees, which is true today and would be true without any of this.
      console.log(`\nMISSING FROM THE VOLUME (${plan.missing.length}) — already unserveable, restore from a backup:`);
      for (const object of plan.missing.slice(0, 20)) console.log(`  ${object.oid}`);
    }
    if (plan.corrupt.length) {
      console.log(`\nCORRUPT ON THE VOLUME (${plan.corrupt.length}) — copying these would move the corruption into the bucket:`);
      for (const object of plan.corrupt.slice(0, 20)) console.log(`  ${object.oid} (reads as ${object.actualDigest})`);
    }
    process.exit(plan.corrupt.length ? 1 : 0);
  }

  if (command === 'copy') {
    const result = await migrateLfsObjectsToBucket(config, db, {
      limit: Number.isFinite(limit) ? limit : undefined,
      onProgress: ({ copied, pending, oid }) => process.stderr.write(`\r${copied}/${pending} ${oid.slice(0, 12)}…`),
    });
    process.stderr.write('\r');
    console.log(`copied    : ${result.copied} (${bytes(result.copiedBytes)})`);
    console.log(`skipped   : ${result.alreadyPresent} already in the bucket`);
    console.log(`remaining : ${result.remaining}`);
    if (result.missing.length) console.log(`missing   : ${result.missing.length} not on the volume`);
    if (result.failed.length) {
      console.log(`\nFAILED (${result.failed.length}):`);
      for (const object of result.failed.slice(0, 20)) console.log(`  ${object.oid}: ${object.reason}`);
    }
    console.log('\nNothing was deleted from the volume. Run `verify` next.');
    process.exit(result.failed.length ? 1 : 0);
  }

  if (command === 'verify') {
    const result = await verifyBucketHoldsEveryObject(config, db, { limit: Number.isFinite(limit) ? limit : null });
    console.log(`checked: ${result.checked}/${result.total}`);
    if (result.problems.length) {
      console.log(`\nPROBLEMS (${result.problems.length}):`);
      for (const problem of result.problems.slice(0, 20)) console.log(`  ${problem.oid}: ${problem.reason}`);
    }
    console.log(result.readyForCutover
      ? '\nEvery recorded object is readable and correct in the bucket.'
      : '\nNOT ready for cutover.');
    process.exit(result.readyForCutover ? 0 : 1);
  }

  if (command === 'reclaim') {
    const result = await reclaimVolumeAfterMigration(config, db, { confirm });
    console.log(`removed locally: ${result.removed} (${bytes(result.reclaimedBytes)} reclaimed)`);
    if (result.kept.length) {
      console.log(`\nKEPT (${result.kept.length}) — the bucket could not be trusted for these:`);
      for (const object of result.kept.slice(0, 20)) console.log(`  ${object.oid}: ${object.reason}`);
    }
    process.exit(0);
  }

  console.log(USAGE);
  process.exit(1);
} catch (error) {
  console.error(`\n${error.message}`);
  process.exit(1);
} finally {
  db.close();
}
