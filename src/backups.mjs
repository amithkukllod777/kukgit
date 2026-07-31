import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { requireUser } from './auth.mjs';
import { packPortableArchive, sha256File, unpackPortableArchive, validateArchivePath } from './backup-archive.mjs';
import { audit, uid } from './db.mjs';
import { repoDiskPath } from './git.mjs';
import { httpError, originAllowed } from './security.mjs';
import { KUKGIT_VERSION } from './version.mjs';

const BACKUP_FORMAT = 'kukgit-backup-v1';
const BACKUP_INDEX_FORMAT = 'kukgit-backup-index-v1';
const BACKUP_FILENAME = /^kukgit-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}\.kgbak$/;
const MAX_BODY_BYTES = 32 * 1024;

function execGit(args, { cwd, allowFailure = false, maxBuffer = 32 * 1024 * 1024 } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer,
    timeout: 10 * 60 * 1000,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw httpError(400, String(result.stderr || result.stdout || 'Git backup command failed.').trim().slice(0, 2000), 'BACKUP_GIT_ERROR');
  }
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function writeJsonAtomic(filePath, value, mode = 0o600) {
  const destination = path.resolve(filePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode, flag: 'wx' });
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, mode);
}

function readJson(filePath, code = 'BACKUP_JSON_INVALID') {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { throw httpError(400, `Invalid JSON file '${path.basename(filePath)}'.`, code); }
}

function safeBackupFilename(value) {
  const filename = path.basename(String(value ?? ''));
  if (!BACKUP_FILENAME.test(filename) || filename !== String(value ?? '')) {
    throw httpError(400, 'Backup filename is invalid.', 'BACKUP_FILENAME_INVALID');
  }
  return filename;
}

function backupPath(config, filename) {
  return path.join(config.backupsDir, safeBackupFilename(filename));
}

function indexPathForArchive(archivePath) {
  return `${archivePath}.json`;
}

function backupTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function acquireBackupLock(config, operation) {
  fs.mkdirSync(path.dirname(config.backupLockPath), { recursive: true, mode: 0o700 });
  let fd;
  try { fd = fs.openSync(config.backupLockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw httpError(409, 'Another backup or restore operation is already running.', 'BACKUP_LOCKED');
    throw error;
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, operation, startedAt: new Date().toISOString() }));
  fs.closeSync(fd);
  return () => fs.rmSync(config.backupLockPath, { force: true });
}

function verifyDatabaseSnapshot(databasePath) {
  const snapshot = new DatabaseSync(databasePath);
  try {
    const integrity = snapshot.prepare('PRAGMA integrity_check').all();
    if (!integrity.length || integrity.some((row) => String(Object.values(row)[0]).toLowerCase() !== 'ok')) {
      throw httpError(400, 'SQLite snapshot failed integrity verification.', 'BACKUP_DATABASE_CORRUPT');
    }
    const foreignKeys = snapshot.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length) throw httpError(400, 'SQLite snapshot contains foreign-key violations.', 'BACKUP_DATABASE_FOREIGN_KEY_ERROR');
    const repositoryCount = Number(snapshot.prepare('SELECT COUNT(*) AS count FROM repositories').get().count);
    return { repositoryCount };
  } finally {
    snapshot.close();
  }
}

function createDatabaseSnapshot(db, destination) {
  fs.rmSync(destination, { force: true });
  db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  db.exec(`VACUUM INTO ${sqlLiteral(destination)}`);
  fs.chmodSync(destination, 0o600);
  return verifyDatabaseSnapshot(destination);
}

function repositoryRows(databasePath) {
  const snapshot = new DatabaseSync(databasePath);
  try {
    return snapshot.prepare(`
      SELECT r.id, r.slug AS currentSlug, r.name, r.default_branch AS defaultBranch,
        r.archived_at AS archivedAt, r.deleted_at AS deletedAt,
        r.deleted_original_slug AS deletedOriginalSlug,
        current_org.slug AS currentOrgSlug,
        original_org.slug AS originalOrgSlug
      FROM repositories r
      JOIN organizations current_org ON current_org.id = r.organization_id
      LEFT JOIN organizations original_org ON original_org.id = r.deleted_from_org_id
      ORDER BY r.id
    `).all();
  } finally {
    snapshot.close();
  }
}

