#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * What KukGit ships that somebody else wrote, and whether we may sell it.
 *
 * Two questions, and they are asked at different times by different people.
 * Engineering asks "is this licence compatible with a commercial product",
 * once, when a dependency is added. A customer's procurement team asks "give us
 * a bill of materials", months later, in a format their scanner reads.
 *
 * Both are answered from `package-lock.json`, because that is the file that
 * decides what actually gets installed. `package.json` says what we asked for;
 * the lockfile says what arrives.
 *
 * **A declared licence is not a verified licence.** The `license` field is what
 * the publisher typed. Nothing here reads LICENSE files or checks that the
 * declaration is true, and a report that implied otherwise would be worse than
 * no report — so a package with nothing declared is a refusal, not a pass.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Licences a commercial, closed-source product can ship.
 *
 * Permissive only. The absences are the point: GPL, LGPL, AGPL and SSPL are not
 * here, because KukGit is sold and will be self-hosted by customers, and a
 * copyleft dependency in that position is a legal question that has to be
 * answered by a person before the dependency is added, not discovered by a
 * customer's scanner afterwards.
 *
 * Adding to this list is a business decision. It is deliberately a code change
 * with a reviewer rather than a configuration file somebody can edit quietly.
 */
export const ALLOWED_LICENCES = Object.freeze([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'Unlicense',
]);

/**
 * There is no separate list of licences to refuse.
 *
 * There was one, and it was redundant: GPL is refused because it is not on the
 * list above, not because a second rule named it. A guard that cannot fail —
 * reverting it changed no test — is worse than no guard, because it reads like
 * a safety net and is not one.
 */

function lockfile(file = path.join(root, 'package-lock.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function manifest(file = path.join(root, 'package.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Every installed package, as one flat list.
 *
 * Keyed by install path in the lockfile, which is how the same package at two
 * versions appears twice — and it must, because both are shipped and both have
 * a licence.
 */
export function installedPackages(lock = lockfile()) {
  const packages = [];
  for (const [location, meta] of Object.entries(lock.packages ?? {})) {
    if (!location) continue;
    const name = meta.name ?? location.split('node_modules/').pop();
    packages.push({
      name,
      version: meta.version ?? null,
      licence: meta.license ?? null,
      location,
      optional: Boolean(meta.optional),
      dev: Boolean(meta.dev),
      integrity: meta.integrity ?? null,
      resolved: meta.resolved ?? null,
    });
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
}

/**
 * Whether a declared licence expression is one we may ship.
 *
 * SPDX expressions can be compound. `(MIT OR Apache-2.0)` is fine if either
 * side is allowed, because we may choose. `MIT AND GPL-3.0` is not, because we
 * must satisfy both. Getting that backwards is the kind of mistake that only
 * shows up in a due-diligence review.
 */
export function licenceAllowed(expression) {
  const text = String(expression ?? '').trim();
  if (!text) return false;

  // Split on the operator that binds loosest, at depth zero. `A OR B AND C` is
  // `A OR (B AND C)` in SPDX, and stripping the brackets instead — which this
  // did first — turns `(A OR B) AND C` into something else entirely.
  for (const [operator, combine] of [['OR', 'some'], ['AND', 'every']]) {
    const parts = splitOperator(text, operator);
    if (parts.length > 1) return parts[combine]((part) => licenceAllowed(part));
  }
  if (text.startsWith('(') && text.endsWith(')')) return licenceAllowed(text.slice(1, -1));

  // `Apache-2.0 WITH LLVM-exception` is still Apache-2.0. An exception narrows
  // what a licence requires; it does not turn one licence into another.
  return ALLOWED_LICENCES.includes(text.replace(/\s+WITH\s+.*$/i, '').trim());
}

/** Splits on an SPDX operator outside brackets, or returns the whole thing. */
function splitOperator(text, operator) {
  const parts = [];
  let depth = 0;
  let current = '';
  const tokens = text.split(/(\s+|\(|\))/);
  for (const token of tokens) {
    if (token === '(') depth += 1;
    if (token === ')') depth -= 1;
    if (depth === 0 && token.toUpperCase() === operator) { parts.push(current.trim()); current = ''; continue; }
    current += token;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

/**
 * Everything wrong with what is installed.
 *
 * Returned rather than printed so the same function answers `npm run deps` and
 * the test that runs in CI.
 */
export function auditDependencies({ lock = lockfile(), pkg = manifest() } = {}) {
  const problems = [];
  const packages = installedPackages(lock);

  for (const entry of packages) {
    if (!entry.licence) {
      // Not a pass. A package that declares nothing is a package whose terms
      // nobody has read, and shipping it is the same risk as shipping GPL.
      problems.push({ kind: 'undeclared-licence', name: entry.name, version: entry.version });
      continue;
    }
    if (!licenceAllowed(entry.licence)) {
      problems.push({ kind: 'licence-not-allowed', name: entry.name, version: entry.version, licence: entry.licence });
    }
  }

  // The lockfile and the manifest disagreeing is how a dependency gets added
  // without anybody reviewing the licence — the audit above would still pass,
  // against a tree nobody approved.
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies });
  const rootEntry = lock.packages?.[''] ?? {};
  const lockDeclared = Object.keys({ ...rootEntry.dependencies, ...rootEntry.devDependencies, ...rootEntry.optionalDependencies });
  for (const name of declared) {
    if (!lockDeclared.includes(name)) problems.push({ kind: 'not-in-lockfile', name });
  }
  for (const name of lockDeclared) {
    if (!declared.includes(name)) problems.push({ kind: 'not-in-manifest', name });
  }
  if (rootEntry.version && pkg.version && rootEntry.version !== pkg.version) {
    problems.push({ kind: 'version-mismatch', name: pkg.name, manifest: pkg.version, lockfile: rootEntry.version });
  }

  return { packages, problems };
}

function purl(entry) {
  const [scope, name] = entry.name.startsWith('@') ? entry.name.slice(1).split('/') : [null, entry.name];
  const base = scope ? `pkg:npm/%40${scope}/${name}` : `pkg:npm/${name}`;
  return entry.version ? `${base}@${entry.version}` : base;
}

/**
 * A CycloneDX bill of materials.
 *
 * CycloneDX because it is what procurement scanners read. **Deterministic on
 * purpose**: no timestamp and no random serial unless one is supplied, so two
 * runs of the same tree produce byte-identical output and a diff between two
 * releases is a diff of what changed rather than of when it ran.
 */
export function cycloneDx({ lock = lockfile(), pkg = manifest(), timestamp = null } = {}) {
  const components = installedPackages(lock).map((entry) => ({
    type: 'library',
    'bom-ref': purl(entry),
    name: entry.name,
    version: entry.version ?? '',
    purl: purl(entry),
    scope: entry.optional ? 'optional' : 'required',
    licenses: entry.licence ? [{ license: { id: entry.licence } }] : [],
    ...(entry.integrity ? { hashes: hashesFrom(entry.integrity) } : {}),
  }));

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    // Derived from the content, so the same tree always gets the same serial.
    serialNumber: `urn:uuid:${deterministicUuid(components)}`,
    metadata: {
      ...(timestamp ? { timestamp } : {}),
      component: {
        type: 'application',
        'bom-ref': `pkg:npm/${pkg.name}@${pkg.version}`,
        name: pkg.name,
        version: pkg.version,
        description: pkg.description ?? '',
      },
    },
    components,
  };
}

function hashesFrom(integrity) {
  const [algorithm, value] = String(integrity).split('-');
  const named = { sha512: 'SHA-512', sha256: 'SHA-256', sha1: 'SHA-1' }[algorithm];
  if (!named || !value) return [];
  return [{ alg: named, content: Buffer.from(value, 'base64').toString('hex') }];
}

function deterministicUuid(components) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(components)).digest('hex');
  return [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32)].join('-');
}

