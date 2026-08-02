#!/usr/bin/env node
import process from 'node:process';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { migrateMaintenanceWindows } from '../src/maintenance-windows.mjs';
import { listIncidents, migrateStatusPage, statusSnapshot, writeStatusSnapshot } from '../src/status-page.mjs';

const USAGE = `KukGit status

  npm run status                      what the public page says right now
  npm run status -- --snapshot DIR    write status.json and index.html for hosting elsewhere

A status page served by the instance it reports on cannot report that the
instance is down. The snapshot is two ordinary files: push them to object
storage or a CDN on a schedule, which is where a status page belongs.
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
const snapshotIndex = args.indexOf('--snapshot');
const directory = snapshotIndex >= 0 ? String(args[snapshotIndex + 1] ?? '') : null;

const config = loadConfig();
const db = openDatabase(config);
migrateMaintenanceWindows(db);
migrateStatusPage(db);

try {
  if (snapshotIndex >= 0) {
    if (!directory) { console.error('--snapshot takes a directory.'); process.exit(1); }
    const written = writeStatusSnapshot(config, db, directory);
    console.log(`${written.state} — wrote ${written.files.join(', ')} to ${written.directory}`);
    process.exit(0);
  }

  const snapshot = statusSnapshot(config, db);
  console.log(`state          ${snapshot.state}`);
  console.log(`open incidents ${snapshot.incidents.length}`);
  console.log(`maintenance    ${snapshot.maintenance.length} upcoming or in progress`);
  for (const incident of snapshot.incidents) {
    console.log(`\n  ${incident.severity.toUpperCase()} ${incident.title} (${incident.state})`);
    for (const update of incident.updates) console.log(`    ${update.at}  ${update.state}: ${update.body.slice(0, 100)}`);
  }
  const resolved = listIncidents(db, { limit: 5 }).filter((incident) => incident.state === 'resolved');
  if (resolved.length) {
    console.log('\nrecently resolved:');
    for (const incident of resolved) console.log(`  ${incident.resolvedAt}  ${incident.title}`);
  }
  process.exit(0);
} catch (error) {
  console.error(`status failed: ${error.message}`);
  process.exit(1);
} finally {
  db.close();
}