function repositoryStorage(row) {
  const deleted = Boolean(row.deletedAt);
  const orgSlug = deleted ? row.originalOrgSlug : row.currentOrgSlug;
  const repoSlug = deleted ? row.deletedOriginalSlug : row.currentSlug;
  if (!orgSlug || !repoSlug) throw httpError(400, `Repository '${row.id}' has incomplete lifecycle storage metadata.`, 'BACKUP_REPOSITORY_METADATA_INVALID');
  return { orgSlug, repoSlug, deleted };
}

function createRepositorySnapshot(config, row, stagingRoot) {
  const storage = repositoryStorage(row);
  const gitDir = repoDiskPath(config, storage.orgSlug, storage.repoSlug);
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
    throw httpError(404, `Git storage is missing for '${storage.orgSlug}/${storage.repoSlug}'.`, 'BACKUP_REPOSITORY_MISSING');
  }
  execGit(['--git-dir', gitDir, 'fsck', '--full']);
  const refs = execGit(['--git-dir', gitDir, 'for-each-ref', '--format=%(refname)%09%(objectname)']).stdout
    .trim().split('\n').filter(Boolean).map((line) => {
      const [name, sha] = line.split('\t');
      return { name, sha };
    });
  const relativePath = refs.length ? `repositories/${row.id}.bundle` : `repositories/${row.id}.empty.json`;
  const destination = path.join(stagingRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (refs.length) {
    execGit(['--git-dir', gitDir, 'bundle', 'create', destination, '--all']);
    fs.chmodSync(destination, 0o600);
  } else {
    writeJsonAtomic(destination, { repositoryId: row.id, empty: true, createdAt: new Date().toISOString() });
  }
  return {
    id: row.id,
    name: row.name,
    storageOrgSlug: storage.orgSlug,
    storageRepoSlug: storage.repoSlug,
    defaultBranch: row.defaultBranch || 'main',
    archived: Boolean(row.archivedAt),
    deleted: storage.deleted,
    snapshotType: refs.length ? 'bundle' : 'empty',
    path: relativePath,
    refCount: refs.length,
    refs,
  };
}

async function fileRecord(stagingRoot, relativePath) {
  const safe = validateArchivePath(relativePath);
  const sourcePath = path.join(stagingRoot, ...safe.split('/'));
  const digest = await sha256File(sourcePath);
  return { path: safe, sourcePath, size: digest.size, sha256: digest.sha256 };
}

function sanitizedConfiguration(config) {
  return {
    baseUrl: config.baseUrl,
    sshHost: config.sshHost,
    sshPort: config.sshPort,
    sshUser: config.sshUser,
    retentionCount: config.backupRetentionCount,
    retentionDays: config.backupRetentionDays,
    storageLayout: 'data/repos/<organization>/<repository>.git',
  };
}

export async function createVerifiedBackup(config, db) {
  const releaseLock = acquireBackupLock(config, 'create');
  const backupId = crypto.randomBytes(12).toString('hex');
  const createdAt = new Date();
  const stagingRoot = fs.mkdtempSync(path.join(config.tempDir, 'backup-create-'));
  try {
    fs.mkdirSync(config.backupsDir, { recursive: true, mode: 0o700 });
    const databaseRelativePath = 'metadata/kukgit.db';
    const databaseDestination = path.join(stagingRoot, 'metadata', 'kukgit.db');
    fs.mkdirSync(path.dirname(databaseDestination), { recursive: true, mode: 0o700 });
    const databaseInfo = createDatabaseSnapshot(db, databaseDestination);
    const rows = repositoryRows(databaseDestination);
    const repositories = rows.map((row) => createRepositorySnapshot(config, row, stagingRoot));
    const configRelativePath = 'metadata/config.json';
    writeJsonAtomic(path.join(stagingRoot, 'metadata', 'config.json'), sanitizedConfiguration(config));

    const payloadPaths = [databaseRelativePath, configRelativePath, ...repositories.map((repository) => repository.path)];
    const payloadFiles = [];
    for (const relativePath of payloadPaths) payloadFiles.push(await fileRecord(stagingRoot, relativePath));
    const payloadMap = new Map(payloadFiles.map((file) => [file.path, file]));
    for (const repository of repositories) {
      const file = payloadMap.get(repository.path);
      repository.size = file.size;
      repository.sha256 = file.sha256;
    }
    const databaseFile = payloadMap.get(databaseRelativePath);
    const configFile = payloadMap.get(configRelativePath);
    const manifest = {
      format: BACKUP_FORMAT,
      backupId,
      createdAt: createdAt.toISOString(),
      application: { name: 'KukGit', version: KUKGIT_VERSION },
      database: { path: databaseRelativePath, size: databaseFile.size, sha256: databaseFile.sha256, repositoryCount: databaseInfo.repositoryCount },
      configuration: { path: configRelativePath, size: configFile.size, sha256: configFile.sha256, secretValuesIncluded: false },
      repositories,
      totals: {
        repositories: repositories.length,
        activeRepositories: repositories.filter((repository) => !repository.deleted).length,
        trashedRepositories: repositories.filter((repository) => repository.deleted).length,
        refs: repositories.reduce((sum, repository) => sum + repository.refCount, 0),
      },
      files: payloadFiles.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 })),
    };
    const manifestRelativePath = 'manifest.json';
    writeJsonAtomic(path.join(stagingRoot, manifestRelativePath), manifest);
    const archiveEntries = [
      { path: manifestRelativePath, sourcePath: path.join(stagingRoot, manifestRelativePath) },
      ...payloadFiles.map(({ path: filePath, sourcePath }) => ({ path: filePath, sourcePath })),
    ];
    const filename = `kukgit-${backupTimestamp(createdAt)}-${backupId.slice(0, 12)}.kgbak`;
    const destination = path.join(config.backupsDir, filename);
    const packed = await packPortableArchive(archiveEntries, destination);
    const verified = await verifyBackupArchive(config, destination);
    const index = {
      format: BACKUP_INDEX_FORMAT,
      filename,
      archiveSha256: packed.archiveSha256,
      archiveSize: packed.archiveSize,
      createdAt: manifest.createdAt,
      backupId,
      totals: manifest.totals,
      verifiedAt: verified.verifiedAt,
    };
    writeJsonAtomic(indexPathForArchive(destination), index);
    return { ...index, path: destination, verification: verified };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    releaseLock();
  }
}

