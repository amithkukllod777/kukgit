import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createFilesystemStorage, createObjectStorage, digestObject } from './object-storage.mjs';

export const MIGRATION_LIMITS = {
  // Objects are copied one at a time. A bucket will happily accept more, but the
  // limit that matters is the instance's own memory and the volume's read
  // throughput, and a migration that saturates either is one that has to be run
  // during an outage instead of alongside live traffic.
  defaultBatch: 200,
};

function objectRows(db) {
  return db.prepare('SELECT oid, size, storage_path AS storagePath FROM lfs_objects ORDER BY oid').all();
}

function sourcePathFor(config, row) {
  return path.resolve(config.lfsDir, ...String(row.storagePath).split('/'));
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) { size += chunk.length; hash.update(chunk); }
  return { digest: hash.digest('hex'), size };
}

/**
 * Reports what a migration would move, without moving anything.
 *
 * Run first, always. It is the only way to find out that the volume is missing
 * objects the database still lists *before* a cutover makes that everyone's
 * problem — and a corrupt source object found here is a restore-from-backup
 * decision, not something a copy should paper over.
 */
export async function planLfsStorageMigration(config, db, { verifySource = true } = {}) {
  const source = createFilesystemStorage({ root: config.lfsDir });
  const target = createObjectStorage(config, { prefix: 'lfs' });
  if (target.kind !== 's3') {
    throw new Error('Object storage is not configured. Set KUKGIT_OBJECT_STORAGE_DRIVER=s3 and its bucket and credentials.');
  }

  const rows = objectRows(db);
  const plan = { total: rows.length, totalBytes: 0, pending: [], alreadyPresent: [], missing: [], corrupt: [] };

  for (const row of rows) {
    const key = String(row.storagePath);
    const filePath = sourcePathFor(config, row);
    plan.totalBytes += Number(row.size);

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      plan.missing.push({ oid: row.oid, size: Number(row.size), key });
      continue;
    }
    if (verifySource) {
      const digest = await sha256File(filePath);
      // The OID *is* the SHA-256, so this check is free and it is the only one
      // that catches a volume that has quietly rotted.
      if (digest.digest !== row.oid || digest.size !== Number(row.size)) {
        plan.corrupt.push({ oid: row.oid, key, actualDigest: digest.digest, actualSize: digest.size });
        continue;
      }
    }
    const existing = await target.head(key).catch(() => null);
    if (existing && existing.size === Number(row.size)) {
      // Resumable by construction: a second run skips what the first copied,
      // because an object is addressed by its digest and the bucket already has
      // exactly these bytes.
      plan.alreadyPresent.push({ oid: row.oid, size: Number(row.size), key });
      continue;
    }
    plan.pending.push({ oid: row.oid, size: Number(row.size), key, filePath });
  }
  return plan;
}

/**
 * Copies LFS objects from the instance volume into the configured bucket.
 *
 * **Nothing on the volume is deleted.** A migration that removes its own source
 * has no rollback: the moment anything is wrong with the bucket — a wrong
 * region, a lifecycle rule, a credential that expires — the objects are simply
 * gone. Reclaiming the volume is a separate, deliberate step taken after the
 * instance has been serving from the bucket long enough to trust it.
 *
 * Every object is verified **in the bucket** after it is written, by reading it
 * back and re-hashing. A `PUT` that returned 200 is a claim; the digest is the
 * proof, and this is the one moment when checking it costs nothing extra.
 */
