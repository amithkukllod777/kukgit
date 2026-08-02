import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { packPortableArchive, sha256File, unpackPortableArchive } from './backup-archive.mjs';
import { audit, uid } from './db.mjs';
import { lfsStorage } from './git-lfs.mjs';
import { repoDiskPath } from './git.mjs';
import { httpError, originAllowed } from './security.mjs';
import { requireUser } from './auth.mjs';
import { tenantRowCensus, tenantSelectors } from './tenant-lifecycle.mjs';

/**
 * What a withheld value is replaced with.
 *
 * A visible sentinel rather than `null`, so somebody reading the file sees that
 * something was taken out without finding the manifest first — and so an import
 * can tell "this was withheld" from "this was empty" and refuse to load a
 * credential that would never work.
 */
export const REDACTION_SENTINEL = '[redacted by KukGit export]';

export const TENANT_EXPORT = {
  format: 'kukgit-tenant-export-v1',
  // A row at a time would be correct and slow; a whole table in memory would be
  // correct until the table is large. Batches are the compromise, and the batch
  // size is the only tuning knob here.
  batchRows: 500,
  extension: '.kgexp',
};

/**
 * Columns withheld from an export because their contents are credential material.
 *
 * This is the difference between an export and a backup. A backup is restored
 * into the instance that made it, where the encryption key still exists and the
 * ciphertext is meaningful. An export **leaves the building**: every credential
 * in it becomes a credential outside anybody's control, sitting in a file that
 * will be emailed, copied to a laptop and kept for years.
 *
 * Matched on the column name rather than listed per table, for the same reason
 * the table graph is derived: a table added later is covered without anybody
 * remembering this file exists.
 */
const REDACTED_COLUMN_PATTERNS = [
  /^ciphertext$/, /_ciphertext$/,
  /^token_hash$/, /_token_hash$/,
  /^secret$/, /_secret$/, /^secret_(iv|tag|nonce|salt|hash)$/,
  /^(password|passphrase)(_|$)/,
  /^private_key(_|$)/,
  // A digest **of a credential**, which is not the same thing as a digest of
  // content. `secrets.value_sha256` is an unsalted SHA-256 of the secret
  // itself: for anything short or low-entropy that is brute-forceable, and for
  // everything else it answers "is the value X?" for an attacker who has a
  // guess. Content checksums are exempted below by name; these are not.
  /^(value|secret|token|password|key|credential)_(hash|digest|sha1|sha256|sha512|md5)$/,
];

// Any column whose name contains one of these segments is treated as
// credential-shaped and must be either redacted or explained. `iv` is here as a
// whole segment, which is why `archived_at` is not caught by it.
const SENSITIVE_SEGMENTS = new Set([
  'secret', 'secrets', 'token', 'tokens', 'password', 'passphrase', 'key', 'keys',
  'cipher', 'ciphertext', 'encrypted', 'nonce', 'iv', 'salt', 'hash', 'hashed',
  'credential', 'credentials', 'signature', 'hmac', 'private',
  // Digests are here because a digest of a credential is a credential. Most of
  // them turn out to be checksums of content and are exempted below — but each
  // one is a decision somebody made, which is the entire mechanism.
  'digest', 'sha1', 'sha256', 'sha512', 'md5', 'checksum',
]);

/**
 * Columns that look like credentials and are exported anyway, each with a reason.
 *
 * The same shape as the deletion's unreachable-table list, and for the same
 * reason: "this one is fine" needs to be written down by somebody, once, where
 * the next person can disagree with it.
 */
const EXPORTED_DESPITE_THE_NAME = new Map([
  ['token_prefix', 'the non-secret prefix a token is looked up by; the hash beside it is withheld'],
  ['token_expires_at', 'a timestamp'],
  ['publisher_token_id', 'an identifier for a token row, not the token'],
  ['public_key', 'a public key; publishing it is the entire point of one'],
  ['key_type', 'the algorithm name of a public key'],
  ['fingerprint', 'a truncated digest used to recognise a credential, never to reconstruct one'],
  ['cache_key', 'a cache name chosen by the workflow author'],
  ['job_key', 'a workflow job identifier'],
  ['anchor_key', 'a review anchor: file, line and side'],
  ['idempotency_key', 'a de-duplication identifier for a delivery'],
  ['digest', 'the SHA-256 of stored content, which is in the export beside it'],
]);