function validateManifest(manifest, extractedEntries) {
  if (!manifest || manifest.format !== BACKUP_FORMAT || !/^[0-9a-f]{24}$/.test(String(manifest.backupId ?? ''))) {
    throw httpError(400, 'Backup manifest format or identifier is invalid.', 'BACKUP_MANIFEST_INVALID');
  }
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.repositories)) throw httpError(400, 'Backup manifest collections are invalid.', 'BACKUP_MANIFEST_INVALID');
  const entryMap = new Map(extractedEntries.map((entry) => [entry.path, entry]));
  const allowed = new Set(['manifest.json']);
  for (const file of manifest.files) {
    const filePath = validateArchivePath(file.path);
    allowed.add(filePath);
    const entry = entryMap.get(filePath);
    if (!entry || entry.size !== file.size || entry.sha256 !== file.sha256) {
      throw httpError(400, `Backup manifest mismatch for '${filePath}'.`, 'BACKUP_MANIFEST_FILE_MISMATCH');
    }
  }
  for (const entry of extractedEntries) {
    if (!allowed.has(entry.path)) throw httpError(400, `Unexpected backup entry '${entry.path}'.`, 'BACKUP_UNEXPECTED_ENTRY');
  }
  if (!manifest.database || !allowed.has(manifest.database.path)) throw httpError(400, 'Backup database entry is missing.', 'BACKUP_DATABASE_MISSING');
  const repositoryIds = new Set();
  for (const repository of manifest.repositories) {
    if (!repository?.id || repositoryIds.has(repository.id)) throw httpError(400, 'Backup repository identifiers are invalid.', 'BACKUP_REPOSITORY_DUPLICATE');
    repositoryIds.add(repository.id);
    if (!['bundle', 'empty'].includes(repository.snapshotType) || !allowed.has(repository.path)) {
      throw httpError(400, `Backup repository '${repository.id}' has invalid snapshot metadata.`, 'BACKUP_REPOSITORY_METADATA_INVALID');
    }
    repoDiskPath({ repositoriesDir: '/tmp/kukgit-validate' }, repository.storageOrgSlug, repository.storageRepoSlug);
  }
  if (Number(manifest.database.repositoryCount) !== manifest.repositories.length) {
    throw httpError(400, 'Backup database and repository manifest counts differ.', 'BACKUP_REPOSITORY_COUNT_MISMATCH');
  }
  return entryMap;
}

