import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { hashPassword } from '../src/auth.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, createDemoCommit } from '../src/git.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { archiveRepository, migrateRepositoryLifecycle } from '../src/repository-lifecycle.mjs';
import { createSshKeysArchiveGuard } from '../src/ssh-keys-archive-guard.mjs';
import {
  authorizeSshCommand,
  createDeployKey,
  createUserSshKey,
  generateAuthorizedKeys,
  migrateSshKeys,
  parseSshOriginalCommand,
  parseSshPublicKey,
  revokeDeployKey,
  revokeUserSshKey,
  sshCloneUrl,
} from '../src/ssh-keys.mjs';
import { migrateWebhooks } from '../src/webhooks.mjs';

function sshString(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(buffer.length);
  return Buffer.concat([length, buffer]);
}

function ed25519Key(seed = 1, comment = 'test@example') {
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, seed))]);
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
}

function rsaKey(bytes = 256) {
  const exponent = Buffer.from([0x01, 0x00, 0x01]);
  const modulus = Buffer.alloc(bytes, 0x5a);
  modulus[0] = 0x80;
  const blob = Buffer.concat([
    sshString('ssh-rsa'),
    sshString(exponent),
    sshString(modulus),
  ]);
  return `ssh-rsa ${blob.toString('base64')} generated`;
}

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-ssh-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Repository Owner',
    webhookEncryptionKey: 'ssh-test-webhook-key-with-enough-entropy',
    sshHost: 'git.example.test',
    sshPort: 2222,
    sshUser: 'git',
    nodeBinary: '/usr/bin/node',
    sshCommandScript: '/opt/kukgit/scripts/ssh-command.mjs',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateWebhooks(db);
  migrateRepositoryLifecycle(db);
  migrateSshKeys(db);
  const { userId: ownerId, orgId } = seedCore(db, config);
  const owner = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(ownerId);

  const repositories = [];
  for (const slug of ['ssh-demo', 'other-demo']) {
    const id = uid('repo');
    createBareRepository(config, 'kuklabs', slug);
    db.prepare(`
      INSERT INTO repositories
        (id, organization_id, slug, name, description, visibility, default_branch, created_by)
      VALUES (?, ?, ?, ?, '', 'private', 'main', ?)
    `).run(id, orgId, slug, slug === 'ssh-demo' ? 'SSH Demo' : 'Other Demo', ownerId);
    await createDemoCommit(config, 'kuklabs', slug);
    repositories.push({ id, slug, orgSlug: 'kuklabs', organizationId: orgId });
  }

  const viewerId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(viewerId, 'viewer@example.com', hashPassword('secure-viewer-password'), 'Read Only User');
  db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'viewer')")
    .run(orgId, viewerId);

  const repository = () => db.prepare(`
    SELECT r.id, r.slug, r.name, r.description, r.visibility,
      r.default_branch AS defaultBranch, r.organization_id AS organizationId,
      r.archived_at AS archivedAt, o.slug AS orgSlug, o.name AS orgName
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE r.id = ?
  `).get(repositories[0].id);

  return { config, db, owner, ownerId, viewerId, orgId, repositories, repository };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('validates Ed25519 and RSA public-key blobs and computes stable fingerprints', () => {
  const ed = parseSshPublicKey(ed25519Key(7));
  assert.equal(ed.keyType, 'ssh-ed25519');
  assert.match(ed.fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.equal(ed.publicKey.split(' ').length, 2);
  assert.equal(parseSshPublicKey(ed25519Key(7, 'different-comment')).fingerprint, ed.fingerprint);

  const rsa = parseSshPublicKey(rsaKey(256));
  assert.equal(rsa.keyType, 'ssh-rsa');
  assert.throws(() => parseSshPublicKey(rsaKey(128)), (error) => error.code === 'SSH_RSA_TOO_SMALL');
  assert.throws(() => parseSshPublicKey(`ssh-rsa ${ed.publicKey.split(' ')[1]}`), (error) => error.code === 'SSH_KEY_TYPE_MISMATCH');
  assert.throws(() => parseSshPublicKey(`${ed.publicKey}\nmalicious`), (error) => error.code === 'SSH_KEY_INVALID');
});

test('prevents active key reuse across user and deploy-key scopes', async (t) => {
  const context = await setup(t);
  const key = ed25519Key(11);
  const userKey = createUserSshKey(context.db, context.ownerId, { title: 'Owner laptop', publicKey: key });
  assert.throws(
    () => createDeployKey(context.db, context.repositories[0].id, context.ownerId, { title: 'Duplicate machine', publicKey: key }),
    (error) => error.code === 'SSH_KEY_DUPLICATE',
  );
  revokeUserSshKey(context.db, context.ownerId, userKey.id);
  const deploy = createDeployKey(context.db, context.repositories[0].id, context.ownerId, { title: 'Deployment', publicKey: key });
  assert.equal(deploy.canWrite, false);
  assert.throws(
    () => createUserSshKey(context.db, context.viewerId, { title: 'Duplicate user', publicKey: key }),
    (error) => error.code === 'SSH_KEY_DUPLICATE',
  );
});

test('authorizes user keys by effective permission and deploy keys by repository scope', async (t) => {
  const context = await setup(t);
  const ownerKey = createUserSshKey(context.db, context.ownerId, { title: 'Owner', publicKey: ed25519Key(21) });
  const viewerKey = createUserSshKey(context.db, context.viewerId, { title: 'Viewer', publicKey: ed25519Key(22) });
  const readOnlyDeploy = createDeployKey(context.db, context.repositories[0].id, context.ownerId, {
    title: 'Read only CI', publicKey: ed25519Key(23), canWrite: false,
  });
  const writableDeploy = createDeployKey(context.db, context.repositories[0].id, context.ownerId, {
    title: 'Release bot', publicKey: ed25519Key(24), canWrite: true,
  });

  const ownerPush = authorizeSshCommand(context.db, context.config, {
    keyKind: 'user', keyId: ownerKey.id, originalCommand: "git-receive-pack 'kuklabs/ssh-demo.git'",
  });
  assert.equal(ownerPush.command.write, true);
  assert.equal(ownerPush.actor.permission, 'admin');
  assert.ok(fs.existsSync(ownerPush.gitDirectory));

  const viewerFetch = authorizeSshCommand(context.db, context.config, {
    keyKind: 'user', keyId: viewerKey.id, originalCommand: "git-upload-pack 'kuklabs/ssh-demo.git'",
  });
  assert.equal(viewerFetch.command.write, false);
  assert.throws(
    () => authorizeSshCommand(context.db, context.config, {
      keyKind: 'user', keyId: viewerKey.id, originalCommand: "git-receive-pack 'kuklabs/ssh-demo.git'",
    }),
    (error) => error.code === 'REPOSITORY_ACCESS_DENIED',
  );

  authorizeSshCommand(context.db, context.config, {
    keyKind: 'deploy', keyId: readOnlyDeploy.id, originalCommand: "git-upload-pack 'kuklabs/ssh-demo.git'",
  });
  assert.throws(
    () => authorizeSshCommand(context.db, context.config, {
      keyKind: 'deploy', keyId: readOnlyDeploy.id, originalCommand: "git-receive-pack 'kuklabs/ssh-demo.git'",
    }),
    (error) => error.code === 'DEPLOY_KEY_READ_ONLY',
  );
  assert.throws(
    () => authorizeSshCommand(context.db, context.config, {
      keyKind: 'deploy', keyId: writableDeploy.id, originalCommand: "git-upload-pack 'kuklabs/other-demo.git'",
    }),
    (error) => error.code === 'DEPLOY_KEY_REPOSITORY_MISMATCH',
  );

  const used = context.db.prepare('SELECT last_used_at AS lastUsedAt FROM user_ssh_keys WHERE id = ?').get(ownerKey.id);
  assert.ok(used.lastUsedAt);
  const auditCount = context.db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action LIKE 'git.ssh.%'").get().count;
  assert.ok(auditCount >= 3);

  revokeDeployKey(context.db, context.repositories[0].id, readOnlyDeploy.id);
  assert.throws(
    () => authorizeSshCommand(context.db, context.config, {
      keyKind: 'deploy', keyId: readOnlyDeploy.id, originalCommand: "git-upload-pack 'kuklabs/ssh-demo.git'",
    }),
    (error) => error.code === 'DEPLOY_KEY_REPOSITORY_MISMATCH',
  );
});

test('archived repositories allow SSH fetch but reject SSH push', async (t) => {
  const context = await setup(t);
  const key = createUserSshKey(context.db, context.ownerId, { title: 'Owner', publicKey: ed25519Key(31) });
  archiveRepository(context.db, context.repository(), context.owner);
  const fetch = authorizeSshCommand(context.db, context.config, {
    keyKind: 'user', keyId: key.id, originalCommand: "git-upload-pack 'kuklabs/ssh-demo.git'",
  });
  assert.equal(fetch.command.write, false);
  assert.throws(
    () => authorizeSshCommand(context.db, context.config, {
      keyKind: 'user', keyId: key.id, originalCommand: "git-receive-pack 'kuklabs/ssh-demo.git'",
    }),
    (error) => error.code === 'REPOSITORY_ARCHIVED',
  );
});

test('forced SSH command parser rejects shell injection and unsupported commands', () => {
  const parsed = parseSshOriginalCommand("git-upload-pack 'kuklabs/ssh-demo.git'");
  assert.deepEqual(parsed, { service: 'git-upload-pack', orgSlug: 'kuklabs', repoSlug: 'ssh-demo', write: false });
  for (const command of [
    "git-upload-pack '../../etc/passwd'",
    "git-upload-pack 'kuklabs/ssh-demo.git'; id",
    "git-receive-pack \"kuklabs/ssh-demo.git\"",
    "bash -c 'id'",
    "git-archive 'kuklabs/ssh-demo.git'",
  ]) {
    assert.throws(() => parseSshOriginalCommand(command), (error) => error.code === 'SSH_COMMAND_REJECTED');
  }
});

test('generates restricted authorized_keys entries and SSH clone URLs', async (t) => {
  const context = await setup(t);
  const userKey = createUserSshKey(context.db, context.ownerId, { title: 'Owner', publicKey: ed25519Key(41) });
  const deployKey = createDeployKey(context.db, context.repositories[0].id, context.ownerId, {
    title: 'Deploy', publicKey: ed25519Key(42), canWrite: true,
  });
  const output = generateAuthorizedKeys(context.db, context.config);
  assert.match(output, /restrict,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty/);
  assert.match(output, new RegExp(`--key-kind user --key-id ${userKey.id}`));
  assert.match(output, new RegExp(`--key-kind deploy --key-id ${deployKey.id}`));
  assert.equal(output.includes('PRIVATE KEY'), false);
  assert.equal(sshCloneUrl(context.config, 'kuklabs', 'ssh-demo'), 'ssh://git@git.example.test:2222/kuklabs/ssh-demo.git');
});

test('archive guard blocks deploy-key writes but permits reads', async (t) => {
  const context = await setup(t);
  archiveRepository(context.db, context.repository(), context.owner);
  const next = (_req, res) => { res.writeHead(204); res.end(); };
  const guard = createSshKeysArchiveGuard({ config: context.config, db: context.db, next });
  const server = http.createServer(guard);
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const read = await fetch(`${origin}/api/ssh-keys/kuklabs/ssh-demo/deploy-keys`);
  assert.equal(read.status, 204);
  const write = await fetch(`${origin}/api/ssh-keys/kuklabs/ssh-demo/deploy-keys`, { method: 'POST' });
  assert.equal(write.status, 409);
  assert.equal((await write.json()).error.code, 'REPOSITORY_ARCHIVED');
});