function columnIsRedacted(column) {
  return REDACTED_COLUMN_PATTERNS.some((pattern) => pattern.test(column));
}

function columnLooksSensitive(column) {
  return column.toLowerCase().split('_').some((segment) => SENSITIVE_SEGMENTS.has(segment));
}

/**
 * Classifies every column an export would write.
 *
 * `unexplained` is the one that matters. A credential-shaped column nobody has
 * either redacted or excused is not evidence that it is safe to export; it is
 * evidence that nobody looked — and unlike a missed table, the consequence is
 * that the credential is now in a file somebody else keeps.
 *
 * A non-empty `unexplained` list fails the export.
 */
export function tenantExportColumnPolicy(db, tables) {
  const redacted = [];
  const explained = [];
  const unexplained = [];
  for (const table of tables) {
    for (const row of db.prepare(`PRAGMA table_info(${table})`).all()) {
      const column = String(row.name);
      const qualified = `${table}.${column}`;
      if (columnIsRedacted(column)) { redacted.push(qualified); continue; }
      if (!columnLooksSensitive(column)) continue;
      const reason = EXPORTED_DESPITE_THE_NAME.get(column);
      if (reason) explained.push({ column: qualified, reason });
      else unexplained.push(qualified);
    }
  }
  return { redacted, explained, unexplained };
}

