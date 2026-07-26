import { currentUser } from './auth.mjs';
import { resolveRef } from './git.mjs';
import {
  createNotification,
  migrateNotifications,
  notifyPullRequestCreated,
  notifyPullRequestMerged,
  notifyPullRequestReview,
} from './notifications.mjs';

function captureJsonResponse(res) {
  const chunks = [];
  let size = 0;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  res.write = (chunk, encoding, callback) => {
    if (chunk && size < 512 * 1024) {
      const value = Buffer.from(chunk);
      chunks.push(value);
      size += value.length;
    }
    return originalWrite(chunk, encoding, callback);
  };
  res.end = (chunk, encoding, callback) => {
    if (chunk && size < 512 * 1024) {
      const value = Buffer.from(chunk);
      chunks.push(value);
      size += value.length;
    }
    return originalEnd(chunk, encoding, callback);
  };
  return () => {
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return null; }
  };
}

function redact(error) {
  return String(error?.message || error || 'Notification event failed.')
    .replace(/(password|token|secret)=([^\s&]+)/gi, '$1=[REDACTED]')
    .slice(0, 1200);
}

export function notifyFailedCommitStatus(db, config, { orgSlug, repoSlug, sha, context, state }) {
  migrateNotifications(db);
  if (!['failure', 'error'].includes(state)) return 0;
  const repository = db.prepare(`
    SELECT r.id, r.slug, o.slug AS orgSlug
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ? AND r.deleted_at IS NULL
  `).get(orgSlug, repoSlug);
  if (!repository) return 0;
  const pulls = db.prepare(`
    SELECT id, number, title, author_id AS authorId, head_branch AS headBranch
    FROM pull_requests WHERE repository_id = ? AND status = 'open'
  `).all(repository.id);
  let created = 0;
  for (const pull of pulls) {
    let headSha;
    try { headSha = resolveRef(config, orgSlug, repoSlug, pull.headBranch).toLowerCase(); }
    catch { continue; }
    if (headSha !== String(sha).toLowerCase()) continue;
    const result = createNotification(db, config, {
      userId: pull.authorId,
      category: 'status',
      title: `${context} reported ${state}`,
      body: `Status check ${context} reported ${state} for pull request #${pull.number}: ${pull.title}`,
      link: `#/repo/${orgSlug}/${repoSlug}/pulls`,
      dedupeKey: `status:${pull.id}:${sha}:${context}:${state}`,
      metadata: { pullRequestId: pull.id, repositoryId: repository.id, sha, context, state },
      email: {
        subject: `[${repoSlug}] ${context} ${state} on PR #${pull.number}`,
        text: `The ${context} status check reported ${state} for pull request #${pull.number} in ${orgSlug}/${repoSlug}.\n\n${pull.title}\n\nOpen KukGit: ${config.baseUrl}/#/repo/${orgSlug}/${repoSlug}/pulls`,
      },
    });
    if (result.notification || result.email) created += 1;
  }
  return created;
}

export function createNotificationEventCapture({ config, db, next }) {
  return async function notificationEventCapture(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const method = String(req.method || 'GET').toUpperCase();
    const actor = currentUser(db, req);
    const readPayload = captureJsonResponse(res);
    res.once('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300 || method !== 'POST') return;
      const payload = readPayload();
      try {
        let match = url.pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/pulls$/);
        if (match && payload?.pullRequest?.number) {
          notifyPullRequestCreated(db, config, {
            orgSlug: decodeURIComponent(match[1]),
            repoSlug: decodeURIComponent(match[2]),
            number: payload.pullRequest.number,
            actorId: actor?.id,
          });
          return;
        }
        match = url.pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/);
        if (match) {
          notifyPullRequestMerged(db, config, {
            orgSlug: decodeURIComponent(match[1]),
            repoSlug: decodeURIComponent(match[2]),
            number: Number(match[3]),
            actorId: actor?.id,
          });
          return;
        }
        match = url.pathname.match(/^\/api\/governance\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/);
        if (match && payload?.review?.state) {
          notifyPullRequestReview(db, config, {
            orgSlug: decodeURIComponent(match[1]),
            repoSlug: decodeURIComponent(match[2]),
            number: Number(match[3]),
            actorId: actor?.id,
            state: payload.review.state,
          });
          return;
        }
        match = url.pathname.match(/^\/api\/status-checks\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]{40})\/statuses$/);
        if (match && payload?.status) {
          notifyFailedCommitStatus(db, config, {
            orgSlug: decodeURIComponent(match[1]),
            repoSlug: decodeURIComponent(match[2]),
            sha: match[3],
            context: payload.status.context,
            state: payload.status.state,
          });
        }
      } catch (error) {
        console.error(`[notifications] event capture: ${redact(error)}`);
      }
    });
    return next(req, res);
  };
}
