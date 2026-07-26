import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { httpError } from './security.mjs';

export const BACKUP_ARCHIVE_MAGIC = Buffer.from('KUKGIT_BACKUP_V1\n', 'utf8');
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024 * 1024;

export function validateArchivePath(value) {
  const archivePath = String(value ?? '');
  if (!archivePath || archivePath.length > 1024 || archivePath.includes('\\') || archivePath.includes('\0')) {
    throw httpError(400, 'Backup archive entry path is invalid.', 'BACKUP_PATH_INVALID');
  }
  if (archivePath.startsWith('/') || /^[A-Za-z]:/.test(archivePath)) {
    throw httpError(400, 'Backup archive cannot contain absolute paths.', 'BACKUP_PATH_ABSOLUTE');
  }
  const normalized = path.posix.normalize(archivePath);
  if (normalized !== archivePath || normalized === '.' || normalized === '..' || normalized.startsWith('../') || archivePath.split('/').includes('..')) {
    throw httpError(400, 'Backup archive contains an unsafe path.', 'BACKUP_PATH_TRAVERSAL');
  }
  return archivePath;
}

export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

function encodeHeader(header) {
  const payload = Buffer.from(JSON.stringify(header), 'utf8');
  if (payload.length < 2 || payload.length > MAX_HEADER_BYTES) {
    throw httpError(400, 'Backup archive header is invalid.', 'BACKUP_HEADER_INVALID');
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  return [length, payload];
}

export async function packPortableArchive(entries, outputPath) {
  if (!Array.isArray(entries) || !entries.length) throw httpError(400, 'Backup archive requires at least one entry.', 'BACKUP_ENTRIES_REQUIRED');
  const seen = new Set();
  const normalized = [];
  let total = 0;
  for (const entry of entries) {
    const archivePath = validateArchivePath(entry.path);
    if (seen.has(archivePath)) throw httpError(400, `Duplicate backup entry '${archivePath}'.`, 'BACKUP_DUPLICATE_ENTRY');
    seen.add(archivePath);
    const sourcePath = path.resolve(String(entry.sourcePath ?? ''));
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) throw httpError(400, `Backup source '${archivePath}' is not a regular file.`, 'BACKUP_SOURCE_INVALID');
    const digest = await sha256File(sourcePath);
    if (digest.size > MAX_ENTRY_BYTES || total + digest.size > MAX_TOTAL_BYTES) {
      throw httpError(413, 'Backup snapshot exceeds the portable archive size limit.', 'BACKUP_TOO_LARGE');
    }
    total += digest.size;
    normalized.push({ path: archivePath, sourcePath, size: digest.size, sha256: digest.sha256 });
  }

  const destination = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const output = fs.createWriteStream(temporary, { mode: 0o600, flags: 'wx' });
  const gzip = createGzip({ level: 9 });
  gzip.pipe(output);
  try {
    await writeChunk(gzip, BACKUP_ARCHIVE_MAGIC);
    for (const entry of normalized) {
      const [length, header] = encodeHeader({ path: entry.path, size: entry.size, sha256: entry.sha256 });
      await writeChunk(gzip, length);
      await writeChunk(gzip, header);
      for await (const chunk of fs.createReadStream(entry.sourcePath)) await writeChunk(gzip, chunk);
    }
    const [endLength, endHeader] = encodeHeader({ end: true, entries: normalized.length, totalBytes: total });
    await writeChunk(gzip, endLength);
    await writeChunk(gzip, endHeader);
    gzip.end();
    await finished(output);
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
    const archiveDigest = await sha256File(destination);
    return { outputPath: destination, entries: normalized, totalBytes: total, archiveSha256: archiveDigest.sha256, archiveSize: archiveDigest.size };
  } catch (error) {
    gzip.destroy();
    output.destroy();
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

class AsyncByteReader {
  constructor(readable) {
    this.iterator = readable[Symbol.asyncIterator]();
    this.queue = [];
    this.buffered = 0;
    this.done = false;
  }

  async fill(minimum) {
    while (this.buffered < minimum && !this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        break;
      }
      const value = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      if (value.length) {
        this.queue.push(value);
        this.buffered += value.length;
      }
    }
  }

  take(maximum) {
    if (!this.queue.length || maximum <= 0) return Buffer.alloc(0);
    const first = this.queue[0];
    if (first.length <= maximum) {
      this.queue.shift();
      this.buffered -= first.length;
      return first;
    }
    const value = first.subarray(0, maximum);
    this.queue[0] = first.subarray(maximum);
    this.buffered -= value.length;
    return value;
  }

  async readExact(length) {
    if (!Number.isInteger(length) || length < 0) throw httpError(400, 'Backup archive length is invalid.', 'BACKUP_LENGTH_INVALID');
    await this.fill(length);
    if (this.buffered < length) throw httpError(400, 'Backup archive ended unexpectedly.', 'BACKUP_ARCHIVE_TRUNCATED');
    const result = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const chunk = this.take(length - offset);
      chunk.copy(result, offset);
      offset += chunk.length;
    }
    return result;
  }

  async consumeExact(length, consumer) {
    let remaining = length;
    while (remaining > 0) {
      await this.fill(1);
      if (!this.buffered) throw httpError(400, 'Backup archive entry is truncated.', 'BACKUP_ENTRY_TRUNCATED');
      const chunk = this.take(Math.min(remaining, 1024 * 1024));
      await consumer(chunk);
      remaining -= chunk.length;
    }
  }

  async hasMore() {
    await this.fill(1);
    return this.buffered > 0;
  }
}

