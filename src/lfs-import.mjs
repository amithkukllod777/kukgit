import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { httpError } from './security.mjs';
import { lfsStorage } from './git-lfs.mjs';
import { repoDiskPath } from './git.mjs';
import { normalizeImportToken } from './repository-import.mjs';

/**
 * Fetching the files a mirror clone did not bring.
 *
 * `git clone --mirror` copies every object in the repository, and a repository
 * using Git LFS does not contain its large files — it contains 130-byte text
 * files that name them. So an imported repository looks complete, clones fine,
 * and hands anybody who checks it out a pointer where their model weights or
 * their video used to be. The failure is silent and it is discovered later, by
 * somebody who assumed the migration worked.
 *
 * This finds those pointers, fetches what they name from the host we imported
 * from, and stores it here.
 *
 * **What comes back is verified before it is kept.** The pointer says the file's
 * SHA-256; the bytes are hashed while they are downloaded and the object is
 * discarded if they disagree. Without that, whatever the far end sends is what
 * KukGit serves under a name that promises otherwise — and that host is one we
 * have just been told to trust by somebody pasting a URL.
 */

const POINTER_MAX_BYTES = 300;
const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n?$/;
const BATCH_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 60000;

/**
 * Reads a pointer, or decides it is not one.
 *
 * Deliberately strict. A blob that merely looks pointer-ish — the right words in
 * a README, a pointer with an extra line — is a file somebody committed, and
 * treating it as a pointer would replace their file with whatever an LFS server
 * returns for that OID.
 */
export function parseLfsPointer(text) {
  const value = String(text ?? '');
  if (value.length > POINTER_MAX_BYTES) return null;
  const match = POINTER.exec(value);
  if (!match) return null;
  const size = Number(match[2]);
  if (!Number.isSafeInteger(size) || size < 0) return null;
  return { oid: match[1], size };
}

function git(args, { cwd, maxBuffer = 64 * 1024 * 1024, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(httpError(504, 'Git command timed out.', 'GIT_TIMEOUT'));
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) { child.kill('SIGKILL'); }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on('close', (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (status !== 0) return reject(httpError(400, `git ${args[0]} failed: ${stderr.trim().slice(0, 300)}`, 'GIT_ERROR'));
      resolve(stdout);
    });
  });
}

/**
 * Every LFS pointer in a bare repository, across all refs.
 *
 * Two passes rather than one. The first lists object names and sizes without
 * reading any content — a pointer is always tiny, so anything over 300 bytes is
 * dismissed for the cost of reading its header. Only the survivors are read.
 * On a repository with a gigabyte of blobs that is the difference between
 * seconds and minutes.
 */
