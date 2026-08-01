import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { requireUser } from './auth.mjs';
import { packPortableArchive, sha256File, unpackPortableArchive, validateArchivePath } from './backup-archive.mjs';
import {
  createBackupsApiHandler,
  createVerifiedBackup as createBaseBackup,
  restoreBackupArchive as restoreBaseBackup,
  verifyBackupArchive as verifyBaseBackup,
} from './backups.mjs';
import { audit, uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';
import { lfsStorage } from './git-lfs.mjs';
import { digestObject } from './object-storage.mjs';

const BACKUP_FILENAME = /^kukgit-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}\.kgbak$/;
const OID_PATTERN = /^[0-9a-f]{64}$/;

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function lfsRows(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'lfs_objects'").get();
    if (!table) return [];
    return db.prepare(`
      SELECT oid, size, storage_path AS storagePath
      FROM lfs_objects ORDER BY oid
    `).all();
  } finally {
    db.close();
  }
}

function lfsSourcePath(config, row) {
  if (!OID_PATTERN.test(String(row.oid ?? ''))) throw httpError(400, 'Backup LFS object OID is invalid.', 'BACKUP_LFS_OID_INVALID');
  const storagePath = validateArchivePath(String(row.storagePath ?? ''));
  if (!storagePath.startsWith('objects/') || path.posix.basename(storagePath) !== row.oid) {
    throw httpError(400, `Backup LFS storage path for '${row.oid}' is invalid.`, 'BACKUP_LFS_PATH_INVALID');
  }
  const source = path.resolve(config.lfsDir, ...storagePath.split('/'));
  const root = `${path.resolve(config.lfsDir)}${path.sep}`;
  if (!source.startsWith(root)) throw httpError(400, 'Backup LFS path escapes storage.', 'BACKUP_LFS_PATH_INVALID');
  return { storagePath, source, archivePath: `lfs/${storagePath}` };
}

/**
 * Verifies one live object and says whether its bytes can go in the archive.
 *
 * On a volume the object is read from disk and copied into the archive, which is
 * what makes a `.kgbak` self-contained. In a bucket it is read *through* and
 * re-hashed but **not** copied: an archive is not the place to put a bucket, and
 * an operator who thinks a 40 GB file contains their 4 TB of objects has a
 * recovery plan that fails the first time it is needed.
 *
 * Either way the object is verified. What changes is where the bytes end up, and
 * the manifest records which of the two happened.
 */
async function verifyLiveLfsObject(config, row) {
  const location = lfsSourcePath(config, row);
  const storage = lfsStorage(config);

  if (storage.selfContainedBackup) {
    if (!fs.existsSync(location.source) || !fs.statSync(location.source).isFile()) {
      throw httpError(404, `Git LFS object '${row.oid}' is missing from storage.`, 'BACKUP_LFS_OBJECT_MISSING');
    }
    const digest = await sha256File(location.source);
    if (digest.size !== Number(row.size)) throw httpError(400, `Git LFS object '${row.oid}' has the wrong size.`, 'BACKUP_LFS_SIZE_MISMATCH');
    if (digest.sha256 !== row.oid) throw httpError(400, `Git LFS object '${row.oid}' failed SHA-256 verification.`, 'BACKUP_LFS_HASH_MISMATCH');
    return {
      oid: row.oid,
      size: digest.size,
      sha256: digest.sha256,
      path: location.archivePath,
      sourcePath: location.source,
      storagePath: location.storagePath,
      inArchive: true,
    };
  }

  const head = await storage.head(location.storagePath).catch(() => null);
  if (!head) throw httpError(404, `Git LFS object '${row.oid}' is missing from object storage.`, 'BACKUP_LFS_OBJECT_MISSING');
  const { digest, size } = await digestObject(storage, location.storagePath);
  if (size !== Number(row.size)) throw httpError(400, `Git LFS object '${row.oid}' has the wrong size.`, 'BACKUP_LFS_SIZE_MISMATCH');
  if (digest !== row.oid) throw httpError(400, `Git LFS object '${row.oid}' failed SHA-256 verification.`, 'BACKUP_LFS_HASH_MISMATCH');
  return {
    oid: row.oid,
    size,
    sha256: digest,
    path: location.archivePath,
    sourcePath: null,
    storagePath: location.storagePath,
    inArchive: false,
  };
}