function verifyBundle(bundlePath, tempRoot, repositoryId) {
  const verifier = path.join(tempRoot, 'verify', `${repositoryId}.git`);
  fs.mkdirSync(path.dirname(verifier), { recursive: true, mode: 0o700 });
  execGit(['init', '--bare', verifier]);
  execGit(['--git-dir', verifier, 'bundle', 'verify', bundlePath]);
  const heads = execGit(['bundle', 'list-heads', bundlePath]).stdout.trim().split('\n').filter(Boolean);
  fs.rmSync(verifier, { recursive: true, force: true });
  return heads.length;
}

async function extractAndVerify(config, archivePath) {
  const extractRoot = fs.mkdtempSync(path.join(config.tempDir, 'backup-verify-'));
  try {
    const unpacked = await unpackPortableArchive(archivePath, extractRoot);
    const manifestEntry = unpacked.entries.find((entry) => entry.path === 'manifest.json');
    if (!manifestEntry) throw httpError(400, 'Backup manifest is missing.', 'BACKUP_MANIFEST_MISSING');
    const manifest = readJson(manifestEntry.destination, 'BACKUP_MANIFEST_INVALID');
    const entryMap = validateManifest(manifest, unpacked.entries);
    const databaseEntry = entryMap.get(manifest.database.path);
    const database = verifyDatabaseSnapshot(databaseEntry.destination);
    if (database.repositoryCount !== manifest.repositories.length) throw httpError(400, 'Backup database repository count is inconsistent.', 'BACKUP_REPOSITORY_COUNT_MISMATCH');
    let verifiedRefs = 0;
    for (const repository of manifest.repositories) {
      const entry = entryMap.get(repository.path);
      if (repository.snapshotType === 'bundle') {
        const refCount = verifyBundle(entry.destination, extractRoot, repository.id);
        if (refCount < repository.refCount) throw httpError(400, `Git bundle '${repository.id}' is missing refs.`, 'BACKUP_BUNDLE_REF_MISMATCH');
        verifiedRefs += refCount;
      } else {
        const marker = readJson(entry.destination, 'BACKUP_EMPTY_MARKER_INVALID');
        if (marker.repositoryId !== repository.id || marker.empty !== true) throw httpError(400, `Empty repository marker '${repository.id}' is invalid.`, 'BACKUP_EMPTY_MARKER_INVALID');
      }
    }
    return {
      extractRoot,
      manifest,
      entries: unpacked.entries,
      entryMap,
      verifiedAt: new Date().toISOString(),
      verifiedRefs,
      expandedBytes: unpacked.totalBytes,
    };
  } catch (error) {
    fs.rmSync(extractRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyBackupArchive(config, archivePath) {
  const extracted = await extractAndVerify(config, archivePath);
  try {
    const archiveDigest = await sha256File(archivePath);
    return {
      valid: true,
      filename: path.basename(archivePath),
      archiveSha256: archiveDigest.sha256,
      archiveSize: archiveDigest.size,
      backupId: extracted.manifest.backupId,
      createdAt: extracted.manifest.createdAt,
      verifiedAt: extracted.verifiedAt,
      totals: extracted.manifest.totals,
      verifiedRefs: extracted.verifiedRefs,
      expandedBytes: extracted.expandedBytes,
    };
  } finally {
    fs.rmSync(extracted.extractRoot, { recursive: true, force: true });
  }
}

function ensureEmptyTarget(targetDir) {
  const target = path.resolve(targetDir);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || fs.readdirSync(target).length) throw httpError(409, 'Restore target must be a missing or empty directory.', 'RESTORE_TARGET_NOT_EMPTY');
  }
  return target;
}

function initializeBareRepository(destination, defaultBranch) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  execGit(['init', '--bare', `--initial-branch=${defaultBranch || 'main'}`, destination]);
  execGit(['--git-dir', destination, 'config', 'http.receivepack', 'true']);
  execGit(['--git-dir', destination, 'config', 'receive.denyNonFastForwards', 'true']);
}

function restoreRepositorySnapshot(buildRoot, repository, entry) {
  const destination = path.join(buildRoot, 'repos', repository.storageOrgSlug, `${repository.storageRepoSlug}.git`);
  initializeBareRepository(destination, repository.defaultBranch);
  if (repository.snapshotType === 'bundle') {
    execGit(['--git-dir', destination, 'fetch', entry.destination, 'refs/*:refs/*']);
  }
  execGit(['--git-dir', destination, 'symbolic-ref', 'HEAD', `refs/heads/${repository.defaultBranch || 'main'}`]);
  execGit(['--git-dir', destination, 'update-server-info']);
  execGit(['--git-dir', destination, 'fsck', '--full']);
  return destination;
}