export async function findLfsPointers(config, orgSlug, repoSlug) {
  const gitDir = repoDiskPath(config, orgSlug, repoSlug);
  if (!fs.existsSync(gitDir)) throw httpError(404, 'Repository not found on disk.', 'REPO_NOT_FOUND');

  const listing = await git(['--git-dir', gitDir, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectname) %(objectsize)']);
  const candidates = [];
  for (const line of listing.split('\n')) {
    const [type, name, size] = line.split(' ');
    if (type !== 'blob' || !name) continue;
    if (Number(size) > POINTER_MAX_BYTES) continue;
    candidates.push(name);
  }
  if (!candidates.length) return [];

  // One `cat-file --batch` for all of them; spawning git per blob would be one
  // process per candidate.
  const pointers = new Map();
  const contents = await new Promise((resolve, reject) => {
    const child = spawn('git', ['--git-dir', gitDir, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => (status === 0
      ? resolve(Buffer.concat(chunks))
      : reject(httpError(400, `git cat-file failed: ${stderr.trim().slice(0, 300)}`, 'GIT_ERROR'))));
    child.stdin.end(`${candidates.join('\n')}\n`);
  });

  // `<sha> <type> <size>\n<content>\n` per object, back to back.
  let offset = 0;
  while (offset < contents.length) {
    const newline = contents.indexOf(0x0a, offset);
    if (newline < 0) break;
    const header = contents.subarray(offset, newline).toString('utf8');
    const [, , sizeRaw] = header.split(' ');
    const size = Number(sizeRaw);
    if (!Number.isFinite(size)) break;
    const body = contents.subarray(newline + 1, newline + 1 + size).toString('utf8');
    offset = newline + 1 + size + 1;
    const pointer = parseLfsPointer(body);
    // Keyed by OID: the same file committed on four branches is one object.
    if (pointer) pointers.set(pointer.oid, pointer);
  }
  return [...pointers.values()];
}

/**
 * The LFS endpoint for a repository we cloned from.
 *
 * Git LFS puts it at `<repository url>/info/lfs` by convention, and every host
 * that serves LFS over HTTPS follows it.
 */
export function lfsEndpointFor(sourceUrl) {
  const value = String(sourceUrl ?? '').trim();
  if (!value.startsWith('https://')) {
    throw httpError(400, 'Git LFS objects can only be fetched over HTTPS.', 'LFS_IMPORT_UNSUPPORTED');
  }
  return `${value.replace(/\.git$/, '').replace(/\/+$/, '')}.git/info/lfs`;
}

function authorizationFor(token) {
  const value = normalizeImportToken(token);
  return value ? `Basic ${Buffer.from(`x-access-token:${value}`, 'utf8').toString('base64')}` : null;
}

/**
 * Asks the source where each object may be downloaded from.
 *
 * The batch API answers with a URL and headers per object, which is how hosts
 * hand out short-lived signed links to their own object store.
 */
export async function requestLfsBatch({ endpoint, token, objects }, { fetchImpl = fetch } = {}) {
  const headers = {
    Accept: 'application/vnd.git-lfs+json',
    'Content-Type': 'application/vnd.git-lfs+json',
    'User-Agent': 'KukGit',
  };
  const authorization = authorizationFor(token);
  if (authorization) headers.Authorization = authorization;

  let response;
  try {
    response = await fetchImpl(`${endpoint}/objects/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: objects.map(({ oid, size }) => ({ oid, size })) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw httpError(504, `The Git LFS server did not answer: ${String(error?.message ?? error).slice(0, 200)}`, 'LFS_IMPORT_UNREACHABLE');
  }
  if (response.status === 401 || response.status === 403) {
    throw httpError(401, 'The Git LFS server rejected the access token. It needs the same read access as the clone.', 'LFS_IMPORT_UNAUTHORIZED');
  }
  if (!response.ok) throw httpError(502, `The Git LFS server refused the request: HTTP ${response.status}`, 'LFS_IMPORT_FAILED');
  const body = await response.json().catch(() => null);
  if (!body || !Array.isArray(body.objects)) throw httpError(502, 'The Git LFS server returned no object list.', 'LFS_IMPORT_BAD_RESPONSE');
  return body.objects;
}

/**
 * Downloads one object, hashing as it goes, and keeps it only if it is what it
 * claimed to be.
 */
async function downloadVerified(action, pointer, config, { fetchImpl }) {
  const temporary = path.join(config.tempDir, `lfs-import-${pointer.oid.slice(0, 16)}-${process.pid}`);
  fs.mkdirSync(config.tempDir, { recursive: true });
  const hash = crypto.createHash('sha256');
  let written = 0;

  let response;
  try {
    response = await fetchImpl(action.href, {
      headers: { 'User-Agent': 'KukGit', ...(action.header ?? {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw httpError(504, `Download failed: ${String(error?.message ?? error).slice(0, 200)}`, 'LFS_IMPORT_DOWNLOAD_FAILED');
  }
  if (!response.ok) throw httpError(502, `Download failed: HTTP ${response.status}`, 'LFS_IMPORT_DOWNLOAD_FAILED');
  if (!response.body) throw httpError(502, 'Download returned no body.', 'LFS_IMPORT_DOWNLOAD_FAILED');

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (source) {
        for await (const chunk of source) {
          written += chunk.length;
          // Stop the moment it is longer than promised, rather than filling the
          // disk with whatever the far end feels like sending.
          if (written > pointer.size) throw httpError(422, 'The object is larger than its pointer declares.', 'LFS_IMPORT_SIZE_MISMATCH');
          hash.update(chunk);
          yield chunk;
        }
      },
      fs.createWriteStream(temporary),
    );

    if (written !== pointer.size) {
      throw httpError(422, `The object is ${written} bytes and its pointer says ${pointer.size}.`, 'LFS_IMPORT_SIZE_MISMATCH');
    }
    const digest = hash.digest('hex');
    if (digest !== pointer.oid) {
      // The whole point. What the far end sent is not what the repository says
      // it is, and storing it would have KukGit serve those bytes under a name
      // that promises otherwise.
      throw httpError(422, 'The downloaded object does not match the SHA-256 in its pointer.', 'LFS_IMPORT_HASH_MISMATCH');
    }
    return temporary;
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Finds, fetches, verifies and stores every LFS object a repository points at.
 *
 * One object's failure is one object's failure: a migration of four hundred
 * files must not stop at the one that was deleted from the source last year.
 * Everything that did not come across is named in the result.
 */
export async function importLfsObjects(db, config, { repository, sourceUrl, token = null, attachedBy = null }, { fetchImpl = fetch } = {}) {
  const pointers = await findLfsPointers(config, repository.orgSlug, repository.slug);
  if (!pointers.length) return { found: 0, imported: 0, alreadyHeld: 0, bytes: 0, failures: [] };

  const endpoint = lfsEndpointFor(sourceUrl);
  const held = new Set(db.prepare('SELECT oid FROM lfs_objects').all().map((row) => row.oid));
  const wanted = pointers.filter((pointer) => !held.has(pointer.oid));
  const alreadyHeld = pointers.length - wanted.length;

  // Objects KukGit already holds still need attaching to this repository, or
  // the repository's own LFS listing shows nothing.
  const attach = db.prepare('INSERT INTO repository_lfs_objects (repository_id, oid, attached_by) VALUES (?, ?, ?) ON CONFLICT(repository_id, oid) DO NOTHING');
  for (const pointer of pointers) {
    if (held.has(pointer.oid)) attach.run(repository.id, pointer.oid, attachedBy);
  }

  const failures = [];
  let imported = 0;
  let bytes = 0;

  for (let index = 0; index < wanted.length; index += BATCH_LIMIT) {
    const slice = wanted.slice(index, index + BATCH_LIMIT);
    let answers;
    try {
      answers = await requestLfsBatch({ endpoint, token, objects: slice }, { fetchImpl });
    } catch (error) {
      // A whole batch failing is not a reason to abandon the next one, and the
      // reason belongs against every object it covered.
      for (const pointer of slice) failures.push({ oid: pointer.oid, size: pointer.size, reason: error.message });
      continue;
    }

    const byOid = new Map(answers.map((answer) => [String(answer.oid ?? '').toLowerCase(), answer]));
    for (const pointer of slice) {
      const answer = byOid.get(pointer.oid);
      try {
        if (!answer) throw httpError(404, 'The Git LFS server did not answer for this object.', 'LFS_IMPORT_MISSING');
        if (answer.error) throw httpError(Number(answer.error.code) || 422, String(answer.error.message ?? 'The Git LFS server refused this object.'), 'LFS_IMPORT_REFUSED');
        const action = answer.actions?.download;
        // No download action and no error means the server believes we already
        // have it — which we do not, or it would not be in `wanted`.
        if (!action?.href) throw httpError(422, 'The Git LFS server offered no download for this object.', 'LFS_IMPORT_NO_ACTION');
        if (pointer.size > config.lfsMaxObjectBytes) {
          throw httpError(413, `The object is larger than this instance's ${config.lfsMaxObjectBytes}-byte limit.`, 'LFS_OBJECT_TOO_LARGE');
        }

        const temporary = await downloadVerified(action, pointer, config, { fetchImpl });
        try {
          const key = path.posix.join('objects', pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid);
          await lfsStorage(config).putFile(key, temporary);
          db.prepare(`
            INSERT INTO lfs_objects (oid, size, storage_path, last_verified_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(oid) DO UPDATE SET last_verified_at = CURRENT_TIMESTAMP
          `).run(pointer.oid, pointer.size, key);
          attach.run(repository.id, pointer.oid, attachedBy);
          imported += 1;
          bytes += pointer.size;
        } finally {
          fs.rmSync(temporary, { force: true });
        }
      } catch (error) {
        failures.push({ oid: pointer.oid, size: pointer.size, reason: String(error?.message ?? error).slice(0, 300) });
      }
    }
  }

  return { found: pointers.length, imported, alreadyHeld, bytes, failures };
}
