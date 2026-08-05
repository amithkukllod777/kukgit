import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ALLOWED_LICENCES,
  auditDependencies,
  cycloneDx,
  installedPackages,
  licenceAllowed,
} from '../scripts/dependencies.mjs';

/**
 * The licence gate, and the bill of materials it produces.
 *
 * This is the check that decides whether KukGit may ship a dependency at all,
 * so the interesting tests are the refusals. A gate that only proves it lets
 * MIT through has not been tested.
 */

function lockWith(packages) {
  return { packages: { '': { name: 'kukgit', version: '0.2.0', dependencies: {} }, ...packages } };
}

test('the real tree passes, and is small', async () => {
  const { packages, problems } = auditDependencies();
  assert.deepEqual(problems, []);
  // `pg` is the only declared dependency. If this number moves a long way,
  // somebody added a package tree and this test is the place to notice.
  assert.ok(packages.length <= 30, `${packages.length} packages installed`);
});

test('permissive licences pass', async () => {
  for (const licence of ALLOWED_LICENCES) assert.equal(licenceAllowed(licence), true, licence);
});

test('copyleft is refused, by name', async () => {
  // KukGit is sold and will be self-hosted by customers. A copyleft dependency
  // in that position is a legal question for a person, not something to find
  // out from a customer's scanner.
  for (const licence of ['GPL-3.0', 'GPL-2.0-only', 'AGPL-3.0', 'LGPL-3.0', 'SSPL-1.0', 'MPL-2.0']) {
    assert.equal(licenceAllowed(licence), false, licence);
  }
});

test('a package that declares nothing is refused, not passed over', async () => {
  assert.equal(licenceAllowed(''), false);
  assert.equal(licenceAllowed(null), false);
  assert.equal(licenceAllowed(undefined), false);

  const { problems } = auditDependencies({
    lock: lockWith({ 'node_modules/mystery': { name: 'mystery', version: '1.0.0' } }),
  });
  // A package whose terms nobody has read is the same risk as a package whose
  // terms are GPL.
  assert.equal(problems[0].kind, 'undeclared-licence');
});

test('OR lets us choose, AND makes us satisfy both', async () => {
  // We may take the MIT side.
  assert.equal(licenceAllowed('(MIT OR GPL-3.0)'), true);
  assert.equal(licenceAllowed('Apache-2.0 OR MIT'), true);
  // We would have to satisfy the GPL as well. Getting this backwards is the
  // kind of mistake that only surfaces in a due-diligence review.
  assert.equal(licenceAllowed('MIT AND GPL-3.0'), false);
  assert.equal(licenceAllowed('MIT AND ISC'), true);
});

test('an exception does not change which licence it is', async () => {
  // An exception narrows what a licence requires; it does not turn one licence
  // into another.
  assert.equal(licenceAllowed('Apache-2.0 WITH LLVM-exception'), true);
  assert.equal(licenceAllowed('GPL-2.0 WITH Classpath-exception-2.0'), false);
});

test('brackets group, and AND binds tighter than OR', async () => {
  // `A OR B AND C` is `A OR (B AND C)` in SPDX. Stripping the brackets and
  // splitting — which this did first — reads `(A OR B) AND C` as something
  // else entirely, and gets the answer right by accident or not at all.
  // `MIT OR (GPL AND GPL)` — we take the MIT side. Splitting on AND first
  // reads it as `(MIT OR GPL) AND GPL` and refuses a package we may ship.
  assert.equal(licenceAllowed('MIT OR GPL-3.0 AND GPL-3.0'), true);
  assert.equal(licenceAllowed('MIT OR GPL-3.0 AND MIT'), true);
  assert.equal(licenceAllowed('(MIT OR GPL-3.0) AND GPL-3.0'), false);
  assert.equal(licenceAllowed('(MIT OR GPL-3.0) AND ISC'), true);
  assert.equal(licenceAllowed('(GPL-3.0 OR LGPL-3.0) AND MIT'), false);
});

test('a dependency added without the lockfile is caught', async () => {
  const { problems } = auditDependencies({
    lock: lockWith({}),
    pkg: { name: 'kukgit', version: '0.2.0', dependencies: { pg: '8.22.0' } },
  });
  // Otherwise a dependency gets added and the audit passes against a tree
  // nobody approved.
  assert.ok(problems.some((problem) => problem.kind === 'not-in-lockfile' && problem.name === 'pg'));
});

test('a lockfile carrying something package.json does not is caught', async () => {
  const lock = lockWith({});
  lock.packages[''].dependencies = { sneaky: '1.0.0' };
  const { problems } = auditDependencies({ lock, pkg: { name: 'kukgit', version: '0.2.0', dependencies: {} } });
  assert.ok(problems.some((problem) => problem.kind === 'not-in-manifest' && problem.name === 'sneaky'));
});

test('a stale lockfile version is caught', async () => {
  const lock = lockWith({});
  lock.packages[''].version = '0.1.0';
  const { problems } = auditDependencies({ lock, pkg: { name: 'kukgit', version: '0.2.0', dependencies: {} } });
  assert.ok(problems.some((problem) => problem.kind === 'version-mismatch'));
});

test('the same package at two versions is listed twice', async () => {
  const packages = installedPackages(lockWith({
    'node_modules/a': { name: 'a', version: '1.0.0', license: 'MIT' },
    'node_modules/b/node_modules/a': { name: 'a', version: '2.0.0', license: 'MIT' },
  }));
  // Both are shipped and both have a licence. Collapsing them would hide one.
  assert.deepEqual(packages.map((entry) => `${entry.name}@${entry.version}`), ['a@1.0.0', 'a@2.0.0']);
});

test('the bill of materials is CycloneDX, and the same every run', async () => {
  const first = cycloneDx();
  const second = cycloneDx();
  assert.equal(first.bomFormat, 'CycloneDX');
  assert.equal(first.specVersion, '1.5');
  // No timestamp and no random serial, so a diff between two releases is a
  // diff of what changed rather than of when it ran.
  assert.equal(first.metadata.timestamp, undefined);
  assert.deepEqual(first, second);
  assert.match(first.serialNumber, /^urn:uuid:[0-9a-f-]{36}$/);
});

test('a timestamp is included only when asked for', async () => {
  const stamped = cycloneDx({ timestamp: '2026-08-05T00:00:00.000Z' });
  assert.equal(stamped.metadata.timestamp, '2026-08-05T00:00:00.000Z');
});

test('every component has a purl and a version a scanner can use', async () => {
  for (const component of cycloneDx().components) {
    assert.match(component.purl, /^pkg:npm\//, component.name);
    assert.ok(component.version, `${component.name} has no version`);
    assert.equal(component.type, 'library');
  }
});

test('a scoped package gets a purl a scanner will parse', async () => {
  const bom = cycloneDx({
    lock: lockWith({ 'node_modules/@scope/thing': { name: '@scope/thing', version: '1.2.3', license: 'MIT' } }),
    pkg: { name: 'kukgit', version: '0.2.0' },
  });
  // The `@` has to be percent-encoded or the purl is not a purl.
  assert.equal(bom.components[0].purl, 'pkg:npm/%40scope/thing@1.2.3');
});

test('the gate runs in CI and locally', async () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // A licence gate that does not run is decoration.
  assert.match(workflow, /npm run deps/);
  assert.equal(manifest.scripts.deps, 'node scripts/dependencies.mjs check');
  assert.equal(manifest.scripts.sbom, 'node scripts/dependencies.mjs sbom');
});