export async function restoreBackupArchive(config, archivePath, targetDir, { dryRun = false } = {}) {
  const releaseLock = acquireBackupLock(config, dryRun ? 'restore-dry-run' : 'restore');
  let extracted;
  try {
    const target = ensureEmptyTarget(targetDir);
    extracted = await extractAndVerify(config, archivePath);
    if (dryRun) {
      return {
        dryRun: true,
        valid: true,
        target,
        backupId: extracted.manifest.backupId,
        totals: extracted.manifest.totals,
        verifiedRefs: extracted.verifiedRefs,
      };
    }
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const buildRoot = path.join(parent, `.${path.basename(target)}.restore-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(buildRoot, { recursive: false, mode: 0o700 });
    try {
      const databaseEntry = extracted.entryMap.get(extracted.manifest.database.path);
      fs.copyFileSync(databaseEntry.destination, path.join(buildRoot, 'kukgit.db'), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(path.join(buildRoot, 'kukgit.db'), 0o600);
      fs.mkdirSync(path.join(buildRoot, 'tmp'), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(buildRoot, 'backups'), { recursive: true, mode: 0o700 });
      for (const repository of extracted.manifest.repositories) {
        restoreRepositorySnapshot(buildRoot, repository, extracted.entryMap.get(repository.path));
      }
      verifyDatabaseSnapshot(path.join(buildRoot, 'kukgit.db'));
      writeJsonAtomic(path.join(buildRoot, 'RESTORE.json'), {
        format: 'kukgit-restore-record-v1',
        backupId: extracted.manifest.backupId,
        archive: path.basename(archivePath),
        restoredAt: new Date().toISOString(),
        repositories: extracted.manifest.repositories.length,
      });
      if (fs.existsSync(target)) fs.rmdirSync(target);
      fs.renameSync(buildRoot, target);
      return {
        dryRun: false,
        restored: true,
        target,
        backupId: extracted.manifest.backupId,
        totals: extracted.manifest.totals,
        verifiedRefs: extracted.verifiedRefs,
      };
    } catch (error) {
      fs.rmSync(buildRoot, { recursive: true, force: true });
      throw error;
    }
  } finally {
    if (extracted?.extractRoot) fs.rmSync(extracted.extractRoot, { recursive: true, force: true });
    releaseLock();
  }
}

export function listBackupSnapshots(config) {
  fs.mkdirSync(config.backupsDir, { recursive: true, mode: 0o700 });
  const records = [];
  for (const filename of fs.readdirSync(config.backupsDir)) {
    if (!filename.endsWith('.kgbak.json')) continue;
    const archiveFilename = filename.slice(0, -5);
    if (!BACKUP_FILENAME.test(archiveFilename)) continue;
    const archive = path.join(config.backupsDir, archiveFilename);
    const sidecar = path.join(config.backupsDir, filename);
    try {
      const index = readJson(sidecar, 'BACKUP_INDEX_INVALID');
      const stat = fs.existsSync(archive) ? fs.statSync(archive) : null;
      records.push({
        filename: archiveFilename,
        createdAt: index.createdAt,
        backupId: index.backupId,
        archiveSha256: index.archiveSha256,
        archiveSize: stat?.size ?? index.archiveSize ?? null,
        verifiedAt: index.verifiedAt ?? null,
        totals: index.totals ?? null,
        available: Boolean(stat?.isFile()),
      });
    } catch {
      records.push({ filename: archiveFilename, available: fs.existsSync(archive), invalidIndex: true });
    }
  }
  return records.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export function pruneBackupSnapshots(config, { keep = config.backupRetentionCount, days = config.backupRetentionDays } = {}) {
  const keepCount = Math.max(1, Math.min(Number(keep) || 1, 10000));
  const retentionDays = Math.max(1, Math.min(Number(days) || 1, 36500));
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const records = listBackupSnapshots(config);
  const removed = [];
  records.forEach((record, index) => {
    const timestamp = Date.parse(record.createdAt || '');
    if (index < keepCount || !Number.isFinite(timestamp) || timestamp >= cutoff) return;
    const archive = path.join(config.backupsDir, record.filename);
    fs.rmSync(archive, { force: true });
    fs.rmSync(indexPathForArchive(archive), { force: true });
    removed.push(record.filename);
  });
  return { keep: keepCount, days: retentionDays, removed, remaining: listBackupSnapshots(config).length };
}

export function getMaintenanceState(config) {
  if (!fs.existsSync(config.maintenancePath)) return { enabled: false };
  try {
    const state = readJson(config.maintenancePath, 'MAINTENANCE_STATE_INVALID');
    return { enabled: true, reason: String(state.reason || 'Maintenance in progress.'), enabledAt: state.enabledAt || null, actor: state.actor || null };
  } catch {
    return { enabled: true, reason: 'Maintenance in progress.', invalidState: true };
  }
}

export function setMaintenanceState(config, enabled, { reason = 'Maintenance in progress.', actor = 'system' } = {}) {
  if (!enabled) {
    fs.rmSync(config.maintenancePath, { force: true });
    return { enabled: false };
  }
  writeJsonAtomic(config.maintenancePath, {
    format: 'kukgit-maintenance-v1',
    reason: String(reason).slice(0, 500),
    actor: String(actor).slice(0, 200),
    enabledAt: new Date().toISOString(),
  });
  return getMaintenanceState(config);
}

function sendMaintenance(res, state) {
  const body = JSON.stringify({ error: { code: 'MAINTENANCE_MODE', message: state.reason, enabledAt: state.enabledAt } });
  res.writeHead(503, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Retry-After': '300',
  });
  res.end(body);
}

export function createMaintenanceGuard({ config, next }) {
  return async function maintenanceGuard(req, res) {
    const state = getMaintenanceState(config);
    if (!state.enabled) return next(req, res);
    const url = new URL(req.url, config.baseUrl);
    const method = String(req.method || 'GET').toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method) || url.pathname === '/api/backups') return next(req, res);
    sendMaintenance(res, state);
  };
}

function requireInstanceAdmin(config, user) {
  if (String(user.email || '').toLowerCase() !== String(config.adminEmail || '').toLowerCase()) {
    throw httpError(403, 'KukGit instance administrator access is required.', 'INSTANCE_ADMIN_REQUIRED');
  }
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

async function readRequestJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'BACKUP_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

function routeMatch(pathname, pattern) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  }) + '$');
  const match = pathname.match(regex);
  if (!match) return null;
  try { return Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])); }
  catch { throw httpError(400, 'Invalid request path.', 'INVALID_PATH'); }
}

export function createBackupsApiHandler({ config, db }) {
  return async function handleBackupsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/backups')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);
      requireInstanceAdmin(config, user);
      if (pathname === '/api/backups' && req.method === 'GET') {
        return sendJson(res, 200, {
          backups: listBackupSnapshots(config),
          maintenance: getMaintenanceState(config),
          policy: { retentionCount: config.backupRetentionCount, retentionDays: config.backupRetentionDays },
        });
      }
      if (pathname === '/api/backups' && req.method === 'POST') {
        const backup = await createVerifiedBackup(config, db);
        audit(db, { userId: user.id, action: 'backup.created', targetType: 'backup', targetId: backup.backupId, metadata: { filename: backup.filename, archiveSha256: backup.archiveSha256, totals: backup.totals } });
        return sendJson(res, 201, { backup });
      }
      if (pathname === '/api/backups/prune' && req.method === 'POST') {
        const body = await readRequestJson(req);
        const result = pruneBackupSnapshots(config, { keep: body.keep, days: body.days });
        audit(db, { userId: user.id, action: 'backup.pruned', targetType: 'backup', metadata: result });
        return sendJson(res, 200, { result });
      }
      const params = routeMatch(pathname, '/api/backups/:filename/verify');
      if (params && req.method === 'POST') {
        const filename = safeBackupFilename(params.filename);
        const verification = await verifyBackupArchive(config, backupPath(config, filename));
        const indexFile = indexPathForArchive(backupPath(config, filename));
        if (fs.existsSync(indexFile)) {
          const index = readJson(indexFile, 'BACKUP_INDEX_INVALID');
          index.verifiedAt = verification.verifiedAt;
          index.archiveSha256 = verification.archiveSha256;
          index.archiveSize = verification.archiveSize;
          writeJsonAtomic(indexFile, index);
        }
        audit(db, { userId: user.id, action: 'backup.verified', targetType: 'backup', targetId: verification.backupId, metadata: { filename, archiveSha256: verification.archiveSha256 } });
        return sendJson(res, 200, { verification });
      }
      throw httpError(404, 'Backup API endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] backup API`, error);
      if (!res.headersSent) {
        sendJson(res, status, { error: { code: error.code || 'INTERNAL_ERROR', message: status >= 500 ? 'An unexpected server error occurred.' : error.message, requestId } });
      } else res.end();
    }
    return true;
  };
}