function safeDestination(root, archivePath) {
  const destination = path.resolve(root, ...archivePath.split('/'));
  const resolvedRoot = path.resolve(root);
  if (!destination.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw httpError(400, 'Backup archive extraction escaped its target.', 'BACKUP_EXTRACTION_ESCAPE');
  }
  return destination;
}

export async function unpackPortableArchive(archivePath, targetDir) {
  const source = path.resolve(archivePath);
  const target = path.resolve(targetDir);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw httpError(404, 'Backup archive was not found.', 'BACKUP_NOT_FOUND');
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw httpError(409, 'Backup extraction target must be empty.', 'BACKUP_TARGET_NOT_EMPTY');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });

  const gunzip = createGunzip();
  const input = fs.createReadStream(source);
  input.pipe(gunzip);
  const reader = new AsyncByteReader(gunzip);
  const seen = new Set();
  const entries = [];
  let total = 0;
  try {
    const magic = await reader.readExact(BACKUP_ARCHIVE_MAGIC.length);
    if (!crypto.timingSafeEqual(magic, BACKUP_ARCHIVE_MAGIC)) throw httpError(400, 'Unsupported backup archive format.', 'BACKUP_FORMAT_UNSUPPORTED');
    while (true) {
      const lengthBuffer = await reader.readExact(4);
      const headerLength = lengthBuffer.readUInt32BE(0);
      if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) throw httpError(400, 'Backup entry header is invalid.', 'BACKUP_HEADER_INVALID');
      let header;
      try { header = JSON.parse((await reader.readExact(headerLength)).toString('utf8')); }
      catch { throw httpError(400, 'Backup entry header JSON is invalid.', 'BACKUP_HEADER_JSON_INVALID'); }
      if (header.end === true) {
        if (header.entries !== entries.length || header.totalBytes !== total) throw httpError(400, 'Backup archive footer does not match its contents.', 'BACKUP_FOOTER_MISMATCH');
        if (await reader.hasMore()) throw httpError(400, 'Backup archive contains trailing data.', 'BACKUP_TRAILING_DATA');
        break;
      }
      const entryPath = validateArchivePath(header.path);
      if (seen.has(entryPath)) throw httpError(400, `Duplicate backup entry '${entryPath}'.`, 'BACKUP_DUPLICATE_ENTRY');
      seen.add(entryPath);
      const size = Number(header.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES || total + size > MAX_TOTAL_BYTES) {
        throw httpError(413, 'Backup entry exceeds the extraction size limit.', 'BACKUP_ENTRY_TOO_LARGE');
      }
      if (!/^[0-9a-f]{64}$/i.test(String(header.sha256 ?? ''))) throw httpError(400, 'Backup entry checksum is invalid.', 'BACKUP_CHECKSUM_INVALID');
      const destination = safeDestination(target, entryPath);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(destination, 'wx', 0o600);
      const hash = crypto.createHash('sha256');
      try {
        await reader.consumeExact(size, async (chunk) => {
          hash.update(chunk);
          fs.writeSync(fd, chunk);
        });
      } finally {
        fs.closeSync(fd);
      }
      const actual = hash.digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(String(header.sha256).toLowerCase()))) {
        throw httpError(400, `Checksum mismatch for '${entryPath}'.`, 'BACKUP_ENTRY_CORRUPT');
      }
      total += size;
      entries.push({ path: entryPath, size, sha256: actual, destination });
    }
    return { archivePath: source, targetDir: target, entries, totalBytes: total };
  } catch (error) {
    input.destroy();
    gunzip.destroy();
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