export function migrateTenantExport(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_exports (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      organization_slug TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      archive_sha256 TEXT NOT NULL,
      archive_bytes INTEGER NOT NULL,
      manifest TEXT NOT NULL,
      complete INTEGER NOT NULL DEFAULT 0,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      verified_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_exports_org
      ON tenant_exports(organization_id, created_at DESC);
  `);
}

function git(gitDir, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['--git-dir', gitDir, ...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 600_000,
  });
  if (result.status !== 0 && !allowFailure) {
    throw httpError(500, `git ${args[0]} failed: ${(result.stderr || '').trim().slice(0, 300)}`, 'EXPORT_GIT_FAILED');
  }
  return result;
}

function safeName(value) {
  const name = String(value ?? '');
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(name) || name.includes('..')) {
    throw httpError(400, `Refusing to export under the unsafe name '${name}'.`, 'EXPORT_NAME_INVALID');
  }
  return name;
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = fs.openSync(filePath, 'wx', 0o600);
  try {
    for (const row of rows) fs.writeSync(handle, `${JSON.stringify(row)}\n`);
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Reads one table's rows for this tenant, in batches, with credentials withheld.
 *
 * `null` would be indistinguishable from a column that was genuinely empty, so a
 * withheld value is written as a visible sentinel. Somebody reading the export
 * six months from now should be able to see that something was taken out without
 * having to find the manifest first.
 */
function* tenantRows(db, selector, organizationId) {
  const columns = db.prepare(`PRAGMA table_info(${selector.table})`).all().map((row) => String(row.name));
  const redactedColumns = columns.filter((column) => columnIsRedacted(column));
  const parameters = Array(selector.params).fill(organizationId);
  let offset = 0;
  while (true) {
    const rows = db.prepare(`SELECT * FROM ${selector.table} WHERE ${selector.sql} LIMIT ? OFFSET ?`)
      .all(...parameters, TENANT_EXPORT.batchRows, offset);
    if (!rows.length) return;
    for (const row of rows) {
      // Node's SQLite rows have a null prototype, and a null-prototype object
      // does not round-trip through everything that later reads this file.
      const plain = { ...row };
      for (const column of redactedColumns) plain[column] = REDACTION_SENTINEL;
      yield plain;
    }
    if (rows.length < TENANT_EXPORT.batchRows) return;
    offset += rows.length;
  }
}

/**
 * Writes one Git bundle per repository.
 *
 * A bundle, not a copy of the directory, because `git clone` reads a bundle
 * directly. An export whose repositories can only be opened by KukGit is not an
 * export; it is a hostage note. This one is opened by Git.
 *
 * A repository whose bytes are not on disk is recorded as **missing** rather
 * than skipped. An export that quietly omits a repository is worse than no
 * export, because somebody then deletes the original believing they have it.
 */
async function bundleRepositories(config, db, organization, stagingDir) {
  const repositories = db.prepare(`
    SELECT id, slug, name, default_branch AS defaultBranch, deleted_at AS deletedAt
    FROM repositories WHERE organization_id = ? ORDER BY slug
  `).all(organization.id);

  const results = [];
  for (const repository of repositories) {
    const slug = safeName(repository.slug);
    const gitDir = repoDiskPath(config, organization.slug, slug);
    const archivePath = `repositories/${slug}.bundle`;
    const base = {
      id: repository.id,
      slug,
      name: repository.name,
      defaultBranch: repository.defaultBranch,
      inTrash: Boolean(repository.deletedAt),
      path: archivePath,
    };

    if (!fs.existsSync(gitDir)) {
      results.push({ ...base, missing: true, reason: 'no repository directory on disk' });
      continue;
    }
    const refs = git(gitDir, ['for-each-ref', '--format=%(refname)'], { allowFailure: true }).stdout
      .split('\n').map((line) => line.trim()).filter(Boolean);
    if (!refs.length) {
      // `git bundle create` refuses to write an empty bundle, and it is right to:
      // an empty file is not a repository. Recorded as empty, which is a true
      // statement about the repository rather than a gap in the export.
      results.push({ ...base, empty: true, refs: 0, path: null });
      continue;
    }

    const destination = path.join(stagingDir, 'repositories', `${slug}.bundle`);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    git(gitDir, ['bundle', 'create', destination, '--all']);
    // Two counts, because they answer different questions. `refs` is what the
    // repository held; `bundleHeads` is what the file that leaves actually
    // carries. Verification checks the second matches and that it is not fewer
    // than the first — a bundle with fewer heads than the repository had is an
    // export that lost a branch.
    const heads = git(gitDir, ['bundle', 'list-heads', destination], { allowFailure: true }).stdout
      .split('\n').filter(Boolean).length;
    const digest = await sha256File(destination);
    results.push({ ...base, refs: refs.length, bundleHeads: heads, bytes: digest.size, sha256: digest.sha256 });
  }
  return results;
}

/**
 * Copies the tenant's Git LFS objects into the export.
 *
 * Copied, not referenced — even when they live in a bucket. A backup may point
 * at the bucket because a restore happens on the instance that still has it; the
 * customer receiving this export does not, and a manifest telling them their
 * large files are in somebody else's S3 account is not a copy of their data.
 */
async function copyLfsObjects(config, db, organization, stagingDir) {
  // A database on which Git LFS has never been migrated has no such table, and
  // that is a true "no objects" rather than an error. Reached by running the
  // export against an instance whose server has not started yet, which is
  // exactly when somebody is trying it out.
  const installed = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'repository_lfs_objects'").get();
  if (!installed) return { objects: [], missing: [], bytes: 0 };

  const rows = db.prepare(`
    SELECT DISTINCT o.oid, o.size, o.storage_path AS storagePath
    FROM repository_lfs_objects link
    JOIN lfs_objects o ON o.oid = link.oid
    WHERE link.repository_id IN (SELECT id FROM repositories WHERE organization_id = ?)
    ORDER BY o.oid
  `).all(organization.id);

  const storage = lfsStorage(config);
  const objects = [];
  const missing = [];
  for (const row of rows) {
    const oid = String(row.oid);
    if (!/^[0-9a-f]{64}$/.test(oid)) {
      missing.push({ oid, reason: 'object id is not a SHA-256 digest' });
      continue;
    }
    const archivePath = `lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;
    const destination = path.join(stagingDir, ...archivePath.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      const source = await storage.createReadStream(String(row.storagePath));
      await pipeline(source, fs.createWriteStream(destination, { mode: 0o600, flags: 'wx' }));
    } catch (error) {
      fs.rmSync(destination, { force: true });
      missing.push({ oid, reason: error.message.slice(0, 200) });
      continue;
    }
    // Content-addressed storage means the name is the checksum, so a copy that
    // hashes to something else is a corrupt copy and is reported as missing
    // rather than handed over as if it were the file.
    const digest = await sha256File(destination);
    if (digest.sha256 !== oid) {
      fs.rmSync(destination, { force: true });
      missing.push({ oid, reason: `copied bytes hash to ${digest.sha256}` });
      continue;
    }
    objects.push({ oid, size: digest.size, path: archivePath });
  }
  return { objects, missing, bytes: objects.reduce((sum, object) => sum + object.size, 0) };
}

