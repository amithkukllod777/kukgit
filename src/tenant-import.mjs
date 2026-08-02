import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { unpackPortableArchive } from './backup-archive.mjs';
import { audit, uid } from './db.mjs';
import { lfsStorage } from './git-lfs.mjs';
import { repoDiskPath } from './git.mjs';
import { httpError } from './security.mjs';
import { tenantRowCensus, tenantSelectors } from './tenant-lifecycle.mjs';
import { REDACTION_SENTINEL, TENANT_EXPORT, verifyTenantExport } from './tenant-export.mjs';

export function migrateTenantImport(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_imports (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      organization_slug TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      archive_sha256 TEXT NOT NULL,
      exported_at TEXT,
      report TEXT NOT NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_imports_org
      ON tenant_imports(organization_slug, created_at DESC);
  `);
}

function assertSlug(value) {
  const slug = String(value ?? '');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    throw httpError(400, `'${slug}' is not a valid organization slug.`, 'IMPORT_SLUG_INVALID');
  }
  return slug;
}

function git(args, { cwd = undefined } = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', cwd, maxBuffer: 32 * 1024 * 1024, timeout: 600_000 });
  if (result.status !== 0) {
    throw httpError(500, `git ${args[0]} failed: ${(result.stderr || '').trim().slice(0, 300)}`, 'IMPORT_GIT_FAILED');
  }
  return result.stdout;
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
}

/**
 * Which columns of a row point at a user, and whether the row can survive
 * without one.
 *
 * A user id from another instance means nothing here — the account is not part
 * of the tenant's data and was never in the archive. So every user reference is
 * either re-linked by email, set to null where the schema allows it, or the row
 * is dropped and counted. Nothing is inserted pointing at an account that does
 * not exist.
 */
function userReferences(db, table) {
  const nullable = new Map(db.prepare(`PRAGMA table_info(${table})`).all()
    .map((row) => [String(row.name), row.notnull === 0]));
  return db.prepare(`PRAGMA foreign_key_list(${table})`).all()
    .filter((key) => key.table === 'users')
    .map((key) => ({ column: String(key.from), nullable: nullable.get(String(key.from)) !== false }));
}

async function openArchive(config, archivePath) {
  fs.mkdirSync(config.tempDir, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(config.tempDir, 'tenant-import-'));
  const unpacked = await unpackPortableArchive(archivePath, path.join(root, 'contents'));
  const byPath = new Map(unpacked.entries.map((entry) => [entry.path, entry]));
  const manifestEntry = byPath.get('manifest.json');
  if (!manifestEntry) {
    fs.rmSync(root, { recursive: true, force: true });
    throw httpError(400, 'Export manifest is missing.', 'IMPORT_MANIFEST_MISSING');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestEntry.destination, 'utf8'));
  if (manifest.format !== TENANT_EXPORT.format) {
    fs.rmSync(root, { recursive: true, force: true });
    throw httpError(400, `Unsupported export format '${manifest.format}'.`, 'IMPORT_FORMAT_UNSUPPORTED');
  }
  return { root, manifest, byPath };
}

/**
 * Says what an import would do, without doing any of it.
 *
 * An import writes into a live instance and there is no undo beyond deleting
 * the tenant again, so the plan is the thing an operator reads first. It names
 * every row that will not be loaded and why, which is the part that matters:
 * an import that quietly drops the secrets is one somebody discovers when a
 * deployment fails a week later.
 */
export async function planTenantImport(config, db, { archivePath, slug = null } = {}) {
  const opened = await openArchive(config, archivePath);
  try {
    const { manifest, byPath } = opened;
    const targetSlug = assertSlug(slug ?? manifest.organization.slug);
    const conflicts = [];
    if (db.prepare('SELECT 1 AS found FROM organizations WHERE slug = ?').get(targetSlug)) {
      conflicts.push(`an organization with the slug '${targetSlug}' already exists`);
    }
    if (db.prepare('SELECT 1 AS found FROM organizations WHERE id = ?').get(manifest.organization.id)) {
      conflicts.push(`an organization with the id '${manifest.organization.id}' already exists`);
    }

    const known = new Set(tenantSelectors(db).selectors.map((selector) => selector.table));
    known.add('organizations');
    const tables = [];
    const skipped = [];
    for (const table of manifest.tables ?? []) {
      const entry = byPath.get(table.path);
      if (!entry) { skipped.push({ table: table.table, reason: 'missing from the archive', rows: table.rows }); continue; }
      if (!known.has(table.table)) {
        // A table this instance does not have, or does not consider part of a
        // tenant. Reported rather than dropped silently: the two instances are
        // running different versions and somebody needs to know which.
        skipped.push({ table: table.table, reason: 'this instance has no such tenant table', rows: table.rows });
        continue;
      }
      const columns = tableColumns(db, table.table);
      const rows = readJsonl(entry.destination);
      const withheld = rows.filter((row) => Object.values(row).includes(REDACTION_SENTINEL)).length;
      const unknownColumns = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((column) => !columns.has(column));
      tables.push({
        table: table.table,
        rows: rows.length,
        // A row whose credential was withheld cannot be loaded — see
        // `importTenantArchive`. Counted here so the number is visible before
        // anybody commits to the import.
        withheld,
        loadable: rows.length - withheld,
        unknownColumns,
      });
    }

    const members = manifest.members && byPath.get(manifest.members.path)
      ? readJsonl(byPath.get(manifest.members.path).destination)
      : [];
    const resolvedMembers = members.map((member) => ({
      email: member.email,
      role: member.role,
      userId: db.prepare('SELECT id FROM users WHERE email = ?').get(String(member.email ?? '').toLowerCase())?.id ?? null,
    }));

    return {
      archivePath: path.resolve(archivePath),
      organization: { ...manifest.organization, slug: targetSlug },
      exportedAt: manifest.generatedAt,
      exportComplete: manifest.complete === true,
      conflicts,
      tables,
      skipped,
      repositories: (manifest.repositories ?? []).map((repository) => ({
        slug: repository.slug,
        empty: Boolean(repository.empty),
        missing: Boolean(repository.missing),
        exists: fs.existsSync(repoDiskPath(config, targetSlug, repository.slug)),
      })),
      lfsObjects: manifest.lfs?.objects ?? 0,
      members: resolvedMembers,
      unresolvedMembers: resolvedMembers.filter((member) => !member.userId).map((member) => member.email),
    };
  } finally {
    fs.rmSync(opened.root, { recursive: true, force: true });
  }
}

/**
 * Loads an export into this instance.
 *
 * The archive is verified first, always. Loading an archive nobody has checked
 * is how a half-written file becomes a half-restored tenant, and the point at
 * which somebody notices is usually the point at which the original is gone.
 *
 * Original identifiers are kept rather than remapped. They are random and the
 * archive's internal references all use them, so keeping them makes every
 * foreign key inside the tenant correct with no mapping table to get wrong. The
 * cost is that importing over a tenant that still exists is refused, which is
 * the right answer anyway.
 */
export async function importTenantArchive(config, db, {
  archivePath, slug = null, userId = null, allowIncomplete = false,
}) {
  const verified = await verifyTenantExport(config, archivePath);
  if (!verified.complete && !allowIncomplete) {
    throw httpError(409, `This export did not verify: ${verified.problems.join('; ')}`, 'IMPORT_ARCHIVE_UNVERIFIED');
  }

  const opened = await openArchive(config, archivePath);
  const createdPaths = [];
  try {
    const { manifest, byPath } = opened;
    const targetSlug = assertSlug(slug ?? manifest.organization.slug);
    const organizationId = manifest.organization.id;
    if (db.prepare('SELECT 1 AS found FROM organizations WHERE slug = ? OR id = ?').get(targetSlug, organizationId)) {
      throw httpError(409, `'${targetSlug}' already exists on this instance. Import under a different slug with --as, or delete it first.`, 'IMPORT_ORGANIZATION_EXISTS');
    }

    // Parents before children, which is the delete order read backwards. The
    // deletion holds foreign keys at every step by going deepest-first; an
    // import holds them by going the other way.
    const { selectors } = tenantSelectors(db);
    const insertOrder = ['organizations', ...selectors.map((selector) => selector.table).reverse()];
    const available = new Map((manifest.tables ?? []).map((table) => [table.table, table]));

    const members = manifest.members && byPath.get(manifest.members.path)
      ? readJsonl(byPath.get(manifest.members.path).destination)
      : [];
    // The only remapping there is. Everything else keeps its identifier; a user
    // does not, because the account belongs to this instance and not to the
    // archive.
    const userByOldId = new Map();
    const unresolvedMembers = [];
    for (const member of members) {
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(String(member.email ?? '').toLowerCase());
      if (existing) userByOldId.set(member.userId, existing.id);
      else unresolvedMembers.push(member.email);
    }

    // The bytes go into the store before any row points at them. `lfs_objects`
    // is not tenant-scoped — objects are content-addressed and shared between
    // tenants — so it is not in the archive, and `repository_lfs_objects` would
    // have no parent row to reference. Writing the bytes first means the worst
    // case is an object with nothing pointing at it, which the existing LFS
    // garbage collector already handles; the other order leaves a row promising
    // bytes that are not there.
    const storage = lfsStorage(config);
    const lfsObjects = [];
    const lfsFailures = [];
    for (const [entryPath, entry] of byPath) {
      if (!entryPath.startsWith('lfs/objects/')) continue;
      const key = entryPath.slice('lfs/'.length);
      const oid = path.posix.basename(entryPath);
      try {
        await storage.putFile(key, entry.destination);
        lfsObjects.push({ oid, size: entry.size, storagePath: key });
      } catch (error) {
        lfsFailures.push({ oid, reason: error.message.slice(0, 200) });
      }
    }

    const loaded = {};
    const withheldRows = {};
    const droppedRows = {};
    const droppedColumns = {};

    const run = db.transaction(() => {
      for (const object of lfsObjects) {
        // `OR IGNORE` because another tenant on this instance may already have
        // pushed the identical file. That is the entire point of addressing an
        // object by its content.
        db.prepare('INSERT OR IGNORE INTO lfs_objects (oid, size, storage_path) VALUES (?, ?, ?)')
          .run(object.oid, object.size, object.storagePath);
      }
      for (const table of insertOrder) {
        const declared = available.get(table);
        const entry = declared && byPath.get(declared.path);
        if (!entry) continue;
        const columns = tableColumns(db, table);
        const users = userReferences(db, table);
        let inserted = 0;

        for (const row of readJsonl(entry.destination)) {
          // A withheld credential must never be inserted. A secret whose
          // ciphertext is a sentinel would decrypt to nothing, a runner whose
          // token hash is a sentinel could never authenticate, and both would
          // sit in the interface looking real. An absent one is honest; a
          // broken one costs somebody an afternoon.
          if (Object.values(row).includes(REDACTION_SENTINEL)) {
            withheldRows[table] = (withheldRows[table] ?? 0) + 1;
            continue;
          }

          const value = {};
          let dropRow = false;
          for (const [column, raw] of Object.entries(row)) {
            if (!columns.has(column)) {
              droppedColumns[`${table}.${column}`] = (droppedColumns[`${table}.${column}`] ?? 0) + 1;
              continue;
            }
            value[column] = raw;
          }
          for (const reference of users) {
            const current = value[reference.column];
            if (current === null || current === undefined) continue;
            const mapped = userByOldId.get(current);
            if (mapped) { value[reference.column] = mapped; continue; }
            if (reference.nullable) { value[reference.column] = null; continue; }
            // A row that requires a person this instance does not have. Dropped
            // and counted rather than pointed at somebody else.
            dropRow = true;
          }
          if (dropRow) { droppedRows[table] = (droppedRows[table] ?? 0) + 1; continue; }
          if (table === 'organizations') value.slug = targetSlug;

          const names = Object.keys(value);
          db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
            .run(...names.map((name) => value[name]));
          inserted += 1;
        }
        if (inserted) loaded[table] = inserted;
      }
    });
    run();

    const repositories = [];
    for (const repository of manifest.repositories ?? []) {
      if (repository.missing) { repositories.push({ slug: repository.slug, restored: false, reason: 'not in the export' }); continue; }
      const target = repoDiskPath(config, targetSlug, repository.slug);
      if (repository.empty) {
        // No commits to restore, but the repository row was loaded, so the
        // directory has to exist or every later push and read fails.
        git(['init', '--bare', '--quiet', '--initial-branch=main', target]);
        createdPaths.push(target);
        git(['--git-dir', target, 'config', 'http.receivepack', 'true']);
        git(['--git-dir', target, 'update-server-info']);
        repositories.push({ slug: repository.slug, restored: true, empty: true });
        continue;
      }
      const bundle = byPath.get(repository.path);
      if (!bundle) { repositories.push({ slug: repository.slug, restored: false, reason: 'bundle missing from the archive' }); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      git(['clone', '--bare', '--quiet', bundle.destination, target]);
      createdPaths.push(target);
      // The clone points `origin` at a bundle in a temporary directory that is
      // about to be deleted. Leaving it would make every later fetch fail with
      // a path nobody recognises.
      git(['--git-dir', target, 'remote', 'remove', 'origin']);
      git(['--git-dir', target, 'config', 'http.receivepack', 'true']);
      git(['--git-dir', target, 'config', 'receive.denyNonFastForwards', 'true']);
      git(['--git-dir', target, 'update-server-info']);
      repositories.push({ slug: repository.slug, restored: true, refs: repository.refs });
    }

    // The same census the deletion and the export use, run against what was
    // actually loaded. An import that reports success without counting is the
    // same claim a deletion makes without one.
    const census = tenantRowCensus(db, organizationId);
    const report = {
      organization: { id: organizationId, slug: targetSlug, name: manifest.organization.name },
      exportedAt: manifest.generatedAt,
      exportComplete: manifest.complete === true,
      loaded,
      withheldRows,
      droppedRows,
      droppedColumns,
      unresolvedMembers,
      repositories,
      lfsObjects: lfsObjects.length,
      lfsFailures,
      census: { total: census.total, counts: census.counts },
      complete: repositories.every((repository) => repository.restored) && lfsFailures.length === 0,
      warnings: [
        ...Object.entries(withheldRows).map(([table, count]) => `${count} ${table} row(s) held a withheld credential and were not loaded; they must be recreated`),
        ...Object.entries(droppedRows).map(([table, count]) => `${count} ${table} row(s) required a user this instance does not have`),
        ...(unresolvedMembers.length ? [`${unresolvedMembers.length} member(s) have no account here: ${unresolvedMembers.join(', ')}`] : []),
        ...repositories.filter((repository) => !repository.restored).map((repository) => `repository '${repository.slug}' was not restored: ${repository.reason}`),
        ...lfsFailures.map((failure) => `Git LFS object ${failure.oid} was not written: ${failure.reason}`),
      ],
    };

    const id = uid('imp');
    db.prepare(`
      INSERT INTO tenant_imports
        (id, organization_id, organization_slug, archive_path, archive_sha256, exported_at, report, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, organizationId, targetSlug, path.resolve(archivePath), verified.archiveSha256 ?? '', manifest.generatedAt, JSON.stringify(report), userId);

    if (userId) {
      audit(db, {
        userId,
        organizationId,
        action: 'tenant.imported',
        targetType: 'organization',
        targetId: organizationId,
        metadata: { importId: id, rows: census.total, repositories: repositories.length, complete: report.complete },
      });
    }

    return { id, ...report };
  } catch (error) {
    // A failed import leaves nothing behind. The metadata was one transaction;
    // the repositories were not, so they are removed here — a bare repository
    // with no row pointing at it is invisible to every part of KukGit and would
    // sit on the volume until somebody went looking.
    for (const created of createdPaths) fs.rmSync(created, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(opened.root, { recursive: true, force: true });
  }
}

export function listTenantImports(db, { slug = null, limit = 50 } = {}) {
  const rows = slug
    ? db.prepare('SELECT * FROM tenant_imports WHERE organization_slug = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(slug, limit)
    : db.prepare('SELECT * FROM tenant_imports ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit);
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    slug: row.organization_slug,
    archivePath: row.archive_path,
    exportedAt: row.exported_at,
    createdAt: row.created_at,
    report: row.report ? JSON.parse(row.report) : null,
  }));
}
