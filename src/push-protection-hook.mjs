import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { scanFiles } from './secret-scanning.mjs';
import { evaluatePush, rejectionMessage } from './push-protection.mjs';

const ZERO = /^0+$/;

/**
 * Runs `git` inside the receiving repository.
 *
 * The hook is executed by Git with the repository as its working directory, and
 * the objects being pushed are already in it — a pre-receive hook can read them
 * before deciding, which is the whole reason the decision can happen here at all.
 */
function git(gitDir, args) {
  const result = spawnSync('git', ['--git-dir', gitDir, ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
}

function parseUpdates(input) {
  return String(input || '').trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [previousSha, sha, ref] = line.trim().split(/\s+/);
    return { previousSha, sha, ref };
  }).filter((update) => update.ref?.startsWith('refs/heads/') && !ZERO.test(update.sha ?? ''));
}

/**
 * Decides whether an incoming push may be accepted.
 *
 * Only the content the push introduces is scanned. Scanning the whole repository
 * would reject a push for a credential that was already there — which is a
 * problem the author of *this* push usually cannot fix, and being unable to push
 * because of somebody else's old mistake is how a control gets disabled.
 *
 * The database is opened read-only. A pre-receive hook runs while the push is
 * still in flight, and a hook that writes is a hook that can leave state behind
 * for a push that was then rejected.
 */
export async function runPushProtection({
  databasePath, repositoryId, gitDir, updates, baseUrl = '', orgSlug = '', repoSlug = '',
}) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const policyRow = db.prepare('SELECT enabled, block_severities AS blockSeverities, allow_example_files AS allowExampleFiles FROM secret_push_protection WHERE repository_id = ?')
      .get(repositoryId);
    if (!policyRow || !policyRow.enabled) return { allowed: true };

    const policy = {
      enabled: true,
      blockSeverities: String(policyRow.blockSeverities).split(',').filter(Boolean),
      allowExampleFiles: Boolean(policyRow.allowExampleFiles),
    };
    const bypassed = new Set(db.prepare(`
      SELECT fingerprint FROM secret_push_bypasses
      WHERE repository_id = ? AND expires_at > datetime('now')
    `).all(repositoryId).map((row) => row.fingerprint));

    const findings = [];
    for (const update of parseUpdates(updates)) {
      const range = update.previousSha && !ZERO.test(update.previousSha)
        ? `${update.previousSha}..${update.sha}`
        : update.sha;
      // `--diff-filter=ACMR` because a deletion introduces nothing. A rename is
      // included: the same credential at a new path is still being pushed.
      const paths = git(gitDir, ['diff', '--name-only', '--diff-filter=ACMR', range])
        .trim().split('\n').filter(Boolean);
      const files = [];
      for (const filePath of paths) {
        try { files.push({ path: filePath, content: git(gitDir, ['show', `${update.sha}:${filePath}`]) }); }
        catch { /* unreadable at this commit; nothing to scan */ }
      }
      findings.push(...scanFiles(files).findings);
    }

    const decision = evaluatePush({ findings, policy, bypassed });
    if (decision.allowed) return { allowed: true };
    return {
      allowed: false,
      message: rejectionMessage(decision, { orgSlug, repoSlug, baseUrl }),
      blocked: decision.blocked.length,
    };
  } finally {
    db.close();
  }
}
