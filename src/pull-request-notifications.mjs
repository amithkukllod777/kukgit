import { createNotification, migrateNotifications } from './notifications.mjs';
import { getEffectiveRepositoryAccess, permissionAtLeast } from './repository-access.mjs';

function findPullRequest(db, orgSlug, repoSlug, number) {
  return db.prepare(`
    SELECT p.id, p.number, p.title, p.author_id AS authorId,
      r.id AS repositoryId, r.slug AS repoSlug,
      r.organization_id AS organizationId, o.slug AS orgSlug
    FROM pull_requests p
    JOIN repositories r ON r.id = p.repository_id
    JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ? AND p.number = ?
  `).get(orgSlug, repoSlug, Number(number));
}

function repositoryRecipients(db, pull, minimumPermission = 'write') {
  const members = db.prepare(`
    SELECT user_id AS userId FROM org_members WHERE organization_id = ?
  `).all(pull.organizationId);
  const recipients = [];
  for (const member of members) {
    const access = getEffectiveRepositoryAccess(db, {
      userId: member.userId,
      repositoryId: pull.repositoryId,
    });
    if (access && permissionAtLeast(access.permission, minimumPermission)) recipients.push(member.userId);
  }
  return recipients;
}

export function notifyPullRequestCreated(db, config, { orgSlug, repoSlug, number, actorId }) {
  migrateNotifications(db);
  const pull = findPullRequest(db, orgSlug, repoSlug, number);
  if (!pull) return 0;
  let created = 0;
  for (const userId of repositoryRecipients(db, pull, 'write')) {
    if (userId === actorId) continue;
    const result = createNotification(db, config, {
      userId,
      category: 'pull_request',
      title: `Pull request #${pull.number} opened in ${pull.repoSlug}`,
      body: pull.title,
      link: `#/repo/${pull.orgSlug}/${pull.repoSlug}/pulls`,
      dedupeKey: `pr-opened:${pull.id}:${userId}`,
      metadata: {
        pullRequestId: pull.id,
        repositoryId: pull.repositoryId,
        number: pull.number,
      },
      email: {
        subject: `[${pull.repoSlug}] Pull request #${pull.number}: ${pull.title}`,
        text: `A new pull request was opened in ${pull.orgSlug}/${pull.repoSlug}.\n\n#${pull.number} ${pull.title}\n\nOpen KukGit: ${config.baseUrl}/#/repo/${pull.orgSlug}/${pull.repoSlug}/pulls`,
      },
    });
    if (result.notification || result.email) created += 1;
  }
  return created;
}

export function notifyPullRequestMerged(db, config, { orgSlug, repoSlug, number, actorId }) {
  migrateNotifications(db);
  const pull = findPullRequest(db, orgSlug, repoSlug, number);
  if (!pull || pull.authorId === actorId) return 0;
  const result = createNotification(db, config, {
    userId: pull.authorId,
    category: 'pull_request',
    title: `Pull request #${pull.number} merged`,
    body: `${pull.title} was merged into its base branch.`,
    link: `#/repo/${pull.orgSlug}/${pull.repoSlug}/pulls`,
    dedupeKey: `pr-merged:${pull.id}`,
    metadata: {
      pullRequestId: pull.id,
      repositoryId: pull.repositoryId,
      number: pull.number,
    },
    email: {
      subject: `[${pull.repoSlug}] Pull request #${pull.number} merged`,
      text: `Your pull request was merged in ${pull.orgSlug}/${pull.repoSlug}.\n\n#${pull.number} ${pull.title}\n\nOpen KukGit: ${config.baseUrl}/#/repo/${pull.orgSlug}/${pull.repoSlug}/pulls`,
    },
  });
  return result.notification || result.email ? 1 : 0;
}

export function notifyPullRequestReview(db, config, { orgSlug, repoSlug, number, actorId, state }) {
  migrateNotifications(db);
  const pull = findPullRequest(db, orgSlug, repoSlug, number);
  if (!pull || pull.authorId === actorId) return 0;
  const label = state === 'approved'
    ? 'approved'
    : state === 'changes_requested'
      ? 'requested changes on'
      : 'commented on';
  const result = createNotification(db, config, {
    userId: pull.authorId,
    category: 'pull_request',
    title: `Review ${label} pull request #${pull.number}`,
    body: pull.title,
    link: `#/repo/${pull.orgSlug}/${pull.repoSlug}/pulls`,
    dedupeKey: `pr-review:${pull.id}:${actorId}:${state}:${Date.now()}`,
    metadata: {
      pullRequestId: pull.id,
      repositoryId: pull.repositoryId,
      number: pull.number,
      reviewState: state,
    },
    email: {
      subject: `[${pull.repoSlug}] Review update on pull request #${pull.number}`,
      text: `A reviewer ${label} your pull request in ${pull.orgSlug}/${pull.repoSlug}.\n\n#${pull.number} ${pull.title}\n\nOpen KukGit: ${config.baseUrl}/#/repo/${pull.orgSlug}/${pull.repoSlug}/pulls`,
    },
  });
  return result.notification || result.email ? 1 : 0;
}
