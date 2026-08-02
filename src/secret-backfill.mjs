import { spawnSync } from 'node:child_process';
import { repoDiskPath } from './git.mjs';
import { recordFindings, scanFiles } from './secret-scanning.mjs';

export const BACKFILL_LIMITS = {
  maxCommitsPerRef: 2000,
  maxFilesPerCommit: 3000,
};

function git(gitDir, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['--git-dir', gitDir, ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
  });
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args[0]} failed: ${result.stderr?.trim()}`);
  return result.stdout ?? '';
}

function lines(text) {
  return text.trim().split('\n').filter(Boolean);
}

/**
 * Scans what is currently on every branch.
 *
 * The default, and the one that matters most. A credential in the current tree
 * is the one an attacker finds by cloning; a credential that was removed three
 * years ago is a rotation task, not an exposure that is still growing.
 *
 * It is also the mode that finishes. Full history on a large repository reads
 * every blob ever written, and a scan nobody runs to completion protects nobody.
 */
export function scanCurrentTrees(config, db, { repository, onProgress = null }) {
  const gitDir = repoDiskPath(config, repository.orgSlug, repository.repoSlug);
  const refs = lines(git(gitDir, ['for-each-ref', '--format=%(refname)', 'refs/heads/'], { allowFailure: true }));

  const summary = { refs: refs.length, scanned: 0, skipped: 0, findings: 0, byRef: [] };
  const seen = new Set();

  for (const ref of refs) {
    const sha = git(gitDir, ['rev-parse', ref], { allowFailure: true }).trim();
    if (!sha) continue;
    const tree = git(gitDir, ['ls-tree', '-r', '--name-only', sha], { allowFailure: true });
    const paths = lines(tree).slice(0, BACKFILL_LIMITS.maxFilesPerCommit);

    const files = [];
    for (const filePath of paths) {
      // Blobs are shared between branches, so the same file at the same content
      // is read once no matter how many branches carry it. On a repository with
      // fifty release branches that is the difference between one scan and fifty.
      const blob = git(gitDir, ['rev-parse', `${sha}:${filePath}`], { allowFailure: true }).trim();
      if (!blob || seen.has(blob)) continue;
      seen.add(blob);
      try { files.push({ path: filePath, content: git(gitDir, ['cat-file', 'blob', blob]) }); }
      catch { summary.skipped += 1; }
    }

    const scan = scanFiles(files);
    summary.scanned += scan.scanned;
    summary.skipped += scan.skipped.length;
    if (scan.findings.length) {
      recordFindings(db, { repositoryId: repository.id, ref, commitSha: sha, findings: scan.findings });
      summary.findings += scan.findings.length;
    }
    summary.byRef.push({ ref, sha, files: files.length, findings: scan.findings.length });
    onProgress?.({ ref, files: files.length, findings: scan.findings.length });
  }
  return summary;
}

/**
 * Scans every commit reachable from every branch.
 *
 * Slow, bounded, and off by default. It finds credentials that were committed
 * and later removed — which still need rotating, because the bytes are in every
 * clone anybody took in between.
 *
 * Blobs are deduplicated across the whole walk, so a file that never changed
 * across a thousand commits is read once.
 */
export function scanFullHistory(config, db, { repository, maxCommitsPerRef = BACKFILL_LIMITS.maxCommitsPerRef, onProgress = null }) {
  const gitDir = repoDiskPath(config, repository.orgSlug, repository.repoSlug);
  const refs = lines(git(gitDir, ['for-each-ref', '--format=%(refname)', 'refs/heads/'], { allowFailure: true }));

  const summary = { refs: refs.length, commits: 0, blobs: 0, scanned: 0, skipped: 0, findings: 0, truncated: [] };
  const seen = new Set();

  for (const ref of refs) {
    const commits = lines(git(gitDir, ['rev-list', `--max-count=${maxCommitsPerRef + 1}`, ref], { allowFailure: true }));
    if (commits.length > maxCommitsPerRef) {
      // Said out loud. A bounded scan reported as complete is worse than no scan,
      // because somebody then believes the part it never reached is clean.
      summary.truncated.push({ ref, limit: maxCommitsPerRef });
      commits.length = maxCommitsPerRef;
    }

    for (const commit of commits) {
      summary.commits += 1;
      const entries = lines(git(gitDir, ['ls-tree', '-r', commit], { allowFailure: true }));
      const files = [];
      for (const entry of entries.slice(0, BACKFILL_LIMITS.maxFilesPerCommit)) {
        const [meta, filePath] = entry.split('\t');
        const blob = meta?.split(/\s+/)[2];
        if (!blob || !filePath || seen.has(blob)) continue;
        seen.add(blob);
        summary.blobs += 1;
        try { files.push({ path: filePath, content: git(gitDir, ['cat-file', 'blob', blob]) }); }
        catch { summary.skipped += 1; }
      }
      if (!files.length) continue;

      const scan = scanFiles(files);
      summary.scanned += scan.scanned;
      summary.skipped += scan.skipped.length;
      if (scan.findings.length) {
        recordFindings(db, { repositoryId: repository.id, ref, commitSha: commit, findings: scan.findings });
        summary.findings += scan.findings.length;
      }
      onProgress?.({ ref, commit, blobs: summary.blobs, findings: summary.findings });
    }
  }
  return summary;
}

export function repositoriesToScan(db, { orgSlug = null, repoSlug = null } = {}) {
  const rows = db.prepare(`
    SELECT r.id, r.slug AS repoSlug, o.slug AS orgSlug
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE r.deleted_at IS NULL
    ORDER BY o.slug, r.slug
  `).all();
  return rows.filter((row) => (!orgSlug || row.orgSlug === orgSlug) && (!repoSlug || row.repoSlug === repoSlug));
}
