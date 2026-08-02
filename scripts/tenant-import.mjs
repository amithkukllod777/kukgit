#!/usr/bin/env node
import process from 'node:process';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { migrateTenantExport } from '../src/tenant-export.mjs';
import {
  importTenantArchive,
  listTenantImports,
  migrateTenantImport,
  planTenantImport,
} from '../src/tenant-import.mjs';

const USAGE = `KukGit tenant import

  npm run import -- --archive PATH --plan        what it would do, without doing it
  npm run import -- --archive PATH               load it
  npm run import -- --archive PATH --as newslug  under a different organization slug
  npm run import -- --list                       what has been imported here

Loads a tenant export into this instance: every row, every repository and every
Git LFS object. The archive is verified before anything is written.

Two things do not come back, by design. Credentials were withheld from the
export, so any row holding one is not loaded and must be recreated. Members are
re-linked by email, so a person with no account here is reported rather than
invented.

Run --plan first. Both numbers are in it.
`;

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(args.length ? 0 : 1); }

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] ?? '') : null;
}

const archivePath = flag('--archive');
const slug = flag('--as');
const planOnly = args.includes('--plan');
const listing = args.includes('--list');
const allowIncomplete = args.includes('--allow-incomplete');

const config = loadConfig();
const db = openDatabase(config);
migrateTenantExport(db);
migrateTenantImport(db);

function warn(lines) {
  if (!lines.length) return;
  console.log('\nNOT EVERYTHING CAME BACK:');
  for (const line of lines) console.log(`  - ${line}`);
}

try {
  if (listing) {
    const records = listTenantImports(db, { slug });
    if (!records.length) { console.log('Nothing has been imported here.'); process.exit(0); }
    for (const record of records) {
      const state = record.report?.complete ? 'complete' : 'INCOMPLETE';
      console.log(`${record.createdAt}  ${record.slug.padEnd(24)} ${state.padEnd(11)} exported ${record.exportedAt}`);
    }
    process.exit(0);
  }

  if (!archivePath) { console.error('--archive is required. See --help.'); process.exit(1); }

  if (planOnly) {
    const plan = await planTenantImport(config, db, { archivePath, slug });
    console.log(`Would import ${plan.organization.slug} (exported ${plan.exportedAt})\n`);
    if (!plan.exportComplete) console.log('  the export itself is marked INCOMPLETE\n');
    for (const table of plan.tables) {
      const held = table.withheld ? `  (${table.withheld} withheld)` : '';
      console.log(`  ${table.table.padEnd(34)} ${String(table.loadable).padStart(6)} rows${held}`);
      if (table.unknownColumns.length) console.log(`  ${''.padEnd(34)} columns this instance does not have: ${table.unknownColumns.join(', ')}`);
    }
    console.log(`\n  repositories   ${plan.repositories.length}`);
    console.log(`  LFS objects    ${plan.lfsObjects}`);
    console.log(`  members        ${plan.members.length} (${plan.unresolvedMembers.length} with no account here)`);
    for (const skipped of plan.skipped) console.log(`  skipped ${skipped.table}: ${skipped.reason}`);
    if (plan.conflicts.length) {
      console.log('\nCANNOT IMPORT:');
      for (const conflict of plan.conflicts) console.log(`  - ${conflict}`);
      process.exit(1);
    }
    if (plan.unresolvedMembers.length) {
      console.log('\nThese people have no account on this instance, so their membership');
      console.log('will not be created. Invite them first if they should keep access:');
      for (const email of plan.unresolvedMembers) console.log(`  - ${email}`);
    }
    process.exit(0);
  }

  console.log(`Importing ${archivePath}\n`);
  const report = await importTenantArchive(config, db, { archivePath, slug, allowIncomplete });
  console.log(`  organization   ${report.organization.slug}`);
  console.log(`  rows           ${report.census.total}`);
  console.log(`  repositories   ${report.repositories.filter((entry) => entry.restored).length} of ${report.repositories.length}`);
  console.log(`  LFS objects    ${report.lfsObjects}`);
  warn(report.warnings);
  console.log(`\n${report.complete ? 'Imported.' : 'Imported with gaps — read them above.'}`);
  process.exit(0);
} catch (error) {
  console.error(`\nimport failed: ${error.message}`);
  process.exit(1);
} finally {
  db.close();
}