function findOrganization(db, slug) {
  const organization = db.prepare('SELECT id, slug, name, plan, created_at AS createdAt FROM organizations WHERE slug = ?').get(slug);
  if (!organization) throw httpError(404, 'Organization not found.', 'ORGANIZATION_NOT_FOUND');
  return organization;
}

export function tenantExportsDir(config) {
  return path.join(config.backupsDir, 'tenant-exports');
}

/**
 * Writes everything one tenant owns into a single verifiable archive.
 *
 * The metadata comes from the same schema-derived selectors the deletion uses,
 * which is the point of building it this way: the export covers the rows the
 * deletion removes, by construction. A table added to the schema next month is
 * in both or in neither, and there is a test that asserts the two lists are the
 * same set.
 */
export async function createTenantExport(config, db, { slug, userId = null, outputDir = null, now = new Date() } = {}) {
  const organization = findOrganization(db, safeName(slug));
  const { graph, selectors } = tenantSelectors(db);
  if (graph.unclassified.length) {
    throw httpError(409, `Cannot export: ${graph.unclassified.length} table(s) are unclassified: ${graph.unclassified.join(', ')}`, 'EXPORT_UNCLASSIFIED_TABLES');
  }

  const tables = [...selectors.map((selector) => selector.table), 'organizations'];
  const policy = tenantExportColumnPolicy(db, tables);
  if (policy.unexplained.length) {
    throw httpError(409, `Cannot export: ${policy.unexplained.length} credential-shaped column(s) are neither withheld nor explained: ${policy.unexplained.join(', ')}`, 'EXPORT_UNEXPLAINED_COLUMNS');
  }

  fs.mkdirSync(config.tempDir, { recursive: true, mode: 0o700 });
  const stagingDir = fs.mkdtempSync(path.join(config.tempDir, 'tenant-export-'));
  try {
    const census = tenantRowCensus(db, organization.id);
    const files = [];

    for (const selector of [...selectors, { table: 'organizations', sql: 'id = ?', params: 1 }]) {
      const relative = `metadata/${selector.table}.jsonl`;
      const destination = path.join(stagingDir, ...relative.split('/'));
      let rows = 0;
      writeJsonl(destination, (function* counted() {
        for (const row of tenantRows(db, selector, organization.id)) { rows += 1; yield row; }
      })());
      if (!rows) { fs.rmSync(destination, { force: true }); continue; }
      const digest = await sha256File(destination);
      files.push({ path: relative, table: selector.table, rows, bytes: digest.size, sha256: digest.sha256 });
    }

    // The member list, which is not the same thing as exporting user accounts.
    // `org_members` holds user ids and nothing else, and an id means nothing on
    // another instance — so an import could restore an organization with no
    // members and no way to get in. Email is what identifies the same person on
    // two instances, and an organization's own member list is the
    // organization's data.
    const members = db.prepare(`
      SELECT m.user_id AS userId, m.role, m.created_at AS createdAt, u.email, u.display_name AS displayName
      FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ? ORDER BY u.email
    `).all(organization.id);
    if (members.length) {
      const destination = path.join(stagingDir, 'metadata', 'members.jsonl');
      writeJsonl(destination, members.map((member) => ({ ...member })));
      const digest = await sha256File(destination);
      files.push({ path: 'metadata/members.jsonl', members: members.length, bytes: digest.size, sha256: digest.sha256 });
    }

    const repositories = await bundleRepositories(config, db, organization, stagingDir);
    const lfs = await copyLfsObjects(config, db, organization, stagingDir);
    for (const object of lfs.objects) {
      files.push({ path: object.path, oid: object.oid, bytes: object.size, sha256: object.oid });
    }
    for (const repository of repositories.filter((entry) => entry.sha256)) {
      files.push({ path: repository.path, repository: repository.slug, bytes: repository.bytes, sha256: repository.sha256 });
    }

    const missingRepositories = repositories.filter((entry) => entry.missing);
    const manifest = {
      format: TENANT_EXPORT.format,
      generatedAt: now.toISOString(),
      organization: { id: organization.id, slug: organization.slug, name: organization.name, plan: organization.plan },
      census: { total: census.total, counts: census.counts },
      tables: files.filter((file) => file.table).map(({ path: filePath, table, rows, bytes, sha256 }) => ({ path: filePath, table, rows, bytes, sha256 })),
      repositories,
      members: files.filter((file) => file.members).map(({ path: filePath, members: count, bytes, sha256 }) => ({ path: filePath, members: count, bytes, sha256 }))[0] ?? null,
      lfs: { objects: lfs.objects.length, bytes: lfs.bytes, missing: lfs.missing },
      // Named, not merely done. A customer reading this needs to know what was
      // taken out and why before they discover it by trying to use the export.
      redactedColumns: policy.redacted,
      exportedDespiteTheName: policy.explained,
      notIncluded: graph.unreachable.map(({ table, reason }) => ({ table, reason })),
      // A gap anywhere makes the whole export incomplete, and an incomplete
      // export is not permitted to stand in for the customer's data when a
      // deletion asks whether one exists.
      complete: missingRepositories.length === 0 && lfs.missing.length === 0,
      warnings: [
        ...missingRepositories.map((entry) => `repository '${entry.slug}' has no bytes on disk: ${entry.reason}`),
        ...lfs.missing.map((entry) => `Git LFS object ${entry.oid} could not be copied: ${entry.reason}`),
      ],
    };
    const manifestPath = path.join(stagingDir, 'manifest.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

    const stamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const directory = path.resolve(outputDir ?? tenantExportsDir(config));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const archivePath = path.join(directory, `kukgit-export-${organization.slug}-${stamp}-${crypto.randomBytes(4).toString('hex')}${TENANT_EXPORT.extension}`);

    const entries = [
      { path: 'manifest.json', sourcePath: manifestPath },
      ...files.map((file) => ({ path: file.path, sourcePath: path.join(stagingDir, ...file.path.split('/')) })),
    ];
    const packed = await packPortableArchive(entries, archivePath);

    const id = uid('exp');
    db.prepare(`
      INSERT INTO tenant_exports
        (id, organization_id, organization_slug, archive_path, archive_sha256, archive_bytes, manifest, complete, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, organization.id, organization.slug, packed.outputPath, packed.archiveSha256, packed.archiveSize,
      JSON.stringify(manifest), manifest.complete ? 1 : 0, userId);

    if (userId) {
      audit(db, {
        userId,
        organizationId: organization.id,
        action: 'tenant.exported',
        targetType: 'organization',
        targetId: organization.id,
        metadata: {
          exportId: id,
          rows: census.total,
          repositories: repositories.length,
          lfsObjects: lfs.objects.length,
          complete: manifest.complete,
        },
      });
    }

    return {
      id,
      organizationId: organization.id,
      slug: organization.slug,
      archivePath: packed.outputPath,
      archiveSha256: packed.archiveSha256,
      archiveBytes: packed.archiveSize,
      manifest,
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Opens the archive and checks that it is what it says it is.
 *
 * Unpacking already verifies every entry against the checksum in its header, so
 * this checks the things a packer could get wrong and still produce a valid
 * archive: that the manifest agrees with the contents, that each bundle is a
 * bundle Git will accept, and that each LFS object still hashes to its own name.
 *
 * An export nobody has opened is a belief, not a backup. This is the difference,
 * and it runs before an export is allowed to authorise a deletion.
 */
export async function verifyTenantExport(config, archivePath) {
  fs.mkdirSync(config.tempDir, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(config.tempDir, 'tenant-export-verify-'));
  const scratchRepo = path.join(root, '.verify.git');
  try {
    const unpacked = await unpackPortableArchive(archivePath, path.join(root, 'contents'));
    const byPath = new Map(unpacked.entries.map((entry) => [entry.path, entry]));
    const manifestEntry = byPath.get('manifest.json');
    if (!manifestEntry) throw httpError(400, 'Export manifest is missing.', 'EXPORT_MANIFEST_MISSING');
    const manifest = JSON.parse(fs.readFileSync(manifestEntry.destination, 'utf8'));
    if (manifest.format !== TENANT_EXPORT.format) {
      throw httpError(400, `Unsupported export format '${manifest.format}'.`, 'EXPORT_FORMAT_UNSUPPORTED');
    }

    const problems = [];
    const checkFile = (declared, label) => {
      const entry = byPath.get(declared.path);
      if (!entry) { problems.push(`${label} '${declared.path}' is not in the archive`); return null; }
      if (declared.sha256 && entry.sha256 !== declared.sha256) problems.push(`${label} '${declared.path}' does not match the manifest checksum`);
      return entry;
    };

    let rows = 0;
    for (const table of manifest.tables ?? []) {
      const entry = checkFile(table, 'table');
      if (!entry) continue;
      // Counted from the file, not trusted from the manifest. A manifest is
      // written by the same code that wrote the file it describes, so believing
      // it would make this check test nothing.
      const lines = fs.readFileSync(entry.destination, 'utf8').split('\n').filter(Boolean).length;
      if (lines !== table.rows) problems.push(`table '${table.table}' holds ${lines} rows, the manifest says ${table.rows}`);
      rows += lines;
    }

    let members = 0;
    if (manifest.members) {
      const entry = checkFile(manifest.members, 'member list');
      if (entry) {
        members = fs.readFileSync(entry.destination, 'utf8').split('\n').filter(Boolean).length;
        if (members !== manifest.members.members) {
          problems.push(`member list holds ${members} members, the manifest says ${manifest.members.members}`);
        }
      }
    }

    spawnSync('git', ['init', '--bare', '--quiet', scratchRepo], { encoding: 'utf8' });
    let bundles = 0;
    for (const repository of manifest.repositories ?? []) {
      if (repository.missing || repository.empty) continue;
      const entry = checkFile(repository, 'repository bundle');
      if (!entry) continue;
      const verified = spawnSync('git', ['--git-dir', scratchRepo, 'bundle', 'verify', entry.destination], {
        encoding: 'utf8', timeout: 600_000,
      });
      if (verified.status !== 0) {
        problems.push(`repository '${repository.slug}' bundle failed git verification: ${(verified.stderr || '').trim().slice(0, 200)}`);
        continue;
      }
      const heads = spawnSync('git', ['--git-dir', scratchRepo, 'bundle', 'list-heads', entry.destination], { encoding: 'utf8' })
        .stdout.split('\n').filter(Boolean).length;
      if (heads !== repository.bundleHeads) problems.push(`repository '${repository.slug}' bundle holds ${heads} heads, the manifest says ${repository.bundleHeads}`);
      if (heads < repository.refs) problems.push(`repository '${repository.slug}' bundle holds ${heads} heads for ${repository.refs} refs, so a ref did not make it into the export`);
      bundles += 1;
    }

    let lfsObjects = 0;
    for (const entry of unpacked.entries) {
      if (!entry.path.startsWith('lfs/objects/')) continue;
      const oid = path.posix.basename(entry.path);
      // The name of a content-addressed object is its checksum, so this is the
      // one check the archive format cannot do for itself.
      if (entry.sha256 !== oid) problems.push(`Git LFS object '${oid}' does not hash to its own name`);
      lfsObjects += 1;
    }
    if (lfsObjects !== (manifest.lfs?.objects ?? 0)) {
      problems.push(`archive holds ${lfsObjects} Git LFS objects, the manifest says ${manifest.lfs?.objects ?? 0}`);
    }

    for (const warning of manifest.warnings ?? []) problems.push(`recorded when exported: ${warning}`);

    return {
      archivePath: path.resolve(archivePath),
      archiveSha256: (await sha256File(path.resolve(archivePath))).sha256,
      organization: manifest.organization,
      generatedAt: manifest.generatedAt,
      rows,
      members,
      bundles,
      lfsObjects,
      redactedColumns: manifest.redactedColumns ?? [],
      problems,
      complete: problems.length === 0 && manifest.complete === true,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Verifies an export and records that it was verified.
 *
 * Only a record written by this function lets a deletion proceed. Creating an
 * archive is not enough — the row stays unverified until something has opened
 * the file and read every byte back.
 */
export async function verifyRecordedExport(config, db, { exportId }) {
  const record = db.prepare('SELECT * FROM tenant_exports WHERE id = ?').get(exportId);
  if (!record) throw httpError(404, 'No export with that id.', 'EXPORT_NOT_FOUND');
  const result = await verifyTenantExport(config, record.archive_path);
  db.prepare('UPDATE tenant_exports SET verified_at = CURRENT_TIMESTAMP, complete = ? WHERE id = ?')
    .run(result.complete ? 1 : 0, exportId);
  return { exportId, ...result };
}

export function listTenantExports(db, { slug = null, limit = 50 } = {}) {
  const rows = slug
    ? db.prepare('SELECT * FROM tenant_exports WHERE organization_slug = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(slug, limit)
    : db.prepare('SELECT * FROM tenant_exports ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit);
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    slug: row.organization_slug,
    archivePath: row.archive_path,
    archiveSha256: row.archive_sha256,
    archiveBytes: Number(row.archive_bytes),
    complete: Boolean(row.complete),
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
    manifest: row.manifest ? JSON.parse(row.manifest) : null,
  }));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
  return true;
}

/**
 * The evidence surface, and only that.
 *
 * Exports are **created from the command line**, not from an HTTP request. An
 * export copies every repository and every large file a tenant owns; over a real
 * customer that is minutes to hours of byte copying, and an HTTP request that
 * runs for an hour is a request that times out halfway through leaving a
 * half-written archive nobody knows about. What the API offers is the list: who
 * exported what, when, whether it verified, and where the archive is.
 *
 * Instance administrator only, for the same reason the deletion routes are: an
 * export manifest is a description of everything a tenant owns.
 */
export function createTenantExportApiHandler({ config, db, isInstanceAdmin }) {
  return async function tenantExportApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    if (!url.pathname.startsWith('/api/instance-admin/tenants/exports')) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    const method = String(req.method || 'GET').toUpperCase();

    try {
      const user = requireUser(db, req);
      if (!isInstanceAdmin(config, user)) {
        throw httpError(403, 'KukGit instance administrator access is required.', 'INSTANCE_ADMIN_REQUIRED');
      }

      if (url.pathname === '/api/instance-admin/tenants/exports' && method === 'GET') {
        return sendJson(res, 200, { exports: listTenantExports(db, { slug: url.searchParams.get('slug') }) });
      }

      const verifyMatch = /^\/api\/instance-admin\/tenants\/exports\/([^/]+)\/verify$/.exec(url.pathname);
      if (verifyMatch && method === 'POST') {
        if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
        const verified = await verifyRecordedExport(config, db, { exportId: decodeURIComponent(verifyMatch[1]) });
        audit(db, {
          userId: user.id,
          action: 'tenant.export_verified',
          targetType: 'organization',
          targetId: verified.organization?.id ?? null,
          metadata: { exportId: verified.exportId, complete: verified.complete, problems: verified.problems.length },
        });
        return sendJson(res, 200, { ...verified, requestId });
      }

      throw httpError(404, 'Unknown tenant export route.', 'TENANT_EXPORT_ROUTE_NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'TENANT_EXPORT_FAILED',
          message: status >= 500 ? 'Tenant export is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}
