import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ACCEPTED,
  FAILING_SEVERITIES,
  acceptedNow,
  failing,
  parseAudit,
  runAudit,
} from '../scripts/vulnerabilities.mjs';

/**
 * The advisory gate.
 *
 * The interesting behaviour is all in what it refuses to do: fail on a `low`,
 * pass when it could not reach the registry, and honour an acceptance that has
 * expired.
 */

const REPORT = {
  vulnerabilities: {
    'left-pad': {
      name: 'left-pad',
      severity: 'high',
      fixAvailable: true,
      via: [{ source: 111, name: 'left-pad', title: 'Prototype pollution', severity: 'high', url: 'https://x/111' }],
    },
    'right-pad': {
      name: 'right-pad',
      severity: 'low',
      fixAvailable: false,
      // The string entries are the chain that pulls the vulnerability in, not
      // findings. Counting them reports one advisory several times.
      via: ['left-pad', { source: 222, name: 'right-pad', title: 'Regex denial of service', severity: 'low' }, 'left-pad'],
    },
  },
};

test('only advisory objects are findings, not the chain that pulls them in', async () => {
  const findings = parseAudit(REPORT);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((finding) => finding.package), ['left-pad', 'right-pad']);
  // Most severe first, so the thing somebody must act on is the thing they read.
  assert.equal(findings[0].severity, 'high');
});

test('the same advisory reported against two packages is counted once', async () => {
  const findings = parseAudit({
    vulnerabilities: {
      a: { via: [{ source: 999, name: 'shared', title: 'x', severity: 'high' }] },
      b: { via: [{ source: 999, name: 'shared', title: 'x', severity: 'high' }] },
    },
  });
  assert.equal(findings.length, 1);
});

test('high and critical fail; moderate and low are reported and do not', async () => {
  // A gate that fails on everything gets switched off within a month. A gate
  // that fails on nothing is decoration.
  assert.deepEqual([...FAILING_SEVERITIES], ['critical', 'high']);
  const blocking = failing(parseAudit(REPORT));
  assert.deepEqual(blocking.map((finding) => finding.package), ['left-pad']);
});

test('an accepted advisory stops failing, and only that one', async () => {
  const now = new Date('2026-08-05T00:00:00.000Z');
  const accepted = [{ id: 111, package: 'left-pad', why: 'no fix; not reachable from our code', until: '2026-12-31', by: 'amith' }];
  assert.deepEqual(failing(parseAudit(REPORT), { accepted, now }), []);

  // An id reused for a different package is a different problem, and an
  // acceptance that silently covered it would be an acceptance nobody made.
  const elsewhere = [{ id: 111, package: 'something-else', why: '…', until: '2026-12-31', by: 'amith' }];
  assert.equal(failing(parseAudit(REPORT), { accepted: elsewhere, now }).length, 1);
});

test('an expired acceptance stops counting', async () => {
  const accepted = [{ id: 111, package: 'left-pad', why: '…', until: '2026-07-31', by: 'amith' }];
  // An accepted risk with no end date is a risk nobody looks at again. Past its
  // date the build goes red so the decision is made again by somebody who can
  // see what has changed.
  assert.equal(acceptedNow(accepted, new Date('2026-08-05T00:00:00.000Z')).length, 0);
  assert.equal(failing(parseAudit(REPORT), { accepted, now: new Date('2026-08-05T00:00:00.000Z') }).length, 1);
  assert.equal(failing(parseAudit(REPORT), { accepted, now: new Date('2026-07-30T00:00:00.000Z') }).length, 0);
});

test('an acceptance is valid through the whole of its last day', async () => {
  const accepted = [{ id: 111, package: 'left-pad', why: '…', until: '2026-08-05', by: 'amith' }];
  // Otherwise it expires at midnight and somebody's build goes red on the day
  // they were told it was still fine.
  assert.equal(acceptedNow(accepted, new Date('2026-08-05T18:00:00.000Z')).length, 1);
});

test('nothing is accepted today', async () => {
  // An entry here is a decision that KukGit ships a known vulnerability.
  assert.deepEqual([...ACCEPTED], []);
});

test('every acceptance carries a person, a reason and an expiry', async () => {
  for (const entry of ACCEPTED) {
    assert.ok(entry.by, `${entry.id} has nobody attached`);
    assert.ok(entry.why, `${entry.id} has no reason`);
    assert.match(String(entry.until), /^\d{4}-\d{2}-\d{2}$/, `${entry.id} has no expiry`);
  }
});

test('an unreachable registry is not a pass', async (t) => {
  const dir = fs.mkdtempSync('/tmp/kukgit-audit-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(`${dir}/package.json`, '{"name":"x","version":"1.0.0"}');
  fs.writeFileSync(`${dir}/.npmrc`, 'registry=http://127.0.0.1:59998/\n');

  const result = runAudit({ cwd: dir });
  // A machine with no route to the registry is not a machine with no
  // vulnerabilities, and reporting a pass would be a lie the build tells
  // itself.
  assert.equal(result.available, false);
  assert.ok(result.why, 'it says why');
  assert.deepEqual(result.findings, []);
});

test('the real tree is checked, and the gate runs in CI', async () => {
  const result = runAudit();
  if (result.available) assert.deepEqual(failing(result.findings), []);

  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(workflow, /npm run vulns/);
  assert.equal(manifest.scripts.vulns, 'node scripts/vulnerabilities.mjs');
});
