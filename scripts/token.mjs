import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { normalizeEmail } from '../src/security.mjs';
import { createPersonalAccessToken, listPersonalAccessTokens, revokePersonalAccessToken } from '../src/tokens.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index];
    if (!part.startsWith('--')) throw new Error(`Unexpected argument: ${part}`);
    const key = part.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function usage() {
  console.log(`KukGit personal access token management

Usage:
  npm run token -- create --email <email> --name <name> [--scopes repo:read,repo:write] [--days 90]
  npm run token -- list --email <email>
  npm run token -- revoke --email <email> --id <token-id>

The plaintext token is shown only once when it is created.`);
}

function findUser(db, email) {
  if (!email) throw new Error('--email is required.');
  const user = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE email = ?').get(normalizeEmail(email));
  if (!user) throw new Error(`No KukGit user exists for ${email}.`);
  return user;
}

const { command, options } = parseArgs(process.argv.slice(2));
if (!command || command === 'help' || command === '--help') {
  usage();
  process.exit(0);
}

const config = loadConfig();
const db = openDatabase(config);
try {
  const user = findUser(db, options.email);
  if (command === 'create') {
    const days = options.days === undefined ? 90 : Number(options.days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('--days must be a whole number between 1 and 3650.');
    const token = createPersonalAccessToken(db, user.id, {
      name: options.name,
      scopes: options.scopes ?? 'repo:read,repo:write',
      expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
    });
    console.log('\nPersonal access token created. Copy it now; KukGit will not show it again.\n');
    console.log(token.token);
    console.log(`\nID: ${token.id}`);
    console.log(`Name: ${token.name}`);
    console.log(`Scopes: ${token.scopes.join(', ')}`);
    console.log(`Expires: ${token.expiresAt}`);
  } else if (command === 'list') {
    const tokens = listPersonalAccessTokens(db, user.id).map((token) => ({
      id: token.id,
      name: token.name,
      prefix: `${token.tokenPrefix}…`,
      scopes: token.scopes.join(', '),
      expires: token.expiresAt ?? 'never',
      lastUsed: token.lastUsedAt ?? 'never',
      status: token.revokedAt ? 'revoked' : token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now() ? 'expired' : 'active',
    }));
    console.table(tokens);
  } else if (command === 'revoke') {
    if (!options.id) throw new Error('--id is required.');
    const token = revokePersonalAccessToken(db, user.id, options.id);
    console.log(`Revoked ${token.name} (${token.tokenPrefix}…).`);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} finally {
  db.close();
}
