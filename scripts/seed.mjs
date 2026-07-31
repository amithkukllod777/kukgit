import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { audit, findRepo, openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, createDemoCommit, repositoryExists } from '../src/git.mjs';

const config = loadConfig();
fs.mkdirSync(config.repositoriesDir, { recursive: true });
const db = openDatabase(config);
const core = seedCore(db, config);
const user = db.prepare('SELECT id FROM users WHERE email = ?').get(config.adminEmail.toLowerCase());
const org = db.prepare("SELECT id FROM organizations WHERE slug = 'kuklabs'").get();
let repo = findRepo(db, 'kuklabs', 'kukgit-demo');
if (!repo) {
  const id = uid('repo');
  if (!repositoryExists(config, 'kuklabs', 'kukgit-demo')) createBareRepository(config, 'kuklabs', 'kukgit-demo');
  db.prepare(`INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'kukgit-demo', 'KukGit Demo', 'A real Git repository created by the KukGit seed script.', 'public', 'main', ?)`)
    .run(id, org.id, user.id);
  await createDemoCommit(config, 'kuklabs', 'kukgit-demo');
  db.prepare(`INSERT INTO issues (id, repository_id, number, title, body, priority, author_id) VALUES (?, ?, 1, ?, ?, 'high', ?)`)
    .run(uid('iss'), id, 'Add organization invitation flow', 'Invite developers by email and assign organization roles.', user.id);
  db.prepare(`INSERT INTO issues (id, repository_id, number, title, body, priority, author_id) VALUES (?, ?, 2, ?, ?, 'medium', ?)`)
    .run(uid('iss'), id, 'Connect Kuklabs Account', 'Replace local authentication with the shared Kuklabs Account contract.', user.id);
  audit(db, { organizationId: org.id, userId: user.id, action: 'repository.seeded', targetType: 'repository', targetId: id, metadata: { slug: 'kukgit-demo' } });
  console.log('Created kuklabs/kukgit-demo with an initial commit and sample issues.');
} else {
  console.log('Demo repository already exists; no changes made.');
}
console.log(`Admin email: ${config.adminEmail}`);
console.log(core.seeded ? 'Core KukGit account created.' : 'Core KukGit account already exists.');
db.close();
