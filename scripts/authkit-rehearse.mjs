import fs from 'node:fs';
import path from 'node:path';
import { DRILL_CHECKS, runAuthKitRehearsal } from '../src/authkit-rehearsal.mjs';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function usage() {
  process.stdout.write(`KukGit AuthKit rollout drill\n\n`
    + `  npm run authkit:rehearse -- [--operator name] [--evidence <file.json>] [--url <authkit>]\n\n`
    + `Stands up a KukGit instance in AuthKit mode against a stand-in Kuklabs AuthKit and\n`
    + `drives every flow the rollout checklist names — password, OTP signup, Google,\n`
    + `refresh rotation, central device revocation, blocked product access, an AuthKit\n`
    + `outage and logout — over real HTTP with a real cookie jar.\n\n`
    + `Nothing on this machine is touched: the instance is a throwaway directory that is\n`
    + `deleted when the drill finishes.\n\n`
    + `Checks:\n`
    + DRILL_CHECKS.map((check) => `  ${check.id.padEnd(38)} ${check.description}`).join('\n')
    + `\n`);
}

function summary(record) {
  const lines = [
    `authkit          ${record.authkit.kind} at ${record.authkit.baseUrl}`,
    `contract         ${record.authkit.contract ?? 'unknown'}`,
    `upstream calls   ${record.upstreamCalls}`,
    '',
  ];
  for (const check of record.checks) {
    lines.push(`${check.ok ? '✓' : '✗'} ${check.id.padEnd(38)} ${check.detail}`);
  }
  for (const id of record.skipped) lines.push(`– ${id.padEnd(38)} did not run`);
  lines.push('', `result           ${record.result.toUpperCase()}`);
  lines.push(`confidence       ${record.confidence}`);
  if (record.confidence === 'rehearsed') {
    // The distinction the record exists to preserve. A simulator can show that
    // KukGit's half of the conversation is right; it cannot show that the real
    // AuthKit says what the simulator says it says.
    lines.push('');
    lines.push('This ran against the simulator, so it rehearses the production checks rather');
    lines.push('than signing them off. See docs/AUTHKIT_REHEARSAL.md for what a staging run');
    lines.push('against the real service still has to prove.');
  }
  return `${lines.join('\n')}\n`;
}

if (['help', '--help', '-h'].includes(process.argv[2])) {
  usage();
} else {
  try {
    const { record } = await runAuthKitRehearsal({
      operator: argument('--operator'),
      authkitBaseUrl: argument('--url'),
    });
    process.stdout.write(summary(record));

    const evidence = argument('--evidence');
    if (evidence) {
      const target = path.resolve(evidence);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      process.stdout.write(`\nEvidence written to ${target}\n`);
    }

    process.exitCode = record.complete ? 0 : 1;
  } catch (error) {
    process.stderr.write(`AuthKit drill failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
