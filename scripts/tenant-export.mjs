#!/usr/bin/env node
import process from 'node:process';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import {
  createTenantExport,
  listTenantExports,
  migrateTenantExport,
  tenantExportsDir,
  verifyRecordedExport,
  verifyTenantExport,
} from '../src/tenant-export.mjs';

const USAGE = `KukGit tenant export

  npm run export -- --org acme              export one tenant, then verify the archive
  npm run export -- --org acme --out DIR    write the archive somewhere else
  npm run export -- --verify PATH           re-verify an archive that already exists
  npm run export -- --list [--org acme]     what has been exported, and whether it verified

Writes every row, every repository and every Git LFS object one organization
owns into a single archive, then opens it again and checks it. Repositories go
in as Git bundles, so 'git clone' reads them without KukGit.

Credential columns are withheld and named in the manifest. An export leaves the
building; the encryption key does not go with it.

A tenant deletion refuses to execute unless a verified export was taken after
the deletion was requested.
`;

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(args.length ? 0 : 1); }

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] ?? '') : null;
}

const slug = flag('--org');
const outputDir = flag('--out');
const verifyPath = flag('--verify');
const listing = args.includes('--list');

const config = loadConfig();
const db = openDatabase(config);
migrateTenantExport(db);

function bytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = Number(value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function reportVerification(result) {
  console.log(`  rows           ${result.rows}`);
  console.log(`  bundles        ${result.bundles}`);
  console.log(`  LFS objects    ${result.lfsObjects}`);
  console.log(`  withheld       ${result.redactedColumns.length} credential column(s)`);
  if (result.problems.length) {
    // An export believed to be complete is the failure this whole feature
    // exists to prevent, so the problems are the loudest thing printed.
    console.log('\nNOT COMPLETE:');
    for (const problem of result.problems) console.log(`  - ${problem}`);
  }
  console.log(`\n${result.complete ? 'Verified.' : 'This export must not be relied on.'}`);
}

try {
  if (listing) {
    const exports = listTenantExports(db, { slug });
    if (!exports.length) { console.log('No exports recorded.'); process.exit(0); }
    for (const record of exports) {
      const state = record.verifiedAt ? (record.complete ? 'verified' : 'FAILED') : 'unverified';
      console.log(`${record.createdAt}  ${record.slug.padEnd(24)} ${state.padEnd(10)} ${bytes(record.archiveBytes).padStart(10)}  ${record.archivePath}`);
    }
    process.exit(0);
  }

  if (verifyPath) {
    console.log(`Verifying ${verifyPath}\n`);
    const result = await verifyTenantExport(config, verifyPath);
    console.log(`  organization   ${result.organization?.slug ?? 'unknown'}`);
    console.log(`  exported       ${result.generatedAt}`);
    reportVerification(result);
    process.exit(result.complete ? 0 : 1);
  }

  if (!slug) { console.error('--org is required. See --help.'); process.exit(1); }

  console.log(`Exporting ${slug} to ${outputDir ?? tenantExportsDir(config)}\n`);
  const created = await createTenantExport(config, db, { slug, outputDir });
  console.log(`  archive        ${created.archivePath}`);
  console.log(`  size           ${bytes(created.archiveBytes)}`);
  console.log(`  sha256         ${created.archiveSha256}`);
  console.log(`  repositories   ${created.manifest.repositories.length}`);
  console.log('');

  // Created and verified in one command on purpose. An archive nobody has
  // opened is a belief, and the moment to find out it is wrong is now rather
  // than after the original has been deleted.
  const verified = await verifyRecordedExport(config, db, { exportId: created.id });
  reportVerification(verified);
  if (verified.complete) {
    console.log('\nGive this archive and its sha256 to the customer. Keep the sha256');
    console.log('somewhere other than beside the archive.');
  }
  process.exit(verified.complete ? 0 : 1);
} catch (error) {
  console.error(`\nexport failed: ${error.message}`);
  process.exit(1);
} finally {
  db.close();
}