function describe(problem) {
  switch (problem.kind) {
    case 'undeclared-licence': return `${problem.name}@${problem.version} declares no licence`;
    case 'licence-not-allowed': return `${problem.name}@${problem.version} is ${problem.licence}, which KukGit may not ship`;
    case 'not-in-lockfile': return `${problem.name} is in package.json but not the lockfile — run npm install`;
    case 'not-in-manifest': return `${problem.name} is in the lockfile but not package.json`;
    case 'version-mismatch': return `package.json says ${problem.manifest}, the lockfile says ${problem.lockfile}`;
    default: return JSON.stringify(problem);
  }
}

function main() {
  const [action = 'check', ...rest] = process.argv.slice(2);

  if (action === 'sbom') {
    const out = rest[rest.indexOf('--out') + 1];
    const document = `${JSON.stringify(cycloneDx(), null, 2)}\n`;
    if (rest.includes('--out') && out) {
      fs.writeFileSync(path.resolve(root, out), document);
      console.log(`Wrote ${out}`);
    } else {
      process.stdout.write(document);
    }
    return;
  }

  if (action !== 'check') {
    console.error(`Unknown action "${action}". Use check or sbom.`);
    process.exitCode = 1;
    return;
  }

  const { packages, problems } = auditDependencies();
  const shipped = packages.filter((entry) => !entry.dev);
  const licences = new Map();
  for (const entry of shipped) licences.set(entry.licence ?? '(none)', (licences.get(entry.licence ?? '(none)') ?? 0) + 1);

  console.log(`${shipped.length} package${shipped.length === 1 ? '' : 's'} ship with KukGit.`);
  for (const [licence, count] of [...licences].sort()) console.log(`  ${String(count).padStart(3)} × ${licence}`);

  if (!problems.length) {
    console.log('\nEvery licence is one KukGit may ship, and the lockfile matches package.json.');
    console.log('Declared, not verified: nothing here reads a LICENSE file.');
    return;
  }
  console.log('');
  for (const problem of problems) console.log(`✗ ${describe(problem)}`);
  process.exitCode = 1;
}

export { describe };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
