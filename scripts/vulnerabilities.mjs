#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Is what we ship safe today.
 *
 * The licence gate answers *may we ship this*, once, when a dependency is
 * added. This answers a question whose answer changes without anybody touching
 * the repository: a package that was fine on Monday has a CVE on Thursday, and
 * nothing in the build would have noticed.
 *
 * `npm audit` is the source. It is not a great one — it knows about advisories
 * published to the npm registry and nothing else — but it is the one that
 * matches the dependency tree exactly, and a check that runs beats a better
 * check that does not.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What fails the build, and what is only reported.
 *
 * High and critical fail. Moderate and low are printed and do not.
 *
 * A gate that fails on everything gets switched off within a month — somebody
 * hits a `low` in a transitive dependency with no fix available, the build is
 * red, and the fastest way to ship is to remove the check. A gate that fails on
 * nothing is decoration. This is the line where the failure is worth somebody's
 * afternoon.
 */
export const FAILING_SEVERITIES = Object.freeze(['critical', 'high']);
const ALL_SEVERITIES = Object.freeze(['critical', 'high', 'moderate', 'low', 'info']);

/**
 * Advisories accepted with their eyes open.
 *
 * Empty, and it should stay that way. An entry is a decision that KukGit ships
 * a known vulnerability, so it needs a person, a reason and — this is the part
 * that matters — **an expiry**. An accepted risk with no expiry is a risk
 * nobody ever looks at again; it becomes part of the furniture and is still
 * there three years later when somebody asks why.
 *
 *   { id: 1234567, package: 'left-pad', why: '…', until: '2026-12-31', by: 'amith' }
 *
 * Past its date it stops counting and the build goes red again, which is the
 * point: the decision has to be made again by somebody who can see what has
 * changed.
 */
export const ACCEPTED = Object.freeze([]);

export function acceptedNow(accepted = ACCEPTED, now = new Date()) {
  return accepted.filter((entry) => {
    const until = new Date(`${entry.until}T23:59:59.999Z`);
    return Number.isFinite(until.getTime()) && until >= now;
  });
}

/**
 * Turn `npm audit --json` into a flat list.
 *
 * npm has changed this shape twice. Version 2 keys `vulnerabilities` by package
 * name, with `via` holding either advisory objects or the names of the packages
 * that pull the vulnerability in. Only the objects carry an id and a title;
 * the strings are the chain, and counting them as findings reports the same
 * advisory once per hop.
 */
export function parseAudit(report) {
  const findings = [];
  const seen = new Set();
  for (const [name, entry] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via === 'string') continue;
      const id = via.source ?? via.url ?? `${name}:${via.title}`;
      if (seen.has(id)) continue;
      seen.add(id);
      findings.push({
        id,
        package: via.name ?? name,
        title: via.title ?? 'unknown advisory',
        severity: String(via.severity ?? entry.severity ?? 'info').toLowerCase(),
        url: via.url ?? null,
        fixAvailable: Boolean(entry.fixAvailable),
        range: via.range ?? entry.range ?? null,
      });
    }
  }
  return findings.sort((a, b) => ALL_SEVERITIES.indexOf(a.severity) - ALL_SEVERITIES.indexOf(b.severity)
    || String(a.package).localeCompare(String(b.package)));
}

/**
 * Which findings fail the build.
 *
 * An accepted entry is matched on the advisory id **and** the package, because
 * an id reused for a different package is a different problem and an acceptance
 * that silently covered it would be an acceptance nobody made.
 */
export function failing(findings, { accepted = ACCEPTED, now = new Date() } = {}) {
  const live = acceptedNow(accepted, now);
  return findings.filter((finding) => {
    if (!FAILING_SEVERITIES.includes(finding.severity)) return false;
    return !live.some((entry) => String(entry.id) === String(finding.id) && entry.package === finding.package);
  });
}

/**
 * Run `npm audit`, or say why it could not.
 *
 * A machine with no route to the registry is not a machine with no
 * vulnerabilities, and reporting a pass would be a lie the build tells itself.
 * It is reported as unavailable, and the caller decides — the same rule the
 * PostgreSQL step follows.
 */
export function runAudit({ cwd = root } = {}) {
  const result = spawnSync('npm', ['audit', '--json'], { cwd, encoding: 'utf8', timeout: 120_000 });
  // `npm audit` exits non-zero when it *finds* something, so the status alone
  // says nothing about whether it ran.
  let report;
  try { report = JSON.parse(result.stdout || '{}'); }
  catch { return { available: false, why: 'npm audit did not return JSON', findings: [] }; }
  if (report.error || (!report.vulnerabilities && !report.metadata)) {
    return { available: false, why: report?.error?.summary ?? 'the npm registry could not be reached', findings: [] };
  }
  return { available: true, findings: parseAudit(report), metadata: report.metadata ?? null };
}

function main() {
  const { available, why, findings, metadata } = runAudit();

  if (!available) {
    console.log(`Could not check for advisories: ${why}`);
    console.log('This is not a pass. A machine with no route to the registry is not a machine with no vulnerabilities.');
    // Not a failure either — an air-gapped build must not go red for being
    // air-gapped. The caller reports it as unavailable and says so out loud.
    process.exitCode = 0;
    return;
  }

  const counts = metadata?.vulnerabilities ?? {};
  const total = Number(counts.total ?? findings.length);
  console.log(`${metadata?.dependencies?.total ?? '?'} packages checked against the npm advisory database.`);

  if (!total) {
    console.log('No known advisories.');
    const stale = ACCEPTED.length - acceptedNow().length;
    if (stale) console.log(`${stale} accepted-risk entr${stale === 1 ? 'y has' : 'ies have'} expired and can be removed.`);
    return;
  }

  for (const severity of ALL_SEVERITIES) {
    const count = Number(counts[severity] ?? 0);
    if (count) console.log(`  ${String(count).padStart(3)} × ${severity}`);
  }
  console.log('');
  for (const finding of findings) {
    console.log(`  [${finding.severity}] ${finding.package} — ${finding.title}`);
    if (finding.url) console.log(`          ${finding.url}`);
    console.log(`          ${finding.fixAvailable ? 'a fix is available' : 'no fix available yet'}`);
  }

  const blocking = failing(findings);
  if (!blocking.length) {
    console.log(`\nNothing at ${FAILING_SEVERITIES.join(' or ')} that is not already accepted.`);
    return;
  }
  console.log(`\n${blocking.length} advisor${blocking.length === 1 ? 'y' : 'ies'} at ${FAILING_SEVERITIES.join(' or ')} must be fixed or explicitly accepted.`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