export async function migrateLfsObjectsToBucket(config, db, {
  limit = MIGRATION_LIMITS.defaultBatch,
  onProgress = null,
  verifySource = true,
} = {}) {
  const plan = await planLfsStorageMigration(config, db, { verifySource });
  if (plan.corrupt.length) {
    throw new Error(`${plan.corrupt.length} object(s) on the volume do not match their recorded digest. Restore from a backup before migrating; copying them would move the corruption into the bucket.`);
  }

  const target = createObjectStorage(config, { prefix: 'lfs' });
  const staging = path.join(config.tempDir, 'lfs-migration');
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });

  const copied = [];
  const failed = [];
  for (const object of plan.pending.slice(0, limit)) {
    try {
      // `putFile` consumes the file it is given, so it gets a copy. The original
      // stays on the volume where a rollback can still find it.
      const temporary = path.join(staging, `${object.oid}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
      fs.copyFileSync(object.filePath, temporary);
      await target.putFile(object.key, temporary);

      const { digest, size } = await digestObject(target, object.key);
      if (digest !== object.oid || size !== object.size) {
        // Written but wrong. Removing it means the next run retries cleanly
        // instead of finding a plausible-looking object already in place.
        await target.remove(object.key).catch(() => {});
        throw new Error(`stored object does not match its digest (${digest})`);
      }
      copied.push({ oid: object.oid, size: object.size });
      onProgress?.({ oid: object.oid, size: object.size, copied: copied.length, pending: plan.pending.length });
    } catch (error) {
      failed.push({ oid: object.oid, reason: error.message });
    }
  }

  fs.rmSync(staging, { recursive: true, force: true });
  return {
    total: plan.total,
    alreadyPresent: plan.alreadyPresent.length,
    missing: plan.missing,
    copied: copied.length,
    copiedBytes: copied.reduce((sum, object) => sum + object.size, 0),
    failed,
    remaining: Math.max(0, plan.pending.length - copied.length),
  };
}

/**
 * Confirms every recorded object is readable and correct in the bucket.
 *
 * The gate for the cutover. Not "did the copy report success" — that is what the
 * copy already claimed — but "can this instance serve every object it says it
 * has, from the store it is about to switch to".
 */
export async function verifyBucketHoldsEveryObject(config, db, { limit = null } = {}) {
  const target = createObjectStorage(config, { prefix: 'lfs' });
  if (target.kind !== 's3') throw new Error('Object storage is not configured.');

  const rows = objectRows(db);
  const checked = limit ? rows.slice(0, limit) : rows;
  const problems = [];
  for (const row of checked) {
    const key = String(row.storagePath);
    try {
      const { digest, size } = await digestObject(target, key);
      if (digest !== row.oid) problems.push({ oid: row.oid, reason: 'digest' });
      else if (size !== Number(row.size)) problems.push({ oid: row.oid, reason: 'size' });
    } catch (error) {
      problems.push({ oid: row.oid, reason: error.code === 'STORAGE_OBJECT_MISSING' ? 'missing' : error.message });
    }
  }
  return {
    checked: checked.length,
    total: rows.length,
    complete: checked.length === rows.length,
    problems,
    // A partial check cannot clear a cutover: the objects it skipped are exactly
    // the ones nobody has looked at.
    readyForCutover: problems.length === 0 && checked.length === rows.length,
  };
}

/**
 * Removes objects from the volume once the bucket demonstrably holds them.
 *
 * Each object is re-verified in the bucket immediately before its local copy is
 * removed. Trusting an earlier verification would mean deleting on the strength
 * of a result from before a lifecycle rule, a bucket policy change or an
 * accidental delete could have happened.
 */
export async function reclaimVolumeAfterMigration(config, db, { confirm = false } = {}) {
  if (!confirm) throw new Error('Reclaiming the volume deletes local objects. Pass confirm to proceed.');
  const target = createObjectStorage(config, { prefix: 'lfs' });
  if (target.kind !== 's3') throw new Error('Object storage is not configured.');

  const removed = [];
  const kept = [];
  for (const row of objectRows(db)) {
    const key = String(row.storagePath);
    const filePath = sourcePathFor(config, row);
    if (!fs.existsSync(filePath)) continue;
    try {
      const { digest, size } = await digestObject(target, key);
      if (digest !== row.oid || size !== Number(row.size)) {
        kept.push({ oid: row.oid, reason: 'the bucket copy does not match' });
        continue;
      }
      fs.rmSync(filePath, { force: true });
      removed.push({ oid: row.oid, size: Number(row.size) });
    } catch (error) {
      kept.push({ oid: row.oid, reason: error.code === 'STORAGE_OBJECT_MISSING' ? 'not in the bucket' : error.message });
    }
  }
  return {
    removed: removed.length,
    reclaimedBytes: removed.reduce((sum, object) => sum + object.size, 0),
    kept,
  };
}