async function augmentBackupWithLfs(config, archivePath) {
  const root = fs.mkdtempSync(path.join(config.tempDir, 'backup-lfs-'));
  const replacement = `${archivePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.lfs.tmp`;
  try {
    const unpacked = await unpackPortableArchive(archivePath, root);
    const manifestEntry = unpacked.entries.find((entry) => entry.path === 'manifest.json');
    if (!manifestEntry) throw httpError(400, 'Backup manifest is missing.', 'BACKUP_MANIFEST_MISSING');
    const manifest = JSON.parse(fs.readFileSync(manifestEntry.destination, 'utf8'));
    const databaseEntry = unpacked.entries.find((entry) => entry.path === manifest.database?.path);
    if (!databaseEntry) throw httpError(400, 'Backup database entry is missing.', 'BACKUP_DATABASE_MISSING');

    const objects = [];
    for (const row of lfsRows(databaseEntry.destination)) objects.push(await verifyLiveLfsObject(config, row));
    const storage = lfsStorage(config);
    manifest.lfs = {
      format: 'kukgit-lfs-backup-v1',
      objectCount: objects.length,
      totalBytes: objects.reduce((sum, object) => sum + object.size, 0),
      // Where the bytes are. `selfContained: false` means this archive verifies
      // the objects but does not contain them, and a restore needs the store
      // below as well — stated in the manifest so it is discovered when the
      // archive is read rather than when the restore fails.
      selfContained: storage.selfContainedBackup,
      // The descriptor carries a bucket, a region and an endpoint. It carries no
      // credential: an archive that could be read is an archive that hands over
      // the object store.
      store: storage.describe(),
      objects: objects.map(({ sourcePath, ...object }) => object),
    };
    manifest.totals = {
      ...manifest.totals,
      lfsObjects: manifest.lfs.objectCount,
      lfsBytes: manifest.lfs.totalBytes,
    };
    const archived = objects.filter((object) => object.inArchive);
    const existingFiles = Array.isArray(manifest.files) ? manifest.files.filter((file) => !String(file.path).startsWith('lfs/')) : [];
    // `files` lists what the archive actually holds. Listing an object that was
    // only verified would make every archive integrity check fail on a file that
    // was never meant to be there.
    manifest.files = [
      ...existingFiles,
      ...archived.map((object) => ({ path: object.path, size: object.size, sha256: object.sha256 })),
    ];
    writeJsonAtomic(manifestEntry.destination, manifest);

    const existingEntries = unpacked.entries
      .filter((entry) => entry.path !== 'manifest.json' && !entry.path.startsWith('lfs/'))
      .map((entry) => ({ path: entry.path, sourcePath: entry.destination }));
    const entries = [
      { path: 'manifest.json', sourcePath: manifestEntry.destination },
      ...existingEntries,
      ...archived.map((object) => ({ path: object.path, sourcePath: object.sourcePath })),
    ];
    await packPortableArchive(entries, replacement);
    fs.renameSync(replacement, archivePath);
    fs.chmodSync(archivePath, 0o600);

    const archiveDigest = await sha256File(archivePath);
    const sidecar = `${archivePath}.json`;
    if (fs.existsSync(sidecar)) {
      const index = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      index.archiveSha256 = archiveDigest.sha256;
      index.archiveSize = archiveDigest.size;
      index.totals = manifest.totals;
      writeJsonAtomic(sidecar, index);
    }
    return manifest.lfs;
  } finally {
    fs.rmSync(replacement, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function verifyLfsArchive(config, archivePath) {
  const root = fs.mkdtempSync(path.join(config.tempDir, 'verify-lfs-'));
  try {
    const unpacked = await unpackPortableArchive(archivePath, root);
    const manifestEntry = unpacked.entries.find((entry) => entry.path === 'manifest.json');
    if (!manifestEntry) throw httpError(400, 'Backup manifest is missing.', 'BACKUP_MANIFEST_MISSING');
    const manifest = JSON.parse(fs.readFileSync(manifestEntry.destination, 'utf8'));
    if (!manifest.lfs) return { objectCount: 0, totalBytes: 0, legacyWithoutLfs: true };
    if (manifest.lfs.format !== 'kukgit-lfs-backup-v1' || !Array.isArray(manifest.lfs.objects)) {
      throw httpError(400, 'Backup Git LFS manifest is invalid.', 'BACKUP_LFS_MANIFEST_INVALID');
    }
    // Absent on an archive written before object storage existed, and those are
    // always self-contained — every one of them had the bytes on a volume.
    const selfContained = manifest.lfs.selfContained !== false;
    const entries = new Map(unpacked.entries.map((entry) => [entry.path, entry]));
    const seen = new Set();
    let totalBytes = 0;
    for (const object of manifest.lfs.objects) {
      if (!OID_PATTERN.test(String(object.oid ?? '')) || seen.has(object.oid)) {
        throw httpError(400, 'Backup Git LFS object identifiers are invalid.', 'BACKUP_LFS_OID_INVALID');
      }
      seen.add(object.oid);
      const archiveObjectPath = validateArchivePath(object.path);
      if (archiveObjectPath !== `lfs/objects/${object.oid.slice(0, 2)}/${object.oid.slice(2, 4)}/${object.oid}`) {
        throw httpError(400, `Backup Git LFS path for '${object.oid}' is invalid.`, 'BACKUP_LFS_PATH_INVALID');
      }
      if (object.sha256 !== object.oid) {
        throw httpError(400, `Backup Git LFS object '${object.oid}' failed manifest verification.`, 'BACKUP_LFS_OBJECT_INVALID');
      }
      if (object.inArchive === false) {
        // Verified at backup time by reading it out of the object store and
        // re-hashing it; the bytes are not here. Checking the archive for it
        // would fail an archive that is exactly as intended.
        if (selfContained) {
          throw httpError(400, `Backup claims to be self-contained but '${object.oid}' is not in it.`, 'BACKUP_LFS_OBJECT_INVALID');
        }
        totalBytes += Number(object.size);
        continue;
      }
      const entry = entries.get(archiveObjectPath);
      if (!entry || entry.size !== Number(object.size) || entry.sha256 !== object.oid) {
        throw httpError(400, `Backup Git LFS object '${object.oid}' failed manifest verification.`, 'BACKUP_LFS_OBJECT_INVALID');
      }
      totalBytes += entry.size;
    }
    if (seen.size !== Number(manifest.lfs.objectCount) || totalBytes !== Number(manifest.lfs.totalBytes)) {
      throw httpError(400, 'Backup Git LFS totals are inconsistent.', 'BACKUP_LFS_TOTALS_INVALID');
    }
    return {
      objectCount: seen.size,
      totalBytes,
      legacyWithoutLfs: false,
      selfContained,
      // Restoring this archive needs the object store as well. The caller is
      // told, rather than finding out when a clone fails to fetch an object.
      store: selfContained ? null : (manifest.lfs.store ?? null),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export async function createVerifiedBackup(config, db) {
  const backup = await createBaseBackup(config, db);
  const lfs = await augmentBackupWithLfs(config, backup.path);
  const verification = await verifyBackupArchive(config, backup.path);
  const archiveDigest = await sha256File(backup.path);
  return {
    ...backup,
    archiveSha256: archiveDigest.sha256,
    archiveSize: archiveDigest.size,
    totals: { ...backup.totals, lfsObjects: lfs.objectCount, lfsBytes: lfs.totalBytes },
    verification,
  };
}

export async function verifyBackupArchive(config, archivePath) {
  const base = await verifyBaseBackup(config, archivePath);
  const lfs = await verifyLfsArchive(config, archivePath);
  return { ...base, lfs };
}

async function restoreLfsObjects(config, archivePath, target) {
  const root = fs.mkdtempSync(path.join(config.tempDir, 'restore-lfs-'));
  try {
    const unpacked = await unpackPortableArchive(archivePath, root);
    const manifestEntry = unpacked.entries.find((entry) => entry.path === 'manifest.json');
    const manifest = manifestEntry ? JSON.parse(fs.readFileSync(manifestEntry.destination, 'utf8')) : null;
    if (!manifest?.lfs?.objects?.length) return { objectCount: 0, totalBytes: 0 };
    const entries = new Map(unpacked.entries.map((entry) => [entry.path, entry]));
    let totalBytes = 0;
    for (const object of manifest.lfs.objects) {
      const entry = entries.get(object.path);
      if (!entry) throw httpError(400, `Restored Git LFS object '${object.oid}' is missing.`, 'RESTORE_LFS_OBJECT_MISSING');
      const destination = path.join(target, 'lfs', 'objects', object.oid.slice(0, 2), object.oid.slice(2, 4), object.oid);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.copyFileSync(entry.destination, destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, 0o600);
      const digest = await sha256File(destination);
      if (digest.sha256 !== object.oid || digest.size !== Number(object.size)) {
        throw httpError(400, `Restored Git LFS object '${object.oid}' failed verification.`, 'RESTORE_LFS_OBJECT_INVALID');
      }
      totalBytes += digest.size;
    }
    return { objectCount: manifest.lfs.objects.length, totalBytes };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export async function restoreBackupArchive(config, archivePath, targetDir, options = {}) {
  const verification = await verifyBackupArchive(config, archivePath);
  const result = await restoreBaseBackup(config, archivePath, targetDir, options);
  if (options.dryRun) return { ...result, lfs: verification.lfs };
  try {
    const lfs = await restoreLfsObjects(config, archivePath, path.resolve(targetDir));
    return { ...result, lfs };
  } catch (error) {
    fs.rmSync(path.resolve(targetDir), { recursive: true, force: true });
    throw error;
  }
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

function managedArchivePath(config, filenameValue) {
  const filename = path.basename(String(filenameValue ?? ''));
  if (!BACKUP_FILENAME.test(filename) || filename !== String(filenameValue ?? '')) {
    throw httpError(400, 'Backup filename is invalid.', 'BACKUP_FILENAME_INVALID');
  }
  return path.join(config.backupsDir, filename);
}

export function createLfsAwareBackupsApiHandler({ config, db }) {
  const base = createBackupsApiHandler({ config, db });
  return async function handleLfsAwareBackups(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const createRoute = url.pathname === '/api/backups' && req.method === 'POST';
    const verifyMatch = req.method === 'POST' && url.pathname.match(/^\/api\/backups\/(kukgit-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}\.kgbak)\/verify$/);
    if (!createRoute && !verifyMatch) return base(req, res);
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);
      requireInstanceAdmin(config, user);
      if (createRoute) {
        const backup = await createVerifiedBackup(config, db);
        audit(db, {
          userId: user.id,
          action: 'backup.created',
          targetType: 'backup',
          targetId: backup.backupId,
          metadata: { filename: backup.filename, archiveSha256: backup.archiveSha256, totals: backup.totals },
        });
        return sendJson(res, 201, { backup });
      }
      const archivePath = managedArchivePath(config, verifyMatch[1]);
      const verification = await verifyBackupArchive(config, archivePath);
      const sidecar = `${archivePath}.json`;
      if (fs.existsSync(sidecar)) {
        const index = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
        index.verifiedAt = verification.verifiedAt;
        index.archiveSha256 = verification.archiveSha256;
        index.archiveSize = verification.archiveSize;
        writeJsonAtomic(sidecar, index);
      }
      audit(db, {
        userId: user.id,
        action: 'backup.verified',
        targetType: 'backup',
        targetId: verification.backupId,
        metadata: { filename: verifyMatch[1], archiveSha256: verification.archiveSha256, lfs: verification.lfs },
      });
      return sendJson(res, 200, { verification });
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] LFS-aware backup API`, error);
      if (!res.headersSent) sendJson(res, status, { error: { code: error.code || 'INTERNAL_ERROR', message: status >= 500 ? 'An unexpected server error occurred.' : error.message, requestId } });
      else res.end();
    }
    return true;
  };
}
