#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { deployReadiness } from '../src/deploy-readiness.mjs';

const USAGE = `KukGit deploy check

  npm run deploy:check              is this box ready to run KukGit
  npm run deploy:check -- --json    the same thing as JSON

Run it on the server, with the same environment KukGit will start with:

  env $(cat /etc/kukgit.env | xargs) npm run deploy:check

Exits non-zero if anything failed, so it can gate a deploy. Warnings do not
fail: most are correct for an internal trial and wrong for real users, and a
check that blocks on both stops being read.
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = await deployReadiness({ repositoryRoot });

if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ready ? 0 : 1);
}

const MARK = { pass: '  ok  ', warn: ' warn ', fail: ' FAIL ' };
console.log(`KukGit deploy check — ${report.host}, ${report.mode} mode\n`);
for (const entry of report.checks) {
  console.log(`[${MARK[entry.status]}] ${entry.message}`);
  if (entry.fix && entry.status !== 'pass') console.log(`           ${entry.fix}`);
}

console.log(`\n${report.passed} ok, ${report.warned} warning${report.warned === 1 ? '' : 's'}, ${report.failed} failure${report.failed === 1 ? '' : 's'}`);
if (report.ready) {
  console.log('\nReady. Next: npm run seed, then start the server and push a repository.');
  if (report.warned) console.log('Read the warnings before anybody outside your team uses this.');
} else {
  console.log('\nNot ready. Fix the failures above and run this again.');
}
process.exit(report.ready ? 0 : 1);
